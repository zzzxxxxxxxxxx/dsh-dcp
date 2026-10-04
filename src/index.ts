/**
 * `dsh-dcp` — dynamic context pruning for the DeepSeek Harness.
 *
 * The plugin takes its cue from opencode-dcp's model-driven compaction, fitted
 * to the Harness's event-sourced session: the agent model authors every summary
 * inside a `compact` tool call, and the plugin commits it as a native compaction
 * transaction. Deduplication is a model-free rewrite of `tool/result`
 * content; failed output is left alone, because upstream prunes a failed
 * call's INPUTS and keeps the message, which this port cannot do. All state is derived by folding the
 * session log; nothing is persisted outside it.
 *
 * @module dsh-dcp
 */
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type imports: each pulls the declaration merge that puts the
// service on `Context` (sessionProjections, commands, systemPrompt, tokenMeter,
// approval) without importing any value at runtime.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-user-approval'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DcpState } from './types.ts'
import { SUMMARY_HEADER, initialDcpState } from './types.ts'
import { Config as ConfigSchema, manualFor, resolveConfig, validateConfigKeys } from './config.ts'
import type { Config as DcpConfig } from './config.ts'
import type { SurfaceTarget } from './surface.ts'
import { dcpProjectionDefinition } from './projection.ts'
import { enumerateTargets } from './boundaries.ts'
import { describeProblem, resolveRange } from './boundaries.ts'
import { appendMissingBlocks, blockMarker, checkPlaceholders, expandPlaceholders, wrapSummary } from './placeholders.ts'
import { PROTECTED_BODY_MAX, boundBody, isProtected, matchesAny } from './protected.ts'
import { commitCompression } from './transaction.ts'
import type { CompressionEntry } from './transaction.ts'
import { contentOf, eventAt, surfaceSeqs } from './surface.ts'
import { loadPrompts, promptFingerprint } from './prompts/index.ts'
import { trace } from './trace.ts'
// Importing this module is also what registers the `dsh-dcp` message source
// kind with `@deepseek-ai/dsh-llm`; the constant keeps the literal in one place.
import { DCP_SOURCE } from './source.ts'
import type { LoadedPrompts } from './prompts/index.ts'
import { SessionMutex, runStrategies } from './runner.ts'
import { findBlock, recallBlock } from './recall.ts'
import { nudgeVerdict, readPressure, type Pressure } from './nudges.ts'

/** Cordis plugin name, used for fiber diagnostics. */
export const name = 'dsh-dcp'

/** Services that must exist before the plugin activates. */
export const inject = ['tools', 'sessionProjections']

/** The plugin configuration schema. */
export const Config = ConfigSchema

/** Build the dynamic prompt section text. */
function guidanceFor(config: DcpConfig): string {
  if (config.compaction?.permission === 'deny') {
    // Under `deny` the compaction tools are never registered, so the section
    // must not teach a vocabulary the model cannot use — that burns a turn on a
    // tool call that cannot resolve. Deduplication and pruning do keep running,
    // and their notices still carry the plugin name, so the section stays honest
    // about what the model will observe.
    return 'Dynamic context pruning (dsh-dcp) is active: superseded duplicate tool outputs are rewritten automatically. '
      + 'Compaction is disabled in this deployment — there is no compact, compact_targets or recall tool.'
  }
  const lines: string[] = []
  lines.push('Dynamic context pruning (dsh-dcp) is active.')
  lines.push('compact collapses a contiguous span into one summary. Pass {startId, endId, summary} entries.')
  if (config.manualMode?.enabled === true) {
    lines.push('Manual mode is on: run exactly one compaction pass when asked, then stop.')
  }
  return lines.join('\n')
}

/** Everything the tools, the command, and the strategy pass share. */
export interface PluginRuntime {
  ctx: Context
  config: DcpConfig
  prompts: LoadedPrompts
  mutex: SessionMutex
  /** Reasons already reported per session by the nudge diagnostic. */
  nudgeBlocks: WeakMap<Session, Set<string>>
  stateOf(session: Session): DcpState
  priceOf(session: Session): (seq: number) => number | undefined
  /**
   * Price one model message with the meter's estimator.
   *
   * `undefined` when this deployment has no `tokenMeter` service. Callers omit
   * the strategy dep in that case rather than pass a zero-returning estimator,
   * which would report every pruned node as fully reclaimed.
   */
  estimateMessage(message: ToolResultMessage): number | undefined
  declaredPaths(name: string, args: unknown): readonly string[]
}

/**
 * A cheap fingerprint of the row's delivered configuration.
 *
 * `.volatile()` fields arrive as stable references: the settings page writes
 * through them, changing what they `get()` without replacing the raw object the
 * plugin was mounted with. Reading a value therefore cannot tell "unchanged"
 * from "changed", but reading through the references can. Anything that cannot
 * be rendered falls back to a value that always differs, which re-resolves every
 * time — correct, if not free.
 */
function configStamp(raw: unknown): string {
  try {
    return JSON.stringify(raw, (_key, value) => (
      typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get: () => unknown }).get()
        : value
    )) ?? ''
  } catch {
    return `unstringifiable:${Math.random()}`
  }
}

