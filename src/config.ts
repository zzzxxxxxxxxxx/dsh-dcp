/**
 * Plugin configuration schema and load-time validation.
 *
 * The row's `config:` is the single source of truth, and because it is a
 * schemastery schema the Harness projects it into a Settings page for the
 * `dsh-dcp` profile entry (namespace = entry id). Cordis validates and then
 * RESTARTS the plugin when a setting is written, so every field here is read
 * once per plugin lifetime; there is no live-mutation path to maintain.
 *
 * Schemastery's object resolver copies unknown keys through rather than
 * rejecting them, so `resolveConfig` re-checks the key set and fails loud —
 * a typo must not silently disable a strategy.
 *
 * @module dsh-dcp/config
 */
import z from '@deepseek-ai/schemastery'

/** A threshold that is either an absolute token count or a percentage string like `"80%"`. */
export type LimitSpec = number | string

/** Configuration of the `compaction` subtree. */
export interface CompactionConfig {
  /** `allow` runs directly, `ask` goes through the approval seam, `deny` hides the tool. */
  permission?: 'allow' | 'ask' | 'deny'
  /** Soft upper threshold: above it, DCP injects strong compression nudges. */
  maxContextLimit?: LimitSpec
  /** Soft lower threshold: below it the turn nudge stays off. */
  minContextLimit?: LimitSpec
  /** Per-`provider/model` override for `maxContextLimit`. */
  modelMaxLimits?: Record<string, LimitSpec>
  /** Per-`provider/model` override for `minContextLimit`. */
  modelMinLimits?: Record<string, LimitSpec>
  /** Inject the context-limit nudge at most once every N nodes. */
  nudgeFrequency?: number
  /** Tool names whose completed outputs are appended verbatim to a summary. */
  protectedTools?: string[]
  /** Preserve user messages verbatim during compression. */
  protectUserMessages?: boolean
  /** Offer the `recall` tool so pruned content can be retrieved on demand. */
  recall?: boolean
}

/** Configuration of the automated strategies. */
export interface StrategiesConfig {
  deduplication?: { enabled?: boolean; protectedTools?: string[] }
}

/**
 * The full plugin configuration, in the plain shape the runtime reads.
 *
 * A `.volatile()` field arrives from cordis as a stable reference, not a value;
 * {@link resolveConfig} unwraps those at the mount boundary so everything below
 * this interface is an ordinary value read.
 */
export interface Config {
  /** Whether an automatic prune pass reports itself at all. */
  pruneNotification?: 'off' | 'minimal'
  /** Globs matched against the file paths a tool call touches. */
  protectedFilePatterns?: string[]
  /** Keep the newest N turns out of the strategy candidates. */
  turnProtection?: { enabled?: boolean; turns?: number }
  experimental?: { allowSubAgents?: boolean; customPrompts?: boolean }
  commands?: { protectedTools?: string[] }
  manualMode?: { enabled?: boolean; automaticStrategies?: boolean }
  compaction?: CompactionConfig
  strategies?: StrategiesConfig
}

/**
 * Default protected tool names for the `compact` tool itself.
 *
 * `subagent*` is a GLOB, and it has to be. The delegation tool is registered
 * once per provider with a configurable name (`dsh-tool-subagent`'s
 * `toolName`, default `subagent`), and the shipped presets register four of
 * them: `subagent`, `subagent_fork`, `subagent_codex`, `subagent_claude_code`.
 * All four return `started subagent <id>` for a continuable child, and that id
 * is the ONLY handle for reaching it afterwards — `send_message` takes
 * `agent_id`, and nothing lists a parent's subagent children (`list_agents`
 * covers the teammate layer, which is a different registry). Naming the bare
 * `subagent` protected one of the four and stranded the rest.
 *
 * These are addresses, not content: two ids are two children, never one child's
 * newer version. `protectionSuffix` therefore deduplicates by body text and
 * never by tool name.
 *
 * `skill` carries content instead: a skill's body is instructions the model may
 * be following, and two loads are two different skills.
 *
 * `todo_write` was on this list and should not have been. Its tool result is a
 * receipt — `Updated todo list: 3 pending, 1 in progress, 2 completed.` — while
 * the list itself is a separate `todo/write` session event that compaction never
 * touches. Protecting the receipt preserved a count and nothing else, and a
 * count is stale the moment the next write lands.
 *
 * `todo_read` was on the list too. No such tool exists in the Harness; it came
 * from upstream's tool set.
 *
 * Deliberately absent: every tool whose handles can be rediscovered by asking
 * (`spawn_teammate` → `list_agents`; `team_task_create` → `team_task_list`;
 * `schedule_create` → `schedule_list`; `create_goal` → `get_goal`; `workflow`
 * and the `job_*` tools → `job_list`). They need no protection because nothing
 * is lost, and `bash`/`read`/`grep` outputs stay unprotected because summarising
 * them is the entire point.
 */
