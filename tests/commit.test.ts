/**
 * Integration tests over a real `Session`.
 *
 * These are the acceptance tests for the write path: they build a realistic
 * conversation (assistant tool calls paired with their results), commit a DCP
 * compaction transaction against it, and assert the derived model history, the
 * surface, tool-pairing balance, and deterministic replay.
 *
 * @module dsh-dcp/tests/commit
 */
import { describe, expect, it } from 'vitest'
import { Session, foldSurface } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { applyDcpEvent } from '../src/projection.ts'
import { commitCompression } from '../src/transaction.ts'
import { recallBlock } from '../src/recall.ts'
import { compactTool } from '../src/index.ts'
import type { PluginRuntime } from '../src/index.ts'
import { SessionMutex } from '../src/runner.ts'
import { loadPrompts } from '../src/prompts/index.ts'
import { initialDcpState } from '../src/types.ts'
import type { DcpState } from '../src/types.ts'
import { wrapSummary } from '../src/placeholders.ts'

const SOURCE = { provider: 'test', model: 'test' }

/**
 * Build `rounds` of user → assistant(tool call) → tool result.
 * Surface nodes per round are user, assistant, result; the log-only tool/call
 * sits between the assistant message and its result.
 */
function buildConversation(session: Session, rounds: number): DcpState {
  let state = initialDcpState()
  const feed = (event: Parameters<typeof applyDcpEvent>[1]): void => {
    state = applyDcpEvent(state, event)
  }
  feed(session.append('turn/start', { turn: 1 }))
  for (let index = 0; index < rounds; index += 1) {
    const callId = `call-${index}` as unknown as import('@deepseek-ai/dsh-llm').ToolCallId
    feed(session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: `request ${index}` }], source: { kind: 'user' } }),
      { surfaceOp: 'append' }))
    feed(session.append('assistant/message', {
      turn: 1,
      step: index + 1,
      message: createAssistantMessage({
        content: [
          { type: 'text', text: `reading f${index}.ts` },
          { type: 'tool-call', id: callId, name: 'read', arguments: `{"path":"f${index}.ts"}` } as never,
        ],
        source: SOURCE,
      }),
      stream: [],
    }, { surfaceOp: 'append' }))
    feed(session.append('tool/call', { turn: 1, step: index + 1, callId, name: 'read', arguments: `{"path":"f${index}.ts"}` }))
    feed(session.append('tool/result', {
      turn: 1,
      step: index + 1,
      message: createToolResultMessage({
        callId: callId as never,
        content: [{ type: 'text', text: `contents of f${index}.ts` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }))
  }
  return state
}

/** Every model-visible text block, in order. */
function derivedText(session: Session): string[] {
  return session.deriveMessages().flatMap((message) =>
    message.content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text))
}

/** The current surface as plain numbers. */
function nodes(session: Session): number[] {
  return [...session.surface.nodes].map(Number)
}

describe('commitCompression', () => {
  it('replaces a balanced span with one checkpoint and keeps the rest verbatim', () => {
    const session = Session.create('commit-basic' as never)
    const state = buildConversation(session, 3)
    const before = nodes(session)
    // Round 2 = user, assistant, result; both edges are balanced.
    const startSeq = before[3] as number
    const endSeq = before[5] as number
    const outside = before.slice(6)

    const outcome = commitCompression(session, {
      startSeq,
      endSeq,
      summary: wrapSummary('b1', 'Everything about f1.ts.'),
      blockId: 'b1',
      consumedIds: [],
    }, { provider: 'test', model: 'test', shadowedTokens: 10 }, state.turn)

    expect(outcome.ok).toBe(true)
    const after = nodes(session)
    expect(after).toHaveLength(before.length - 2)
    expect(after).toContain(outcome.ok ? outcome.checkpointSeq : -1)

    const text = derivedText(session)
    expect(text.filter((item) => item.includes('Everything about f1.ts'))).toHaveLength(1)
    expect(text.some((item) => item.includes('request 1'))).toBe(false)
    expect(text.some((item) => item.includes('contents of f1.ts'))).toBe(false)
    // The first and last rounds survive untouched.
    expect(text.some((item) => item.includes('request 0'))).toBe(true)
    expect(text.some((item) => item.includes('contents of f2.ts'))).toBe(true)
    for (const seq of outside) expect(after).toContain(seq)
  })

  it('writes the seam-shaped bracket: start, summary, checkpoint, end', () => {
    const session = Session.create('commit-shape' as never)
    const state = buildConversation(session, 3)
    const before = nodes(session)
    const outcome = commitCompression(session, {
      startSeq: before[3] as number,
      endSeq: before[5] as number,
      summary: wrapSummary('b1', 'one round'),
      blockId: 'b1',
      consumedIds: [],
    }, { provider: 'p', model: 'm', shadowedTokens: 3 }, state.turn)
    expect(outcome.ok).toBe(true)

    const tail = session.snapshotEvents().slice(-4).map((event) => event.type)
    expect(tail).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  })

  it('replays to the same surface through the canonical fold', () => {
    const session = Session.create('commit-replay' as never)
    const state = buildConversation(session, 3)
    const before = nodes(session)
    commitCompression(session, {
      startSeq: before[3] as number,
      endSeq: before[5] as number,
      summary: wrapSummary('b1', 'compressed'),
      blockId: 'b1',
      consumedIds: [],
    }, { provider: 'p', model: 'm', shadowedTokens: 3 }, state.turn)

    const replayed = foldSurface(session.snapshotEvents())
    expect(replayed.nodes.map(Number)).toEqual(nodes(session))
    expect(replayed.replacements).toHaveLength(1)
  })

  it('refuses a span that covers the system prompt', () => {
    const session = Session.create('commit-head' as never)
    session.append('turn/start', { turn: 1 })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('prompt') }, { surfaceOp: 'append' })
    session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' })

    const before = nodes(session)
    const outcome = commitCompression(session, {
      startSeq: before[0] as number,
      endSeq: before[1] as number,
      summary: 'nope',
      blockId: 'b1',
      consumedIds: [],
    }, { provider: 'p', model: 'm', shadowedTokens: 1 }, 1)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.failure.kind).toBe('system-head')
  })

  it('reports a stale handle instead of guessing', () => {
    const session = Session.create('commit-stale' as never)
    buildConversation(session, 2)
    const outcome = commitCompression(session, {
      startSeq: 9999,
      endSeq: 9999,
      summary: 'nope',
      blockId: 'b1',
      consumedIds: [],
    }, { provider: 'p', model: 'm', shadowedTokens: 1 }, 1)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.failure.kind).toBe('range-not-on-surface')
  })

  it('refuses an edge that would split a tool call from its result', () => {
    const session = Session.create('commit-split' as never)
    buildConversation(session, 2)
    const before = nodes(session)
    // before[2] is the tool result of round 1: cutting before it splits the pair.
    const outcome = commitCompression(session, {
      startSeq: before[2] as number,
      endSeq: before[5] as number,
      summary: 'nope',
      blockId: 'b1',
      consumedIds: [],
    }, { provider: 'p', model: 'm', shadowedTokens: 1 }, 1)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.failure.kind).toBe('unbalanced-start')
  })
})