/** Assemble the runtime accessors the plugin bodies share. */
function runtime(ctx: Context, raw: unknown, prompts: LoadedPrompts, onPromptsReloaded?: () => void): PluginRuntime {
  // Configuration is live, not a mount-time snapshot.
  //
  // `dsh-settings` persists a settings edit by writing through the stable
  // references the schema handed the row and re-resolving the running fiber — it
  // does NOT remount the plugin. A captured snapshot therefore kept the old
  // thresholds until the next restart, which made the settings page look broken:
  // the file changed, the running process did not. Re-resolving the same raw
  // object reads the new values; the stamp keeps the unchanged case to one
  // stringify per read.
  let snapshot = resolveConfig(raw)
  let stamp = configStamp(raw)
  // The prompt store is live for the same reason, and by its own fingerprint:
  // turning `experimental.customPrompts` on (or editing an override file while it
  // is on) re-reads the four files and hands the caller a chance to re-register
  // the tools, whose descriptions come from those texts.
  let loaded = prompts
  let promptStamp = promptFingerprint(snapshot.experimental?.customPrompts === true)
  const refreshPrompts = (): void => {
    const enabled = snapshot.experimental?.customPrompts === true
    const next = promptFingerprint(enabled)
    if (next === promptStamp) return
    promptStamp = next
    loaded = loadPrompts(enabled, enabled)
    for (const warning of loaded.warnings) ctx.logger?.warn?.('dsh-dcp: %s', warning)
    trace('prompts/reloaded', { enabled, applied: loaded.applied.length, warnings: loaded.warnings.length })
    onPromptsReloaded?.()
  }
  return {
    ctx,
    get config(): DcpConfig {
      const next = configStamp(raw)
      if (next !== stamp) {
        const before = snapshot.experimental?.customPrompts === true
        stamp = next
        snapshot = resolveConfig(raw)
        trace('config/reloaded', {
          minContextLimit: snapshot.compaction?.minContextLimit,
          maxContextLimit: snapshot.compaction?.maxContextLimit,
          nudgeFrequency: snapshot.compaction?.nudgeFrequency,
          manualMode: snapshot.manualMode?.enabled === true,
          customPrompts: snapshot.experimental?.customPrompts === true,
        })
        // Eagerly, not on the next reminder: a deployment whose pressure never
        // reaches the band would otherwise keep the old tool descriptions until
        // the next restart — exactly the state this feature removes.
        if (before !== (snapshot.experimental?.customPrompts === true)) refreshPrompts()
      }
      return snapshot
    },
    get prompts(): LoadedPrompts {
      refreshPrompts()
      return loaded
    },
    mutex: new SessionMutex(),
    nudgeBlocks: new WeakMap(),
    stateOf(session) {
      return ctx.sessionProjections.stateOf(session, 'dcp') ?? initialDcpState()
    },
    /**
     * File paths a tool declares for one call.
     *
     * Asking the tool's own call presenter is strictly better than guessing
     * argument names: a tool that renders an inline diff already knows which
     * files the call touches.
     */
    declaredPaths(name, args) {
      const definition = ctx.tools.get(name)
      const present = definition?.presentCall
      if (typeof present !== 'function') return []
      try {
        const view = present(args as never) as { locations?: readonly { path?: string }[] } | undefined
        return (view?.locations ?? []).map((location) => location.path ?? '').filter((path) => path.length > 0)
      } catch {
        return []
      }
    },
    priceOf(session) {
      const meter = ctx.get('tokenMeter')
      if (meter === undefined) return () => undefined
      const prices = new Map<number, number>()
      try {
        for (const node of meter.measure(session).nodes) {
          // The shadow-price protocol prices a replacement with the node's
          // fixed-heuristic value, so the meter's own O(1) fold agrees with the
          // appends it replays. The route price (`node.tokens`) is what trigger,
          // retention and range selection read; writing it here would leave the
          // fold permanently adrift for any node whose route price differs —
          // notably an image occurrence carrying the adapter's declared visual
          // price (dsh-token-meter types.d.ts:39-55).
          prices.set(node.seq as number, node.heuristicTokens)
        }
      } catch {
        return () => undefined
      }
      return (seq: number) => prices.get(seq)
    },
    /**
     * Price one model message with the meter's estimator.
     *
     * Resolved per call, never captured in `apply()`: `tokenMeter` is not in
     * this plugin's `inject` list, so the service may arrive after the mount —
     * the same reason `priceOf` looks it up lazily. The estimator is what makes
     * the reclaimed figure honest: a rewrite that keeps an attachment removes
     * less than the node's price (audit 06 §3.1).
     */
    estimateMessage(message) {
      return ctx.get('tokenMeter')?.estimateMessage(message)
    },
  }
}

/**
 * Logs are deliberately NOT captured here.
 *
 * The host's logger has no sink of its own (cordis keeps an in-memory ring, and
 * the app's exporter keeps warn/error for startup diagnostics), so this plugin
 * briefly installed an exporter to mirror its own `dsh-dcp:` lines into the
 * decision trace. That was removed again: `dsh-logger-panel` is the sink for the
 * whole host — every plugin's records, all levels, a live Settings page and
 * rotating JSONL files — and a second, plugin-local copy of the same lines buys
 * nothing. The decision trace stays decision-shaped: verdicts and their inputs,
 * which are not log lines at all.
 */
/** Whether DCP must leave this session alone. */
function isExcludedSession(session: Session, config: DcpConfig): boolean {
  const header = session.header as { origin?: string; delegationDepth?: number }
  const subagent = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
  return subagent && config.experimental?.allowSubAgents !== true
}

/** The routing facts a transaction records. */
function routing(session: Session, price: (seq: number) => number | undefined, shadowed: readonly number[]): { provider: string; model: string; shadowedTokens: number } {
  const header = session.requestHeader() as { config?: { provider?: string; model?: string } } | undefined
  const provider = header?.config?.provider ?? 'unknown'
  const model = header?.config?.model ?? 'unknown'
  let tokens = 0
  for (const seq of shadowed) tokens += price(seq) ?? 0
  return { provider, model, shadowedTokens: tokens }
}

/**
 * Collect the bodies that must survive one range.
 *
 * Two lists keep a body: `compaction.protectedTools` (by tool name) and
 * `protectedFilePatterns` (by the paths a call declared). The latter used to
 * reach deduplication only, so the setting's own description — "never pruned or
 * compacted away" — was half true: a `protectedFilePatterns` match still
 * disappeared from the model's history the moment a compaction covered its span.
 *
 * @param session - session being compacted.
 * @param shadowed - the surface seqs the range replaces.
 * @param config - resolved row configuration.
 * @param declaredPaths - resolves the paths one call declared, from its arguments;
 *   a throw counts as "declared nothing" rather than failing the range.
 * @returns the appendix to append to the summary, or an empty string.
 */