export const DEFAULT_COMPACTION_PROTECTED_TOOLS = ['subagent*', 'skill']

/**
 * Default protected tool names for the command-driven sweep.
 *
 * Deduplication reads this list as well (see `deduplicationCandidates`), so
 * these names are exempt everywhere — sweep, panel, and the model-free pass.
 * The defaults therefore keep `write`/`edit` receipts out of deduplication too:
 * editing this list changes pruning behaviour, not just the command surface
 * (audit CORE-5).
 */
export const DEFAULT_COMMAND_PROTECTED_TOOLS = [
  ...DEFAULT_COMPACTION_PROTECTED_TOOLS,
  'compact',
  'write',
  'edit',
  'plan_enter',
  'plan_exit',
]

/**
 * A threshold is an absolute token count or a `"80%"` percentage.
 *
 * The string arm is pattern-checked rather than a bare `z.string()`: an
 * unconstrained string accepted `"abc"`, and {@link resolveLimit} reads a
 * percentage it cannot parse as `undefined` — so a typo silently removed the
 * context ceiling instead of failing the mount.
 */
const limitSchema = z.union([z.number(), z.string().pattern(/^\s*\d+(?:\.\d+)?\s*%\s*$/)])

/**
 * Schemastery configuration for the plugin row.
 *
 * Every field carries a description: the Harness generates the settings page
 * from this schema (`settings.describe()` serializes it, `meta.description`
 * included), and the plugin ships no bespoke form — so this text IS the
 * configuration UI's help.
 */
/**
 * The plugin's configuration schema.
 *
 * Deliberately unannotated: `.volatile()` changes a field's output type to an
 * opaque stable reference, which an explicit `z<Config>` no longer accepts. The
 * {@link Config} interface describes what the RUNTIME reads — plain values —
 * and {@link resolveConfig} is the single boundary that produces that shape:
 * `tests/config.test.ts` checks the two agree field for field.
 */
export const Config = z.object({
  pruneNotification: z.union(['off', 'minimal'] as const).default('minimal').volatile()
    .description('What an automatic prune pass reports. A notice is model-visible, so "minimal" is one line and "off" leaves reporting to the panel.'),
  protectedFilePatterns: z.array(z.string()).default([])
    .description('Globs matched against the file paths a tool call touches; matching calls are never pruned or compacted away.'),
  turnProtection: z.object({
    enabled: z.boolean().default(false).volatile()
      .description('Keep the newest turns out of the strategy candidates.'),
    turns: z.number().step(1).min(1).default(4).volatile()
      .description('How many turns stay protected.'),
  }).default({})
    .description('Protect recently touched tools from the automatic strategies.'),
  experimental: z.object({
    allowSubAgents: z.boolean().default(false).volatile()
      .description('Let DCP compact subagent sessions too.'),
    customPrompts: z.boolean().default(false).volatile()
      .description('Enable prompt overrides under $DSH_HOME/dcp-prompts/.'),
  }).default({})
    .description('Opt-in behaviour that is off by default.'),
  commands: z.object({
    protectedTools: z.array(z.string()).default([...DEFAULT_COMMAND_PROTECTED_TOOLS])
      .description('Tool-name globs the sweep path, the panel and deduplication never touch.'),
  }).default({})
    .description('The /dcp-compact command surface.'),
  manualMode: z.object({
    enabled: z.boolean().default(false).volatile()
      .description('Manual mode: stop nudging, and let the model compact only after an explicit /dcp-compact request.'),
    automaticStrategies: z.boolean().default(true).volatile()
      .description('Keep running deduplication while manual mode is on.'),
  }).default({})
    .description('Restrict compaction to explicit requests.'),
  compaction: z.object({
    permission: z.union(['allow', 'ask', 'deny'] as const).default('allow')
      .description('"allow" runs directly, "ask" goes through the Harness approval seam, "deny" leaves the compact tool unregistered.'),
    // The two limits are the edges of three bands, not a window: below `min`
    // nothing nudges, between them the turn nudge may fire, and
    // above `max` the context-limit nudge repeats (src/nudges.ts:109-113).
    // Percentages, not the absolute counts upstream ships: upstream tells the
    // reader to lower them for a smaller window, and a fixed 50k/100k is 5%/10%
    // of a 1M window — long before any pressure. A share of the window scales
    // with the model instead.
    //
    // A percentage needs the route to report a context window, and a route that
    // reports none gets no nudge at all (`resolveLimit` returns undefined, and
    // `selectNudge` returns null when both thresholds are undefined). That is
    // left as it is, and deliberately: an unreported window is a deployment or
    // provider defect, not something this plugin should paper over. Falling back
    // to a token count would put the thresholds back to the guessing the
    // percentages exist to remove.
    maxContextLimit: limitSchema.default('67%').volatile()
      .description('Strong nudge threshold, as a share of the model window. Above it DCP tells the model to compact now, and keeps saying so while pressure stays there. A percentage like "67%", or absolute tokens.'),
    minContextLimit: limitSchema.default('33%').volatile()
      .description('Weak nudge threshold, as a share of the model window. Below it nothing nudges; between it and the strong threshold the turn nudge may fire. A percentage, or absolute tokens.'),
    modelMaxLimits: z.dict(limitSchema).default({})
      .description('Per-"provider/model" override for maxContextLimit.'),
    modelMinLimits: z.dict(limitSchema).default({})
      .description('Per-"provider/model" override for minContextLimit.'),
    nudgeFrequency: z.number().step(1).min(1).default(5).volatile()
      .description('Inject a nudge at most once every N conversation nodes.'),
    protectedTools: z.array(z.string()).default([...DEFAULT_COMPACTION_PROTECTED_TOOLS])
      .description('Tool-name globs whose outputs are appended verbatim to a summary instead of being condensed away, and are exempt from deduplication for the same reason.'),
    protectUserMessages: z.boolean().default(false).volatile()
      .description('Preserve user messages verbatim. Large pasted prompts then never compress away.'),
    recall: z.boolean().default(true)
      .description('Register the recall tool, which reads a block\'s original content back without changing the conversation.'),
  }).default({})
    .description('Model-driven compaction and its nudges.'),
  strategies: z.object({
    deduplication: z.object({
      enabled: z.boolean().default(true).volatile()
        .description('Rewrite the outputs of older identical tool calls, keeping the newest.'),
      protectedTools: z.array(z.string()).default([])
        .description('Extra tool-name globs to exempt from deduplication, on top of commands.protectedTools and compaction.protectedTools.'),
    }).default({})
      .description('Duplicate tool-call output pruning.'),
  }).default({})
    .description('The automatic, model-free pruning strategies.'),
})

