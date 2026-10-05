/**
 * Target-map and range-resolver regression tests.
 *
 * `compact_targets` prints one line per surface node, and the model picks two
 * handles from that listing. Everything the line carries is produced here: the
 * `n<seq>` handle, the `<`/`>` cut markers, the preview, and the token price.
 * The resolver then has to accept what the listing promised — a range is
 * snapped outward to the nearest legal cuts rather than refused for a
 * guessable edge — and refuse only what cannot be cut at all (the system head,
 * an open step at the tail, a handle that is gone).
 *
 * `src/boundaries.ts` had no test importing it before this file, so these tests
 * pin both halves: the shape of the listing, and the resolver's four answers
 * (resolved, snapped, refused with a named problem, and the empty surface).
 *
 * @module dsh-dcp/tests/boundaries
 */
import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MAX_TARGETS, TARGET_TAIL, describeProblem, enumerateTargets, resolveRange } from '../src/boundaries.ts'
import type { RangeProblem } from '../src/boundaries.ts'
import type { DcpBlockState } from '../src/types.ts'

const SOURCE = { provider: 'test', model: 'test' }

/** The listing is one line per node; a preview wider than this is truncated. */
const PREVIEW_CHARS = 72

/**
 * Build `rounds` of user → assistant(tool call) → tool result on `turn`.
 * Surface nodes per round are user, assistant, result; the log-only `tool/call`
 * sits between the assistant message and its result.
 */
function buildConversation(session: Session, rounds: number, turn = 1): void {
  session.append('turn/start', { turn })
  for (let index = 0; index < rounds; index += 1) {
    const callId = `call-${turn}-${index}` as unknown as ToolCallId
    session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: `request ${index}` }], source: { kind: 'user' } }),
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

/** The current surface as plain numbers. */
function nodes(session: Session): number[] {
  return [...session.surface.nodes].map(Number)
}

/** One element by index, failing loudly instead of yielding `undefined`. */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`no element at index ${index} (length ${list.length})`)
  return value
}

/** One hand-built block, so the listing's labelling can be tested in isolation. */
function block(id: string, seq: number, overrides: Partial<DcpBlockState> = {}): DcpBlockState {
  return {
    id,
    compactionId: `dcp-${id}`,
    seq,
    summarySeq: seq,
    spanStart: seq,
    spanEnd: seq,
    shadowed: [seq],
    tokens: 0,
    consumed: [],
    ...overrides,
  }
}

