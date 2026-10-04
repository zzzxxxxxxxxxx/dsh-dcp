/**
 * The write path: one native compaction transaction per compressed entry.
 *
 * DCP speaks the Harness's own compaction vocabulary instead of a private one,
 * which is what makes the built-in "context compacted" conversation row and the
 * manual compaction card light up with no client code, and what lets
 * checkpoint-aware consumers (`dsh-session-reference`, session queries) treat a
 * DCP summary exactly like a backend summary.
 *
 * The durable shape is fixed by the seam:
 *
 *     compaction/start   {compactionId, sourceCommandId?, turn}     log-only, holds the lock
 *     compaction/summary {…, rawOutput}                             log-only, no llmStreamCall
 *     user/message       ← immediately after its pricing event
 *     compaction/end     {compactionId, sourceCommandId?, turn}     log-only, releases the lock
 *
 * `llmStreamCall` is deliberately absent: the agent model authored this summary
 * inside a tool call, so there is no `ctx.llm.stream()` call to identify. That
 * is the seam's documented "unmarked summarizer" variant.
 *
 * @module dsh-dcp/transaction
 */
import { randomUUID } from 'node:crypto'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { unwrapSummary } from './placeholders.ts'
import { COMPACTION_ID_PREFIX } from './types.ts'
import { contentOf, eventAt, surfaceSeqs } from './surface.ts'

/** Everything one transaction needs, already validated by the caller. */
export interface CompressionEntry {
  /** Inclusive surface seqs the summary replaces. */
  startSeq: number
  endSeq: number
  /** The final summary body, placeholders already expanded and protections appended. */
  summary: string
  /**
   * The summary as the PANEL should show it: the model's own words with
   * placeholders expanded, and without this plugin's transport framing (the
   * header, the block marker) or the protected-body appendix.
   *
   * The two differ on purpose. The model reads the framed form, because the
   * marker is what `unwrapSummary` strips when it expands a nested `(bN)`; a
   * person reading the compaction row wants the summary, not the envelope.
   *
   * Optional only so a hand-built entry (a test) need not restate it; the
   * stored form is unwrapped as the fallback, which is the same text minus the
   * header and marker.
   */
  display?: string
  topic?: string
  startId?: string
  endId?: string
  /** Block alias assigned to this entry. */
  blockId: string
  /** Prior blocks whose bodies were absorbed. */
  consumedIds: string[]
  /** Initiating `/dcp-compact` invocation, for a manual transaction. */
  sourceCommandId?: string
}

/** Routing facts a summarization transaction records. */
export interface TransactionRouting {
  provider: string
  model: string
  /** Heuristic token price of the shadowed surface span. */
  shadowedTokens: number
}

/** Why a transaction did not run. */
export type CommitFailure =
  | { kind: 'range-not-on-surface'; seq: number }
  | { kind: 'inverted-range'; startSeq: number; endSeq: number }
  | { kind: 'system-head' }
  | { kind: 'unbalanced-start'; seq: number }
  | { kind: 'unbalanced-end'; seq: number }
  | { kind: 'aborted'; reason: string }

/** The result of one transaction attempt. */
export type CommitOutcome =
  | { ok: true; compactionId: string; summarySeq: number; checkpointSeq: number; shadowed: number[] }
  | { ok: false; failure: CommitFailure; compactionId?: string }

/**
 * Validate one entry against the CURRENT surface without writing anything.
 *
 * The surface can change between the model's decision and this call (another
 * plugin may have compacted, or the model may cite a stale handle), so every
 * edge is re-checked here and every optional append is built before the first
 * write lands.
 *
 * @param session - session to validate against.
 * @param startSeq - inclusive range start.
 * @param endSeq - inclusive range end.
 * @returns the shadowed sequence list, or the first failure.
 */
export function validateEntry(session: Session, startSeq: number, endSeq: number): { ok: true; shadowed: number[] } | { ok: false; failure: CommitFailure } {
  const nodes = surfaceSeqs(session)
  const startIdx = nodes.indexOf(startSeq)
  const endIdx = nodes.indexOf(endSeq)
  if (startIdx === -1) return { ok: false, failure: { kind: 'range-not-on-surface', seq: startSeq } }
  if (endIdx === -1) return { ok: false, failure: { kind: 'range-not-on-surface', seq: endSeq } }
  // Both sequences are on the surface, but the model named them the wrong way
  // round. Reporting this as `range-not-on-surface` told it "seq N left the
  // conversation" about a seq it can still see, which sends it looking for a
  // compaction that never happened.
  if (startIdx > endIdx) return { ok: false, failure: { kind: 'inverted-range', startSeq, endSeq } }
  if (startIdx === 0 && eventAt(session, startSeq)?.type === 'system/message') {
    return { ok: false, failure: { kind: 'system-head' } }
  }
  if (!toolPairingBalancedBefore(session, startSeq as SessionSeq)) {
    return { ok: false, failure: { kind: 'unbalanced-start', seq: startSeq } }
  }
  if (!toolPairingBalancedAfter(session, endSeq as SessionSeq)) {
    return { ok: false, failure: { kind: 'unbalanced-end', seq: endSeq } }
  }
  // No empty-range branch: both indices are positions in the same array and
  // `startIdx <= endIdx` here, so the slice holds at least the start node. The
  // branch that used to live here was unreachable, and a failure kind nothing
  // can produce only invites a reader to trust a state that cannot occur.
  return { ok: true, shadowed: nodes.slice(startIdx, endIdx + 1) }
}

/** Mint a transaction identity that stays unique across a resumed log. */
export function mintCompactionId(): string {
  return `${COMPACTION_ID_PREFIX}${randomUUID()}`
}

