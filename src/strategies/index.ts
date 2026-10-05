/**
 * The automated strategy: deterministic, model-free content pruning.
 *
 * It operates on the derived view — the tool call/result pairs currently on the
 * surface — and is idempotent: a node that already carries a DCP placeholder is
 * never a candidate again, so a repeated pass writes nothing.
 *
 * Porting note: upstream ALSO strips the ARGUMENTS of an errored tool call
 * after N turns, and deliberately leaves the error message alone, because the
 * message is what the model needs to fix the problem. That is not expressible
 * here — the model sees those arguments inside the assistant message's
 * `tool-call` blocks, and an `assistant/message` can never be a surface
 * replacement (the session forbids its `sourceEventSeqs`, which every
 * replacement must carry).
 *
 * A `purgeErrors` strategy used to fill that gap by rewriting the errored
 * OUTPUT of failures that were not duplicates. It was wrong: it kept the
 * arguments it could not use and discarded the only diagnosis the model had,
 * for a failure it could not otherwise recover. That strategy is gone.
 *
 * Deduplication is a different rule: it keys on the call signature (`name` +
 * normalized arguments), so two identical calls are one repeated call and the
 * older repetition is superseded. The newest result always survives with its
 * error text and `isError` flag intact; and when that newest result FAILED, the
 * newest earlier SUCCESS survives alongside it, because the two are different
 * evidence — a failure does not supersede a success, and a pruned node has no
 * recall path, so eliding it would lose the only good output the group had.
 * Two residual costs remain, both deliberate: a repeated pair whose failures
 * differ (transient vs permanent) still elides the older diagnosis, and a
 * repeated successful pair whose outputs differ still elides the older output.
 *
 * @module dsh-dcp/strategies
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { Config } from '../config.ts'
import { manualFor } from '../config.ts'
import { collectFilePaths, isProtected, matchesAny } from '../protected.ts'
import { contentOf, eventText } from '../surface.ts'
import type { DcpState } from '../types.ts'
import { PRUNE_OUTPUT_PLACEHOLDER } from '../types.ts'

/** One tool call and its result currently on the surface. */
export interface ToolPair {
  callId: string
  name: string
  /** Raw JSON argument string, as the model produced it. */
  arguments: string
  /** Turn the call ran in. */
  turn: number
  /** Surface seq of the paired `tool/result`. */
  resultSeq: number
  /**
   * Whether the call failed.
   *
   * Deduplication keys on the call signature, not on this flag; it reads the
   * flag only to decide whether a newer repetition may supersede an older one
   * (a failure may not supersede a success — see the module note).
   */
  isError: boolean
  /** Model-visible text of the result. */
  resultText: string
  /**
   * The result event's durable `meta` presentation payload, when the producing
   * tool attached one. Read for its declared file locations: for some tools the
   * only path in the event lives here, not in the arguments (audit STATE-6).
   */
  meta?: unknown
}

/**
 * One node selected for rewriting.
 *
 * No `reason` field: the only kind of rewrite this plugin performs now is
 * "this tool result is duplicated", and a field with one possible value only
 * pretends there is a choice. The `question` wording that used to live here came
 * from upstream's question-tool handling, whose write path this plugin never had.
 */
export interface Candidate {
  seq: number
  tokens: number
  label: string
}

/** Resolve one tool's declared file locations for a set of arguments. */
export type DeclaredPaths = (name: string, args: unknown) => readonly string[]

/**
 * Derive every tool call/result pair that is currently on the surface.
 *
 * Surface membership is what matters: a pair whose result was already shadowed
 * by a compaction is not a candidate, and a call whose result never landed is
 * skipped rather than guessed.
 *
 * @param session - session to read.
 * @returns pairs in surface order.
 */
export function collectToolPairs(session: Session): ToolPair[] {
  const calls = new Map<string, { name: string; arguments: string; turn: number }>()
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { callId: string; name: string; arguments: string; turn: number }
    calls.set(data.callId, { name: data.name, arguments: data.arguments, turn: data.turn })
  }

  const pairs: ToolPair[] = []
  for (const raw of session.surface.nodes) {
    const seq = Number(raw)
    const event = session.eventAt(raw)
    if (event?.type !== 'tool/result') continue
    const data = event.data as { message?: { toolCallId?: string; isError?: boolean }; meta?: unknown }
    const callId = data.message?.toolCallId
    if (callId === undefined) continue
    const call = calls.get(callId)
    if (call === undefined) continue
    pairs.push({
      callId,
      name: call.name,
      arguments: call.arguments,
      turn: call.turn,
      resultSeq: seq,
      isError: data.message?.isError === true,
      resultText: eventText(event),
      meta: data.meta,
    })
  }
  return pairs
}

/** Normalize a JSON argument string for signature comparison. */
function normalizeArguments(raw: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(raw)))
  } catch {
    return raw
  }
}

