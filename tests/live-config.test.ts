/**
 * Configuration is live, not a mount-time snapshot.
 *
 * `dsh-settings` persists a settings edit by writing through the stable
 * references the schema delivered and re-resolving the running fiber — the
 * plugin is NOT remounted. A captured snapshot therefore kept the old values
 * until the next restart, and the settings page looked broken: the file changed,
 * the running process did not. (That is exactly how the reminder thresholds were
 * observed to stay at 33%/67% after being edited to 1%/5%.)
 *
 * These tests mount the real container services and hand `apply()` the shape the
 * container delivers — volatile fields as stable references — then change what
 * those references return, the way a settings write does.
 *
 * @module dsh-dcp/tests/live-config
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { apply } from '../src/index.ts'
import { NUDGE_PREFIX } from '../src/prompts/index.ts'

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

/** A `.volatile()` field as cordis delivers it: a stable read-through reference. */
function boxed<T>(read: () => T): { get: () => T } {
  return { get: read }
}

type Raw = Record<string, unknown>

interface Harness {
  ctx: Context
  create: (id: string) => Session
}

type Session = {
  append: (type: string, data: unknown, options?: unknown) => { seq: number }
  snapshotEvents: () => readonly { type: string; seq: number; data?: unknown }[]
}

/** Real services, a real store, and an agent whose `inject` appends like the host's. */
async function harness(): Promise<Harness & { applied: (raw: Raw) => void }> {
  const holder: { session?: Session } = {}
  class AppendingAgents extends Service<Context> {
    constructor(ctx: Context) { super(ctx, 'agents') }
    get(id: string): { id: string; inject: (message: unknown) => void } {
      return { id, inject: (message) => { void holder.session?.append('user/message', message, { surfaceOp: 'append' }) } }
    }
  }
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  new SessionStore(ctx)
  new TokenMeter(ctx)
  new AppendingAgents(ctx)
  await tick(20)
  return {
    ctx,
    applied: (raw: Raw) => { apply(ctx as never, raw as never) },
    create: (id: string) => {
      const session = (ctx as unknown as { sessions: { create: (name: string) => Session } }).sessions.create(id)
      holder.session = session
      return session
    },
  }
}

const noticesOf = (session: Session): string[] => session.snapshotEvents()
  .filter((event) => event.type === 'user/message'
    && (event.data as { source?: { kind?: string } } | undefined)?.source?.kind === 'dsh-dcp')
  .map((event) => ((event.data as { content: readonly { type: string; text?: string }[] }).content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n'))

describe('live configuration', () => {
  it('follows a threshold edit without a restart', async () => {
    let min: number | string = 0
    let max: number | string = 1_000_000
    const h = await harness()
    h.applied({
      compaction: {
        minContextLimit: boxed(() => min),
        maxContextLimit: boxed(() => max),
        nudgeFrequency: boxed(() => 1),
      },
    })

    const session = h.create('live-thresholds')
    const turn = (index: number): void => {
      session.append('turn/start', { turn: index })
      session.append('step/start', { turn: index, step: 1 })
      session.append('user/message',
        createUserMessage({ content: [{ type: 'text', text: `q${index}` }], source: { kind: 'user' } }),
        { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn: index,
        step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: `a${index}` }], source: { provider: 'test', model: 'test' } }),
        stream: [],
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: index, step: 1 })
      session.append('turn/end', { turn: index, reason: { kind: 'completed' } })
    }

    turn(1)
    await tick(80)
    expect(noticesOf(session)).toHaveLength(1)
    expect(noticesOf(session)[0]).toContain(NUDGE_PREFIX)

    // The settings page's write: the reference now reports a band this session
    // sits below. Without a live read the reminder would keep firing.
    min = 900_000
    max = 1_000_000
    turn(2)
    await tick(80)
    expect(noticesOf(session)).toHaveLength(1)

    // …and back, so "it stopped" is not just "it was a one-shot".
    min = 0
    turn(3)
    await tick(80)
    expect(noticesOf(session)).toHaveLength(2)
  })

  it('follows a deduplication switch without a restart', async () => {
    let enabled = true
    const h = await harness()
    h.applied({ strategies: { deduplication: { enabled: boxed(() => enabled) } } })
    const session = h.create('live-dedup')

    const step = (turn: number, index: number): void => {
      const callId = `call-${turn}-${index}` as never
      session.append('step/start', { turn, step: index + 1 })
      session.append('assistant/message', {
        turn,
        step: index + 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' }],
          source: { provider: 'test', model: 'test' },
        }),
        stream: [],
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step: index + 1, callId, name: 'bash', arguments: '{"command":"ls"}' })
      session.append('tool/result', {
        turn,
        step: index + 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: `output ${index}` }], isError: false }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: index + 1 })
    }
    // The pass writes at the NEXT turn boundary, so a turn is: duplicates, end,
    // then a fresh turn to trigger it.
    const turnWithDuplicates = (turn: number): void => {
      session.append('turn/start', { turn })
      session.append('user/message',
        createUserMessage({ content: [{ type: 'text', text: `t${turn}` }], source: { kind: 'user' } }),
        { surfaceOp: 'append' })
      step(turn, 0)
      step(turn, 1)
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const prunes = (): number => session.snapshotEvents().filter((event) => event.type === 'compaction/prune').length

    turnWithDuplicates(1)
    session.append('turn/start', { turn: 2 })
    await tick(120)
    expect(prunes()).toBe(1)

    enabled = false
    turnWithDuplicates(2)
    session.append('turn/start', { turn: 3 })
    await tick(120)
    expect(prunes()).toBe(1)
  })
})