function protectionSuffix(
  session: Session,
  shadowed: readonly number[],
  config: DcpConfig,
  declaredPaths: (name: string, args: unknown) => readonly string[],
): string {
  const protectedTools = config.compaction?.protectedTools ?? []
  const protectUser = config.compaction?.protectUserMessages === true
  const protectedPaths = config.protectedFilePatterns ?? []
  // One pass over the log for every lookup in the loop below, not one per node:
  // `toolNameOf` used to rescan the whole event list on every call.
  const toolNames = toolNamesByCallId(session)
  const calls = protectedPaths.length === 0 ? undefined : toolCallsByCallId(session)
  const userBodies: string[] = []
  /**
   * The protected bodies, deduplicated by CONTENT — never by tool.
   *
   * An earlier version kept only the newest body of each tool, on the theory
   * that a later call supersedes an earlier one. That theory holds for state —
   * successive `todo_write` receipts describe one list — and fails for
   * everything else on the list. A `subagent` result is an ADDRESS: when the
   * child runs continuable, the tool returns `started subagent <id>`, that id is
   * the only way to `send_message` it afterwards, and nothing lists a parent's
   * subagent children (`list_agents` covers the teammate layer). Collapsing two
   * of those to one does not save space, it strands a child. `skill` fails the
   * same way, since two loads are two different skills.
   *
   * Identical text is redundant whoever produced it, so that is what collapses.
   * Distinct text is kept, because distinct is exactly what it is.
   */
  const toolBodies: string[] = []
  const seenBodies = new Set<string>()

  for (const seq of shadowed) {
    const event = eventAt(session, seq)
    if (event === undefined) continue
    const content = contentOf(event)
    const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    if (event.type === 'user/message') {
      if (protectUser && text.trim().length > 0) userBodies.push(boundBody(text.trim(), PROTECTED_BODY_MAX))
      // `<protect>` spans are bounded too: an unbounded one let a single span
      // defeat the compression it was supposed to survive.
      continue
    }
    if (event.type !== 'tool/result' || text.trim().length === 0) continue
    const name = toolNameOf(session, seq, toolNames)
    // A path-protected call is decided by the paths its ARGUMENTS declared, which
    // is the same source the deduplication pass reads.
    const call = calls === undefined ? undefined : toolCallOf(session, seq, calls)
    // `declaredPaths` is a plugin accessor, not a pure helper: a deployment can
    // mount one that throws. A throw here would abort the whole batch, so a call
    // whose paths cannot be resolved declares none.
    let paths: readonly string[] = []
    if (call !== undefined) {
      try {
        paths = declaredPaths(call.name, call.args)
      } catch {
        paths = []
      }
    }
    if (!isProtected(name, protectedTools, paths, protectedPaths)) continue
    const body = boundBody(text.trim(), PROTECTED_BODY_MAX)
    if (seenBodies.has(body)) continue
    seenBodies.add(body)
    toolBodies.push(body)
  }

  const parts: string[] = []
  if (userBodies.length > 0) {
    parts.push(`User messages preserved verbatim:\n\n${userBodies.join('\n\n')}`)
  }
  if (toolBodies.length > 0) {
    parts.push(`The following protected tool outputs were part of this conversation section:\n\n${toolBodies.join('\n\n')}`)
  }
  return parts.length === 0 ? '' : `\n\n${parts.join('\n\n')}`
}

/**
 * Index every tool call's name by its call id, in one pass.
 *
 * `protectionSuffix` resolves a name per shadowed node; scanning the event list
 * inside that loop made one compaction O(nodes × events).
 *
 * @param session - session to index.
 * @returns the `toolCallId → name` map.
 */
function toolNamesByCallId(session: Session): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { callId?: string; name?: string }
    if (typeof data.callId === 'string' && typeof data.name === 'string') names.set(data.callId, data.name)
  }
  return names
}

/** Resolve the tool name behind one `tool/result` node. */
function toolNameOf(session: Session, resultSeq: number, names?: Map<string, string>): string {
  const result = session.eventAt(resultSeq as never)
  if (result?.type !== 'tool/result') return ''
  const callId = (result.data as { message?: { toolCallId?: string } }).message?.toolCallId
  if (callId === undefined) return ''
  return (names ?? toolNamesByCallId(session)).get(callId) ?? ''
}

/** One tool call's name and parsed arguments, indexed by call id. */
interface ToolCallFacts {
  name: string
  args: unknown
}

/**
 * Index every tool call's name and arguments by its call id, in one pass.
 *
 * `protectionSuffix` needs the paths a call touched to honor
 * `protectedFilePatterns` the way the setting's description promises ("never
 * pruned or compacted away"), and the arguments are the only place those paths
 * are declared. Parsing them here keeps that to one pass per compaction, and an
 * unparsable payload simply declares nothing rather than failing the commit.
 *
 * @param session - session to index.
 * @returns the `toolCallId → {name, args}` map.
 */
function toolCallsByCallId(session: Session): Map<string, ToolCallFacts> {
  const calls = new Map<string, ToolCallFacts>()
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { callId?: string; name?: string; arguments?: unknown }
    if (typeof data.callId !== 'string' || typeof data.name !== 'string') continue
    let args: unknown
    if (typeof data.arguments === 'string') {
      try {
        args = JSON.parse(data.arguments)
      } catch {
        args = undefined
      }
    } else {
      args = data.arguments
    }
    calls.set(data.callId, { name: data.name, args })
  }
  return calls
}

/** Resolve the tool call behind one `tool/result` node. */
function toolCallOf(session: Session, resultSeq: number, calls: Map<string, ToolCallFacts>): ToolCallFacts | undefined {
  const result = session.eventAt(resultSeq as never)
  if (result?.type !== 'tool/result') return undefined
  const callId = (result.data as { message?: { toolCallId?: string } }).message?.toolCallId
  if (callId === undefined) return undefined
  return calls.get(callId)
}

/** One entry the caller asked for, before it is validated. */
interface RequestedEntry {
  startId: string
  endId: string
  summary: string
  topic?: string
}

/** Normalize either dialect into requested range entries. */
function requestedEntries(args: { content: readonly Record<string, unknown>[] }): { entries: RequestedEntry[]; problems: string[] } {
  const entries: RequestedEntry[] = []
  const problems: string[] = []
  for (const [index, item] of args.content.entries()) {
    const summary = typeof item['summary'] === 'string' ? item['summary'] : undefined
    if (summary === undefined || summary.trim().length === 0) {
      problems.push(`entry ${index + 1}: "summary" is required`)
      continue
    }
    const messageId = typeof item['messageId'] === 'string' ? item['messageId'] : undefined
    if (messageId !== undefined) {
      entries.push({ startId: messageId, endId: messageId, summary, ...(typeof item['topic'] === 'string' ? { topic: item['topic'] } : {}) })
      continue
    }
    const startId = typeof item['startId'] === 'string' ? item['startId'] : undefined
    const endId = typeof item['endId'] === 'string' ? item['endId'] : undefined
    if (startId === undefined || endId === undefined) {
      problems.push(`entry ${index + 1}: provide {startId,endId} or {messageId}`)
      continue
    }
    entries.push({ startId, endId, summary, ...(typeof item['topic'] === 'string' ? { topic: item['topic'] } : {}) })
  }
  return { entries, problems }
}