describe('applyDcpEvent', () => {
  it('derives a block and marks an absorbed block as consumed', () => {
    const session = Session.create('fold' as never)
    let state = buildConversation(session, 3)
    const firstNodes = nodes(session)
    const first = commitCompression(session, {
      startSeq: firstNodes[3] as number,
      endSeq: firstNodes[5] as number,
      summary: wrapSummary('b1', 'first'),
      blockId: 'b1',
      consumedIds: [],
    }, { provider: 'p', model: 'm', shadowedTokens: 1 }, state.turn)
    expect(first.ok).toBe(true)
    for (const event of session.snapshotEvents()) state = applyDcpEvent(state, event)
    expect(state.blocks).toHaveLength(1)
    expect(state.blocks[0]?.id).toBe('b1')

    const secondNodes = nodes(session)
    const second = commitCompression(session, {
      startSeq: secondNodes[1] as number,
      endSeq: secondNodes[secondNodes.length - 1] as number,
      summary: wrapSummary('b2', 'second, absorbing (b1)'),
      blockId: 'b2',
      consumedIds: ['b1'],
    }, { provider: 'p', model: 'm', shadowedTokens: 2 }, state.turn)
    expect(second.ok).toBe(true)

    state = initialDcpState()
    for (const event of session.snapshotEvents()) state = applyDcpEvent(state, event)
    expect(state.blocks).toHaveLength(2)
    expect(state.blocks[0]?.consumedBy).toBe('b2')
    expect(state.blocks[1]?.consumed).toEqual(['b1'])
  })

  it('tracks the open turn and clears it at turn end', () => {
    const session = Session.create('fold-turn' as never)
    let state = initialDcpState()
    state = applyDcpEvent(state, session.append('turn/start', { turn: 4 }))
    expect(state.turn).toBe(4)
    state = applyDcpEvent(state, session.append('turn/end', { turn: 4, reason: { kind: 'completed' } as never }))
    expect(state.turn).toBeNull()
  })
})