/** Every accepted top-level key, for fail-loud typo detection. */
const TOP_LEVEL_KEYS = new Set([
  'pruneNotification',
  'protectedFilePatterns',
  'turnProtection',
  'experimental',
  'commands',
  'manualMode',
  'compaction',
  'strategies',
])

const COMPACTION_KEYS = new Set([
  'permission', 'maxContextLimit', 'minContextLimit',
  'modelMaxLimits', 'modelMinLimits', 'nudgeFrequency',
  'protectedTools', 'protectUserMessages', 'recall',
])

/**
 * Accepted keys under `strategies`.
 *
 * `purgeErrors` is deliberately absent: it was removed, and
 * {@link refuseRemovedSettings} explains why rather than letting the generic
 * typo message stand in for an upgrade note.
 */
const STRATEGY_KEYS = new Set(['deduplication'])

/**
 * Reject unknown keys in the raw row configuration.
 * @param raw - the row's `config:` value before schema resolution.
 * @param path - dotted path used in the error message.
 * @param allowed - accepted key names at this level.
 * @throws when a key outside `allowed` is present.
 */
function assertKeys(raw: unknown, path: string, allowed: ReadonlySet<string>): void {
  if (raw === undefined || raw === null) return
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`dsh-dcp: "${path}" must be an object`)
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new Error(`dsh-dcp: unknown setting "${path === '' ? '' : `${path}.`}${key}" (allowed: ${[...allowed].join(', ')})`)
    }
  }
}

/**
 * Validate the raw configuration before the schema resolves it.
 * @param raw - the row's `config:` value.
 * @throws when a setting is misspelled or a nested object has the wrong shape.
 */
export function validateConfigKeys(raw: unknown): void {
  const record = (raw ?? {}) as Record<string, unknown>
  // Before the generic key check, at every level a removal has touched: a
  // deployment that still carries a removed setting deserves the upgrade note,
  // not "unknown setting". Safe on a non-object `raw` — the guard narrows first.
  refuseRemovedSettings(record)
  assertKeys(raw, '', TOP_LEVEL_KEYS)
  assertKeys(record.turnProtection, 'turnProtection', new Set(['enabled', 'turns']))
  assertKeys(record.experimental, 'experimental', new Set(['allowSubAgents', 'customPrompts']))
  assertKeys(record.commands, 'commands', new Set(['protectedTools']))
  assertKeys(record.manualMode, 'manualMode', new Set(['enabled', 'automaticStrategies']))
  assertKeys(record.compaction, 'compaction', COMPACTION_KEYS)
  const strategies = (record.strategies ?? {}) as Record<string, unknown>
  assertKeys(record.strategies, 'strategies', STRATEGY_KEYS)
  assertKeys(strategies.deduplication, 'strategies.deduplication', new Set(['enabled', 'protectedTools']))
}