/** Build every validated entry before the first write lands, so a batch is all-or-nothing per entry. */
function buildEntries(
  rt: PluginRuntime,
  session: Session,
  requested: readonly RequestedEntry[],
  sourceCommandId: string | undefined,
  nextOrdinal: number,
): { entries: CompressionEntry[]; problems: string[] } {
  const state = rt.stateOf(session)
  const problems: string[] = []
  const entries: CompressionEntry[] = []
  /**
   * Ranges already claimed in this call, as SURFACE POSITIONS.
   *
   * Not seqs: a rewritten node keeps its surface slot but takes a new, higher
   * seq, so the surface is not seq-monotonic (a compacted session can read
   * 1,3,5,21,13,15,17). Comparing seqs therefore rejected adjacent entries that
   * do not actually overlap, and let real overlaps through to fail later at
   * commit time with an unrelated-looking message.
   */
  const claimed: Array<{ from: number; to: number }> = []
  // The surface cannot change while entries are built, so one snapshot serves
  // every range — and makes the position lookups comparable.
  const nodes = surfaceSeqs(session)

  for (const [index, request] of requested.entries()) {
    const resolved = resolveRange(session, request.startId, request.endId)
    if (!resolved.ok) {
      problems.push(`entry ${index + 1}: ${describeProblem(resolved.problem)}`)
      continue
    }
    const from = nodes.indexOf(resolved.startSeq)
    const to = nodes.indexOf(resolved.endSeq)
    if (from === -1 || to === -1) {
      problems.push(`entry ${index + 1}: ${describeProblem({ kind: 'not-on-surface', id: from === -1 ? request.startId : request.endId })}`)
      continue
    }
    const overlap = claimed.find((range) => from <= range.to && to >= range.from)
    if (overlap !== undefined) {
      problems.push(`entry ${index + 1}: overlaps another entry in this call`)
      continue
    }
    const shadowed = nodes.slice(from, to + 1)

    const blocksInRange = state.blocks.filter(
      (block) => block.consumedBy === undefined && block.deactivatedByUser !== true
        && shadowed.includes(block.seq),
    )
    const bodies = new Map<string, string>()
    for (const block of blocksInRange) {
      const stored = eventAt(session, block.seq)
      if (stored === undefined) continue
      bodies.set(block.id, contentOf(stored).filter((item) => item.type === 'text').map((item) => item.text).join('\n'))
    }
    const required = [...bodies.keys()]
    const check = checkPlaceholders(request.summary, required)
    if (check.unknown.length > 0) {
      problems.push(`entry ${index + 1}: (${check.unknown.join(') (')}) is not inside the selected range`)
      continue
    }
    if (check.duplicated.length > 0) {
      // A repeated placeholder inlines the same body twice, which spends context
      // to say the same thing — reject it rather than pay for it silently.
      problems.push(`entry ${index + 1}: (${check.duplicated.join(') (')}) is cited more than once; a block is inlined at its first mention only`)
      continue
    }
    const expanded = expandPlaceholders(request.summary, bodies)
    const completed = appendMissingBlocks(expanded, check.missing, bodies)
    const suffix = protectionSuffix(session, shadowed, rt.config, rt.declaredPaths)
    const blockId = `b${nextOrdinal + entries.length}`

    claimed.push({ from, to })
    entries.push({
      startSeq: resolved.startSeq,
      endSeq: resolved.endSeq,
      summary: wrapSummary(blockId, `${completed}${suffix}`),
      // What the panel shows: the model's summary, before this plugin appends
      // the protected-body appendix and wraps the whole thing in its framing.
      display: completed,
      ...(request.topic === undefined ? {} : { topic: request.topic }),
      startId: resolved.startId,
      endId: resolved.endId,
      blockId,
      consumedIds: required,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    })
  }

  return { entries, problems }
}

/**
 * Re-stamp one built entry with the block alias the log will actually record.
 *
 * `buildEntries` plans aliases optimistically — one per entry that passed its
 * checks — and bakes the alias into the summary's durable marker. A commit can
 * still fail, because `commitCompression` re-validates against the surface as
 * it stands at that moment. A failed entry leaves a gap, and without this
 * re-stamp every later entry would carry an alias one higher than the block the
 * projection actually creates, so `recall bN` would hand back the wrong
 * section. Deriving the alias from the live projection keeps the marker, the
 * alias the tool reports, and the log in step.
 *
 * @param rt - plugin runtime, for the live projection.
 * @param session - session receiving the transaction.
 * @param entry - the entry as built.
 * @returns the entry, with its alias corrected when it had drifted.
 */
function restampBlockId(rt: PluginRuntime, session: Session, entry: CompressionEntry): CompressionEntry {
  const actual = `b${rt.stateOf(session).blocks.length + 1}`
  if (actual === entry.blockId) return entry
  return {
    ...entry,
    blockId: actual,
    summary: entry.summary.replace(blockMarker(entry.blockId), blockMarker(actual)),
  }
}

/** Register the `compact_targets` tool. */
export function targetsTool(rt: PluginRuntime): ToolDefinition {
  return defineTool({
    name: 'compact_targets',
    description: rt.prompts.text['compact-targets'],
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          targets: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      // The listing is already the rendered content. Repeating it in
      // `presentationMeta` stored the same ~2 KB twice per call, so the panel
      // reads it back out of `content` instead (see `presentResult`).
      presentationMeta: (_args, value) => ({ targets: value.targets }),
    },
    presentCall: () => ({ card: 'generic', title: 'Read compaction targets', kind: 'other' }),
    presentResult: (_args, result) => {
      const meta = result.meta as { targets?: number } | undefined
      return { card: 'generic', title: `Compaction targets (${meta?.targets ?? 0})`, content: result.content }
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('compact_targets requires an owning agent session')
      const session = agent.session
      if (isExcludedSession(session, rt.config)) throw new Error('dsh-dcp does not run in subagent sessions (set experimental.allowSubAgents to enable)')
      const state = rt.stateOf(session)
      const price = rt.priceOf(session)
      const { targets, omitted } = enumerateTargets(session, state.blocks, price)
      const text = renderTargets(targets, state, omitted)
      return { text, targets: targets.length }
    },
  })
}

/** Render the target list for the model. */
function renderTargets(
  targets: readonly import('./surface.ts').SurfaceTarget[],
  state: DcpState,
  omitted: number,
): string {
  const lines: string[] = []
  const active = state.blocks.filter((block) => block.consumedBy === undefined && block.deactivatedByUser !== true)
  if (active.length > 0) {
    lines.push('Existing summaries (reference one as (bN) when your range covers it):')
    for (const block of active) {
      lines.push(`  ${block.id}  spans seq ${block.spanStart}..${block.spanEnd}${block.topic === undefined ? '' : `  "${block.topic}"`}`)
    }
    lines.push('')
  }
  lines.push('Conversation handles (oldest first):')
  for (const target of targets) {
    const cost = target.tokens === undefined ? '' : ` ~${target.tokens}tok`
    const cut = `${target.balancedBefore ? '<' : 'x'}${target.balancedAfter ? '>' : 'x'}`
    const label = target.block === undefined ? '' : ` [${target.block}]`
    lines.push(`  ${target.id}  ${target.kind}${cost} ${cut}${label}  ${target.preview}`)
  }
  if (omitted > 0) lines.push(`  … ${omitted} middle nodes omitted; ask again after compressing the oldest ones`)
  lines.push('')
  lines.push('A "<" / ">" pair marks a legal cut on that side; compact snaps to the nearest legal cut when you pick a different edge.')
  return lines.join('\n')
}

