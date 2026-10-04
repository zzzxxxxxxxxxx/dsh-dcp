/**
 * Storage-format regression tests.
 *
 * The strategy pass writes surface replacements, and a surface replacement is
 * only legal inside an open turn. That rule lives in the storage validator, not
 * in `Session.append`: an illegal event is accepted into memory and into the
 * log, and is discovered only when someone loads the session again — as
 * `stored log is corrupt: tool/result is outside an open turn`, with the whole
 * session unloadable.
 *
 * So these tests assert against the validator the storage path actually runs
 * (`assertReleasedV4Relationships`), not against the in-memory session, and one
 * of them reproduces the original defect to prove the assertion has teeth.
 *
 * @module dsh-dcp/tests/persistence
 */
import { describe, expect, it } from 'vitest'
import { Session, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'
import { applyDcpEvent } from '../src/projection.ts'
import { initialDcpState } from '../src/types.ts'
import type { DcpState } from '../src/types.ts'
import { pruneToolResult } from '../src/prune.ts'
import { strategiesAllowed } from '../src/strategies/index.ts'
import { PRUNE_OUTPUT_PLACEHOLDER } from '../src/types.ts'

const SOURCE = { provider: 'test', model: 'test' }

/** A session/event listener the test dispatches to, as the session does. */
type Listener = (session: Session, event: SessionEvent) => unknown

/** Mount the plugin against a context that lets the test drive its events. */
function liveContext(): { ctx: never; listeners: Listener[] } {
  const listeners: Listener[] = []
  const disposer = () => {}
  const child = {
    effect: (body: () => unknown) => { body(); return disposer },
    systemPrompt: { section: () => disposer },
    commands: { register: () => disposer },
  }
  const ctx = {
    effect: (body: () => unknown) => { body(); return disposer },
    on: (event: string, handler: Listener) => { if (event === 'session/event') listeners.push(handler); return disposer },
    get: (service: string) => (service === 'tokenMeter'
      ? { measure: () => ({ nodes: [] }), estimateMessage: () => 0 }
      : undefined),
    inject: (_deps: string[], body: (scope: unknown) => unknown) => { body(child); return Promise.resolve() },
    logger: { info: () => {}, warn: () => {} },
    sessionProjections: {
      register: () => disposer,
      // The real unit folds the log; the stub folds it the same way, so the pass
      // reads the turn and blocks the plugin would read.
      stateOf: (session: Session): DcpState => {
        let state = initialDcpState()
        for (const event of session.snapshotEvents()) state = applyDcpEvent(state, event)
        return state
      },
    },
    tools: { register: () => disposer, get: () => undefined },
  }
  return { ctx: ctx as never, listeners }
}

/**
 * Build one complete turn holding two identical tool calls, so deduplication
 * has a candidate. The skeleton is the one the storage validator requires:
 * every step event must sit inside an open `step/start`, and `turn/end` needs
 * the step closed and every tool call resolved.
 */
function buildTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message',
    createUserMessage({ content: [{ type: 'text', text: `go ${turn}` }], source: { kind: 'user' } }),
    { surfaceOp: 'append' })

  for (const index of [0, 1]) {
    const step = index + 1
    const callId = `call-${turn}-${step}` as unknown as ToolCallId
    session.append('step/start', { turn, step })
    session.append('assistant/message', {
      turn,
      step,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"same.ts"}' } as never],
        source: SOURCE,
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step, callId: callId as never, name: 'read', arguments: '{"path":"same.ts"}' })
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `contents ${step}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step })
  }
}

/** The artifact the storage validator consumes. */
function artifactOf(session: Session, id: string): never {
  return {
    header: { version: 4, id, createdAt: 0, cwd: '/tmp', isSeeded: false, delegationDepth: 0 },
    inheritedEventCount: 0,
    events: session.snapshotEvents(),
  } as never
}

/** Let queued microtasks and the pass's promise chain settle. */
function drain(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** Commit one event and deliver it to the plugin's listeners, as a session does. */
async function commit(
  session: Session,
  listeners: readonly Listener[],
  append: () => SessionEvent,
): Promise<SessionEvent> {
  const event = append()
  for (const listener of listeners) listener(session, event)
  await drain()
  return event
}

describe('strategy pass write timing', () => {
  it('writes nothing at turn/end and prunes inside the next turn', async () => {
    const { ctx, listeners } = liveContext()
    apply(ctx, {} as Config)
    const session = Session.create('timing' as never)

    buildTurn(session, 1)

    await commit(session, listeners, () =>
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never }))
    const afterTurnEnd = session.snapshotEvents().length

    // Writing here is what corrupted the log. Nothing more may be written while
    // no turn is open.
    expect(session.snapshotEvents().length).toBe(afterTurnEnd)
    expect(session.snapshotEvents().some((event) => event.type === 'compaction/prune')).toBe(false)

    const start = await commit(session, listeners, () => session.append('turn/start', { turn: 2 }))

    const written = session.snapshotEvents()
    const prunes = written.filter((event) => event.type === 'compaction/prune')
    expect(prunes.length).toBeGreaterThan(0)
    expect((prunes[0] as SessionEvent).seq).toBeGreaterThan(start.seq)
    const replacement = written.find((event) =>
      event.type === 'tool/result' && (event as { surfaceOp?: unknown }).surfaceOp !== 'append')
    expect(replacement).toBeDefined()

    // The decisive assertion: the log this plugin produced is loadable.
    expect(() => assertReleasedV4Relationships(artifactOf(session, 'timing'), KNOWN_SESSION_EVENT_TYPES))
      .not.toThrow()
  })

  it('proves the assertion has teeth: a replacement outside any turn is rejected', () => {
    const session = Session.create('control' as never)
    buildTurn(session, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })

    // Reproduce the old timing directly: prune with no turn open.
    const target = session.snapshotEvents().find((event) => event.type === 'tool/result')?.seq as number
    const outcome = pruneToolResult(session, target, PRUNE_OUTPUT_PLACEHOLDER, 1)
    // The write succeeds — which is exactly why the defect was silent.
    expect(outcome.ok).toBe(true)

    expect(() => assertReleasedV4Relationships(artifactOf(session, 'control'), KNOWN_SESSION_EVENT_TYPES))
      .toThrow(/outside an open turn/)
  })

  it('refuses a pass while no turn is open', () => {
    const session = Session.create('gate' as never)
    buildTurn(session, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })

    let state = initialDcpState()
    for (const event of session.snapshotEvents()) state = applyDcpEvent(state, event)
    expect(state.turn).toBeNull()
    expect(strategiesAllowed({}, state)).toBe(false)
    // ... and allows it once a turn is open again.
    session.append('turn/start', { turn: 2 })
    let next = initialDcpState()
    for (const event of session.snapshotEvents()) next = applyDcpEvent(next, event)
    expect(strategiesAllowed({}, next)).toBe(true)
  })
})
