/**
 * Behaviour tests for the action verbs, the nudge policy, the configuration
 * guard, and the prompt store.
 *
 * @module dsh-dcp/tests/behaviour
 */
import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { applyDcpEvent } from '../src/projection.ts'
import { commitCompression } from '../src/transaction.ts'
import { initialDcpState } from '../src/types.ts'
import type { DcpState } from '../src/types.ts'
import { wrapSummary } from '../src/placeholders.ts'
import { manualFor, nudgeVerdict } from '../src/nudges.ts'
import { strategiesAllowed } from '../src/strategies/index.ts'
import type { Pressure } from '../src/nudges.ts'
import { findBlock, recallBlock } from '../src/recall.ts'
import { dcpWireView } from '../src/projection.ts'
import { DCP_STATE_VERSION, dcpStateSchema } from '../src/projection.ts'
import { validateConfigKeys, resolveLimit } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { BUILT_IN, NUDGE_PREFIX, PROMPT_NAMES, loadPrompts } from '../src/prompts/index.ts'
import { PRUNE_OUTPUT_PLACEHOLDER } from '../src/types.ts'

const SOURCE = { provider: 'test', model: 'test' }

/** Build a three-round conversation and commit one compaction over round 2. */
function committed(session: Session): { state: DcpState; startSeq: number; endSeq: number } {
  let state = initialDcpState()
  const feed = (event: Parameters<typeof applyDcpEvent>[1]): void => {
    state = applyDcpEvent(state, event)
  }
  feed(session.append('turn/start', { turn: 1 }))
  for (let index = 0; index < 3; index += 1) {
    const callId = `call-${index}` as unknown as ToolCallId
    feed(session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: `request ${index}` }], source: { kind: 'user' } }),
      { surfaceOp: 'append' }))
    feed(session.append('assistant/message', {
      turn: 1,
      step: index + 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: `{"path":"f${index}.ts"}` } as never],
        source: SOURCE,
      }),
      stream: [],
    }, { surfaceOp: 'append' }))
    feed(session.append('tool/call', { turn: 1, step: index + 1, callId: callId as never, name: 'read', arguments: `{"path":"f${index}.ts"}` }))
    feed(session.append('tool/result', {
      turn: 1,
      step: index + 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: `contents of f${index}.ts` }], isError: false }),
    }, { surfaceOp: 'append' }))
  }

  const nodes = [...session.surface.nodes].map(Number)
  const startSeq = nodes[3] as number
  const endSeq = nodes[5] as number
  const outcome = commitCompression(session, {
    startSeq,
    endSeq,
    summary: wrapSummary('b1', 'Round 2 read f1.ts.'),
    blockId: 'b1',
    consumedIds: [],
  }, { provider: 'test', model: 'test', shadowedTokens: 5 }, state.turn)
  expect(outcome.ok).toBe(true)
  for (const event of session.snapshotEvents()) state = applyDcpEvent(state, event)
  return { state, startSeq, endSeq }
}

/** Every model-visible text block. */
function texts(session: Session): string[] {
  return session.deriveMessages().flatMap((message) =>
    message.content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text))
}

describe('recall', () => {
  it('reads a compacted block original content back out of the log', () => {
    const session = Session.create('recall' as never)
    const { state } = committed(session)
    const block = state.blocks[0]
    expect(block).toBeDefined()
    const result = recallBlock(session, state, block as never)
    expect(result.found).toBe(true)
    expect(result.text).toContain('contents of f1.ts')
    expect(result.nodes).toBeGreaterThan(0)
  })

  it('leaves the surface untouched, unlike decompression', () => {
    const session = Session.create('recall-pure' as never)
    const { state } = committed(session)
    const before = [...session.surface.nodes].map(Number)
    const events = session.snapshotEvents().length
    recallBlock(session, state, state.blocks[0] as never)
    expect([...session.surface.nodes].map(Number)).toEqual(before)
    expect(session.snapshotEvents().length).toBe(events)
    expect(texts(session).some((item) => item.includes('Round 2 read f1.ts'))).toBe(true)
  })

  it('filters by query and reports a miss', () => {
    const session = Session.create('recall-query' as never)
    const { state } = committed(session)
    const hit = recallBlock(session, state, state.blocks[0] as never, 'f1.ts')
    expect(hit.found).toBe(true)
    const miss = recallBlock(session, state, state.blocks[0] as never, 'nothing-matches-this')
    expect(miss.found).toBe(false)
  })

  it('resolves unknown handles without throwing', () => {
    const session = Session.create('recall-unknown' as never)
    const { state } = committed(session)
    expect(findBlock(state, 'b9')).toBeUndefined()
    expect(findBlock(state, '1')).toBe(state.blocks[0])
  })
})

