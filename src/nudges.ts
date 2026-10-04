/**
 * Compression nudges.
 *
 * DCP's job in DSH is to make the model *choose* to compact, so the nudges are
 * plain model-facing notices rather than a policy that compacts on its own. Each
 * nudge is anchored: it is injected at most once per `nudgeFrequency` surface
 * nodes, and the anchor is derived from the log (the seq of our own last NUDGE),
 * so the spacing survives a restart with no extra state.
 *
 * @module dsh-dcp/nudges
 */
export { manualFor }
import type { Session } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'
import { manualFor, resolveLimit } from './config.ts'
import { NUDGE_PREFIX } from './prompts/index.ts'
import type { DcpState } from './types.ts'
import { eventAt, surfaceSeqs } from './surface.ts'

/** Which nudge, if any, is due right now. */
export type NudgeKind = 'context-limit' | 'turn'

/** Which nudge is due, or the guard that refused one. */
export interface NudgeVerdict {
  kind: NudgeKind | null
  /** `'due'` when a nudge was selected; otherwise the guard that said no. */
  reason: string
}

/** The pressure reading one nudge decision is based on. */
export interface Pressure {
  /** Combined request-and-response tokens of the latest measurement. */
  current: number
  /** Soft upper threshold, when one could be resolved. */
  max?: number
  /** Soft lower threshold, when one could be resolved. */
  min?: number
  /** The routed model's advertised context window, when known. */
  contextWindow?: number
}

/**
 * Whether one DCP-authored message is a nudge rather than an ordinary notice.
 *
 * Nudges and notices reach the log through the same `kind: 'dsh-dcp'` source —
 * `injectNotice` stamps both — so the fold has no structural discriminator to
 * key on. The durable one is the framing text every nudge opens with:
 * `NUDGE_PREFIX` is prepended by `loadPrompts` whenever a nudge template does not
 * carry it, so neither a user's override nor the built-in text can produce a
 * nudge without it. Deriving state from the prefix is what lets `lastNudgeSeq`
 * mean "the last reminder the model actually received" instead of "the last
 * thing DCP said" (see `src/projection.ts`).
 *
 * @param text - the model-visible text of one DCP message.
 * @returns true when that message is a nudge.
 */
export function isNudgeText(text: string): boolean {
  return text.trimStart().startsWith(NUDGE_PREFIX)
}

/**
 * Per-model limit lookup, falling back to the global setting.
 * @param map - the per-model override map.
 * @param key - `provider/model`.
 * @param fallback - the global specification.
 * @returns the specification to resolve.
 */
function limitFor(map: Record<string, number | string> | undefined, key: string, fallback: number | string | undefined): number | string | undefined {
  const override = map?.[key]
  return override ?? fallback
}

/**
 * Resolve the pressure thresholds for one session.
 * @param session - session whose route decides the window.
 * @param config - resolved configuration.
 * @returns the thresholds; `undefined` when a percentage has no known window.
 */
export function readPressure(session: Session, config: Config, current: number): Pressure {
  const header = session.requestHeader() as { config?: { provider?: string; model?: string } } | undefined
  const route = session.requestContext() as { contextWindow?: number } | undefined
  const model = header?.config?.model ?? ''
  const provider = header?.config?.provider ?? ''
  const key = `${provider}/${model}`
  const contextWindow = route?.contextWindow

  const compaction = config.compaction ?? {}
  const max = resolveLimit(limitFor(compaction.modelMaxLimits, key, compaction.maxContextLimit), contextWindow)
  const min = resolveLimit(limitFor(compaction.modelMinLimits, key, compaction.minContextLimit), contextWindow)
  return {
    current,
    ...(max === undefined ? {} : { max }),
    ...(min === undefined ? {} : { min }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

/**
 * Count the surface nodes appended after one sequence.
 * @param session - session to read.
 * @param sinceSeq - the anchor, or `null` to count the whole surface.
 * @returns the count in surface order.
 */
function nodesSince(session: Session, sinceSeq: number | null): number {
  const nodes = surfaceSeqs(session)
  if (sinceSeq === null) return nodes.length
  let count = 0
  for (const seq of nodes) {
    if (seq > sinceSeq) count += 1
  }
  return count
}

/**
 * Which nudge is due, and — when none is — which guard said no.
 *
 * Two nudges remain. The context-limit one repeats while pressure stays above
 * the strong threshold, whatever the moment. The turn one fires in the band
 * between the thresholds — both of which have to resolve for that band to exist
 * — and only at a TURN BOUNDARY: it is the moment the
 * model has finished answering and the user is reading, which is when "this
 * conversation has grown, earlier parts may no longer be needed" is worth
 * saying. A reminder in the middle of a working turn is an interruption, and an
 * iteration nudge used to be exactly that — counting nodes since the last user
 * message is not evidence that anything should be compacted, so it is gone.
 *
 * @param session - session being nudged.
 * @param config - resolved configuration.
 * @param state - derived DCP state.
 * @param pressure - the current reading.
 * @param atTurnBoundary - whether the event being handled is a `turn/end`.
 *   The turn nudge has no other way to reach the surface: an `assistant/message`
 *   always leaves an assistant node last, so a check that merely looked at the
 *   newest node never saw a boundary at all.
 * @returns the nudge to inject, or `null` with the guard that refused it.
 */
export function nudgeVerdict(
  session: Session,
  config: Config,
  state: DcpState,
  pressure: Pressure,
  atTurnBoundary: boolean,
): NudgeVerdict {
  if (config.compaction?.permission === 'deny') return { kind: null, reason: 'permission-deny' }
  if (manualFor(config)) return { kind: null, reason: 'manual-mode' }
  if (state.live !== null) return { kind: null, reason: 'compaction-in-flight' }
  if (pressure.max === undefined && pressure.min === undefined) return { kind: null, reason: 'no-thresholds' }

  const frequency = Math.max(1, Math.floor(config.compaction?.nudgeFrequency ?? 5))
  const spaced = nodesSince(session, state.lastNudgeSeq) >= frequency

  // The strong nudge needs only its upper threshold: "you are over the limit" is
  // a complete sentence on its own, and `max` alone still means it.
  if (pressure.max !== undefined && pressure.current > pressure.max) {
    return spaced ? { kind: 'context-limit', reason: 'due' } : { kind: null, reason: 'spacing' }
  }

  // The turn nudge lives in the band BETWEEN the thresholds, and a band needs
  // both ends. With `min` unresolved — a percentage lower threshold on a route
  // whose window is unknown is the everyday case — "between" would degrade to
  // `(-inf, max]`, so a 200-token session at its first turn boundary is told the
  // conversation may be long enough to compact. With `max` unresolved there is no
  // ceiling for the band either. Either way there is nothing honest to say.
  if (pressure.max === undefined || pressure.min === undefined) return { kind: null, reason: 'no-thresholds' }

  if (pressure.current < pressure.min) return { kind: null, reason: 'below-min' }
  if (surfaceSeqs(session).length === 0) return { kind: null, reason: 'empty-surface' }
  if (!atTurnBoundary) return { kind: null, reason: 'mid-turn' }
  return spaced ? { kind: 'turn', reason: 'due' } : { kind: null, reason: 'spacing' }
}
