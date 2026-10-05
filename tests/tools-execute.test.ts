/**
 * `execute()` end-to-end tests for the three model-facing tools, plus the
 * approval seam and the automatic pass's notice copy.
 *
 * Every other test in the suite either compiles a definition (`tools.test.ts`)
 * or drives the transaction layer directly (`commit.test.ts`). The bodies in
 * `compactTool`/`targetsTool`/`recallTool` sit between those two layers and
 * carry the branches the model actually hits: alias re-stamping, per-entry
 * refusal, protected-body appendices, the three gates (`deny`, manual mode,
 * live compaction), and the approval seam. This file drives `execute()` against
 * real `Session`s so those branches fail here rather than in a live profile.
 *
 * @module dsh-dcp/tests/tools-execute
 */
import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply, compactTool, recallTool, targetsTool } from '../src/index.ts'
import type { PluginRuntime } from '../src/index.ts'
import { Config as ConfigSchema, resolveConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { SessionMutex, runStrategies } from '../src/runner.ts'
import { isPruned } from '../src/prune.ts'
import { loadPrompts } from '../src/prompts/index.ts'
import { applyDcpEvent } from '../src/projection.ts'
import { initialDcpState } from '../src/types.ts'
import type { DcpState } from '../src/types.ts'

const SOURCE = { provider: 'test', model: 'test' }

/** Fold the whole log exactly the way the plugin's projection does. */
function fold(session: Session): DcpState {
  return session.snapshotEvents().reduce((state, event) => applyDcpEvent(state, event), initialDcpState())
}

/** The current surface as plain numbers. */
function nodes(session: Session): number[] {
  return [...session.surface.nodes].map(Number)
}

/** The handle the model would copy out of `compact_targets`. */
function handle(seq: number): string {
  return `n${seq}`
}

/** Execution identity, as the tool runtime hands it to `execute`. */
function exec(session: Session, callId = 'probe-call'): never {
  return { agent: { session }, callId } as never
}

/** The canonical output shapes the tool schemas declare, for typed assertions. */
interface CompactValue {
  message: string
  blocks: Array<{ id: string; from: string; to: string; nodes: number }>
  skipped: string[]
}
interface TargetsValue { text: string; targets: number }
interface RecallValue { found: boolean; text: string; chars: number; truncated: boolean; nodes: number }

/** Drive `compact` through its real definition and read the declared output. */
async function runCompact(rt: PluginRuntime, args: unknown, session: Session, callId = 'probe-call'): Promise<CompactValue> {
  return (await compactTool(rt).execute(args as never, exec(session, callId))) as CompactValue
}

/** Drive `compact_targets` through its real definition. */
async function runTargets(rt: PluginRuntime, session: Session): Promise<TargetsValue> {
  return (await targetsTool(rt).execute({} as never, exec(session))) as TargetsValue
}

/** Drive `recall` through its real definition. */
async function runRecall(rt: PluginRuntime, args: { block: string; query?: string; offset?: number }, session: Session): Promise<RecallValue> {
  return (await recallTool(rt).execute(args as never, exec(session))) as RecallValue
}

/** Append one user → assistant(tool call) → tool result round. */
function pushRound(session: Session, index: number, overrides: { name?: string; args?: string; resultText?: string; isError?: boolean } = {}): void {
  const callId = `call-${index}`
  const name = overrides.name ?? 'read'
  const args = overrides.args ?? JSON.stringify({ path: `f${index}.ts` })
  session.append('user/message',
    createUserMessage({ content: [{ type: 'text', text: `request ${index}` }], source: { kind: 'user' } }),
    { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: index + 1,
    message: createAssistantMessage({
      content: [
        { type: 'text', text: `calling ${name}` },
        { type: 'tool-call', id: callId as never, name, arguments: args },
      ],
      source: SOURCE,
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: index + 1, callId: callId as never, name, arguments: args })
  session.append('tool/result', {
    turn: 1,
    step: index + 1,
    message: createToolResultMessage({
      callId: callId as never,
      content: [{ type: 'text', text: overrides.resultText ?? `contents of f${index}.ts` }],
      isError: overrides.isError ?? false,
    }),
  }, { surfaceOp: 'append' })
}

/** A conversation whose surface is three nodes per round: user, assistant, result. */
function buildConversation(session: Session, rounds: number, overrides: (index: number) => { name?: string; resultText?: string } = () => ({})): void {
  session.append('turn/start', { turn: 1 })
  for (let index = 0; index < rounds; index += 1) pushRound(session, index, overrides(index))
}

/** The model-visible text of every `compact-checkpoint` message. */
function checkpointTexts(session: Session): string[] {
  return session.snapshotEvents()
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data as { source?: { kind?: string }; content?: readonly { type: string; text?: string }[] })
    .filter((data) => data.source?.kind === 'compact-checkpoint')
    .map((data) => (data.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'))
}

/** The panel-facing summary text of every `compaction/summary` event. */
function summaryTexts(session: Session): string[] {
  return session.snapshotEvents()
    .filter((event) => event.type === 'compaction/summary')
    .map((event) => event.data as { summary?: readonly { type: string; text?: string }[] })
    .map((data) => (data.summary ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'))
}

interface RuntimeOptions {
  config?: Config
  ctx?: unknown
  stateOf?: (session: Session) => DcpState
  priceOf?: (session: Session) => (seq: number) => number | undefined
  estimateMessage?: (message: never) => number | undefined
  declaredPaths?: (name: string, args: unknown) => readonly string[]
}

/** A runtime literal over a real session, with the production defaults. */
function runtimeFor(session: Session, options: RuntimeOptions = {}): PluginRuntime {
  return {
    ctx: (options.ctx ?? { get: () => undefined }) as never,
    config: options.config ?? resolveConfig(ConfigSchema({})),
    prompts: loadPrompts(false, false),
    mutex: new SessionMutex(),
    nudgeBlocks: new WeakMap(),
    stateOf: options.stateOf ?? (() => fold(session)),
    priceOf: options.priceOf ?? (() => () => undefined),
    estimateMessage: options.estimateMessage ?? (() => undefined),
    declaredPaths: options.declaredPaths ?? (() => []),
  }
}

/** A state based on the live fold whose newest block is dropped for `lag` reads. */
function laggingStateOf(session: Session, lag: number, probe: { calls: number; laggedBlocks: number }): (target: Session) => DcpState {
  return (target) => {
    probe.calls += 1
    const live = fold(target)
    // A projection that has not yet seen the newest block: the real hazard the
    // re-stamp exists for (a reloaded fold, a lagging checkpoint).
    if (probe.calls <= lag) {
      probe.laggedBlocks = live.blocks.length - 1
      return { ...live, blocks: live.blocks.slice(0, -1) }
    }
    return live
  }
}

describe('compact execute — a span lands end to end', () => {
  it('reports the alias, the boundaries and the node count the projection records', async () => {
    const session = Session.create('execute-happy' as never)
    buildConversation(session, 3)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]

    const result = await runCompact(
      runtimeFor(session),
      { topic: 'first round', content: [{ startId: handle(first), endId: handle(last), summary: 'Condensed the first round.' }] },
      session,
    )

    expect(result.message).toBe(`Compacted 3 nodes into b1 (${handle(first)}→${handle(last)}).`)
    expect(result.blocks).toEqual([{ id: 'b1', from: handle(first), to: handle(last), nodes: 3 }])
    expect(result.skipped).toEqual([])

    // The alias in the answer is the alias the projection actually created.
    const projected = fold(session)
    expect(projected.blocks).toHaveLength(1)
    expect(projected.blocks[0]?.id).toBe('b1')
    expect(projected.blocks[0]?.seq).toBe(nodes(session)[0])
    // The checkpoint is the model-visible summary; the panel gets the bare body.
    expect(checkpointTexts(session)[0]).toContain('Condensed the first round.')
    // Nothing protected was in range, so no appendix is appended.
    expect(checkpointTexts(session)[0]).not.toContain('protected tool outputs')
    expect(checkpointTexts(session)[0]).not.toContain('User messages preserved verbatim')
    expect(session.deriveMessages().flatMap((message) => message.content).some((block) => block.type === 'text' && block.text.includes('contents of f0.ts'))).toBe(false)
  })

  it('lists a refused entry in the headline while the other one lands', async () => {
    const session = Session.create('execute-partial' as never)
    buildConversation(session, 3)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]

    // Two ENTRIES naming the SAME span: the first claims it, the second is refused.
    const result = await runCompact(runtimeFor(session), {
      topic: 'double',
      content: [
        { startId: handle(first), endId: handle(last), summary: 'first entry' },
        { startId: handle(first), endId: handle(last), summary: 'second entry' },
      ],
    }, session)

    expect(result.blocks).toHaveLength(1)
    expect(result.message).toBe(
      `Compacted 3 nodes into b1 (${handle(first)}→${handle(last)}). `
      + 'Skipped: entry 2: overlaps another entry in this call',
    )
    // The structured field carries the same refusal, which is what a client reads.
    expect(result.skipped).toEqual(['entry 2: overlaps another entry in this call'])
  })

  it('keeps a refusal out of the headline when notices are off but not out of skipped', async () => {
    const session = Session.create('execute-partial-off' as never)
    buildConversation(session, 3)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]

    const config = resolveConfig(ConfigSchema({ pruneNotification: 'off' }))
    const result = await runCompact(runtimeFor(session, { config }), {
      topic: 'quiet',
      content: [
        { startId: handle(first), endId: handle(last), summary: 'first entry' },
        { startId: handle(first), endId: handle(last), summary: 'second entry' },
      ],
    }, session)

    // `off` shortens the sentence, not the answer: the `(from→to)` detail goes
    // away, the refusal the caller has to act on does not.
    expect(result.message).toBe('Compacted 3 nodes into b1. Skipped: entry 2: overlaps another entry in this call')
    expect(result.skipped).toHaveLength(1)
  })

  it('throws when every entry is refused, naming each problem', async () => {
    const session = Session.create('execute-all-refused' as never)
    buildConversation(session, 3)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]

    await expect(compactTool(runtimeFor(session)).execute({
      topic: 'bad',
      content: [
        { startId: handle(first), endId: handle(last), summary: 'cites (b9)' },
        { startId: 'nope', endId: handle(last), summary: 'unknown handle' },
      ],
    }, exec(session))).rejects.toThrow(
      'no compaction was applied: entry 1: (b9) is not inside the selected range; '
      + 'entry 2: "nope" is not a target id; copy handles verbatim from compact_targets',
    )
  })

  it('refuses a summary that cites one block twice and accepts the same range once', async () => {
    const session = Session.create('execute-duplicated' as never)
    buildConversation(session, 3)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]
    const rt = runtimeFor(session)

    await compactTool(rt).execute({ topic: 'base', content: [{ startId: handle(first), endId: handle(last), summary: 'base summary' }] }, exec(session))
    const block = fold(session).blocks[0]
    expect(block?.id).toBe('b1')

    // Re-compact the block's own node; citing it twice would inline the body twice.
    const duplicate = { topic: 'again', content: [{ startId: handle(block?.seq ?? 0), endId: handle(block?.seq ?? 0), summary: 'see (b1) and again (b1)' }] }
    await expect(compactTool(rt).execute(duplicate, exec(session))).rejects.toThrow(
      'no compaction was applied: entry 1: (b1) is cited more than once; a block is inlined at its first mention only',
    )

    // Same range, one mention: accepted, so the refusal above is about the repeat.
    const accepted = await runCompact(rt,
      { topic: 'again', content: [{ startId: handle(block?.seq ?? 0), endId: handle(block?.seq ?? 0), summary: 'folded (b1) into this one' }] },
      session,
    )
    expect(accepted.blocks[0]?.id).toBe('b2')
    // A single mention inlines the cited block's body and leaves no placeholder.
    expect(checkpointTexts(session)[1]).toContain('folded base summary into this one')
    expect(checkpointTexts(session)[1]).not.toContain('(b1)')
  })
})

describe('compact execute — alias re-stamping', () => {
  it('reports the alias the live projection records when the plan drifted', async () => {
    const session = Session.create('execute-restamp' as never)
    buildConversation(session, 3)
    const [u1, , r1, u2, , r2, u3, , r3] = nodes(session) as number[]

    // Two real blocks first, so the live projection holds b1 and b2.
    await compactTool(runtimeFor(session)).execute({ topic: 'one', content: [{ startId: handle(u1 as number), endId: handle(r1 as number), summary: 'one' }] }, exec(session))
    await compactTool(runtimeFor(session)).execute({ topic: 'two', content: [{ startId: handle(u2 as number), endId: handle(r2 as number), summary: 'two' }] }, exec(session))
    expect(fold(session).blocks.map((item) => item.id)).toEqual(['b1', 'b2'])

    // The runtime's projection lags by one block for the reads that plan the
    // alias, then reports live at re-stamp time — exactly the drift the branch
    // exists for. The optimistic plan is therefore b2; the log will hold b3.
    const probe = { calls: 0, laggedBlocks: -1 }
    const drifted = runtimeFor(session, { stateOf: laggingStateOf(session, 2, probe) })
    const result = await runCompact(drifted,
      { topic: 'three', content: [{ startId: handle(u3 as number), endId: handle(r3 as number), summary: 'three' }] },
      session,
    )

    // The plan really did see a projection missing the newest block, so the alias
    // it baked into the summary was b2 while the log would record b3.
    expect(probe.laggedBlocks).toBe(1)
    expect(probe.calls).toBeGreaterThanOrEqual(3)

    const projected = fold(session)
    expect(projected.blocks.map((item) => item.id)).toEqual(['b1', 'b2', 'b3'])
    // The tool, the durable marker and the projection all name the same block.
    expect(result.blocks[0]?.id).toBe('b3')
    expect(result.blocks[0]?.id).not.toBe('b2')
    expect(projected.blocks[2]?.id).toBe(result.blocks[0]?.id)
    expect(checkpointTexts(session)[2]).toContain('<dcp-block-id>b3</dcp-block-id>')
    expect(checkpointTexts(session)[2]).not.toContain('<dcp-block-id>b2</dcp-block-id>')
  })

  it('applies a two-entry batch with consecutive aliases', async () => {
    const session = Session.create('execute-batch' as never)
    buildConversation(session, 4)
    const [u1, , r1, u2, , r2] = nodes(session) as number[]

    const result = await runCompact(runtimeFor(session), {
      topic: 'batch',
      content: [
        { startId: handle(u1 as number), endId: handle(r1 as number), summary: 'first batch entry' },
        { startId: handle(u2 as number), endId: handle(r2 as number), summary: 'second batch entry' },
      ],
    }, session)

    // The second entry commits after the first one has already rewritten the surface.
    expect(result.blocks.map((item) => item.id)).toEqual(['b1', 'b2'])
    expect(result.skipped).toEqual([])
    expect(fold(session).blocks.map((item) => item.id)).toEqual(['b1', 'b2'])
    expect(checkpointTexts(session)[0]).toContain('first batch entry')
    expect(checkpointTexts(session)[1]).toContain('second batch entry')
  })
})

describe('compact execute — protected bodies', () => {
  it('appends a protected tool body to the stored summary and keeps the panel copy clean', async () => {
    const session = Session.create('execute-protected' as never)
    buildConversation(session, 2, (index) => (index === 0
      ? { name: 'subagent', resultText: 'started subagent ab12' }
      : {}))
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]

    await compactTool(runtimeFor(session)).execute(
      { topic: 'protected', content: [{ startId: handle(first), endId: handle(last), summary: 'Summarised the round.' }] },
      exec(session),
    )

    // The child's handle survives the compression, because it is an ADDRESS.
    const stored = checkpointTexts(session)[0] ?? ''
    expect(stored).toContain('The following protected tool outputs were part of this conversation section:')
    expect(stored).toContain('started subagent ab12')
    expect(stored).toContain('Summarised the round.')
    // The panel copy is the model's summary alone: the appendix is framing.
    expect(summaryTexts(session)[0]).toBe('Summarised the round.')
  })

  it('keeps a body whose declared path is protected, as the setting promises', async () => {
    const declaredPaths = (_name: string, args: unknown): readonly string[] => {
      const path = (args as { path?: unknown } | undefined)?.path
      return typeof path === 'string' ? [path] : []
    }
    const config = resolveConfig(ConfigSchema({ protectedFilePatterns: ['f0.ts'] }))

    const session = Session.create('execute-protected-path' as never)
    buildConversation(session, 2)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]
    await compactTool(runtimeFor(session, { config, declaredPaths })).execute(
      { topic: 'path-protected', content: [{ startId: handle(first), endId: handle(last), summary: 'Summarised.' }] },
      exec(session),
    )

    // `protectedFilePatterns` used to reach deduplication only, so a matching body
    // still vanished from the model's history the moment a compaction covered it.
    const stored = checkpointTexts(session)[0] ?? ''
    expect(stored).toContain('The following protected tool outputs were part of this conversation section:')
    expect(stored).toContain('contents of f0.ts')

    // Control: the same span without the pattern drops the body.
    const control = Session.create('execute-unprotected-path' as never)
    buildConversation(control, 2)
    const seqs = nodes(control)
    await compactTool(runtimeFor(control, { declaredPaths })).execute(
      {
        topic: 'unprotected',
        content: [{ startId: handle(seqs[0] as number), endId: handle(seqs[seqs.length - 1] as number), summary: 'Summarised.' }],
      },
      exec(control),
    )
    expect(checkpointTexts(control)[0] ?? '').not.toContain('protected tool outputs')
  })

  it('keeps user messages verbatim only when protectUserMessages is on', async () => {
    const session = Session.create('execute-protect-user' as never)
    buildConversation(session, 2)
    // The span covers both rounds, so both user messages are inside it.
    const seqs = nodes(session)
    const first = seqs[0] as number
    const last = seqs[seqs.length - 1] as number
    const config = resolveConfig(ConfigSchema({ compaction: { protectUserMessages: true } }))

    await compactTool(runtimeFor(session, { config })).execute(
      { topic: 'users', content: [{ startId: handle(first), endId: handle(last), summary: 'compressed' }] },
      exec(session),
    )

    const stored = checkpointTexts(session)[0] ?? ''
    expect(stored).toContain('User messages preserved verbatim:')
    expect(stored).toContain('request 0')
    expect(stored).toContain('request 1')
  })
})

