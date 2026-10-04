/**
 * The `dcp` session-projection unit: a pure fold of the committed session log
 * into DCP's derived state.
 *
 * Nothing here is persisted by DCP itself — the log is the only durable store,
 * and this fold is the cache in front of it. A block is identified by the
 * checkpoint `user/message` that carries its summary; a block is *consumed*
 * when a later checkpoint's replacement shadows that seq; a message is inside
 * an active block when its seq is listed in that block's `shadowed` span.
 *
 * The unit is host-only (`wire` omitted): the browser half reads what it needs
 * through the conversation rows DSH already renders, so there is no client
 * contract to keep in step.
 *
 * @module dsh-dcp/projection
 */
import { z } from 'zod'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection/types'
import type { DcpPendingCallState, DcpState } from './types.ts'
import { COMPACTION_ID_PREFIX, PRUNE_OUTPUT_PLACEHOLDER, PRUNE_QUESTION_PLACEHOLDER, initialDcpState } from './types.ts'
import { isNudgeText } from './nudges.ts'

/** The client-facing summary of one session's DCP activity. Plain JSON. */
export interface DcpWireView {
  /**
   * Active blocks, oldest first.
   *
   * `tokens` is the heuristic price of the content the block replaced — the
   * number a reader actually wants, and the reason the panel is worth opening.
   */
  blocks: { id: string; from: number; to: number; nodes: number; tokens: number; topic?: string }[]
  /**
   * Blocks a later compaction absorbed.
   *
   * A block the user retired (`/dcp-compact decompress`) is not counted here: it
   * left the panel for the opposite reason, and reporting it as absorbed said a
   * user's own decompression had been folded into a summary.
   */
  absorbed: number
  /** Model-free prunes written by the strategies. */
  prunes: number
  /** Heuristic tokens those prunes removed. */
  prunedTokens: number
  /** DCP notice messages injected into this session. */
  notices: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** DCP's derived compaction, prune, and turn state for one session. */
    dcp: DcpState
  }
  interface SessionProjectionMap {
    /**
     * What the DCP panel renders.
     *
     * The client reads it through a session-scoped slot's `useProjection`, so
     * it must stay small, plain JSON, and reference-stable: `view` returns the
     * same object until something a reader can see actually changed, which is
     * what suppresses needless republication.
     */
    dcp: DcpWireView
  }
}

const blockSchema = z.object({
  id: z.string(),
  compactionId: z.string(),
  sourceCommandId: z.string().optional(),
  seq: z.number(),
  summarySeq: z.number(),
  spanStart: z.number(),
  spanEnd: z.number(),
  shadowed: z.array(z.number()),
  tokens: z.number(),
  topic: z.string().optional(),
  mode: z.enum(['range', 'message']).optional(),
  startId: z.string().optional(),
  endId: z.string().optional(),
  consumed: z.array(z.string()),
  consumedBy: z.string().optional(),
  deactivatedByUser: z.boolean().optional(),
  rehydratedSeq: z.number().optional(),
})

const liveSchema = z.object({ compactionId: z.string(), turn: z.number().nullable() })

const pendingCallSchema = z.object({
  callId: z.string(),
  turn: z.number(),
  topic: z.string().optional(),
  entries: z.array(z.string()),
})

const pendingSummarySchema = z.object({
  compactionId: z.string(),
  seq: z.number(),
  spanStart: z.number(),
  spanEnd: z.number(),
  shadowed: z.array(z.number()),
  tokens: z.number(),
})

const pendingPruneSchema = z.object({
  seq: z.number(),
  shadowed: z.array(z.number()),
  tokens: z.number(),
})

/** Validates persisted `dcp` state before it seeds a fold. */
export const dcpStateSchema = z.object({
  blocks: z.array(blockSchema),
  pruneCount: z.number(),
  prunedTokens: z.number(),
  turn: z.number().nullable(),
  live: liveSchema.nullable(),
  pendingCall: pendingCallSchema.nullable(),
  pendingSummary: pendingSummarySchema.nullable(),
  pendingPrune: pendingPruneSchema.nullable(),
  notices: z.number(),
  manualCommandId: z.string().nullable(),
  manualCallId: z.string().nullable(),
  lastNudgeSeq: z.number().nullable(),
})