/** Register the `compact` tool. */
export function compactTool(rt: PluginRuntime): ToolDefinition {
  return defineTool({
    name: 'compact',
    description: rt.prompts.text['compact'],
    parameters: {
      topic: { type: 'string', required: true, description: 'Short label for this compaction pass.' },
      content: {
        type: 'array',
        required: true,
        description: 'One entry per span (range mode) or per message (message mode).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            startId: { type: 'string', description: 'Inclusive start handle from compact_targets.' },
            endId: { type: 'string', description: 'Inclusive end handle from compact_targets.' },
            messageId: { type: 'string', description: 'Single handle (message mode). May widen to the smallest span that keeps tool calls paired with their results.' },
            topic: { type: 'string', description: 'Optional per-entry label.' },
            summary: { type: 'string', required: true, description: 'The exhaustive replacement summary.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          blocks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                nodes: { type: 'integer', required: true },
              },
            },
          },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
      presentationMeta: (_args, value) => ({ message: value.message, blocks: value.blocks }),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Compact ${args.content.length} ${args.content.length === 1 ? 'span' : 'spans'}`,
      kind: 'other',
      rawInput: args.topic,
    }),
    presentResult: (_args, result) => {
      const meta = result.meta as { message?: string; blocks?: readonly { id: string }[] } | undefined
      const ids = (meta?.blocks ?? []).map((block) => block.id)
      return {
        card: 'generic',
        title: ids.length === 0 ? 'Nothing compacted' : `Compacted into ${ids.join(', ')}`,
        content: [{ type: 'text', text: meta?.message ?? '' }],
      }
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('compact requires an owning agent session')
      const session = agent.session
      if (isExcludedSession(session, rt.config)) throw new Error('dsh-dcp does not run in subagent sessions')
      if (rt.config.compaction?.permission === 'deny') throw new Error('compaction is denied by configuration')

      const state = rt.stateOf(session)
      if (state.live !== null) throw new Error('another compaction is already running for this session')
      if (manualFor(rt.config) && state.manualCommandId === null) {
        throw new Error('manual mode is on: compaction runs only after an explicit /dcp-compact request')
      }
      await approve(rt, exec, state)

      // The call-level `topic` is not read here: the block's topic reaches the
      // projection through the `tool/call` arguments, and a second copy on this
      // path only looked like a second source.
      const requested = requestedEntries({ content: (args.content ?? []) as readonly Record<string, unknown>[] })
      if (requested.entries.length === 0) {
        throw new Error(requested.problems.length > 0 ? `no usable entries: ${requested.problems.join('; ')}` : 'no entries supplied')
      }

      const price = rt.priceOf(session)
      const nextOrdinal = state.blocks.length + 1
      const sourceCommandId = state.manualCommandId ?? undefined
      const { entries, problems } = buildEntries(rt, session, requested.entries, sourceCommandId, nextOrdinal)

      if (entries.length === 0) {
        throw new Error(`no compaction was applied: ${problems.join('; ')}`)
      }

      const applied: Array<{ id: string; from: string; to: string; nodes: number }> = []
      // The entries that actually landed, so anything echoing them shows the
      // alias the log recorded rather than the one `buildEntries` predicted.
      const committed: CompressionEntry[] = []
      const failures: string[] = [...problems]
      for (const planned of entries) {
        const entry = restampBlockId(rt, session, planned)
        const outcome = commitCompression(session, entry, routing(session, price, entryRange(session, entry)), state.turn)
        if (!outcome.ok) {
          failures.push(`${entry.blockId}: ${describeFailure(outcome.failure)}`)
          continue
        }
        committed.push(entry)
        applied.push({ id: entry.blockId, from: entry.startId ?? '', to: entry.endId ?? '', nodes: outcome.shadowed.length })
      }

      const total = applied.reduce((sum, item) => sum + item.nodes, 0)
      const summary = rt.config.pruneNotification === 'off'
        ? `Compacted ${total} nodes into ${applied.map((item) => item.id).join(', ')}.`
        : `Compacted ${total} nodes into ${applied.map((item) => `${item.id} (${item.from}→${item.to})`).join(', ')}.`
      // A skipped entry belongs to the ANSWER to this call, not to the automatic
      // prune notice `pruneNotification: off` mutes. Dropping it told the model a
      // half-failed batch had succeeded: it asked for two spans, one landed, and
      // the only place the refusal survived was the panel's metadata.
      const headline = applied.length === 0
        ? `Nothing was compacted. ${failures.join('; ')}`
        : `${summary}${failures.length > 0 ? ` Skipped: ${failures.join('; ')}` : ''}`
      return { message: headline, blocks: applied, skipped: failures }
    },
  })
}

/** Resolve the shadowed seqs of one built entry for pricing. */
function entryRange(session: Session, entry: CompressionEntry): number[] {
  const nodes = surfaceSeqs(session)
  const from = nodes.indexOf(entry.startSeq)
  const to = nodes.indexOf(entry.endSeq)
  return from === -1 || to === -1 ? [] : nodes.slice(from, to + 1)
}

/** Render one commit failure for the model. */
function describeFailure(failure: { kind: string; seq?: number; startSeq?: number; endSeq?: number; reason?: string }): string {
  switch (failure.kind) {
    case 'range-not-on-surface': return `seq ${failure.seq ?? '?'} left the conversation`
    case 'inverted-range': return `seq ${failure.startSeq ?? '?'} comes after seq ${failure.endSeq ?? '?'} in the conversation — name the earlier handle as startId`
    case 'system-head': return 'the range covered the system prompt'
    case 'unbalanced-start': return `seq ${failure.seq ?? '?'} is not a safe start`
    case 'unbalanced-end': return `seq ${failure.seq ?? '?'} is not a safe end`
    default: return failure.reason ?? 'the transaction failed'
  }
}

/**
 * Ask the approval seam when the configuration requires it.
 *
 * A configuration that says `ask` is saying a human must agree before the
 * conversation's history is rewritten. When the seam is not mounted there is
 * nobody to ask, and returning quietly would approve the write on the user's
 * behalf — the one answer a permission check must never invent. Failing here is
 * not a degraded mode: it is the only reading of `ask` that means anything, and
 * the message says exactly what to change.
 */
async function approve(rt: PluginRuntime, exec: { agent?: { session: Session }; callId?: string; signal?: AbortSignal }, state: DcpState): Promise<void> {
  if (rt.config.compaction?.permission !== 'ask') return
  const approval = rt.ctx.get('approval')
  if (approval === undefined || exec.agent === undefined) {
    throw new Error(
      'compaction.permission is "ask", but no approval service is mounted and this call has no owning agent, '
      + 'so nobody can be asked. Mount @deepseek-ai/dsh-user-approval, or set compaction.permission to "allow" '
      + 'to compact without asking.',
    )
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'compact',
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    reason: `dsh-dcp wants to compact ${state.blocks.length === 0 ? 'conversation history' : `${state.blocks.length} existing summaries and history`}`,
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  } as never)
  if (outcome !== 'allowed-once') throw new Error(`compaction was not approved (${outcome})`)
}

/**
 * Register the `recall` tool.
 *
 * Exported so a test can compile it: `defineTool` validates the schema DSL at
 * definition time, which is exactly the check a service container would run.
 *
 * Read-only: it renders a block's original content out of the log into a
 * normal tool result and leaves the surface untouched, so compression does not
 * have to be lossy and the model can come back for a detail it compressed away.
 */
export function recallTool(rt: PluginRuntime): ToolDefinition {
  return defineTool({
    name: 'recall',
    description: [
      'Read back the original content a compaction removed, without changing the conversation.',
      'Pass the block handle a compaction reported (b1, b2, …) — compact_targets lists the current ones.',
      'Pass an optional query to get only the lines matching it, which is usually all you need and always cheaper.',
      'A long body comes back in pages; when the answer says it was truncated, call again with the offset it names.',
      'Use it when a summary you are relying on turns out to be missing a detail you now need.',
    ].join('\n'),
    parameters: {
      block: { type: 'string', required: true, description: 'Block handle, e.g. b2.' },
      query: { type: 'string', description: 'Optional case-insensitive line filter.' },
      offset: { type: 'integer', description: 'Character offset to start from, for a truncated body.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          chars: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          nodes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({ found: value.found, nodes: value.nodes, chars: value.chars }),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Recall ${args.block}${args.query === undefined ? '' : ` matching “${args.query}”`}`,
      kind: 'read',
    }),
    presentResult: (_args, result) => {
      const meta = result.meta as { nodes?: number; chars?: number } | undefined
      return {
        card: 'generic',
        title: `Recalled ${meta?.nodes ?? 0} nodes (${meta?.chars ?? 0} chars)`,
        content: result.content,
      }
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('recall requires an owning agent session')
      const session = agent.session
      const state = rt.stateOf(session)
      const block = findBlock(state, args.block)
      if (block === undefined) {
        const available = state.blocks.length === 0
          ? 'No compaction has run in this session yet.'
          : `Known blocks: ${state.blocks.map((item) => item.id).join(', ')}.`
        return { found: false, text: `Unknown block ${JSON.stringify(args.block)}. ${available}`, chars: 0, truncated: false, nodes: 0 }
      }
      const result = recallBlock(session, state, block, args.query, args.offset ?? 0)
      return { found: result.found, text: result.text, chars: result.chars, truncated: result.truncated, nodes: result.nodes }
    },
  })
}