describe('nudge policy', () => {
  const base: Pressure = { current: 100, max: 50, min: 10 }

  /** The verdict for one reading, with the boundary flag spelled out. */
  const verdict = (session: Session, config: Config, state: DcpState, pressure: Pressure, boundary: boolean) =>
    nudgeVerdict(session, config, state, pressure, boundary)

  it('fires the context-limit nudge above the upper threshold', () => {
    const session = Session.create('nudge-max' as never)
    committed(session)
    expect(verdict(session, {}, initialDcpState(), base, false).kind).toBe('context-limit')
  })

  it('stays silent below the lower threshold', () => {
    const session = Session.create('nudge-min' as never)
    committed(session)
    expect(verdict(session, {}, initialDcpState(), { current: 5, max: 50, min: 10 }, true).kind).toBeNull()
  })

  it('fires the turn nudge at a turn boundary inside the band', () => {
    // The nudge the panel could never reach: an `assistant/message` always leaves
    // an assistant node last, so a check that only looked at the newest surface
    // node reported "mid-turn" forever.
    const session = Session.create('nudge-turn' as never)
    committed(session)
    const inside: Pressure = { current: 20, max: 50, min: 10 }
    expect(verdict(session, {}, initialDcpState(), inside, true).kind).toBe('turn')
  })

  it('says why it stayed quiet mid-turn', () => {
    const session = Session.create('nudge-mid' as never)
    committed(session)
    const inside: Pressure = { current: 20, max: 50, min: 10 }
    expect(verdict(session, {}, initialDcpState(), inside, false).reason).toBe('mid-turn')
  })

  it('respects the injection frequency', () => {
    const session = Session.create('nudge-spacing' as never)
    committed(session)
    const lastSeq = Math.max(...[...session.surface.nodes].map(Number))
    const state = { ...initialDcpState(), lastNudgeSeq: lastSeq }
    expect(verdict(session, {}, state, base, false).kind).toBeNull()
  })

  it('is suppressed in manual mode', () => {
    const session = Session.create('nudge-manual' as never)
    committed(session)
    expect(verdict(session, { manualMode: { enabled: true } }, initialDcpState(), base, false).kind).toBeNull()
    expect(manualFor({ manualMode: { enabled: true } })).toBe(true)
    expect(manualFor({})).toBe(false)
  })

  it('resolves percentage thresholds against the routed window', () => {
    expect(resolveLimit('50%', 1000)).toBe(500)
    expect(resolveLimit('50%', undefined)).toBeUndefined()
    expect(resolveLimit(123, 1000)).toBe(123)
    expect(resolveLimit('250%', 1000)).toBe(1000)
  })

  it('still fires the strong nudge when only the upper threshold resolves', () => {
    // "You are over the limit" is complete without a lower bound.
    const session = Session.create('nudge-one-sided-high' as never)
    committed(session)
    const over: Pressure = { current: 200_000, max: 100_000 }
    expect(verdict(session, {}, initialDcpState(), over, false).kind).toBe('context-limit')
  })

  it('refuses the turn nudge when the lower threshold does not resolve', () => {
    // The everyday case: `minContextLimit` is a percentage and the routed model
    // has no window yet. The band would silently become (-inf, max], so a
    // 200-token session at its first turn boundary was told to consider
    // compacting. There is no band to speak of, so nothing is said.
    const session = Session.create('nudge-one-sided-low' as never)
    committed(session)
    const tiny: Pressure = { current: 200, max: 100_000 }
    const quiet = verdict(session, {}, initialDcpState(), tiny, true)
    expect(quiet.kind).toBeNull()
    expect(quiet.reason).toBe('no-thresholds')
  })

  it('refuses any band nudge when only the lower threshold resolves', () => {
    // No ceiling means no band either: the strong nudge cannot fire and the turn
    // nudge has no upper end, so the reading produces no reminder at all.
    const session = Session.create('nudge-one-sided-min' as never)
    committed(session)
    expect(verdict(session, {}, initialDcpState(), { current: 20, min: 10 }, true).reason).toBe('no-thresholds')
  })
})