/**
 * Append one complete compaction transaction.
 *
 * Every optional field is conditionally spread: `Session.append` rejects a
 * payload containing `undefined` because it is not losslessly JSON
 * serializable, so an absent key must stay absent.
 *
 * @param session - session receiving the transaction.
 * @param entry - the validated entry.
 * @param routing - provider, model, and the shadowed span's heuristic price.
 * @param turn - the caller's belief about the open turn. Advisory only: the log
 *   decides the recorded owner (see below), and a value that disagreed with it
 *   would make the session unloadable rather than merely wrong.
 * @returns the appended identities, or a failure that wrote nothing but the closing marker.
 */
export function commitCompression(
  session: Session,
  entry: CompressionEntry,
  routing: TransactionRouting,
  turn: number | null,
): CommitOutcome {
  const compactionId = CompactionId(mintCompactionId())
  const command = entry.sourceCommandId === undefined ? {} : { sourceCommandId: entry.sourceCommandId as never }

  try {
    const validated = validateEntry(session, entry.startSeq, entry.endSeq)
    if (!validated.ok) return { ok: false, failure: validated.failure }
    const shadowed = validated.shadowed

    // The LOG decides which turn this transaction belongs to, not the caller.
    // The storage format requires the recorded owner to equal the open turn
    // (`compaction/start does not match the open turn`), and it is the log —
    // not the projection — that the validator reads back. A projection that
    // lagged or fell back to the empty state used to write `turn: null` inside
    // an open turn: the tool reported success and the session could never be
    // loaded again. Re-reading costs one scan and removes that whole class.
    const owner = currentTurn(session)
    void turn

    const startEvent = session.append('compaction/start', {
      compactionId,
      ...command,
      turn: owner,
    } as never)

    // `summary` is the field the Harness renders — a client draws the
    // compaction row's one-line preview and its expanded body straight from it
    // (dsh-client-ui-chat reads `compaction/summary.data.summary`). It must be
    // the summary itself, not the framing this plugin wraps around it: shipping
    // `wrapSummary(...)` here made every row read
    // "[Compacted conversation section]" and put the block marker and the
    // protected-body appendix on screen. The framing still travels in the
    // checkpoint message's content, which is what the model reads and what
    // `unwrapSummary` strips when it expands a nested `(bN)`.
    const summaryBlocks: ContentBlock[] = [{ type: 'text', text: entry.summary }]
    const displayBlocks: ContentBlock[] = [{ type: 'text', text: entry.display ?? unwrapSummary(entry.summary) }]
    const summaryRecord = {
      compactionId,
      ...command,
      summary: displayBlocks,
      shadowedRange: { start: entry.startSeq as SessionSeq, end: entry.endSeq as SessionSeq },
      shadowedSeqs: shadowed as SessionSeq[],
      shadowedTokenCount: routing.shadowedTokens,
      provider: routing.provider,
      model: routing.model,
      rawOutput: displayBlocks,
    }
    const summaryEvent = session.append('compaction/summary', summaryRecord as never)

    const checkpoint = createUserMessage({
      content: [{ type: 'text', text: entry.summary }],
      source: compactCheckpointSource(compactionId, entry.sourceCommandId as never),
    })
    const checkpointEvent = session.append('user/message', checkpoint as never, {
      surfaceOp: { op: 'replace', startSeq: entry.startSeq as SessionSeq, endSeq: entry.endSeq as SessionSeq },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowed] as SessionSeq[],
    })

    session.append('compaction/end', { compactionId, ...command, turn: owner } as never)

    return {
      ok: true,
      compactionId,
      summarySeq: summaryEvent.seq,
      checkpointSeq: checkpointEvent.seq,
      shadowed,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // Close only a transaction that actually opened, and only once.
    //
    // A second `compaction/end` for one id is fatal: the format rejects the log
    // with `compaction/end has no matching compaction/start`, which turned a
    // recoverable failure into a permanently unloadable session.
    //
    // "Did the start land" is answered from the log rather than from a local
    // flag, because an `append` can fail after the event has been recorded. A
    // listener used to be able to throw from inside; the Harness now contains a
    // listener's exception (`invokeContainedSessionObservers`, dsh-session), so
    // that route is closed — but reading the log stays the honest answer, since
    // this function cannot know what a future append path does.
    if (landed(session, 'compaction/start', compactionId) && !landed(session, 'compaction/end', compactionId)) {
      try {
        session.append('compaction/end', { compactionId, ...command, turn: currentTurn(session), error: reason } as never)
      } catch {
        // The closing attempt is best-effort: a failure here leaves an unmatched
        // start as the seam's documented "busy" evidence, which is the intended
        // signal rather than something to swallow silently.
      }
    }
    return { ok: false, failure: { kind: 'aborted', reason }, compactionId }
  }
}

/** Whether the log already carries one event type for one compaction id. */
function landed(session: Session, type: string, compactionId: string): boolean {
  return session
    .snapshotEvents()
    .some((event) => event.type === type && (event.data as { compactionId?: string }).compactionId === compactionId)
}

/**
 * The turn a transaction belongs to, when the caller has no projection state.
 *
 * The seam requires a numbered transaction to be strictly enclosed by its open
 * turn, and a standalone manual one to record `null`. Prefer the projection's
 * `turn`; this helper exists for callers without one.
 *
 * @param session - session to inspect.
 * @returns the open turn number, or `null` between turns.
 */
export function currentTurn(session: Session): number | null {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/end') return null
    if (event.type === 'turn/start') return (event.data as { turn: number }).turn
  }
  return null
}