describe('compact execute — refusals', () => {
  it('leaves a subagent session alone unless allowSubAgents is on', async () => {
    // The switch the settings card offers has to actually switch. This is the same
    // predicate the automatic pass and the nudge listener consult, reached through
    // the one path that needs no mounted store.
    const session = Session.create('execute-subagent' as never, undefined, {
      version: 4,
      id: 'execute-subagent',
      createdAt: Date.now(),
      isSeeded: false,
      delegationDepth: 1,
    } as never)
    buildConversation(session, 2)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]
    const call = { topic: 'child', content: [{ startId: handle(first), endId: handle(last), summary: 'compressed' }] }

    await expect(compactTool(runtimeFor(session, { config: resolveConfig(ConfigSchema({})) })).execute(
      call,
      exec(session),
    )).rejects.toThrow('does not run in subagent sessions')

    // …and `experimental.allowSubAgents: true` is what turns the refusal off.
    await compactTool(runtimeFor(session, {
      config: resolveConfig(ConfigSchema({ experimental: { allowSubAgents: true } })),
    })).execute(call, exec(session))
    expect(checkpointTexts(session).length).toBeGreaterThan(0)
  })

  it('refuses when the deployment denies compaction', async () => {
    const session = Session.create('execute-deny' as never)
    buildConversation(session, 2)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]
    const config = resolveConfig(ConfigSchema({ compaction: { permission: 'deny' } }))

    await expect(compactTool(runtimeFor(session, { config })).execute(
      { topic: 'denied', content: [{ startId: handle(first), endId: handle(last), summary: 'x' }] },
      exec(session),
    )).rejects.toThrow('compaction is denied by configuration')
  })

  it('refuses a call manual mode did not authorise, and accepts one it did', async () => {
    const session = Session.create('execute-manual' as never)
    buildConversation(session, 3)
    const [u1, , r1, u2, , r2] = nodes(session) as number[]
    const config = resolveConfig(ConfigSchema({ manualMode: { enabled: true } }))
    const rt = runtimeFor(session, { config })

    await expect(compactTool(rt).execute(
      { topic: 'unasked', content: [{ startId: handle(u1 as number), endId: handle(r1 as number), summary: 'x' }] },
      exec(session),
    )).rejects.toThrow('manual mode is on: compaction runs only after an explicit /dcp-compact request')

    // An explicit request is a real `command/run` event the projection folds.
    session.append('command/run', { commandId: 'cmd-1', name: 'dcp-compact', source: { kind: 'user' } } as never)
    expect(fold(session).manualCommandId).toBe('cmd-1')

    const result = await runCompact(rt,
      { topic: 'asked', content: [{ startId: handle(u2 as number), endId: handle(r2 as number), summary: 'authorised' }] },
      session,
    )
    expect(result.blocks[0]?.id).toBe('b1')
    // The transaction records which command paid for it.
    const start = session.snapshotEvents().find((event) => event.type === 'compaction/start')
    expect((start?.data as { sourceCommandId?: string }).sourceCommandId).toBe('cmd-1')
  })

  it('refuses while another compaction is live', async () => {
    const session = Session.create('execute-live' as never)
    buildConversation(session, 2)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]
    const state = fold(session)

    await expect(compactTool(runtimeFor(session, {
      stateOf: () => ({ ...state, live: { compactionId: 'cp-live', turn: 1 } }),
    })).execute(
      { topic: 'concurrent', content: [{ startId: handle(first), endId: handle(last), summary: 'x' }] },
      exec(session),
    )).rejects.toThrow('another compaction is already running for this session')
  })
})