/**
 * Say what happened to a setting this plugin used to accept.
 *
 * `strategies.purgeErrors` pruned a failed call's OUTPUT, replacing the error
 * text with a placeholder — including failures that were never repeated.
 * Upstream prunes the call's INPUTS and keeps the error message, because the
 * message is what the model needs to fix the problem; this port could not do
 * that (an `assistant/message` can never carry a surface replacement), so it
 * pruned the wrong half and lost the diagnosis. The strategy is gone rather
 * than defaulted off.
 *
 * Deduplication is not that strategy: it keys on the call signature and prunes
 * the older repetition whether it succeeded or failed (see
 * `strategies/index.ts`), and its newest result keeps the error text.
 *
 * A bare "unknown setting" would be technically true and useless — the key is
 * in existing deployments. This guard is a migration aid and can be deleted
 * once no deployment still carries the key.
 *
 * @param strategies - the raw `strategies` object.
 * @throws when a removed key is still present.
 */
function refuseRemovedSettings(root: Record<string, unknown>): void {
  if (root['enabled'] !== undefined) {
    throw new Error(
      'dsh-dcp: the "enabled" master switch was removed. It promised a plugin "mounted but inert" while it '
      + 'only stopped the strategies and the nudges — the model still saw every tool, and calling one threw. '
      + 'Every job it had has a precise switch now: "strategies.deduplication.enabled" and "manualMode.enabled" '
      + 'are on the settings page, "compaction.permission: deny" leaves the model-facing tools unregistered, '
      + 'and dropping this bundle from dsh.profile.bundles turns the plugin off entirely. '
      + 'Delete the "enabled" key from this row\'s config.',
    )
  }
  const strategies = asRecord(root['strategies'])
  if (strategies['purgeErrors'] !== undefined) {
    throw new Error(
      'dsh-dcp: "strategies.purgeErrors" was removed. That strategy rewrote the output of failed calls '
      + '(repeated or not), which removed the error text the model needs, while upstream prunes the call inputs '
      + 'and keeps the message. Deduplication is unaffected: identical calls are still pruned whichever way '
      + 'they ended. Delete the "purgeErrors" block from this row\'s config.',
    )
  }

  // Five settings that promised a choice nobody was making. `compact` has one
  // dialect (a span), `<protect>` tags are not recognised, the tool result never
  // carries the summary text, `/dcp-compact` is always registered, and the iteration
  // nudge is gone with its threshold. A deployment that still carries any of them
  // gets this instead of a bare "unknown setting".
  const compaction = asRecord(root['compaction'])
  const commands = asRecord(root['commands'])
  const removed: Array<[unknown, string]> = [
    [compaction['mode'], '"compaction.mode"'],
    [compaction['iterationNudgeThreshold'], '"compaction.iterationNudgeThreshold"'],
    [compaction['protectTags'], '"compaction.protectTags"'],
    [compaction['showCompression'], '"compaction.showCompression"'],
    [commands['enabled'], '"commands.enabled"'],
  ]
  const present = removed.filter(([value]) => value !== undefined).map(([, name]) => name)
  if (present.length === 0) return
  throw new Error(
    `dsh-dcp: ${present.join(', ')} ${present.length === 1 ? 'was' : 'were'} removed. `
    + 'compact collapses a span and has no other dialect, <protect> tags are no longer recognised, '
    + 'the compact tool result never carries the summary text, the /dcp-compact command is always registered, '
    + 'and the iteration nudge is gone. '
    + `Delete ${present.length === 1 ? 'that key' : 'those keys'} from this row's config.`,
  )
}

/**
 * A config field as cordis delivers it.
 *
 * Schemastery parses every `.volatile()` field into a stable reference so the
 * settings page can write through it without remounting the plugin. A plugin
 * therefore does NOT receive plain values for those fields, and comparing one
 * to `true` — or doing arithmetic on one — is silently always wrong. The shape
 * is structural on purpose: it matches `Volatile<T>` without depending on the
 * package that declares it.
 */
interface VolatileRef<T> {
  get(): T
}

/** A field that may arrive as a reference rather than a value. */
type Delivered<T> = T | VolatileRef<T>