/**
 * Recursively sort object keys and drop null/undefined so two equal calls match.
 *
 * The null-dropping is deliberate and load-bearing: a model that fills an
 * optional parameter with an explicit `null` has made the same call as one that
 * omitted it, and `tests/strategies.test.ts` pins that reading
 * (`{"path":"a.ts"}` dedupes against `{"path":"a.ts","offset":null}`).
 *
 * The known cost is that two calls which merely mention *different* optional
 * keys with null values collapse together (`{"exclude":null}` vs
 * `{"path":null}`) and the older one is rewritten as superseded. That is only
 * wrong for a tool that distinguishes an explicit null from an absent key,
 * which the argument-unaware signature cannot see; narrowing it would give up
 * the case above, which is the far more common shape.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child === undefined || child === null) continue
    out[key] = sortKeys(child)
  }
  return out
}

/** Parse one call's arguments, tolerating a malformed string. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Whether one pair is inside the protected window or matches a protection rule. */
function isShielded(
  pair: ToolPair,
  protectedTools: readonly string[],
  config: Config,
  declaredPaths: DeclaredPaths,
  currentTurn: number | null,
): boolean {
  const turnProtection = config.turnProtection
  if (turnProtection?.enabled === true && currentTurn !== null) {
    if (currentTurn - pair.turn < (turnProtection.turns ?? 4)) return true
  }
  const args = parseArguments(pair.arguments)
  const paths = collectFilePaths(args, declaredPaths(pair.name, args), pair.meta)
  return isProtected(pair.name, protectedTools, paths, config.protectedFilePatterns ?? [])
}

/**
 * Select the older duplicates of identical tool calls.
 * @param pairs - surface tool pairs in order.
 * @param config - resolved configuration.
 * @param declaredPaths - resolver for a tool's declared locations.
 * @param currentTurn - the open turn number, for turn protection.
 * @param price - heuristic token price per surface node.
 * @returns the results to rewrite, keeping the newest call of each signature.
 */
export function deduplicationCandidates(
  pairs: readonly ToolPair[],
  config: Config,
  declaredPaths: DeclaredPaths,
  currentTurn: number | null,
  price: (seq: number) => number,
): Candidate[] {
  const strategy = config.strategies?.deduplication
  if (strategy?.enabled === false) return []
  // Every "protect this tool" list reaches deduplication. The strategy's own
  // list is the explicit one; `commands.protectedTools` governs the sweep and
  // the panel but has always exempted deduplication too (its default keeps
  // `write`/`edit` receipts out); `compaction.protectedTools` promises that a
  // tool's output is "not condensed away", which deduplication also does.
  // Reading only the first two left the summarizer's knob a silent no-op here
  // while the sweep's knob silently switched deduplication off — the wiring
  // mismatch the audit filed as CORE-5 / STATE-4.
  const protectedTools = [
    ...(strategy?.protectedTools ?? []),
    ...(config.commands?.protectedTools ?? []),
    ...(config.compaction?.protectedTools ?? []),
  ]

  const bySignature = new Map<string, ToolPair[]>()
  for (const pair of pairs) {
    if (isShielded(pair, protectedTools, config, declaredPaths, currentTurn)) continue
    if (pair.resultText.includes(PRUNE_OUTPUT_PLACEHOLDER)) continue
    const signature = `${pair.name}::${normalizeArguments(pair.arguments)}`
    const group = bySignature.get(signature)
    if (group === undefined) bySignature.set(signature, [pair])
    else group.push(pair)
  }

  const candidates: Candidate[] = []
  for (const group of bySignature.values()) {
    if (group.length < 2) continue
    const newest = group[group.length - 1]
    if (newest === undefined) continue
    // The newest repetition survives. It supersedes the older ones only when
    // they are the same kind of evidence: a FAILURE does not supersede an
    // earlier SUCCESS, so when the newest result errored and some earlier
    // repetition succeeded, that newest success survives too. Otherwise a
    // transient failure would silently elide the only good output the group
    // ever produced — and a pruned node has no recall path (only compaction
    // blocks are addressable), so the information would be gone for good.
    const survivors = new Set<ToolPair>([newest])
    if (newest.isError) {
      for (let index = group.length - 2; index >= 0; index -= 1) {
        const pair = group[index]
        if (pair !== undefined && !pair.isError) {
          survivors.add(pair)
          break
        }
      }
    }
    for (const pair of group) {
      if (survivors.has(pair)) continue
      candidates.push({
        seq: pair.resultSeq,
        tokens: price(pair.resultSeq),
        label: `${pair.name} duplicate`,
      })
    }
  }
  return candidates
}

/**
 * Whether the strategies may write at all.
 * @param config - resolved configuration.
 * @param state - derived DCP state.
 * @returns true when a strategy pass is allowed.
 */
export function strategiesAllowed(config: Config, state: DcpState): boolean {
  if (state.live !== null) return false
  // A surface replacement is only legal inside an open turn. The storage
  // validator enforces that on read (`tool/result is outside an open turn`),
  // and it only runs when someone loads the log again — so writing outside a
  // turn corrupts the session silently and is discovered much later. This gate
  // is the last line of defence behind the caller's timing.
  if (state.turn === null) return false
  // Manual mode silences the nudges and gates the tool; it stops the
  // model-free strategies only when the deployment says so, which is the same
  // split the configuration offers.
  if (manualFor(config) && config.manualMode?.automaticStrategies === false) return false
  return true
}

export { matchesAny }