/**
 * Install DCP: the projection unit, the model-facing tools, the prompt
 * section, and (when commands are enabled) the `/dcp-compact` command.
 * @param ctx - plugin context.
 * @param raw - the row configuration as cordis parsed it. Its volatile fields
 *   arrive as stable references and are unwrapped here, once.
 */
export function apply(ctx: Context, raw: DcpConfig = {} as DcpConfig): void {
  validateConfigKeys(raw)
  // Mount-time values, for the decisions that genuinely cannot change while the
  // plugin is mounted (prompt overrides are loaded once, tool registration is
  // fixed). Everything that can follow a settings edit reads `rt.config`, which
  // re-resolves the same raw object (see `runtime`).
  const config = resolveConfig(raw)
  const prompts = loadPrompts(config.experimental?.customPrompts === true, config.experimental?.customPrompts === true)
  // Tools carry the prompt texts as their descriptions, so a prompt reload has to
  // re-mount them: the host keeps the definition object it was handed and reads
  // `description` from that object. The runtime is built before the tools exist,
  // so the hook is a box this block fills in.
  let remountTools: () => void = () => {}
  const rt = runtime(ctx, raw, prompts, () => remountTools())
  for (const warning of prompts.warnings) ctx.logger?.warn?.('dsh-dcp: %s', warning)

  ctx.effect(() => ctx.sessionProjections.register(dcpProjectionDefinition as never), 'dsh-dcp: projection unit')

  // Automatic strategies run once per finished turn — but they WRITE on the
  // next turn boundary, not on the one they just saw end.
  //
  // A surface replacement is only legal inside an open turn, and the storage
  // validator enforces that rule on the next read, not on the write. Pruning
  // straight from `turn/end` therefore produced logs that could never be
  // loaded again (`tool/result is outside an open turn`), silently, on every
  // session this plugin ran in. Registering the finished turn here and doing
  // the work as the next turn opens keeps the pass once-per-turn while landing
  // the write where the format allows it: after `turn/start`, before any step.
  const pendingTurns = new WeakSet<Session>()
  ctx.effect(() => {
    // A pass queued as a microtask can outlive the plugin: unloading is what
    // happens when a setting is written, and the queued work would then write to
    // a session on behalf of a plugin that is no longer mounted. The flag is
    // checked at the microtask AND again inside the mutex, because a pass can
    // wait there for another task to finish.
    let live = true
    const off = ctx.on('session/event', (session: Session, event) => guarded(ctx, 'strategy listener', () => {
      if (rt.config.strategies?.deduplication?.enabled === false) return
      if (isExcludedSession(session, rt.config)) return
      if (event.type === 'turn/end') {
        pendingTurns.add(session)
        return
      }
      if (event.type !== 'turn/start') return
      if (!pendingTurns.delete(session)) return
      // Deferred and serialized for the same reason as before: this listener sits
      // inside another append, so writing here would trip the re-entrancy guard.
      queueMicrotask(() => {
        if (!live) return
        void rt.mutex.run(session, () => {
          if (!live) return { pruned: 0, tokens: 0, labels: [] }
          // Read once per pass: a settings write must not change the rules
          // halfway through a pass that is already selecting candidates.
          const config = rt.config
          const report = runStrategies(session, {
            config,
            stateOf: rt.stateOf,
            priceOf: rt.priceOf,
            declaredPaths: rt.declaredPaths,
            // Omitted, not stubbed, when the meter is absent: a zero-returning
            // estimator would make every rewrite look fully reclaimed.
            ...(ctx.get('tokenMeter') === undefined ? {} : { estimateMessage: (message) => rt.estimateMessage(message) }),
          })
          if (report.pruned > 0 && config.pruneNotification !== 'off') announce(rt, session, report.pruned, report.reclaimedTokens)
          trace('strategies/pass', { session: session.id, pruned: report.pruned, tokens: report.tokens, reclaimed: report.reclaimedTokens })
          return report
        }).catch((error: unknown) => {
          trace('strategies/failed', { session: session.id, error: describeError(error) })
          ctx.logger?.warn?.('dsh-dcp: strategy pass failed: %s', describeError(error))
        })
      })
    }))
    return () => {
      live = false
      off?.()
    }
  }, 'dsh-dcp: automatic strategies')

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(
      // Live: turning manual mode or a deny on must change the guidance the next
      // request carries, not the one after the next restart.
      () => scope.systemPrompt.section({ name: 'dsh-dcp', order: 500, text: () => guidanceFor(rt.config) }),
      'dsh-dcp: prompt section',
    )
  })

  // Whether the tools exist at all is a mount-time decision (`permission`,
  // `recall`); what they SAY is not, so a prompt reload only re-registers them.
  const toolDisposers: (() => void)[] = []
  remountTools = () => {
    for (const dispose of toolDisposers.splice(0)) dispose()
    if (config.compaction?.permission === 'deny') return
    toolDisposers.push(ctx.effect(() => ctx.tools.register(compactTool(rt)), 'dsh-dcp: compact tool'))
    toolDisposers.push(ctx.effect(() => ctx.tools.register(targetsTool(rt)), 'dsh-dcp: targets tool'))
    if (config.compaction?.recall !== false) {
      toolDisposers.push(ctx.effect(() => ctx.tools.register(recallTool(rt)), 'dsh-dcp: recall tool'))
    }
  }
  remountTools()

  watchNudges(rt)

  {
    // The host's own `/compact` stays registered and untouched: in the web
    // profile it is mounted per agent by that agent's preset, so a same-name
    // registration here would either be a hard duplicate error (inside the
    // agent scope) or silently shadowed (from the global scope). DCP therefore
    // ships under its own name and the two commands coexist.
    ctx.inject(['commands'], (scope) => {
      scope.effect(
        () => scope.commands.register({
          name: 'dcp-compact',
          description: 'Run a dsh-dcp compaction pass (optional focus)',
          input: { hint: '[focus]' },
          handler: (invocation) => handleCompactCommand(rt, invocation),
        }),
        'dsh-dcp: dcp-compact command',
      )
    })
  }

  ctx.logger?.info?.('dsh-dcp: active (permission=%s)', config.compaction?.permission ?? 'allow')
  // The trace's first line: which build, which thresholds, which gates. Without
  // it, a trace file that contains only "skip" lines cannot say whether the
  // deployment even has usable thresholds.
  trace('install', {
    permission: config.compaction?.permission ?? 'allow',
    minContextLimit: config.compaction?.minContextLimit,
    maxContextLimit: config.compaction?.maxContextLimit,
    nudgeFrequency: config.compaction?.nudgeFrequency,
    manualMode: config.manualMode?.enabled === true,
    deduplication: config.strategies?.deduplication?.enabled !== false,
    customPrompts: config.experimental?.customPrompts === true,
  })
}

