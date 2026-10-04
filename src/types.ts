/**
 * Pure-JSON state shapes derived from the session log, plus the durable
 * constants that make those events self-identifying.
 *
 * Everything here is a projection state or a frozen wire value: it must stay
 * plain JSON so the session-projection cache can checkpoint it, and it must be
 * reconstructable from committed events alone (the session log is the single
 * source of truth).
 *
 * @module dsh-dcp/types
 */

/**
 * The prefix every DCP transaction id carries.
 *
 * A compaction id is the only thing that distinguishes this plugin's
 * transactions from another producer's — the Harness's own `/compact`, another
 * plugin — and more than one write path needs to make that distinction. It is
 * defined once here rather than spelled out at each site.
 */
export const COMPACTION_ID_PREFIX = 'dcp-'

/** The header that marks a DCP-authored compaction summary. FROZEN once shipped. */
export const SUMMARY_HEADER = '[Compacted conversation section]'

/**
 * Placeholder written over a deduplicated or swept tool result.
 * FROZEN: it is the durable discriminator between our prunes and another
 * producer's, and the model-facing text of an already-pruned node.
 */
export const PRUNE_OUTPUT_PLACEHOLDER = '[Output removed to save context - information superseded or no longer needed]'

/**
 * Placeholder written over a `question` tool's input. FROZEN.
 *
 * Read-only now: nothing writes it, but a log that already carries it still
 * folds and classifies correctly.
 */
export const PRUNE_QUESTION_PLACEHOLDER = '[questions removed - see output for user\'s answers]'

/** One completed DCP compaction, derived from the log. */
export interface DcpBlockState {
  /** Stable alias `b<ordinal>`, stamped by the writer and recorded in the summary marker. */
  id: string
  /** Transaction identity shared by start/summary/checkpoint/end. */
  compactionId: string
  /** Initiating `/dcp-compact` invocation, for a manual transaction. */
  sourceCommandId?: string
  /** Seq of the checkpoint `user/message` that carries this block's summary. */
  seq: number
  /** Seq of the `compaction/summary` event. */
  summarySeq: number
  /** Inclusive surface seqs the block's replacement shadowed. */
  spanStart: number
  spanEnd: number
  /** Every shadowed surface node seq, in surface order. */
  shadowed: number[]
  /** Heuristic token price of the shadowed content, from the transaction. */
  tokens: number
  /** Topic supplied by the model, when the entry carried one. */
  topic?: string
  /** Model-supplied boundary handles, for display and diagnostics. */
  startId?: string
  endId?: string
  /** Block ids whose content this block absorbed (their bodies were expanded into it). */
  consumed: string[]
  /** Set on a block once a later block absorbed it. */
  consumedBy?: string
  /** The user asked `/dcp-compact decompress` for this block. */
  deactivatedByUser?: boolean
  /** Seq of the rehydrating replacement, when one was written. */
  rehydratedSeq?: number
}

/** One `compact` tool call awaiting its transaction, for topic correlation. */
export interface DcpPendingCallState {
  callId: string
  turn: number
  topic?: string
  /** Boundary handles in entry order, for display. */
  entries: string[]
}

/** A `compaction/summary` awaiting its checkpoint replacement. */
export interface DcpPendingSummaryState {
  compactionId: string
  seq: number
  spanStart: number
  spanEnd: number
  shadowed: number[]
  tokens: number
}

/** A `compaction/prune` awaiting the replacement it prices. */
export interface DcpPendingPruneState {
  seq: number
  shadowed: number[]
  tokens: number
}

/**
 * A live compaction bracket, used to refuse a concurrent writer.
 *
 * Only brackets that can still be closed count as live: once a `turn/*` event
 * has crossed a bracket (legal only for the orphaned start an upgrade carries
 * over), the fold clears it — see `dropCrossedLive` in `src/projection.ts`.
 */
export interface DcpLiveTransaction {
  compactionId: string
  /** `null` for a standalone manual transaction between turns. */
  turn: number | null
}

/** The `dcp` projection unit's whole value. Plain JSON only. */
export interface DcpState {
  /** Blocks in creation order. */
  blocks: DcpBlockState[]
  /**
   * How many model-free prune replacements the strategies have written.
   *
   * A count rather than the list: the only consumers are the panel's tally and
   * the sum below, so keeping every replacement's seq and reason made the
   * projection state grow for the length of the session to answer two numbers.
   */
  pruneCount: number
  /** Heuristic tokens those prunes removed, summed as they land. */
  prunedTokens: number
  /** The open turn number, or `null` between turns. */
  turn: number | null
  /** A `compaction/start` without its matching `compaction/end`, when one exists. */
  live: DcpLiveTransaction | null
  /** The most recent `compact` tool call, awaiting its transaction. */
  pendingCall: DcpPendingCallState | null
  /** The most recent `compaction/summary`, awaiting its checkpoint replacement. */
  pendingSummary: DcpPendingSummaryState | null
  /** The most recent `compaction/prune`, awaiting the replacement it prices. */
  pendingPrune: DcpPendingPruneState | null
  /** Number of DCP notice messages injected into this session, nudges included. */
  notices: number
  /**
   * Command id of a `/dcp-compact` invocation whose compression the model has not
   * performed yet. Manual mode refuses a stray `compact` call while this is
   * `null`, matching the upstream "tools only run when explicitly triggered"
   * contract.
   *
   * The unlock is scoped to one turn: the fold clears it at the next `turn/end`,
   * and earlier when the attempt it authorised fails. An explicit request buys
   * the compression it asked for, not every later one.
   */
  manualCommandId: string | null
  /**
   * The `compact` call a live manual unlock authorised, when the model made one.
   *
   * A failed call has to spend the unlock — otherwise a request that produced
   * nothing leaves the gate open for the rest of the turn. The result event names
   * only its `toolCallId`, so the id is remembered when the call is folded.
   */
  manualCallId: string | null
  /**
   * Seq of the newest DCP nudge message, for anchor spacing.
   *
   * Only a nudge moves this. Ordinary notices (prune announcements, the
   * `/dcp-compact` steering message) are model-visible too, but they are not the
   * reminder the spacing exists to throttle; letting them advance the anchor
   * starves the nudge in a session whose dedup pass reports every few turns.
   */
  lastNudgeSeq: number | null
}

/** The initial state of a session with no DCP activity yet. */
export function initialDcpState(): DcpState {
  return {
    blocks: [],
    pruneCount: 0,
    prunedTokens: 0,
    turn: null,
    live: null,
    pendingCall: null,
    pendingSummary: null,
    pendingPrune: null,
    notices: 0,
    manualCommandId: null,
    manualCallId: null,
    lastNudgeSeq: null,
  }
}