/**
 * The `dcp` state shape's version.
 *
 * Bumped whenever the folded shape or the fold semantics change, so a cache
 * written by an older build fails `dcpStateSchema` and the projection re-folds
 * the log instead of seeding itself with a state the current code cannot read.
 *
 * 5 replaced the per-prune list with two counters. 6 dropped the pending call's
 * entry cursor. 7 dropped the `mode` a block and a pending call used to carry —
 * the setting behind it is gone, and nothing ever read the field. 8 clears a
 * compaction bracket the log has already crossed (`live`), so a session that the
 * old fold kept locked re-folds unlocked. 9 splits the reminder anchor from the
 * notice counter and scopes the manual unlock: `lastNudgeSeq` now moves only for
 * a real nudge (any notice used to reset it and starve the reminder), and the
 * unlock expires with its turn or with a failed attempt (`manualCallId`). A
 * cache written at 8 must re-fold rather than seed a fold that misreads both.
 */
export const DCP_STATE_VERSION = 9

/** Structural view of the parts of an event this fold reads. */
interface EventShape {
  surfaceOp?: unknown
  sourceEventSeqs?: readonly number[]
  data?: Record<string, unknown>
}

/** Narrow one event's surface operation to a replace marker. */
function replaceOp(event: SessionEvent): { startSeq: number; endSeq: number } | undefined {
  const op = (event as EventShape).surfaceOp
  if (op === null || typeof op !== 'object') return undefined
  const record = op as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (record.op !== 'replace' || typeof record.startSeq !== 'number' || typeof record.endSeq !== 'number') return undefined
  return { startSeq: record.startSeq, endSeq: record.endSeq }
}

/** Read the model-visible plain text of a message-bearing event. */
function messageText(event: SessionEvent): string {
  const data = (event as EventShape).data
  const inline = event.type === 'user/message' ? data : (data?.['message'] as Record<string, unknown> | undefined)
  const content = inline?.['content']
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content as readonly { type?: string; text?: unknown }[]) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Classify the placeholder carried by a rewritten tool result, if any.
 *
 * `input` is gone with the strategy that wrote it; a log that still carries
 * such a placeholder simply does not classify as one of ours, which is the
 * correct reading — that marker came from a build whose error pruning this one
 * removed.
 */
function pruneReasonOf(event: SessionEvent): 'output' | 'question' | undefined {
  const text = messageText(event)
  if (text.includes(PRUNE_OUTPUT_PLACEHOLDER)) return 'output'
  if (text.includes(PRUNE_QUESTION_PLACEHOLDER)) return 'question'
  return undefined
}

/**
 * The producer-declared source of a message-bearing event.
 *
 * A `user/message` event IS the message; every other type wraps it.
 */
function messageSource(event: SessionEvent): Record<string, unknown> | undefined {
  const data = (event as EventShape).data
  const holder = event.type === 'user/message' ? data : (data?.['message'] as Record<string, unknown> | undefined)
  const source = holder?.['source']
  return source !== null && typeof source === 'object' ? (source as Record<string, unknown>) : undefined
}

/** Parse one `compact` tool call's arguments into a pending-call record. */
function pendingCallFrom(callId: string, turn: number, rawArguments: string): DcpPendingCallState | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as { topic?: unknown; content?: unknown }
  const topic = typeof record.topic === 'string' ? record.topic : undefined
  if (!Array.isArray(record.content)) return undefined
  const entries: string[] = []
  for (const item of record.content) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as { startId?: unknown; endId?: unknown; messageId?: unknown }
    if (typeof entry.messageId === 'string') {
      entries.push(entry.messageId)
      continue
    }
    if (typeof entry.startId === 'string' && typeof entry.endId === 'string') {
      entries.push(`${entry.startId}..${entry.endId}`)
    }
  }
  if (entries.length === 0) return undefined
  return { callId, turn, entries, ...(topic === undefined ? {} : { topic }) }
}

/**
 * Split one requested entry's display handle into its boundaries.
 *
 * `pendingCallFrom` stores one handle per requested entry: a bare message id in
 * `message` mode, or `"start..end"` in `range` mode.
 *
 * @param handle - the stored handle, when the batch had one left.
 * @returns the boundary ids the handle names.
 */
function handlesOf(handle: string | undefined): { startId?: string; endId?: string } {
  if (handle === undefined) return {}
  const split = handle.indexOf('..')
  if (split === -1) return { startId: handle, endId: handle }
  return { startId: handle.slice(0, split), endId: handle.slice(split + 2) }
}