describe('enumerateTargets', () => {
  it('mints n<seq> handles and reports the cut flags the session accepts', () => {
    const session = Session.create('boundaries-handles' as never)
    buildConversation(session, 2)
    const surface = nodes(session)

    const { targets, omitted } = enumerateTargets(session, [])
    expect(omitted).toBe(0)
    expect(targets.map((target) => target.id)).toEqual(surface.map((seq) => `n${seq}`))
    expect(targets.map((target) => target.seq)).toEqual(surface)
    expect(targets.map((target) => target.kind)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant', 'tool'])
    // The flags are the session's own answer, not a guess: the listing must not
    // promise a cut that `commitCompression` would then refuse.
    for (const target of targets) {
      expect(target.balancedBefore).toBe(toolPairingBalancedBefore(session, target.seq as never))
      expect(target.balancedAfter).toBe(toolPairingBalancedAfter(session, target.seq as never))
    }

    // The model-facing reading: `<` = a legal cut before this node, `>` = a
    // legal cut after it. Only a tool result starts a pair (no `<`) and only an
    // assistant tool call ends one (no `>`); a user message allows both cuts.
    const marker = (target: { balancedBefore: boolean; balancedAfter: boolean }): string =>
      `${target.balancedBefore ? '<' : 'x'}${target.balancedAfter ? '>' : 'x'}`
    expect(targets.map(marker)).toEqual(['<>', '<x', 'x>', '<>', '<x', 'x>'])
  })

  it('prices a node only when the meter did, and carries no field without a meter', () => {
    const session = Session.create('boundaries-price' as never)
    buildConversation(session, 2)
    const first = at(nodes(session), 0)

    const priced = enumerateTargets(session, [], (seq) => (seq === first ? 42 : undefined))
    expect(at(priced.targets, 0).tokens).toBe(42)
    // The field is optional even when a meter exists: an unpriced node renders
    // no cost rather than `~0tok`.
    expect(at(priced.targets, 1).tokens).toBeUndefined()

    const unpriced = enumerateTargets(session, [])
    expect('tokens' in at(unpriced.targets, 0)).toBe(false)
  })

  it('collapses whitespace and truncates a preview to one line width', () => {
    const session = Session.create('boundaries-preview' as never)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `\n  ${'A'.repeat(120)}\n  ` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const { targets } = enumerateTargets(session, [])
    const preview = at(targets, 0).preview
    expect(preview).toBe(`${'A'.repeat(PREVIEW_CHARS - 1)}…`)
    expect(preview).not.toContain('\n')
    expect(preview.length).toBe(PREVIEW_CHARS)

    const short = Session.create('boundaries-preview-short' as never)
    short.append('turn/start', { turn: 1 })
    short.append('user/message', createUserMessage({ content: [{ type: 'text', text: '  only this  ' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(at(enumerateTargets(short, []).targets, 0).preview).toBe('only this')
  })

  it('labels a live summary node and never one that was absorbed', () => {
    const session = Session.create('boundaries-blocks' as never)
    buildConversation(session, 1)
    const seq = at(nodes(session), 0)

    expect(at(enumerateTargets(session, [block('b1', seq)]).targets, 0).block).toBe('b1')
    // An absorbed block is not offered as a referenceable summary any more.
    expect(at(enumerateTargets(session, [block('b1', seq, { consumedBy: 'b2' })]).targets, 0).block).toBeUndefined()
    // Neither must an absorbed block shadow the label of a live block at the
    // same seq.
    expect(at(enumerateTargets(session, [block('b1', seq), block('b2', seq, { consumedBy: 'b9' })]).targets, 0).block).toBe('b1')
  })

  it('lists the whole surface while it fits, and keeps the newest tail past MAX_TARGETS', () => {
    const small = Session.create('boundaries-small' as never)
    buildConversation(small, 3)
    const smallSurface = nodes(small)
    const smallListing = enumerateTargets(small, [])
    expect(smallListing.omitted).toBe(0)
    expect(smallListing.targets).toHaveLength(smallSurface.length)

    // 34 rounds × 3 nodes = 102 surface nodes, just past the listing cap.
    const session = Session.create('boundaries-large' as never)
    buildConversation(session, 34)
    const surface = nodes(session)
    expect(surface.length).toBeGreaterThan(MAX_TARGETS)
    const { targets, omitted } = enumerateTargets(session, [])

    expect(targets).toHaveLength(MAX_TARGETS)
    expect(omitted).toBe(surface.length - MAX_TARGETS)
    // Oldest first, no repeats, and the two slices do not overlap.
    expect(targets.every((target, index) => index === 0 || target.seq > at(targets, index - 1).seq)).toBe(true)
    expect(at(targets, 0).seq).toBe(at(surface, 0))
    expect(at(targets, targets.length - 1).seq).toBe(at(surface, surface.length - 1))
    // The head is the oldest MAX_TARGETS - TARGET_TAIL, the tail the newest
    // TARGET_TAIL; the gap between them is what `omitted` counts.
    expect(at(targets, MAX_TARGETS - TARGET_TAIL - 1).seq).toBe(at(surface, MAX_TARGETS - TARGET_TAIL - 1))
    expect(at(targets, MAX_TARGETS - TARGET_TAIL).seq).toBe(at(surface, surface.length - TARGET_TAIL))
    const listed = new Set(targets.map((target) => target.seq))
    for (const seq of surface.slice(MAX_TARGETS - TARGET_TAIL, surface.length - TARGET_TAIL)) {
      expect(listed.has(seq)).toBe(false)
    }
  })

  it('describes an empty surface as nothing to list, not as an omission', () => {
    const session = Session.create('boundaries-empty' as never)
    expect(enumerateTargets(session, [])).toEqual({ targets: [], omitted: 0 })
  })
})

describe('resolveRange', () => {
  it('passes a range through untouched when both requested cuts are legal', () => {
    const session = Session.create('resolve-passthrough' as never)
    buildConversation(session, 2)
    const surface = nodes(session)
    const start = at(surface, 0)
    const end = at(surface, 2)

    const resolved = resolveRange(session, `n${start}`, `n${end}`)
    expect(resolved).toEqual({
      ok: true,
      startSeq: start,
      endSeq: end,
      startId: `n${start}`,
      endId: `n${end}`,
      snapped: false,
    })

    // A lone node with legal cuts on both sides is a one-node range, not a snap.
    const single = Session.create('resolve-single' as never)
    single.append('turn/start', { turn: 1 })
    single.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'only' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const only = at(nodes(single), 0)
    expect(resolveRange(single, `n${only}`, `n${only}`)).toMatchObject({ ok: true, startSeq: only, endSeq: only, snapped: false })
  })

  it('snaps outward to the nearest legal cuts instead of refusing', () => {
    const session = Session.create('resolve-snap' as never)
    buildConversation(session, 2)
    const surface = nodes(session)
    // request -> assistant -> result -> request -> assistant -> result
    const assistant0 = at(surface, 1)
    const result0 = at(surface, 2)
    const request1 = at(surface, 3)
    const assistant1 = at(surface, 4)
    const result1 = at(surface, 5)

    // Both edges illegal: the start would split the first pair, the end the
    // second. Snapping grows the range on both sides.
    const both = resolveRange(session, `n${result0}`, `n${assistant1}`)
    expect(both).toMatchObject({ ok: true, startSeq: assistant0, endSeq: result1, snapped: true })
    expect(both.ok && surface.indexOf(both.startSeq) <= surface.indexOf(result0)).toBe(true)
    expect(both.ok && surface.indexOf(both.endSeq) >= surface.indexOf(assistant1)).toBe(true)
    // The snapped range is one the write path accepts, by construction.
    expect(toolPairingBalancedBefore(session, assistant0 as never)).toBe(true)
    expect(toolPairingBalancedAfter(session, result1 as never)).toBe(true)

    // Only the end is illegal: the start stays where the model put it.
    expect(resolveRange(session, `n${request1}`, `n${assistant1}`)).toMatchObject({
      ok: true,
      startSeq: request1,
      endSeq: result1,
      snapped: true,
    })

    // A single tool result is not a cut at all: it expands to its own pair.
    expect(resolveRange(session, `n${result0}`, `n${result0}`)).toMatchObject({
      ok: true,
      startSeq: assistant0,
      endSeq: result0,
      snapped: true,
    })
  })

  it('refuses a start that appears after its end, naming both handles', () => {
    const session = Session.create('resolve-reversed' as never)
    buildConversation(session, 2)
    const surface = nodes(session)
    const early = at(surface, 0)
    const late = at(surface, 5)

    const resolved = resolveRange(session, `n${late}`, `n${early}`)
    expect(resolved).toEqual({ ok: false, problem: { kind: 'reversed', startId: `n${late}`, endId: `n${early}` } })
  })

  it('separates a malformed handle from one that left the conversation', () => {
    const session = Session.create('resolve-handles' as never)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const only = at(nodes(session), 0)

    for (const raw of ['nope', 'n1.5', 'n-1', 'n', `N${only}`, `n${only}x`]) {
      expect(resolveRange(session, raw, raw)).toEqual({ ok: false, problem: { kind: 'unknown-id', id: raw } })
    }
    // A well-formed handle for a node that is not on this surface is a
    // different answer: it existed and left, so the model must re-list.
    expect(resolveRange(session, 'n99999', 'n99999')).toEqual({
      ok: false,
      problem: { kind: 'not-on-surface', id: 'n99999' },
    })
    // The handle round-trips, including the whitespace a model might add.
    expect(resolveRange(session, `  n${only}  `, `n${only}`)).toMatchObject({ ok: true, startSeq: only, endSeq: only })
  })

  it('refuses a range that would cover the system head, and allows one after it', () => {
    const session = Session.create('resolve-system' as never)
    session.append('turn/start', { turn: 1 })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('prompt') }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const head = at(nodes(session), 0)
    const user = at(nodes(session), 1)

    expect(resolveRange(session, `n${head}`, `n${head}`)).toEqual({
      ok: false,
      problem: { kind: 'system-head', id: `n${head}` },
    })
    // The refusal is about covering node 0, not about the head existing.
    expect(resolveRange(session, `n${user}`, `n${user}`)).toMatchObject({ ok: true, startSeq: user, endSeq: user, snapped: false })
  })

  it('reports an end edge that cannot be completed', () => {
    const session = Session.create('resolve-open-step' as never)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    // An assistant tool call with no result yet: the surface ends mid-pair.
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 'open-call' as unknown as ToolCallId, name: 'read', arguments: '{}' } as never,
        ],
        source: SOURCE,
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    const tail = at(nodes(session), nodes(session).length - 1)
    expect(toolPairingBalancedAfter(session, tail as never)).toBe(false)
    expect(resolveRange(session, `n${tail}`, `n${tail}`)).toEqual({
      ok: false,
      problem: { kind: 'unbalanced-end', id: `n${tail}` },
    })
  })

  it('reports a handle that is gone from an empty surface', () => {
    const session = Session.create('resolve-empty' as never)
    expect(nodes(session)).toEqual([])
    expect(resolveRange(session, 'n1', 'n1')).toEqual({ ok: false, problem: { kind: 'not-on-surface', id: 'n1' } })
  })
})

describe('describeProblem', () => {
  it('renders every refusal as its own one-line instruction', () => {
    const cases: Array<[RangeProblem, string]> = [
      [{ kind: 'unknown-id', id: 'zz' }, '"zz" is not a target id'],
      [{ kind: 'not-on-surface', id: 'n9' }, '"n9" is no longer in the conversation'],
      [{ kind: 'reversed', startId: 'n5', endId: 'n2' }, 'start n5 appears after end n2'],
      [{ kind: 'system-head', id: 'n1' }, 'cannot cover the system prompt'],
      [{ kind: 'unbalanced-start', id: 'n3' }, 'no balanced start boundary at or before n3'],
      [{ kind: 'unbalanced-end', id: 'n7' }, 'no balanced end boundary at or after n7'],
    ]
    const rendered = cases.map(([problem]) => describeProblem(problem))
    for (const [problem, expected] of cases) {
      expect(describeProblem(problem)).toContain(expected)
    }
    // Every kind has distinct wording: the model only sees this sentence.
    expect(new Set(rendered).size).toBe(cases.length)
    expect(rendered.every((line) => line.length > 0 && !line.includes('\n'))).toBe(true)
  })
})