describe('approval seam', () => {
  it('fails closed when permission is ask and no approval service is mounted', async () => {
    const session = Session.create('approve-missing' as never)
    buildConversation(session, 2)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]
    const config = resolveConfig(ConfigSchema({ compaction: { permission: 'ask' } }))

    await expect(compactTool(runtimeFor(session, { config })).execute(
      { topic: 'ask', content: [{ startId: handle(first), endId: handle(last), summary: 'x' }] },
      exec(session),
    )).rejects.toThrow(/no approval service is mounted and this call has no owning agent/)
    // Nothing was written: failing closed means failing before the transaction.
    expect(fold(session).blocks).toHaveLength(0)
  })

  it('propagates every outcome that is not allowed-once', async () => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
      const session = Session.create(`approve-${outcome}` as never)
      buildConversation(session, 2)
      const [first, , last] = nodes(session) as [number, number, number, ...number[]]
      const config = resolveConfig(ConfigSchema({ compaction: { permission: 'ask' } }))
      const ctx = { get: (name: string) => (name === 'approval' ? { request: async () => outcome } : undefined) }

      await expect(compactTool(runtimeFor(session, { config, ctx })).execute(
        { topic: 'ask', content: [{ startId: handle(first), endId: handle(last), summary: 'x' }] },
        exec(session),
      )).rejects.toThrow(`compaction was not approved (${outcome})`)
      expect(fold(session).blocks).toHaveLength(0)
    }
  })

  it('compacts after allowed-once and passes the call identity to the seam', async () => {
    const session = Session.create('approve-allowed' as never)
    buildConversation(session, 2)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]
    const config = resolveConfig(ConfigSchema({ compaction: { permission: 'ask' } }))
    const requests: Array<{ toolName?: string; callId?: string; reason?: string }> = []
    const ctx = { get: (name: string) => (name === 'approval' ? { request: async (request: never) => { requests.push(request as never); return 'allowed-once' } } : undefined) }

    const result = await runCompact(
      runtimeFor(session, { config, ctx }),
      { topic: 'ask', content: [{ startId: handle(first), endId: handle(last), summary: 'approved' }] },
      session,
      'call-42',
    )

    expect(result.blocks[0]?.id).toBe('b1')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.toolName).toBe('compact')
    expect(requests[0]?.callId).toBe('call-42')
    expect(requests[0]?.reason).toContain('conversation history')
  })
})