/** Narrow an unknown value to a stable reference. */
function isVolatileRef(value: unknown): value is VolatileRef<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/** Narrow an unknown value to a plain record, or an empty one. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Read one delivered field as its plain value.
 * @param value - the parsed field, possibly a stable reference.
 * @param fallback - the schema's default, used when the field is absent.
 * @returns the plain value.
 */
function plain<T>(value: Delivered<T> | undefined, fallback: T): T {
  const unwrapped = isVolatileRef(value) ? (value.get() as T) : value
  return unwrapped === undefined ? fallback : unwrapped
}

/** Read one delivered boolean. */
function bool(value: unknown, fallback: boolean): boolean {
  return plain<boolean>(value as Delivered<boolean>, fallback)
}

/** Read one delivered number. */
function num(value: unknown, fallback: number): number {
  return plain<number>(value as Delivered<number>, fallback)
}

/**
 * Turn the configuration cordis parsed into the plain shape the runtime reads.
 *
 * This is the ONLY place that knows a volatile field arrives as a reference.
 * Unwrapping here rather than calling `.get()` at each of the sixteen read
 * sites keeps every downstream read an ordinary value read, keeps {@link Config}
 * honest, and lets a hand-written configuration (tests build one) pass through
 * unchanged.
 *
 * Non-volatile fields are copied verbatim.
 *
 * @param raw - the row configuration as `apply()` received it.
 * @returns the same configuration with every volatile field unwrapped.
 */
export function resolveConfig(raw: unknown): Config {
  const root = asRecord(raw)
  const turnProtection = asRecord(root['turnProtection'])
  const manualMode = asRecord(root['manualMode'])
  const compaction = asRecord(root['compaction'])
  const strategies = asRecord(root['strategies'])
  const deduplication = asRecord(strategies['deduplication'])
  const experimental = asRecord(root['experimental'])
  const commands = asRecord(root['commands'])

  return {
    ...(root as Config),
    pruneNotification: plain<'off' | 'minimal'>(
      root['pruneNotification'] as Delivered<'off' | 'minimal'>,
      'minimal',
    ),
    turnProtection: {
      ...(turnProtection as Config['turnProtection']),
      enabled: bool(turnProtection['enabled'], false),
      turns: num(turnProtection['turns'], 4),
    },
    manualMode: {
      ...(manualMode as Config['manualMode']),
      enabled: bool(manualMode['enabled'], false),
      automaticStrategies: bool(manualMode['automaticStrategies'], true),
    },
    compaction: {
      ...(compaction as CompactionConfig),
      maxContextLimit: plain<LimitSpec>(compaction['maxContextLimit'] as Delivered<LimitSpec>, '67%'),
      minContextLimit: plain<LimitSpec>(compaction['minContextLimit'] as Delivered<LimitSpec>, '33%'),
      nudgeFrequency: num(compaction['nudgeFrequency'], 5),
      protectUserMessages: bool(compaction['protectUserMessages'], false),
    },
    experimental: {
      ...(experimental as Config['experimental']),
      allowSubAgents: bool(experimental['allowSubAgents'], false),
      customPrompts: bool(experimental['customPrompts'], false),
    },
    commands: { ...(commands as Config['commands']) },
    strategies: {
      ...(strategies as StrategiesConfig),
      deduplication: {
        ...(deduplication as NonNullable<StrategiesConfig['deduplication']>),
        enabled: bool(deduplication['enabled'], true),
      },
    },
  }
}

/**
 * Whether manual mode is in force.
 *
 * Manual mode silences the nudges and requires an explicit `/dcp-compact` request
 * before the model-facing tool runs. It is a deployment setting, not session
 * state: a per-session toggle earned its keep less than it cost in concepts.
 *
 * @param config - resolved row configuration.
 * @returns true when compaction runs only on explicit request.
 */
export function manualFor(config: Config): boolean {
  return config.manualMode?.enabled === true
}

/**
 * Resolve one limit against a context window.
 * @param spec - an absolute token count or a percentage string.
 * @param contextWindow - the routed model's context window, when known.
 * @returns the token threshold, or `undefined` when a percentage has no window.
 */
export function resolveLimit(spec: LimitSpec | undefined, contextWindow: number | undefined): number | undefined {
  if (spec === undefined) return undefined
  if (typeof spec === 'number') return Number.isFinite(spec) ? Math.max(0, Math.floor(spec)) : undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(spec)
  if (match === null || contextWindow === undefined) return undefined
  const percent = Math.min(100, Math.max(0, Number(match[1])))
  return Math.floor((contextWindow * percent) / 100)
}