/** Three rounds with the middle one committed to `b1`, plus the folded state. */
function committedBlock(id: string): { session: Session; state: DcpState } {
  const session = Session.create(id as never)
  const state = buildConversation(session, 3)
  const before = nodes(session)
  const outcome = commitCompression(session, {
    startSeq: before[3] as number,
    endSeq: before[5] as number,
    summary: wrapSummary('b1', 'Everything about f1.ts.'),
    blockId: 'b1',
    consumedIds: [],
  }, { provider: 'test', model: 'test', shadowedTokens: 10 }, state.turn)
  expect(outcome.ok).toBe(true)
  let folded = initialDcpState()
  for (const event of session.snapshotEvents()) folded = applyDcpEvent(folded, event)
  return { session, state: folded }
}

describe('recall paging', () => {
  it('says a page past the end is past the end, not empty', () => {
    const { session, state } = committedBlock('recall-past-end')
    const block = state.blocks[0]!
    const result = recallBlock(session, state, block, undefined, 100_000)
    expect(result.found).toBe(true)
    // The bare header used to come back with `truncated: false`, which is exactly
    // what "this block has no content" looks like.
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('past the end')
    expect(result.text).toContain('offset 0')
  })

  it('describes the body it actually rendered when the query is blank', () => {
    const { session, state } = committedBlock('recall-blank-query')
    const block = state.blocks[0]!
    const blank = recallBlock(session, state, block, '   ')
    expect(blank.text).not.toContain('filtered by')
    expect(blank.text).toContain('contents of f1.ts')

    const filtered = recallBlock(session, state, block, 'f1.ts')
    expect(filtered.text).toContain('filtered by "f1.ts"')
  })

  /**
   * Rewrite one `tool/result` in place `hops` times, the way the plugin does.
   *
   * The storage format lets a tool/result replacement change `message.content`
   * and nothing else, so every rewrite reuses the previous event's payload and
   * cites the node currently on the surface.
   */
  const chain = (id: string, hops: number): { session: Session; lastSeq: number } => {
    const session = Session.create(id as never)
    session.append('turn/start', { turn: 1 })
    const callId = 'call-chain' as never
    let event = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'the original needle' }], isError: false }),
    }, { surfaceOp: 'append' } as never)
    for (let hop = 1; hop <= hops; hop += 1) {
      const data = event.data as unknown as { message: Record<string, unknown> }
      const payload = {
        ...(event.data as unknown as Record<string, unknown>),
        message: { ...data.message, content: [{ type: 'text', text: `rewrite ${hop}` }] },
      }
      event = session.append('tool/result', payload as never, {
        surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
        sourceEventSeqs: [event.seq],
      } as never)
    }
    return { session, lastSeq: event.seq as number }
  }

  const stateFor = (lastSeq: number): DcpState => ({
    ...initialDcpState(),
    blocks: [{
      id: 'b1',
      compactionId: 'dcp-chain',
      seq: lastSeq,
      summarySeq: lastSeq,
      spanStart: lastSeq,
      spanEnd: lastSeq,
      shadowed: [lastSeq],
      consumed: [],
      tokens: 0,
    }],
  })

  it('reports a replacement chain too deep to walk instead of a confident miss', () => {
    const deepChain = chain('recall-chain', 18)
    const deepState = stateFor(deepChain.lastSeq)
    const deep = recallBlock(deepChain.session, deepState, deepState.blocks[0]!)
    // 18 rewrites are more than the walk follows: the body is an intermediate,
    // and the answer has to say so rather than look like a complete read.
    expect(deep.truncated).toBe(true)
    expect(deep.text).toContain('nest deeper')
    expect(deep.text).not.toContain('the original needle')

    // Control: a chain the walk can finish still reaches the original.
    const shallowChain = chain('recall-shallow', 2)
    const shallowState = stateFor(shallowChain.lastSeq)
    const walked = recallBlock(shallowChain.session, shallowState, shallowState.blocks[0]!)
    expect(walked.truncated).toBe(false)
    expect(walked.text).toContain('the original needle')
  })
})