describe('compact_targets and recall execute', () => {
  it('lists existing summaries, handles and prices', async () => {
    const session = Session.create('targets-execute' as never)
    buildConversation(session, 3)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]
    await compactTool(runtimeFor(session)).execute(
      { topic: 'listed', content: [{ startId: handle(first), endId: handle(last), summary: 'listed' }] },
      exec(session),
    )

    const rt = runtimeFor(session, { priceOf: () => () => 100 })
    const value = await runTargets(rt, session)

    expect(value.targets).toBeGreaterThan(0)
    expect(value.text).toContain('Existing summaries (reference one as (bN) when your range covers it):')
    expect(value.text).toContain('b1  spans seq')
    expect(value.text).toContain('Conversation handles (oldest first):')
    // The listing prices what the model is about to compress.
    expect(value.text).toContain('~100tok')
  })

  it('returns a block body, filters it by query, and names the known blocks otherwise', async () => {
    const session = Session.create('recall-execute' as never)
    buildConversation(session, 3)
    const [first, , last] = nodes(session) as [number, number, number, ...number[]]
    await compactTool(runtimeFor(session)).execute(
      { topic: 'recallable', content: [{ startId: handle(first), endId: handle(last), summary: 'recallable' }] },
      exec(session),
    )
    const rt = runtimeFor(session)

    const full = await runRecall(rt, { block: 'b1' }, session)
    expect(full.found).toBe(true)
    expect(full.nodes).toBe(3)
    expect(full.text).toContain('request 0')
    expect(full.text).toContain('contents of f0.ts')

    // The query path returns only the matching node's lines.
    const filtered = await runRecall(rt, { block: 'b1', query: 'request 0' }, session)
    expect(filtered.found).toBe(true)
    expect(filtered.text).toContain('request 0')
    expect(filtered.text).not.toContain('contents of f0.ts')

    const unknown = await runRecall(rt, { block: 'b7' }, session)
    expect(unknown.found).toBe(false)
    expect(unknown.text).toContain('Unknown block "b7"')
    expect(unknown.text).toContain('Known blocks: b1.')
  })

  it('reads back a tool output that deduplication pruned, by its node handle', async () => {
    // Deduplication replaces an older repeated output with a placeholder and
    // that node is inside no compaction block, so `recall bN` could never reach
    // it: the content was removed with no way back. The original is still in the
    // log and the replacement chain still cites it, so the node handle is all
    // that was missing.
    const session = Session.create('recall-pruned' as never)
    pushRound(session, 0, { args: '{"path":"same.ts"}', resultText: 'the original body' })
    pushRound(session, 1, { args: '{"path":"same.ts"}', resultText: 'the newer body' })

    // Turn 9 against calls made in turn 1: far past turn protection, so the
    // pass actually reaches them (the same clock the strategy tests use).
    const pass = runStrategies(session, {
      config: resolveConfig(ConfigSchema({})),
      stateOf: () => ({ ...fold(session), turn: 9 }),
      priceOf: () => () => 7,
      declaredPaths: () => [],
    })
    expect(pass.pruned).toBe(1)

    const prunedSeq = nodes(session).find((seq) => isPruned(session, seq))
    expect(prunedSeq).toBeDefined()
    const rt = runtimeFor(session)

    const value = await runRecall(rt, { block: handle(prunedSeq as number) }, session)
    expect(value.found).toBe(true)
    expect(value.text).toContain('the original body')
    // The surviving repetition is a different node and must not be what came back.
    expect(value.text).not.toContain('the newer body')
    expect(value.text).toContain(`n${prunedSeq} · original content of a pruned node`)
  })

  it('names the pruned nodes when a node handle is not pruned, and filters one by query', async () => {
    const session = Session.create('recall-pruned-errors' as never)
    pushRound(session, 0, { args: '{"path":"same.ts"}', resultText: 'the original body' })
    pushRound(session, 1, { args: '{"path":"same.ts"}', resultText: 'the newer body' })
    runStrategies(session, {
      config: resolveConfig(ConfigSchema({})),
      stateOf: () => ({ ...fold(session), turn: 9 }),
      priceOf: () => () => 7,
      declaredPaths: () => [],
    })
    const rt = runtimeFor(session)
    const prunedSeq = nodes(session).find((seq) => isPruned(session, seq)) as number

    // A surface node that lost nothing must say so, not answer "no content".
    const intact = nodes(session).find((seq) => !isPruned(session, seq)) as number
    const notPruned = await runRecall(rt, { block: handle(intact) }, session)
    expect(notPruned.found).toBe(false)
    expect(notPruned.text).toContain(`n${intact} is not a pruned node.`)
    // The failure is the listing: a pruned node has no other way to be named.
    expect(notPruned.text).toContain(`Pruned nodes: n${prunedSeq}.`)

    const filtered = await runRecall(rt, { block: handle(prunedSeq), query: 'original' }, session)
    expect(filtered.found).toBe(true)
    expect(filtered.text).toContain('the original body')

    const noMatch = await runRecall(rt, { block: handle(prunedSeq), query: 'absent-line' }, session)
    expect(noMatch.found).toBe(false)
    expect(noMatch.text).toContain('contains no line matching')
  })

  it('refuses every tool that needs an owning agent', async () => {
    const session = Session.create('no-agent' as never)
    buildConversation(session, 2)
    const rt = runtimeFor(session)
    const noAgent = {} as never

    await expect(compactTool(rt).execute({ topic: 'x', content: [] }, noAgent)).rejects.toThrow('compact requires an owning agent session')
    await expect(targetsTool(rt).execute({}, noAgent)).rejects.toThrow('compact_targets requires an owning agent session')
    await expect(recallTool(rt).execute({ block: 'b1' }, noAgent)).rejects.toThrow('recall requires an owning agent session')
  })
})