/**
 * Drop a compaction bracket the log has already crossed.
 *
 * A `turn/*` event can only be recorded while a bracket is open when the format
 * layer treats that bracket as orphaned — the one case it knows is a
 * `compaction/start` an upgrade carried over from a log whose transaction never
 * closed (dsh-session-format-v3-to-v4 marks exactly that). Such a bracket can
 * never be completed afterwards, so keeping it as `live` would disable
 * deduplication, every nudge, the `compact` tool and `/dcp-compact` for the rest
 * of the session's life — silently, and across restarts.
 *
 * @param state - state that may still carry the crossed bracket.
 * @returns the state with `live` cleared.
 */
function dropCrossedLive(state: DcpState): DcpState {
  return state.live === null ? state : { ...state, live: null }
}

/**
 * Close an open manual unlock, leaving everything else alone.
 *
 * Manual mode's contract is "compaction runs only after an explicit request", so
 * the authorisation has to end when the attempt it bought is over — when the turn
 * ends, or when that attempt fails. The returned reference is unchanged when
 * nothing was armed, which keeps the fold's "same reference means no visible
 * change" promise for every ordinary event.
 *
 * @param state - state that may still carry an unlock.
 * @returns the state with `manualCommandId` and `manualCallId` cleared.
 */
function disarmManual(state: DcpState): DcpState {
  return state.manualCommandId === null && state.manualCallId === null
    ? state
    : { ...state, manualCommandId: null, manualCallId: null }
}

/**
 * Fold one committed event into DCP state.
 * @param state - state covering every prior event.
 * @param event - the next committed event.
 * @returns the next state; the same reference when the event is not ours.
 */
export function applyDcpEvent(state: DcpState, event: SessionEvent): DcpState {
  switch (event.type) {
    case 'turn/start': {
      const turn = (event.data as { turn: number }).turn
      return dropCrossedLive(state.turn === turn ? state : { ...state, turn })
    }
    case 'turn/end': {
      // An unlock buys one turn's worth of compaction. Without this, a single
      // `/dcp-compact` — even one whose attempt failed — left the gate open for
      // the rest of the session (nine turns later, and after failures, the model
      // could still compress on its own).
      const ended = disarmManual(state)
      return dropCrossedLive(ended.turn === null ? ended : { ...ended, turn: null })
    }
    case 'command/run': {
      const data = event.data as { commandId: string; name: string; args?: string }
      if (data.name !== 'dcp-compact') return state
      // A bare `/dcp-compact` is the explicit request manual mode waits for;
      // anything else — including the host's own `/compact`, which runs a
      // different backend — is an ordinary invocation. A fresh request starts
      // without the previous one's call id, so a late result cannot spend it.
      return { ...state, manualCommandId: data.commandId, manualCallId: null }
    }
    case 'tool/call': {
      const data = event.data as { turn: number; callId: string; name: string; arguments: string }
      if (data.name !== 'compact') return state
      // Remember the call a live unlock authorised: its result names only itself
      // (see `tool/result`), and even a call whose arguments do not parse must be
      // able to spend an authorisation it can never fulfil.
      const armed = state.manualCommandId === null ? state : { ...state, manualCallId: data.callId }
      const pending = pendingCallFrom(data.callId, data.turn, data.arguments)
      if (pending === undefined) return armed
      return { ...armed, pendingCall: pending }
    }
    case 'compaction/start': {
      const data = event.data as { compactionId: string; turn: number | null }
      return { ...state, live: { compactionId: data.compactionId, turn: data.turn } }
    }
    case 'compaction/summary': {
      const data = event.data as {
        compactionId: string
        shadowedRange: { start: number; end: number }
        shadowedSeqs: readonly number[]
        shadowedTokenCount: number
      }
      return {
        ...state,
        pendingSummary: {
          compactionId: data.compactionId,
          seq: event.seq as number,
          spanStart: data.shadowedRange.start,
          spanEnd: data.shadowedRange.end,
          shadowed: [...data.shadowedSeqs],
          tokens: data.shadowedTokenCount,
        },
      }
    }
    case 'compaction/end': {
      const data = event.data as { error?: unknown; sourceCommandId?: unknown }
      // A transaction that closed with an error never produced a block, so the
      // manual request it was carrying has failed and must not keep the gate
      // open. Only OUR transaction counts: an aborted compaction from another
      // producer must not spend a request it knows nothing about.
      const abortedOurs = typeof data.error === 'string' && data.error.length > 0
        && typeof data.sourceCommandId === 'string' && data.sourceCommandId === state.manualCommandId
      const released = abortedOurs ? disarmManual(state) : state
      return released.live === null ? released : { ...released, live: null }
    }
    case 'compaction/prune': {
      const data = event.data as {
        shadowedSeqs: readonly number[]
        shadowedTokenCount: number
      }
      return {
        ...state,
        pendingPrune: { seq: event.seq as number, shadowed: [...data.shadowedSeqs], tokens: data.shadowedTokenCount },
      }
    }
    case 'tool/result': {
      // A failed `compact` call spends the manual authorisation it was made
      // under: the explicit request produced nothing, and manual mode means the
      // next attempt waits for another one. The result names only the call it
      // answers, so the call id remembered at `tool/call` is what ties the two.
      const result = event.data as { message?: { toolCallId?: string; isError?: boolean } }
      const failedCall = result.message?.isError === true ? result.message.toolCallId : undefined
      const released = failedCall !== undefined && state.manualCallId !== null && failedCall === state.manualCallId
        ? disarmManual(state)
        : state
      const op = replaceOp(event)
      if (op === undefined) return released
      const reason = pruneReasonOf(event)
      if (reason === undefined) return released
      const tokens = released.pendingPrune?.tokens ?? 0
      return {
        ...released,
        pruneCount: released.pruneCount + 1,
        prunedTokens: released.prunedTokens + tokens,
        pendingPrune: null,
      }
    }
    case 'user/message':
      return applyUserMessage(state, event)
    default:
      return state
  }
}