describe('range failures', () => {
  it('names an inverted range instead of claiming the seq left the conversation', async () => {
    const session = Session.create('inverted-range' as never)
    const state = buildConversation(session, 3)
    const before = nodes(session)
    const startSeq = before[5] as number
    const endSeq = before[3] as number

    const outcome = commitCompression(session, {
      startSeq,
      endSeq,
      summary: wrapSummary('b1', 'reversed'),
      blockId: 'b1',
      consumedIds: [],
    }, { provider: 'test', model: 'test', shadowedTokens: 10 }, state.turn)
    expect(outcome.ok).toBe(false)
    // It used to be `range-not-on-surface`, which reads as "this seq is gone"
    // about a seq the model can still see.
    expect(outcome.ok ? undefined : outcome.failure.kind).toBe('inverted-range')

    // The model only sees the rendered failure, so that stays clear too.
    const runtime: PluginRuntime = {
      ctx: undefined as never,
      config: {},
      prompts: loadPrompts(false, false),
      mutex: new SessionMutex(),
      nudgeBlocks: new WeakMap(),
      stateOf: () => state,
      priceOf: () => () => undefined,
      estimateMessage: () => undefined,
      declaredPaths: () => [],
    }
    await expect(compactTool(runtime).execute(
      { topic: 'inverted', content: [{ startId: `n${startSeq}`, endId: `n${endSeq}`, summary: 'reversed' }] },
      { agent: { session } } as never,
    )).rejects.toThrow(/appears after/)
  })
})