/* ── the automatic pass: the notice `announce` injects ─────────────────────── */

interface Captured {
  listeners: Array<{ event: string; handler: (session: Session, event: unknown) => void }>
  tools: string[]
  infos: string[]
  warns: string[]
  injected: Array<{ content: readonly { type: string; text?: string }[] }>
}

/** The token-meter stand-in: route price, heuristic price and estimator differ. */
function meterStub(heuristic: number, replacement: number): unknown {
  return {
    measure: (session: Session) => ({
      totalTokens: 500,
      surfaceTokens: 500,
      surfaceDeltaTokens: 0,
      logRevision: session.seq,
      baseline: { kind: 'none', tokens: 0 },
      nodes: [...session.surface.nodes].map((raw) => ({ seq: Number(raw), tokens: heuristic * 9, heuristicTokens: heuristic })),
    }),
    estimateMessage: () => replacement,
  }
}

/** A recording context with real fold semantics behind `stateOf`. */
function recordingContext(session: Session, services: Record<string, unknown>): { ctx: never; captured: Captured } {
  const captured: Captured = { listeners: [], tools: [], infos: [], warns: [], injected: [] }
  const disposer = (): void => {}
  const scope = {
    effect: (body: () => unknown) => { body(); return disposer },
    systemPrompt: { section: () => disposer },
    commands: { register: () => disposer },
  }
  const ctx = {
    effect: (body: () => unknown) => { body(); return disposer },
    on: (event: string, handler: (session: Session, event: unknown) => void) => {
      captured.listeners.push({ event, handler })
      return disposer
    },
    get: (name: string) => (name === 'agents' ? { get: (id: string) => (id === session.id ? { inject: (message: never) => { captured.injected.push(message as never) } } : undefined) } : services[name]),
    inject: (_deps: string[], body: (child: unknown) => unknown) => { body(scope); return Promise.resolve() },
    logger: {
      info: (...args: unknown[]) => captured.infos.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => captured.warns.push(args.map(String).join(' ')),
      error: () => {},
    },
    sessionProjections: { register: () => disposer, stateOf: (target: Session) => fold(target) },
    tools: { register: (definition: { name: string }) => { captured.tools.push(definition.name); return disposer }, get: () => undefined },
  }
  return { ctx: ctx as never, captured }
}