describe('nudge anchor', () => {
  /** Fold a whole session from scratch, so the appended message is included. */
  const refold = (session: Session): DcpState => {
    let state = initialDcpState()
    for (const event of session.snapshotEvents()) state = applyDcpEvent(state, event)
    return state
  }

  const appendDcpMessage = (session: Session, text: string): number =>
    Number(session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-dcp', form: 'notice', summary: text },
    }), { surfaceOp: 'append' }).seq)

  it('is not moved by an ordinary notice', () => {
    // The shipped dedup pass announces itself with a message of exactly this
    // shape. It used to stamp `lastNudgeSeq`, so in a session whose strategy
    // reports every few turns the reminder was deferred forever by messages that
    // never asked for compaction.
    const session = Session.create('anchor-notice' as never)
    committed(session)
    appendDcpMessage(session, 'dsh-dcp pruned 3 superseded tool outputs (~415 tokens).')
    const state = refold(session)
    expect(state.notices).toBe(1)
    expect(state.lastNudgeSeq).toBeNull()
    // Above the strong threshold, and the real nudge is still due.
    const loud: Pressure = { current: 200_000, max: 100_000, min: 50_000 }
    expect(nudgeVerdict(session, {}, state, loud, false)).toEqual({ kind: 'context-limit', reason: 'due' })
  })

  it('is moved by a real nudge, which then holds the spacing', () => {
    const session = Session.create('anchor-nudge' as never)
    committed(session)
    const nudgeSeq = appendDcpMessage(session, BUILT_IN['turn-nudge'])
    const state = refold(session)
    expect(state.notices).toBe(1)
    expect(state.lastNudgeSeq).toBe(nudgeSeq)
    const loud: Pressure = { current: 200_000, max: 100_000, min: 50_000 }
    expect(nudgeVerdict(session, {}, state, loud, false).reason).toBe('spacing')
  })
})

describe('manual-mode command gate', () => {
  /** The log-only event `CommandRuntime` appends before a handler runs. */
  const commandRun = (session: Session, name: string): Parameters<typeof applyDcpEvent>[1] =>
    session.append('command/run', { commandId: 'cmd-1', name, args: '', source: { kind: 'user' } } as never)

  it('arms on /dcp-compact only, never on the host /compact', () => {
    const session = Session.create('manual-gate' as never)
    const armed = applyDcpEvent(initialDcpState(), commandRun(session, 'dcp-compact'))
    expect(armed.manualCommandId).toBe('cmd-1')

    // The host's `/compact` runs its own backend; letting it unlock DCP's
    // manual-mode gate would let one command authorise another's tool call.
    const untouched = applyDcpEvent(initialDcpState(), commandRun(session, 'compact'))
    expect(untouched.manualCommandId).toBeNull()
  })
})

describe('manual-mode unlock scope', () => {
  /** Hand-made events: the fold reads them without a full session around them. */
  const raw = (type: string, data: Record<string, unknown>): Parameters<typeof applyDcpEvent>[1] =>
    ({ type, data, seq: 1 }) as never

  /** A session whose user has just run `/dcp-compact`. */
  const armed = (): DcpState => {
    const started = applyDcpEvent(initialDcpState(), raw('turn/start', { turn: 1 }))
    return applyDcpEvent(started, raw('command/run', { commandId: 'cmd-1', name: 'dcp-compact', args: '' }))
  }

  /** The checkpoint a successful transaction writes to carry its summary. */
  const checkpoint = (): Parameters<typeof applyDcpEvent>[1] =>
    ({
      type: 'user/message',
      seq: 7,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      data: {
        content: [{ type: 'text', text: '[Compacted conversation section]\nRound 2 kept.' }],
        source: { kind: 'compact-checkpoint', compactionId: 'dcp-1', sourceCommandId: 'cmd-1' },
      },
    }) as never

  it('expires at the end of the turn it was granted for', () => {
    // Before: one `/dcp-compact` left `manualCommandId` set for the rest of the
    // session, so nine turns later the model could still compress on its own.
    let state = armed()
    expect(state.manualCommandId).toBe('cmd-1')
    state = applyDcpEvent(state, raw('turn/end', { turn: 1 }))
    expect(state.manualCommandId).toBeNull()
    state = applyDcpEvent(state, raw('turn/start', { turn: 9 }))
    expect(state.manualCommandId).toBeNull()
  })

  it('is spent by the compression it asked for', () => {
    const state = applyDcpEvent(armed(), checkpoint())
    expect(state.blocks).toHaveLength(1)
    expect(state.manualCommandId).toBeNull()
    expect(state.manualCallId).toBeNull()
  })

  it('is spent by a failed attempt, even one whose call cannot be parsed', () => {
    let state = armed()
    // No usable entries: `execute` throws before any transaction, and the fold
    // still has to be able to tell that this call spent the request.
    state = applyDcpEvent(state, raw('tool/call', {
      turn: 1, callId: 'call-1', name: 'compact', arguments: '{"content":[]}',
    }))
    expect(state.manualCallId).toBe('call-1')
    state = applyDcpEvent(state, raw('tool/result', { message: { toolCallId: 'call-1', isError: true } }))
    expect(state.manualCommandId).toBeNull()
    expect(state.manualCallId).toBeNull()
  })

  it('ignores a result that is not the authorised call', () => {
    let state = armed()
    state = applyDcpEvent(state, raw('tool/call', {
      turn: 1, callId: 'call-1', name: 'compact', arguments: '{"content":[{"messageId":"n1"}]}',
    }))
    state = applyDcpEvent(state, raw('tool/result', { message: { toolCallId: 'read-9', isError: true } }))
    expect(state.manualCommandId).toBe('cmd-1')
    state = applyDcpEvent(state, raw('tool/result', { message: { toolCallId: 'call-1', isError: false } }))
    expect(state.manualCommandId).toBe('cmd-1')
  })

  it('is spent by an aborted transaction that carried it, and only by that one', () => {
    const foreign = applyDcpEvent(armed(), raw('compaction/end', {
      compactionId: 'dcp-other', turn: 1, error: 'another producer failed',
    }))
    expect(foreign.manualCommandId).toBe('cmd-1')

    const aborted = applyDcpEvent(armed(), raw('compaction/end', {
      compactionId: 'dcp-1', sourceCommandId: 'cmd-1', turn: 1, error: 'the surface moved',
    }))
    expect(aborted.manualCommandId).toBeNull()
    expect(aborted.manualCallId).toBeNull()
  })

  it('is not spent by another producer closing cleanly', () => {
    const state = applyDcpEvent(armed(), raw('compaction/end', { compactionId: 'dcp-other', turn: 1 }))
    expect(state.manualCommandId).toBe('cmd-1')
  })
})

