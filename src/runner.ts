/**
 * The automatic strategy pass.
 *
 * One pass derives the surface's tool pairs, asks both strategies for
 * candidates, and rewrites the winners. It never writes outside a
 * `compaction/prune`-priced single-node replacement, it is serialized per
 * session, and it is idempotent: a second pass over the same log finds every
 * candidate already carrying a placeholder and writes nothing.
 *
 * @module dsh-dcp/runner
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'
import { placeholderFor, pruneToolResult } from './prune.ts'
import type { EstimateMessage } from './prune.ts'
import { collectToolPairs, deduplicationCandidates, strategiesAllowed } from './strategies/index.ts'
import type { Candidate, DeclaredPaths } from './strategies/index.ts'
import type { DcpState } from './types.ts'

/** What one strategy pass changed. */
export interface StrategyReport {
  pruned: number
  /**
   * The shadow-price total of the rewritten nodes: the figure the
   * `compaction/prune` protocol claims, and what the meter's O(1) fold reads.
   */
  tokens: number
  /**
   * Tokens the surface actually lost, which is smaller than `tokens` when a
   * rewrite kept an attachment block. This is the figure a human-facing notice
   * may state (audit 06 §3.1); it equals `tokens` whenever no estimator was
   * available.
   */
  reclaimedTokens: number
  /** Labels of what was rewritten, for the panel and the optional notice. */
  labels: string[]
}

/** Everything a pass needs from the plugin. */
export interface StrategyDeps {
  config: Config
  stateOf(session: Session): DcpState
  priceOf(session: Session): (seq: number) => number | undefined
  /**
   * The token meter's message estimator, for the reclaimed figure.
   *
   * Optional on purpose: the meter is not part of this plugin's `inject` list,
   * so a deployment without it must omit the field rather than hand over an
   * estimator that answers zero — a zero would claim the whole node as
   * reclaimed, which is the overstatement being fixed.
   */
  estimateMessage?: EstimateMessage
  declaredPaths: DeclaredPaths
}

/**
 * Run one strategy pass over a session.
 * @param session - session to prune.
 * @param deps - plugin accessors.
 * @returns what changed; an empty report means nothing was rewritten.
 */
export function runStrategies(session: Session, deps: StrategyDeps): StrategyReport {
  const state = deps.stateOf(session)
  if (!strategiesAllowed(deps.config, state)) return { pruned: 0, tokens: 0, reclaimedTokens: 0, labels: [] }

  const raw = deps.priceOf(session)
  const price = (seq: number): number => raw(seq) ?? 0
  const pairs = collectToolPairs(session)

  const candidates: Candidate[] = deduplicationCandidates(pairs, deps.config, deps.declaredPaths, state.turn, price)
  const seen = new Set<number>()
  let pruned = 0
  let tokens = 0
  let reclaimedTokens = 0
  const labels: string[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.seq)) continue
    seen.add(candidate.seq)
    const outcome = pruneToolResult(session, candidate.seq, placeholderFor(), candidate.tokens, deps.estimateMessage)
    if (!outcome.ok) continue
    pruned += 1
    tokens += outcome.tokens
    reclaimedTokens += outcome.reclaimedTokens
    labels.push(candidate.label)
  }
  return { pruned, tokens, reclaimedTokens, labels }
}

/**
 * A per-session serialization chain, so two passes never interleave.
 *
 * NOT reentrant: a task must not call `run()` for its own session, because that
 * call would wait for the task holding the chain — itself — and never settle.
 * `held` turns that deadlock into a thrown error, which is the only outcome a
 * caller can act on. The queue is also unbounded and has no timeout by design:
 * a task that never settles blocks its session's later passes, and inventing a
 * timeout would have to guess how long a legitimate pass may take.
 */
export class SessionMutex {
  private readonly tails = new Map<Session, Promise<void>>()
  private readonly held = new Set<Session>()

  /**
   * Run one task after every previously queued task for this session settles.
   * @param session - the session being serialized.
   * @param task - the work to run.
   * @returns the task's result.
   * @throws when called from inside a task already running for this session.
   */
  async run<T>(session: Session, task: () => T | Promise<T>): Promise<T> {
    if (this.held.has(session)) {
      throw new Error('dsh-dcp: SessionMutex.run() is not reentrant for one session; await the outer pass instead of nesting one inside it')
    }
    const previous = this.tails.get(session) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const mine = previous.then(() => gate)
    this.tails.set(session, mine)
    await previous
    this.held.add(session)
    try {
      return await task()
    } finally {
      this.held.delete(session)
      release()
      if (this.tails.get(session) === mine) this.tails.delete(session)
    }
  }
}
