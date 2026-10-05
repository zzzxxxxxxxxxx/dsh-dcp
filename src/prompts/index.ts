/**
 * Prompt texts and the optional on-disk override store.
 *
 * The built-in texts started from the opencode-dcp prompts and have been edited
 * here since, to the point of being rewritten around this plugin's own tool
 * vocabulary; the attribution and the exact scope of that adaptation are
 * recorded in the repository's `NOTICE` file. `experimental.customPrompts` adds
 * a directory the user can edit without touching the plugin:
 *
 *     $DSH_HOME/dcp-prompts/overrides/<name>.md   (wins)
 *     $DSH_HOME/dcp-prompts/defaults/<name>.md    (seeded, informational)
 *
 * A missing or unreadable directory degrades to the built-in text with one
 * warning; prompt editing must never keep the plugin from loading.
 *
 * @module dsh-dcp/prompts
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Every editable prompt's stable name. */
export const PROMPT_NAMES = [
  'compact',
  'compact-targets',
  'context-limit-nudge',
  'turn-nudge',
] as const

/** One editable prompt's name. */
export type PromptName = (typeof PROMPT_NAMES)[number]

/**
 * The prompts that must always open with {@link NUDGE_PREFIX}.
 *
 * An override file replaces a template wholesale, and the built-in nudge texts
 * carry the prefix as their first line — so a user editing one to change the
 * wording silently deleted the line that tells the model the text is not the
 * user speaking. Restoring it at load keeps the guarantee without asking the
 * author to remember a line that is not theirs to manage.
 */
const NUDGE_PROMPTS: ReadonlySet<PromptName> = new Set(['context-limit-nudge', 'turn-nudge'])

/**
 * Prefixed to every nudge.
 *
 * A nudge is injected as a `user` message — the Harness has no other channel
 * that reaches the model — so without this it reads as the user speaking in the
 * middle of a task. A model that believes the user just spoke stops to answer,
 * which is the opposite of what a reminder is for. One line removes the
 * ambiguity, and it has to be in the TEXT: the message's `source.form: 'notice'`
 * marks it for the UI, and the model never sees that.
 */
export const NUDGE_PREFIX =
  '[dsh-dcp] Automatic context reminder, not a message from the user. Act on it or ignore it, then keep working; do not reply to it and do not ask for confirmation.'

/** The built-in text of every prompt. */
export const BUILT_IN: Record<PromptName, string> = {
  'compact': [
    'Collapse conversation content into a detailed summary, replacing the originals in context.',
    'Read compact_targets first to get the handles this tool accepts.',
    '',
    'THE SUMMARY: be EXHAUSTIVE. Capture file paths, function signatures, decisions, constraints, and key findings — everything that keeps context integrity. This is not a brief note; it is an authoritative record so faithful that the originals add no value.',
    '',
    'USER INTENT FIDELITY: when the covered content includes user messages, preserve their intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes. Quote short user messages directly when that best preserves exact meaning.',
    '',
    'Yet be LEAN. Strip noise: failed attempts that led nowhere, verbose tool output, and back-and-forth exploration. What remains must be pure signal with zero ambiguity.',
    '',
    'Handle rules:',
    '- Copy handles verbatim from compact_targets. Never invent one.',
    '- startId must appear before endId in the conversation.',
    '- A range is snapped outward to the nearest safe boundaries; the result reports where it landed.',
    '- When the range covers an existing summary (a bN handle), reference it as (bN) exactly once in your summary; its stored text is expanded in place. Omit it and the text is appended for you.',
    '',
    'BATCHING: when several independent ranges are ready and do not overlap, send them as separate entries of one call.',
  ].join('\n'),
  'compact-targets': [
    'List the conversation handles you can pass to compact, plus every existing summary block.',
    'Handles look like n123. Each line shows the role, the approximate token cost, whether the boundary before/after it is a safe cut, and a short preview.',
    'Call this immediately before compact; handles are re-validated when compact runs, and a handle that has left the conversation is reported rather than guessed.',
  ].join('\n'),
  'context-limit-nudge': [
    NUDGE_PREFIX,
    '',
    'CRITICAL: the context window is at or above its compaction threshold.',
    'Run one compaction pass now: call compact_targets, then compact the oldest spans that are no longer needed for the active task.',
    'Do not compact content you still need. After the tool returns, continue the task.',
  ].join('\n'),
  'turn-nudge': [
    NUDGE_PREFIX,
    '',
    'The conversation is long enough that earlier content may no longer be needed.',
    'If a completed stretch of work is no longer relevant to the active task, run one compaction pass over it with compact_targets + compact.',
    'If everything is still relevant, ignore this and continue.',
  ].join('\n'),
}