/**
 * Watch finished steps for a nudge that is due, and inject it as a notice.
 *
 * Injection is safe from a `session/event` listener (it routes through the
 * inbox, not the log), but a nudge must not wake an idle agent: it waits for
 * the next admitted step, exactly like upstream's anchored reminders.
 */
function watchNudges(rt: PluginRuntime): void {
  // A decided reminder is delivered OUTSIDE the append that raised the decision.
  //
  // A `session/event` listener runs inside the append that published the event,
  // and delivering a reminder appends a `user/message` — so injecting straight
  // from the listener trips the store's re-entrancy guard (`session append cannot
  // reenter while another append is being published`), and the reminder was lost
  // every single time, silently, because the throw only reached a logger that
  // `dsh web` discards. The automatic pass learned this first and defers with a
  // microtask; a reminder has to do the same.
  //
  // A delivery that still fails — no live agent yet — is kept for one more
  // attempt at the next `turn/start`: a boundary reminder that cannot land
  // immediately is worth delivering at the start of the next turn.
  const pending = new Map<Session, string>()

  const deliver = (session: Session): void => {
    const waiting = pending.get(session)
    if (waiting === undefined) return
    if (rt.ctx.get('agents')?.get(session.id) === undefined) {
      trace('nudge/held', { session: session.id, reason: 'no-agent' })
      reportNudgeBlock(rt, session, 'no-agent', undefined)
      return
    }
    if (injectNotice(rt, session, waiting)) {
      pending.delete(session)
      trace('nudge/delivered', { session: session.id })
      return
    }
    trace('nudge/held', { session: session.id, reason: 'inject-refused' })
    reportNudgeBlock(rt, session, 'inject-refused', undefined)
  }

  rt.ctx.effect(() => rt.ctx.on('session/event', (session: Session, event) => guarded(rt.ctx, 'nudge listener', () => {
    if (event.type === 'turn/start') {
      // Retry outside this append, for the same reason the first attempt waits.
      if (pending.has(session)) queueMicrotask(() => deliver(session))
      return
    }
    if (event.type !== 'assistant/message' && event.type !== 'turn/end') return
    if (isExcludedSession(session, rt.config)) {
      trace('nudge/skip', { session: session.id, reason: 'excluded-session' })
      return
    }
    const meter = rt.ctx.get('tokenMeter')
    if (meter === undefined) {
      trace('nudge/skip', { session: session.id, reason: 'no-meter' })
      reportNudgeBlock(rt, session, 'no-meter', undefined)
      return
    }
    const state = rt.stateOf(session)
    if (manualFor(rt.config)) {
      trace('nudge/skip', { session: session.id, reason: 'manual-mode' })
      return
    }
    let current = 0
    try {
      current = meter.measure(session).totalTokens
    } catch (error) {
      reportNudgeBlock(rt, session, `meter-threw: ${describeError(error)}`, undefined)
      return
    }
    const pressure = readPressure(session, rt.config, current)
    const verdict = nudgeVerdict(session, rt.config, state, pressure, event.type === 'turn/end')
    if (verdict.kind === null) {
      trace('nudge/skip', {
        session: session.id,
        reason: verdict.reason,
        at: event.type,
        current,
        min: pressure.min,
        max: pressure.max,
        window: pressure.contextWindow,
        anchor: state.lastNudgeSeq,
      })
      reportNudgeBlock(rt, session, verdict.reason, pressure)
      return
    }
    const text = rt.prompts.text[verdict.kind === 'context-limit' ? 'context-limit-nudge' : 'turn-nudge']
    trace('nudge/due', { session: session.id, kind: verdict.kind, at: event.type, current, min: pressure.min, max: pressure.max })
    pending.set(session, text)
    queueMicrotask(() => deliver(session))
  })), 'dsh-dcp: nudges')
  // One line at install time. "The watcher never ran" and "the watcher ran and
  // found nothing due" are otherwise the same empty log.
  rt.ctx.logger?.info?.('dsh-dcp: nudge watcher installed')
}