describe('orphaned compaction bracket', () => {
  /**
   * Hand-made events: the storage format refuses to append this sequence, but an
   * upgraded log can combine them (a `compaction/start` whose transaction never
   * closed), and the fold must not stay locked on it.
   */
  const raw = (type: string, data: Record<string, unknown>): Parameters<typeof applyDcpEvent>[1] =>
    ({ type, data, seq: 1 }) as never

  it('stops blocking once a turn event has crossed the bracket', () => {
    let state = applyDcpEvent(initialDcpState(), raw('turn/start', { turn: 1 }))
    state = applyDcpEvent(state, raw('compaction/start', { compactionId: 'dcp-1', turn: 1 }))
    expect(state.live).toEqual({ compactionId: 'dcp-1', turn: 1 })

    state = applyDcpEvent(state, raw('turn/end', { turn: 1 }))
    expect(state.live).toBeNull()

    state = applyDcpEvent(state, raw('turn/start', { turn: 2 }))
    expect(strategiesAllowed({}, state)).toBe(true)
  })

  it('keeps a bracket nothing has crossed', () => {
    const opened = applyDcpEvent(
      applyDcpEvent(initialDcpState(), raw('turn/start', { turn: 1 })),
      raw('compaction/start', { compactionId: 'dcp-1', turn: 1 }),
    )
    expect(strategiesAllowed({}, opened)).toBe(false)
  })
})

describe('panel projection view', () => {
  it('summarises the fold state and reuses the view until it changes', () => {
    const session = Session.create('wire' as never)
    const { state } = committed(session)
    const view = dcpWireView(state)
    expect(view.blocks).toHaveLength(1)
    expect(view.blocks[0]?.id).toBe('b1')
    expect(view.blocks[0]?.nodes).toBe(3)
    expect(view.blocks[0]?.tokens).toBeGreaterThanOrEqual(0)
    // Same state reference in, same view object out: the client republishes nothing.
    expect(dcpWireView(state)).toBe(view)
    expect(dcpWireView({ ...state, notices: state.notices + 1 })).not.toBe(view)
  })

  it('keeps one stable view per state when two sessions interleave', () => {
    // The cache used to be a single process-wide slot, so a second session's
    // read evicted the first one's entry and the client republished an unchanged
    // payload on every alternation.
    const session = Session.create('wire-stable' as never)
    const { state } = committed(session)
    const other = { ...initialDcpState(), notices: 3 }
    const first = dcpWireView(state)
    const second = dcpWireView(other)
    expect(second).not.toBe(first)
    expect(dcpWireView(state)).toBe(first)
    expect(dcpWireView(other)).toBe(second)
  })

  it('counts absorbed blocks, not blocks the user retired', () => {
    const block = (id: string, over: Partial<DcpState['blocks'][number]>): DcpState['blocks'][number] => ({
      id,
      compactionId: `dcp-${id}`,
      seq: 1,
      summarySeq: 1,
      spanStart: 1,
      spanEnd: 2,
      shadowed: [1, 2],
      tokens: 4,
      consumed: [],
      ...over,
    })
    const state: DcpState = {
      ...initialDcpState(),
      blocks: [block('b1', { consumedBy: 'b2' }), block('b2', { deactivatedByUser: true, rehydratedSeq: 8 })],
    }
    const view = dcpWireView(state)
    // Neither is active, but only one was absorbed; the other left because the
    // user asked for its content back.
    expect(view.blocks).toHaveLength(0)
    expect(view.absorbed).toBe(1)
  })
})

