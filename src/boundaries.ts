/**
 * Target enumeration and boundary snapping.
 *
 * DCP never lets the model pick an illegal cut: a requested range is snapped
 * outward to the nearest tool-pairing-balanced cuts, and a range that cannot be
 * balanced (it would swallow the system prompt or end inside an open step) is
 * refused. Snapping is reported back so the model learns where the real edges
 * were.
 *
 * @module dsh-dcp/boundaries
 */
import type { Session } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { DcpBlockState } from './types.ts'
import type { NodeKind, SurfaceTarget } from './surface.ts'
import { eventAt, nodeKind, parseTargetId, preview, surfaceSeqs, targetId } from './surface.ts'

/** Maximum nodes listed in one target map. */
export const MAX_TARGETS = 100

/** Nodes kept from the newest end when the surface exceeds {@link MAX_TARGETS}. */
export const TARGET_TAIL = 20

/** Why a requested range cannot be used. */
export type RangeProblem =
  | { kind: 'unknown-id'; id: string }
  | { kind: 'not-on-surface'; id: string }
  | { kind: 'reversed'; startId: string; endId: string }
  | { kind: 'system-head'; id: string }
  | { kind: 'unbalanced-start'; id: string }
  | { kind: 'unbalanced-end'; id: string }

/** The outcome of resolving one requested range against the current surface. */
export type RangeResolution =
  | { ok: true; startSeq: number; endSeq: number; startId: string; endId: string; snapped: boolean }
  | { ok: false; problem: RangeProblem }

/**
 * Enumerate the addressable surface nodes for the model.
 *
 * `balancedBefore`/`balancedAfter` are the cuts the session will actually
 * accept, so the model can pick legal edges without guessing.
 *
 * @param session - session whose surface is listed.
 * @param blocks - current DCP blocks, used to label summary nodes.
 * @param price - optional per-node token price.
 * @returns the target list in model-visible order, plus an omission count.
 */
export function enumerateTargets(
  session: Session,
  blocks: readonly DcpBlockState[],
  price?: (seq: number) => number | undefined,
): { targets: SurfaceTarget[]; omitted: number } {
  const nodes = surfaceSeqs(session)
  const blockBySeq = new Map<number, string>()
  for (const block of blocks) {
    if (block.consumedBy === undefined && block.deactivatedByUser !== true) {
      blockBySeq.set(block.seq, block.id)
    }
  }

  const describe = (sequence: number): SurfaceTarget => {
    const event = eventAt(session, sequence)
    return {
      id: targetId(sequence),
      seq: sequence,
      kind: nodeKind(event) as NodeKind,
      ...(price === undefined ? {} : { tokens: price(sequence) }),
      preview: preview(event),
      balancedBefore: safeBalance(session, sequence, 'before'),
      balancedAfter: safeBalance(session, sequence, 'after'),
      ...(blockBySeq.has(sequence) ? { block: blockBySeq.get(sequence) } : {}),
    }
  }

  if (nodes.length <= MAX_TARGETS) {
    return { targets: nodes.map(describe), omitted: 0 }
  }
  const head = nodes.slice(0, MAX_TARGETS - TARGET_TAIL)
  const tail = nodes.slice(-TARGET_TAIL)
  return { targets: [...head, ...tail].map(describe), omitted: nodes.length - head.length - tail.length }
}

/**
 * Read one cut's balance without letting a malformed surface abort the listing.
 * @param session - session to read.
 * @param sequence - a surface sequence.
 * @param side - which cut to test.
 * @returns the balance, or `false` when the surface rejects the query.
 */
function safeBalance(session: Session, sequence: number, side: 'before' | 'after'): boolean {
  try {
    return side === 'before'
      ? toolPairingBalancedBefore(session, sequence as never)
      : toolPairingBalancedAfter(session, sequence as never)
  } catch {
    return false
  }
}

/**
 * Resolve one requested `[startId, endId]` pair to a legal balanced range.
 * @param session - session whose surface the range is validated against.
 * @param startId - the model's inclusive start handle.
 * @param endId - the model's inclusive end handle.
 * @returns the legal range, or the first problem found.
 */
export function resolveRange(session: Session, startId: string, endId: string): RangeResolution {
  const start = parseTargetId(startId)
  const end = parseTargetId(endId)
  if (start === undefined) return { ok: false, problem: { kind: 'unknown-id', id: startId } }
  if (end === undefined) return { ok: false, problem: { kind: 'unknown-id', id: endId } }

  const nodes = surfaceSeqs(session)
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) return { ok: false, problem: { kind: 'not-on-surface', id: startId } }
  if (endIdx === -1) return { ok: false, problem: { kind: 'not-on-surface', id: endId } }
  if (startIdx > endIdx) return { ok: false, problem: { kind: 'reversed', startId, endId } }

  // Snapping never crosses the system head: node 0 may only be rewritten by a
  // system/message over exactly that node, which a summary is not.
  let from = startIdx
  let to = endIdx
  let snapped = false
  while (from > 0 && !safeBalance(session, nodes[from] as number, 'before')) {
    from -= 1
    snapped = true
  }
  if (from === 0 && nodes[0] !== undefined && eventAt(session, nodes[0])?.type === 'system/message') {
    return { ok: false, problem: { kind: 'system-head', id: startId } }
  }
  if (!safeBalance(session, nodes[from] as number, 'before')) {
    return { ok: false, problem: { kind: 'unbalanced-start', id: targetId(nodes[from] as number) } }
  }
  while (to < nodes.length - 1 && !safeBalance(session, nodes[to] as number, 'after')) {
    to += 1
    snapped = true
  }
  if (!safeBalance(session, nodes[to] as number, 'after')) {
    return { ok: false, problem: { kind: 'unbalanced-end', id: targetId(nodes[to] as number) } }
  }

  const startSeq = nodes[from] as number
  const endSeq = nodes[to] as number
  return {
    ok: true,
    startSeq,
    endSeq,
    startId: targetId(startSeq),
    endId: targetId(endSeq),
    snapped: snapped || startSeq !== start || endSeq !== end,
  }
}

/**
 * Render one problem for the model.
 * @param problem - the refusal.
 * @returns a one-line explanation.
 */
export function describeProblem(problem: RangeProblem): string {
  switch (problem.kind) {
    case 'unknown-id':
      return `"${problem.id}" is not a target id; copy handles verbatim from compact_targets`
    case 'not-on-surface':
      return `"${problem.id}" is no longer in the conversation; run compact_targets again`
    case 'reversed':
      return `start ${problem.startId} appears after end ${problem.endId}`
    case 'system-head':
      return 'a range cannot cover the system prompt (the first message)'
    case 'unbalanced-start':
      return `no balanced start boundary at or before ${problem.id}`
    case 'unbalanced-end':
      return `no balanced end boundary at or after ${problem.id}`
  }
}