/**
 * Say once per session why a nudge did not fire.
 *
 * `nudgeVerdict` answers `null` for eight different reasons and every one of
 * them is silent, so "nothing is due" and "the listener is broken" produce the
 * same empty log. One line per distinct reason per session is enough to tell
 * them apart, and it is the whole budget.
 *
 * The seen-set belongs to the runtime, not the module: it used to be a
 * module-level WeakMap, so a second `apply()` — a plugin reload, a second
 * profile mounting the same bundle — inherited the first application's memory
 * and silently swallowed the very diagnostics it exists to emit.
 *
 * This was briefly a file trace under `DSH_DCP_TRACE`, because `logger.info`
 * does not reach the console under `dsh web`. That was removed again: the plugin
 * is documented as leaving nothing behind, and the reasons themselves — which
 * are the durable half — stayed. The trace is back, but opt-in: `src/trace.ts`
 * writes only when the environment names a file, and every nudge decision now
 * lands there, which is what makes a silent refusal diagnosable.
 */
function reportNudgeBlock(rt: PluginRuntime, session: Session, reason: string, pressure: Pressure | undefined): void {
  let seen = rt.nudgeBlocks.get(session)
  if (seen === undefined) {
    seen = new Set()
    rt.nudgeBlocks.set(session, seen)
  }
  if (seen.has(reason)) return
  seen.add(reason)
  rt.ctx.logger?.info?.(
    'dsh-dcp: no nudge (%s) at %s tokens, min=%s max=%s',
    reason,
    pressure?.current ?? '-',
    pressure?.min ?? '-',
    pressure?.max ?? '-',
  )
}

/**
 * Run one listener body, converting a throw into a log line.
 *
 * A `session/event` listener runs inside the very append that emitted the
 * event, so an exception raised here propagates back into the Harness's write
 * path — not a place a plugin may fail, and the reason a listener body that
 * only *reads* still needs a boundary. Diagnostics degrade to a warning.
 *
 * @param ctx - plugin context, for the logger.
 * @param what - short name of the listener, for the message.
 * @param body - the listener body.
 */
function guarded(ctx: Context, what: string, body: () => void): void {
  try {
    body()
  } catch (error) {
    const message = describeError(error)
    trace('listener/failed', { what, error: message })
    ctx.logger?.warn?.('dsh-dcp: %s failed: %s', what, message)
  }
}

/**
 * Tell the user what an automatic pass changed.
 *
 * A notice is model-visible (the Harness has no user-only push channel), so it
 * is one bounded line and `pruneNotification: off` removes it entirely in
 * favour of the DCP panel.
 *
 * @param pruned - how many nodes the pass rewrote.
 * @param reclaimed - tokens the surface actually lost, which is less than the
 *   shadow price when a rewrite kept an attachment (`StrategyReport.reclaimedTokens`).
 */
function announce(rt: PluginRuntime, session: Session, pruned: number, reclaimed: number): void {
  injectNotice(rt, session, `dsh-dcp pruned ${pruned} superseded tool ${pruned === 1 ? 'output' : 'outputs'} (~${reclaimed} tokens reclaimed).`)
}

/**
 * Queue one model-facing DCP notice on a session's agent.
 *
 * The Harness has no user-only push channel, so a notice is durable and
 * model-visible by construction; keeping every message short is what keeps that
 * acceptable.
 */
function injectNotice(rt: PluginRuntime, session: Session, text: string): boolean {
  const agent = rt.ctx.get('agents')?.get(session.id)
  if (agent === undefined) return false
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...DCP_SOURCE, form: 'notice', summary: boundContextSummary(text) },
    }))
  } catch (error) {
    // A driver that is winding down can refuse input. Reporting that as a failed
    // injection keeps the caller's fallback (defer to the next turn) in charge,
    // instead of letting the throw abort whatever listener asked for the notice.
    trace('inject/failed', { session: session.id, error: describeError(error) })
    return false
  }
  return true
}

/** Render an unknown error for a log line. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One `/dcp-compact` invocation. */
async function handleCompactCommand(rt: PluginRuntime, invocation: CommandInvocation): Promise<CommandResult> {
  // Under `deny` neither of these tools is registered, so steering the model at
  // them would ask for a tool that does not exist and burn a turn discovering it.
  // Saying so is more useful than leaving the command to fail obscurely.
  if (rt.config.compaction?.permission === 'deny') {
    return { kind: 'error', text: 'Compaction is disabled by this deployment (compaction.permission = "deny").' }
  }
  const input = invocation.rawInput.trim()
  const session = invocation.agent.session
  const state = rt.stateOf(session)
  if (state.live !== null) return { kind: 'error', text: 'A compaction is already running.' }

  const focus = input.length === 0 ? '' : ` Focus on: ${input}.`
  const instruction = createUserMessage({
    content: [{
      type: 'text',
      text: `Run exactly one compaction pass with the compact tool: call compact_targets, then compact the oldest spans that are no longer needed.${focus} When the tool returns, continue the task.`,
    }],
    source: { ...DCP_SOURCE, form: 'notice', summary: 'dsh-dcp: compaction requested' },
  })
  invocation.agent.steer(instruction)
  return { kind: 'success', text: `Asked the model to run a compaction pass${focus.length === 0 ? '' : ` (focus: ${input})`}. Open the DCP panel for details.` }
}

export { SUMMARY_HEADER }