/** Append identical `read` pairs: one dedup signature each, one candidate each. */
function seedDuplicates(session: Session, pairs: number): void {
  session.append('turn/start', { turn: 1 })
  for (let index = 0; index < pairs * 2; index += 1) {
    const pair = Math.floor(index / 2)
    // Same NAME and ARGUMENTS per pair; the older call is the dedup candidate.
    pushRound(session, index, { args: JSON.stringify({ path: `duplicate-${pair}.ts` }), resultText: `identical body ${pair}` })
  }
}

/** Drive the plugin's own listeners exactly as the session's append path does. */
function fire(captured: Captured, session: Session, type: string, data: unknown): void {
  for (const { event, handler } of captured.listeners) {
    if (event === 'session/event') handler(session, Object.freeze({ type, seq: session.seq, time: Date.now(), data }))
  }
}

/** Let the queued strategy pass (microtask + mutex) finish. */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 20) })
}

describe('announce — the automatic pass notice', () => {
  it('states the reclaimed figure rather than the shadow price', async () => {
    const session = Session.create('announce-reclaimed' as never)
    seedDuplicates(session, 1)
    const { ctx, captured } = recordingContext(session, { tokenMeter: meterStub(100, 30) })
    apply(ctx, resolveConfig(ConfigSchema({})))

    // The pass runs on the turn AFTER the one it saw end.
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    fire(captured, session, 'turn/end', { turn: 1 })
    session.append('turn/start', { turn: 2 })
    fire(captured, session, 'turn/start', { turn: 2 })
    await flush()

    const prunes = session.snapshotEvents().filter((event) => event.type === 'compaction/prune')
    expect(prunes).toHaveLength(1)
    // The claim is the node's heuristic price — the value the meter's fold reads.
    expect((prunes[0]?.data as { shadowedTokenCount: number }).shadowedTokenCount).toBe(100)

    expect(captured.injected).toHaveLength(1)
    const notice = captured.injected[0]?.content.find((block) => block.type === 'text')?.text ?? ''
    // 100 − 30: the notice says what the surface lost, not what was priced.
    expect(notice).toBe('dsh-dcp pruned 1 superseded tool output (~70 tokens reclaimed).')
    expect(notice).not.toContain('~100')
  })

  it('pluralises and sums the reclaimed figure across rewrites', async () => {
    const session = Session.create('announce-sum' as never)
    seedDuplicates(session, 2)
    const { ctx, captured } = recordingContext(session, { tokenMeter: meterStub(100, 30) })
    apply(ctx, resolveConfig(ConfigSchema({})))

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    fire(captured, session, 'turn/end', { turn: 1 })
    session.append('turn/start', { turn: 2 })
    fire(captured, session, 'turn/start', { turn: 2 })
    await flush()

    expect(session.snapshotEvents().filter((event) => event.type === 'compaction/prune')).toHaveLength(2)
    const notice = captured.injected[0]?.content.find((block) => block.type === 'text')?.text ?? ''
    expect(notice).toBe('dsh-dcp pruned 2 superseded tool outputs (~140 tokens reclaimed).')
  })

  it('injects nothing when pruneNotification is off', async () => {
    const session = Session.create('announce-off' as never)
    seedDuplicates(session, 1)
    const { ctx, captured } = recordingContext(session, { tokenMeter: meterStub(100, 30) })
    apply(ctx, resolveConfig(ConfigSchema({ pruneNotification: 'off' })))

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    fire(captured, session, 'turn/end', { turn: 1 })
    session.append('turn/start', { turn: 2 })
    fire(captured, session, 'turn/start', { turn: 2 })
    await flush()

    // The rewrite still happens; only the model-facing line is suppressed.
    expect(session.snapshotEvents().filter((event) => event.type === 'compaction/prune')).toHaveLength(1)
    expect(captured.injected).toHaveLength(0)
  })
})