/** Resolve the DSH home directory the same way the Harness does. */
function dshHome(): string {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/** The prompt store's on-disk layout. */
export interface PromptPaths {
  root: string
  defaults: string
  overrides: string
}

/** Resolve the prompt directories. */
export function promptPaths(): PromptPaths {
  const root = join(dshHome(), 'dcp-prompts')
  return { root, defaults: join(root, 'defaults'), overrides: join(root, 'overrides') }
}

/** Loaded prompt texts plus the diagnostics load produced. */
export interface LoadedPrompts {
  text: Record<PromptName, string>
  /** Override files that were applied. */
  applied: string[]
  /** Problems worth one warning each; never fatal. */
  warnings: string[]
}

/**
 * Load prompts, applying overrides when the deployment allows them.
 * @param enabled - whether `experimental.customPrompts` is on.
 * @param seedDefaults - whether a missing defaults directory should be written.
 * @returns the effective texts and any diagnostics.
 */
export function loadPrompts(enabled: boolean, seedDefaults: boolean): LoadedPrompts {
  const text = { ...BUILT_IN }
  const applied: string[] = []
  const warnings: string[] = []
  if (!enabled) return { text, applied, warnings }

  const paths = promptPaths()
  try {
    if (seedDefaults && !existsSync(paths.defaults)) {
      mkdirSync(paths.defaults, { recursive: true })
      for (const name of PROMPT_NAMES) {
        writeFileSync(join(paths.defaults, `${name}.md`), `${BUILT_IN[name]}\n`, 'utf8')
      }
    }
  } catch (error) {
    warnings.push(`could not seed ${paths.defaults}: ${describe(error)}`)
  }

  for (const name of PROMPT_NAMES) {
    const file = join(paths.overrides, `${name}.md`)
    try {
      if (!existsSync(file)) continue
      const body = stripComments(readFileSync(file, 'utf8')).trim()
      if (body.length === 0) continue
      text[name] = NUDGE_PROMPTS.has(name) && !body.startsWith(NUDGE_PREFIX) ? `${NUDGE_PREFIX}\n\n${body}` : body
      applied.push(file)
    } catch (error) {
      warnings.push(`could not read ${file}: ${describe(error)}`)
    }
  }
  return { text, applied, warnings }
}

/** Drop HTML and line comments so an annotated override stays usable. */
function stripComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * Cheap fingerprint of the prompt sources.
 *
 * The override files are read from disk, but a per-use read of four files is
 * more than a nudge or a tool description needs — and the switch itself is part
 * of the answer. Stats are enough: a file that changed has a different mtime or
 * size, and a disabled switch needs no stats at all. (A rewrite that keeps both
 * size and mtime — same second, same length — is missed; that is the standard
 * trade and re-enabling the switch or an explicit reload still picks it up.)
 *
 * @param enabled - whether `experimental.customPrompts` is on.
 * @returns a string that changes exactly when the effective prompts could.
 */
export function promptFingerprint(enabled: boolean): string {
  if (!enabled) return 'off'
  const parts = ['on']
  for (const name of PROMPT_NAMES) {
    try {
      const stat = statSync(join(promptPaths().overrides, `${name}.md`))
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`)
    } catch {
      parts.push(`${name}:-`)
    }
  }
  return parts.join('|')
}

/** Render one error for a warning line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