/** Fold one user message: a checkpoint that opens a block, a rehydration, or a notice. */
function applyUserMessage(state: DcpState, event: SessionEvent): DcpState {
  const source = messageSource(event)
  if (source === undefined) return state

  if (source['kind'] === 'dsh-dcp') {
    const rehydrates = source['rehydrates']
    if (typeof rehydrates === 'string') {
      const blocks = state.blocks.map((block) =>
        block.id === rehydrates ? { ...block, deactivatedByUser: true, rehydratedSeq: event.seq as number } : block)
      return { ...state, blocks }
    }
    const recompresses = source['recompresses']
    if (typeof recompresses === 'string') {
      const blocks = state.blocks.map((block) => {
        if (block.id !== recompresses) return block
        const { deactivatedByUser: _dropped, rehydratedSeq: _seq, ...rest } = block
        return rest
      })
      return { ...state, blocks }
    }
    // Every DCP-authored message is a notice for the panel, but only a nudge may
    // move the reminder anchor. A prune announcement used to reset the spacing to
    // its own seq, so in a session whose dedup pass reports every few turns the
    // real reminder was permanently deferred: the anchor said "we just spoke"
    // about a message that never asked for compaction. The two kinds share one
    // source, so the nudge's framing text is the discriminator (`isNudgeText`).
    return { ...state, notices: state.notices + 1, ...(isNudgeText(messageText(event)) ? { lastNudgeSeq: event.seq as number } : {}) }
  }

  if (source['kind'] !== 'compact-checkpoint') return state
  const op = replaceOp(event)
  if (op === undefined) return state

  const compactionId = typeof source['compactionId'] === 'string' ? source['compactionId'] : undefined
  if (compactionId === undefined) return state
  const sourceCommandId = typeof source['sourceCommandId'] === 'string' ? source['sourceCommandId'] : undefined

  const summary = state.pendingSummary?.compactionId === compactionId ? state.pendingSummary : undefined
  const shadowed = summary?.shadowed ?? [...((event as EventShape).sourceEventSeqs ?? [])]
  const id = `b${state.blocks.length + 1}`

  const consumed: string[] = []
  const blocks = state.blocks.map((block) => {
    if (!shadowed.includes(block.seq)) return block
    if (block.consumedBy !== undefined) return block
    consumed.push(block.id)
    return { ...block, consumedBy: id }
  })

  // Only a transaction THIS plugin minted may claim the parked call: a
  // checkpoint is just a checkpoint, whatever produced it, and the Harness's own
  // `/compact` or another plugin would otherwise walk off with this call's topic.
  //
  // The call is claimed WHOLE, by the first checkpoint of the batch, and then
  // dropped. An earlier attempt parcelled it out one entry per checkpoint,
  // assuming the built entries line up with the requested handles — they do not:
  // `buildEntries` drops an entry whose range is invalid, so the third checkpoint
  // of a three-entry request would claim the second handle and a block would end
  // up carrying a stranger's boundaries. Putting the batch's own span on the
  // first block is a smaller lie than that, and it cannot drift.
  const owned = compactionId.startsWith(COMPACTION_ID_PREFIX)
  const pending = owned ? state.pendingCall : null
  const handles = handlesOf(pending?.entries[0])
  const block = {
    id,
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    seq: event.seq as number,
    summarySeq: summary?.seq ?? (event.seq as number),
    // The shadowed span is contiguous on the SURFACE, but its sequence numbers
    // are not sorted: a rewritten node keeps its slot and takes a higher seq, so
    // a later node can carry a lower one. Reporting the endpoints in the order
    // the surface met them printed ranges like `seq 33..17`, so these are the
    // bounds of the set instead — min..max — which is the only reading of a seq
    // range that holds.
    spanStart: Math.min(op.startSeq, op.endSeq),
    spanEnd: Math.max(op.startSeq, op.endSeq),
    shadowed: [...shadowed],
    tokens: summary?.tokens ?? 0,
    ...(pending?.topic === undefined ? {} : { topic: pending.topic }),
    ...(handles.startId === undefined ? {} : { startId: handles.startId }),
    ...(handles.endId === undefined ? {} : { endId: handles.endId }),
    consumed,
  }

  return {
    ...state,
    blocks: [...blocks, block],
    pendingSummary: null,
    pendingCall: owned ? null : state.pendingCall,
    // The compression the manual request asked for is now in the log, so the
    // authorisation is spent together with the call id that carried it.
    ...(sourceCommandId === undefined ? {} : { manualCommandId: null, manualCallId: null }),
  }
}