describe('commitCompression failure matrix', () => {
  /** Build `rounds` of user → assistant(tool call) → tool result on `turn`. */
  const buildTurn = (session: Session, rounds: number, turn: number): void => {
    session.append('turn/start', { turn })
    for (let index = 0; index < rounds; index += 1) {
      const callId = `call-${turn}-${index}` as unknown as import('@deepseek-ai/dsh-llm').ToolCallId
      session.append('user/message',
        createUserMessage({ content: [{ type: 'text', text: `request ${turn}-${index}` }], source: { kind: 'user' } }),
        { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn,
        step: index + 1,
        message: createAssistantMessage({
          content: [
            { type: 'text', text: `reading f${index}.ts` },
            { type: 'tool-call', id: callId, name: 'read', arguments: `{"path":"f${index}.ts"}` } as never,
          ],
          source: SOURCE,
        }),
        stream: [],
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step: index + 1, callId, name: 'read', arguments: `{"path":"f${index}.ts"}` })
      session.append('tool/result', {
        turn,
        step: index + 1,
        message: createToolResultMessage({
          callId: callId as never,
          content: [{ type: 'text', text: `contents of f${index}.ts` }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
    }
  }

  /**
   * A session whose `append` throws for the event types `shouldFail` selects.
   *
   * Nothing else is intercepted (every other call is bound back to the real
   * session), so the test drives the real transaction and only the append under
   * test fails. `calls` records the event types the transaction attempted, in
   * order — that is how the compensation path is observed.
   */
  const failing = (
    session: Session,
    shouldFail: (type: string, calls: readonly string[]) => boolean,
  ): { session: Session; calls: string[] } => {
    const calls: string[] = []
    const wrapped = new Proxy(session, {
      get(target, prop, receiver) {
        if (prop === 'append') {
          return (type: string, ...rest: unknown[]): unknown => {
            calls.push(type)
            if (shouldFail(type, calls)) throw new Error(`injected ${type} failure`)
            return (target.append as unknown as (kind: string, ...args: unknown[]) => unknown)(type, ...rest)
          }
        }
        const value = Reflect.get(target, prop, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { session: wrapped, calls }
  }

  const entry = (startSeq: number, endSeq: number): Parameters<typeof commitCompression>[1] => ({
    startSeq,
    endSeq,
    summary: wrapSummary('b1', 'failure matrix summary'),
    blockId: 'b1',
    consumedIds: [],
  })
  const routing = { provider: 'test', model: 'test', shadowedTokens: 4 }

  /** The reason a refused transaction reports, asserted to be the aborted form. */
  const abortReason = (outcome: ReturnType<typeof commitCompression>): string => {
    if (outcome.ok) throw new Error('expected the transaction to fail')
    if (outcome.failure.kind !== 'aborted') throw new Error(`expected aborted, got ${outcome.failure.kind}`)
    return outcome.failure.reason
  }

  /** Every `compaction/end` in the log, in order. */
  const ends = (session: Session) => session.snapshotEvents().filter((event) => event.type === 'compaction/end')
  /** The DCP checkpoints in the log, in order. */
  const checkpoints = (session: Session) => session.snapshotEvents().filter((event) =>
    event.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint')

  it('refuses an end edge that would split a tool call from its result', () => {
    const session = Session.create('matrix-unbalanced-end' as never)
    buildConversation(session, 2)
    const before = nodes(session)
    const startSeq = before[3] as number
    const assistantSeq = before[4] as number
    const resultSeq = before[5] as number

    const outcome = commitCompression(session, entry(startSeq, assistantSeq), routing, 1)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? undefined : outcome.failure).toEqual({ kind: 'unbalanced-end', seq: assistantSeq })
    // Validation runs before the first append, so a refused range writes nothing.
    expect(session.snapshotEvents().some((event) => event.type === 'compaction/start')).toBe(false)

    // The teeth: the same start with the paired result as the end is accepted.
    expect(commitCompression(session, entry(startSeq, resultSeq), routing, 1).ok).toBe(true)
  })

  it('refuses a range that covers the system prompt, and still accepts one after it', () => {
    const session = Session.create('matrix-system-head' as never)
    session.append('turn/start', { turn: 1 })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('prompt') }, { surfaceOp: 'append' })
    session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' })
    const before = nodes(session)
    const headSeq = before[0] as number
    const userSeq = before[1] as number

    const refused = commitCompression(session, entry(headSeq, userSeq), routing, 1)
    expect(refused.ok).toBe(false)
    expect(refused.ok ? undefined : refused.failure.kind).toBe('system-head')
    expect(session.snapshotEvents().some((event) => event.type === 'compaction/start')).toBe(false)

    // The refusal is about covering node 0, not about a session having a prompt.
    const accepted = commitCompression(session, entry(userSeq, userSeq), routing, 1)
    expect(accepted.ok).toBe(true)
    expect(nodes(session)).toHaveLength(2)
  })

  it('closes a transaction whose summary append failed with exactly one error end', () => {
    const session = Session.create('matrix-summary-fail' as never)
    buildConversation(session, 2)
    const before = nodes(session)
    const { session: wrapped, calls } = failing(session, (type) => type === 'compaction/summary')

    const outcome = commitCompression(wrapped, entry(before[3] as number, before[5] as number), routing, 1)
    expect(outcome.ok).toBe(false)
    expect(abortReason(outcome)).toContain('injected compaction/summary failure')

    const starts = session.snapshotEvents().filter((event) => event.type === 'compaction/start')
    expect(starts).toHaveLength(1)
    expect(ends(session)).toHaveLength(1)
    // The closing marker carries the reason, and the same transaction identity.
    const closing = ends(session)[0]?.data as { compactionId?: string; error?: string }
    expect(closing.error).toContain('injected compaction/summary failure')
    expect(closing.compactionId).toBe((starts[0]?.data as { compactionId?: string }).compactionId)
    expect(outcome.compactionId).toBe(closing.compactionId)
    // The summary never landed, so no checkpoint did either, and the surface is
    // byte-for-byte what it was.
    expect(session.snapshotEvents().some((event) => event.type === 'compaction/summary')).toBe(false)
    expect(checkpoints(session)).toHaveLength(0)
    expect(calls).toEqual(['compaction/start', 'compaction/summary', 'compaction/end'])
    expect(nodes(session)).toEqual(before)
    expect(foldSurface(session.snapshotEvents()).nodes.map(Number)).toEqual(before)
  })

  it('writes no closing marker when the transaction never opened', () => {
    const session = Session.create('matrix-start-fail' as never)
    buildConversation(session, 2)
    const before = nodes(session)
    const { session: wrapped, calls } = failing(session, (type) => type === 'compaction/start')

    const outcome = commitCompression(wrapped, entry(before[3] as number, before[5] as number), routing, 1)
    expect(outcome.ok).toBe(false)
    expect(abortReason(outcome)).toContain('injected compaction/start failure')

    // `landed('compaction/start')` is false, so the catch must not invent an end
    // for a transaction that does not exist: that would be a second unmatched
    // marker rather than a closed one.
    expect(calls).toEqual(['compaction/start'])
    expect(session.snapshotEvents().some((event) => event.type === 'compaction/start')).toBe(false)
    expect(ends(session)).toHaveLength(0)
    expect(nodes(session)).toEqual(before)
  })

  it('never writes a second end when the first closing append fails', () => {
    const session = Session.create('matrix-end-retry' as never)
    buildConversation(session, 2)
    let closingAttempts = 0
    const { session: wrapped, calls } = failing(session, (type) => {
      if (type !== 'compaction/end') return false
      closingAttempts += 1
      return closingAttempts === 1
    })

    const outcome = commitCompression(wrapped, entry(nodes(session)[3] as number, nodes(session)[5] as number), routing, 1)
    expect(outcome.ok).toBe(false)
    expect(abortReason(outcome)).toContain('injected compaction/end failure')

    // Four appends plus the best-effort retry: the retry is the only end that
    // landed, and a second one would make the session unloadable.
    expect(calls).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end', 'compaction/end'])
    expect(ends(session)).toHaveLength(1)
    expect((ends(session)[0]?.data as { error?: string }).error).toContain('injected compaction/end failure')
    // The checkpoint did land, so the log still folds to a surface that starts
    // with the summary and carries one closing marker.
    expect(checkpoints(session)).toHaveLength(1)
    expect(foldSurface(session.snapshotEvents()).nodes.length).toBeGreaterThan(0)
  })

  it('still commits a range that spans two turns when both edges are legal', () => {
    const session = Session.create('matrix-cross-turn' as never)
    buildTurn(session, 2, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    buildTurn(session, 2, 2)
    const before = nodes(session)

    // user1 (turn 1) … result2 (turn 2): a completed pair on each end, so the
    // range crosses the turn boundary without splitting anything.
    const outcome = commitCompression(session, entry(before[3] as number, before[8] as number), routing, 2)
    expect(outcome.ok).toBe(true)
    expect(outcome.ok ? outcome.shadowed : []).toEqual(before.slice(3, 9))
    expect(nodes(session)).toHaveLength(before.length - 5)
    expect(foldSurface(session.snapshotEvents()).nodes.map(Number)).toEqual(nodes(session))
  })

  it('records a standalone transaction outside a turn with turn null', () => {
    const session = Session.create('matrix-standalone' as never)
    buildConversation(session, 2)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    const before = nodes(session)

    // The log decides the owner: with no open turn the seam's standalone form
    // records `null`, whatever the caller believed. (A `user/message`
    // replacement has no open-turn requirement; only `tool/result` does.)
    const outcome = commitCompression(session, entry(before[3] as number, before[5] as number), routing, 1)
    expect(outcome.ok).toBe(true)
    const start = session.snapshotEvents().filter((event) => event.type === 'compaction/start').at(-1)
    const closing = ends(session).at(-1)
    expect((start?.data as { turn?: number | null }).turn).toBeNull()
    expect((closing?.data as { turn?: number | null }).turn).toBeNull()
    expect(checkpoints(session)).toHaveLength(1)
  })
})
