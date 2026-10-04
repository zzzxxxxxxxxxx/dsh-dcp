/**
 * A reminder has to actually land.
 *
 * `session/event` listeners run inside the append that published the event, and
 * delivering a reminder IS an append (`user/message`) — so the store's
 * re-entrancy guard refuses an injection made straight from the listener
 * (`session append cannot reenter while another append is being published`).
 * That refusal is invisible where it happened: `dsh web` replaces the logger, so
 * the throw only reached a sink nobody reads, and every reminder the plugin ever
 * decided to send was dropped without a trace.
 *
 * This suite mounts the real services — including the real `SessionStore`, whose
 * guard is the thing that refuses — plus an agent whose `inject` appends exactly
 * the way the host's does. The delivery path cannot regress unnoticed again.
 *
 * @module dsh-dcp/tests/nudge-delivery
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { apply } from '../src/index.ts'
import { NUDGE_PREFIX } from '../src/prompts/index.ts'

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

interface Holder {
  session?: { append: (type: string, data: unknown, options?: unknown) => unknown }
}

/** An agent registry whose `inject` appends a notice the way the host's does. */
class AppendingAgents extends Service<Context> {
  constructor(ctx: Context, private readonly holder: Holder) {
    super(ctx, 'agents')
  }

  get(id: string): { id: string; inject: (message: unknown) => void } {
    const session = this.holder.session
    return {
      id,
      inject: (message: unknown) => { session?.append('user/message', message, { surfaceOp: 'append' }) },
    }
  }
}

describe('reminder delivery', () => {
  it('lands outside the append that decided it, and repeats when due again', async () => {
    const holder: Holder = {}
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx)
    new SessionStore(ctx)
    new TokenMeter(ctx)
    new AppendingAgents(ctx, holder)
    await tick(20)

    // Absolute thresholds: every non-empty session is inside the weak band, and
    // one new node is enough spacing, so the next boundary is always "due".
    apply(ctx, { compaction: { minContextLimit: 0, maxContextLimit: 1_000_000, nudgeFrequency: 1 } } as never)
    await tick(20)

    const session = (ctx as unknown as { sessions: { create: (id: string) => never } }).sessions.create('nudge-delivery')
    holder.session = session as unknown as Holder['session']
    const append = (type: string, data: unknown, options?: unknown): unknown =>
      (session as unknown as { append: (t: string, d: unknown, o?: unknown) => unknown }).append(type, data, options)

    const turn = (index: number): void => {
      append('turn/start', { turn: index })
      append('step/start', { turn: index, step: 1 })
      append('user/message',
        createUserMessage({ content: [{ type: 'text', text: `question ${index}` }], source: { kind: 'user' } }),
        { surfaceOp: 'append' })
      append('assistant/message', {
        turn: index,
        step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: `answer ${index}` }], source: { provider: 'test', model: 'test' } }),
        stream: [],
      }, { surfaceOp: 'append' })
      append('step/end', { turn: index, step: 1 })
      append('turn/end', { turn: index, reason: { kind: 'completed' } })
    }

    turn(1)
    await tick(80)

    const snapshot = (): readonly { type: string; data?: never }[] =>
      (session as unknown as { snapshotEvents: () => readonly { type: string; data?: never }[] }).snapshotEvents()
    // `user/message` carries the message as its payload; `assistant/message`
    // wraps it in `message`. Only the first shape reaches the notice list.
    // The snapshot is taken per call: the list grows as notices land.
    const notices = (): { text: string }[] => snapshot()
      .filter((event) => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } } | undefined)?.source?.kind === 'dsh-dcp')
      .map((event) => ({
        text: ((event.data as unknown as { content: readonly { type: string; text?: string }[] }).content)
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n'),
      }))

    // Before the fix this was zero: the injection threw inside the append.
    expect(notices()).toHaveLength(1)
    expect(notices()[0]?.text.startsWith(NUDGE_PREFIX)).toBe(true)
    expect(notices()[0]?.text).toContain('The conversation is long enough')

    // Spacing is one node and each turn ends with a boundary, so the reminder is
    // due again — a nudge is a reminder, not a one-shot.
    turn(2)
    await tick(80)
    expect(notices()).toHaveLength(2)
  })
})