describe('state cache compatibility', () => {
  it('rejects a state written before the unlock and anchor shape changed', () => {
    // The bump is what makes an older cache re-fold instead of seeding a fold
    // that cannot answer "is the unlock still live" or "when did we last nudge".
    expect(DCP_STATE_VERSION).toBe(9)
    const previous: Record<string, unknown> = { ...initialDcpState(), notices: 1 }
    delete previous['manualCallId']
    expect(dcpStateSchema.safeParse(previous).success).toBe(false)
    expect(dcpStateSchema.safeParse(initialDcpState()).success).toBe(true)
  })
})

describe('configuration guard', () => {
  it('rejects a misspelled setting instead of silently ignoring it', () => {
    expect(() => validateConfigKeys({ compaction: { modes: 'range' } })).toThrow(/unknown setting "compaction.modes"/)
    expect(() => validateConfigKeys({ stratgies: {} })).toThrow(/unknown setting "stratgies"/)
    expect(() => validateConfigKeys({ compaction: { permission: 'allow' } })).not.toThrow()
  })

  it('accepts an absent configuration', () => {
    expect(() => validateConfigKeys(undefined)).not.toThrow()
  })
})

describe('prompt store', () => {
  it('falls back to the built-in texts when overrides are disabled', () => {
    const loaded = loadPrompts(false, false)
    expect(loaded.text['compact']).toBe(BUILT_IN['compact'])
    expect(loaded.applied).toEqual([])
  })

  it('keeps every prompt name addressable', () => {
    const loaded = loadPrompts(false, false)
    for (const name of PROMPT_NAMES) {
      expect(loaded.text[name].length).toBeGreaterThan(20)
    }
  })
})

describe('nudge framing', () => {
  it('tells the model a nudge is not the user speaking', () => {
    // Every nudge is injected as a `user` message, so the text is the only place
    // that can say otherwise — `source.form` is UI-only. Without this a model
    // reads the reminder as the user interrupting and stops to answer.
    for (const name of ['context-limit-nudge', 'turn-nudge'] as const) {
      expect(BUILT_IN[name].startsWith(NUDGE_PREFIX), name).toBe(true)
    }
  })

  it('says both halves: it is automatic, and no reply is wanted', () => {
    expect(NUDGE_PREFIX).toContain('not a message from the user')
    expect(NUDGE_PREFIX).toContain('do not reply')
  })

  it('has no iteration nudge left to name', () => {
    // Removed with its setting: counting nodes since the last user message is
    // not evidence that anything should be compacted.
    expect(PROMPT_NAMES).not.toContain('iteration-nudge' as never)
  })
})

describe('removed settings', () => {
  it('explains each key that was deleted with its feature', () => {
    // Unknown keys are rejected anyway; the point is that a deployment still
    // carrying one is told what replaced it instead of "unknown setting".
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ compaction: { mode: 'range' } }, /compaction\.mode" was removed/],
      [{ compaction: { iterationNudgeThreshold: 15 } }, /iterationNudgeThreshold" was removed/],
      [{ compaction: { protectTags: false } }, /protectTags" was removed/],
      [{ compaction: { showCompression: true } }, /showCompression" was removed/],
      [{ commands: { enabled: true } }, /commands\.enabled" was removed/],
    ]
    for (const [raw, expected] of cases) {
      expect(() => validateConfigKeys(raw), JSON.stringify(raw)).toThrow(expected)
    }
  })

  it('names every stale key at once rather than one per edit', () => {
    expect(() => validateConfigKeys({ compaction: { mode: 'range', protectTags: true } }))
      .toThrow(/were removed/)
  })

  it('leaves a configuration that never had them alone', () => {
    expect(() => validateConfigKeys({ compaction: { nudgeFrequency: 5 }, manualMode: { enabled: true } }))
      .not.toThrow()
  })
})