const wireBlockSchema = z.object({
  id: z.string(),
  from: z.number(),
  to: z.number(),
  nodes: z.number(),
  tokens: z.number(),
  topic: z.string().optional(),
})

/** Validates the panel payload before it leaves the host. */
export const dcpWireSchema = z.object({
  blocks: z.array(wireBlockSchema),
  absorbed: z.number(),
  prunes: z.number(),
  prunedTokens: z.number(),
  notices: z.number(),
})

/**
 * Views already built, one per fold state, held weakly.
 *
 * The fold replaces the state reference whenever something changes and reuses it
 * otherwise, so keying on the state object gives exactly the wanted lifetime: an
 * untouched projection republishes nothing, and a state the projection has
 * dropped takes its cached view with it. A single process-wide slot could not:
 * two sessions in one process evicted each other's entry on every read, so each
 * read rebuilt the payload and the client republished a view whose content had
 * not changed.
 */
const viewCache = new WeakMap<DcpState, DcpWireView>()

/**
 * Project the fold state into the panel payload.
 * @param state - current fold state.
 * @returns the wire view, reusing the previous object while nothing visible changed.
 */
export function dcpWireView(state: DcpState): DcpWireView {
  const cached = viewCache.get(state)
  if (cached !== undefined) return cached
  const blocks = state.blocks
    // Same two filters as `enumerateTargets` and `renderTargets`: a block a
    // later compaction absorbed, or one the user retired, is not something the
    // panel should still offer as active.
    .filter((block) => block.consumedBy === undefined && block.deactivatedByUser !== true)
    .map((block) => ({
      id: block.id,
      from: block.spanStart,
      to: block.spanEnd,
      nodes: block.shadowed.length,
      tokens: block.tokens,
      ...(block.topic === undefined ? {} : { topic: block.topic }),
    }))
  const view: DcpWireView = {
    blocks,
    // Two different fates, one of which is not absorption. A block consumed by a
    // later compaction had its body folded into that block's summary; a block the
    // user retired was decompressed, and counting the two together told the panel
    // that a user's own decompression had been "absorbed".
    absorbed: state.blocks.filter((block) => block.consumedBy !== undefined).length,
    prunes: state.pruneCount,
    prunedTokens: state.prunedTokens,
    notices: state.notices,
  }
  viewCache.set(state, view)
  return view
}

/** The registered unit's definition, exported so tests can fold without a registry. */
export const dcpProjectionDefinition = {
  key: 'dcp' as const,
  stateVersion: DCP_STATE_VERSION,
  stateSchema: dcpStateSchema,
  init: (_header: SessionHeader): DcpState => initialDcpState(),
  apply: applyDcpEvent,
  wire: { viewSchema: dcpWireSchema, view: dcpWireView },
}

export type { DcpState }
