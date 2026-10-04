/**
 * Protection rules: tool names, file paths, `<protect>` tags, and user messages.
 *
 * File paths come from three sources, in decreasing authority:
 *   1. the tool's own declaration — `ToolDefinition.presentCall(args).locations`,
 *      so a tool says which argument is a path instead of us guessing;
 *   2. the durable `tool/result` `meta` presentation payload — the producing
 *      tool's own account of what the result touches, which the deduplication
 *      path reads off the result event;
 *   3. a structural scan of the parsed arguments for well-known path-bearing keys.
 *
 * Three bounds keep matching and scanning finite, and all three fail open —
 * refusing to match means a rule protects nothing rather than the pass blocking:
 * a glob pattern over 4 096 characters, a value over 8 192 characters, and a
 * path scan past 10 000 nodes. Each cap is orders of magnitude beyond a real
 * tool name, file path, or argument object; they are what stops one pathological
 * configuration from stalling the agent's event loop (audit STATE-5 / STATE-6,
 * quantified in 06 §3.2). The constants below are the definition of those
 * numbers.
 *
 * @module dsh-dcp/protected
 */

/**
 * One atom of a compiled glob.
 *
 * Matching deliberately runs on these atoms instead of a translated `RegExp`. A
 * pattern with several wildcard runs (`*a*a*a*a*a*a*a*a*b`, or ten directory
 * prefixes in a row) makes a backtracking engine explore exponentially many ways
 * to split the value, and every pattern here comes from configuration — one
 * unfortunate glob froze the agent's event loop for over a second with no
 * timeout (audit STATE-5). The atoms keep the exact language of the old
 * translation — `*` stays inside one path segment, `?` is one segment
 * character, `**` spans separators, and `**` before a separator is an optional
 * directory prefix — while making a match `O(atoms × value length)` with no
 * backtracking.
 */
type GlobAtom =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'star' }
  | { readonly kind: 'globstar' }
  | { readonly kind: 'dirprefix' }
  | { readonly kind: 'question' }

/**
 * Compiled patterns, keyed by their source.
 *
 * `matchesAny` used to build a fresh `RegExp` for every pattern of every value,
 * so a strategy pass recompiled the whole protected list once per tool pair.
 * The cache is bounded because the keys are configuration strings and the
 * process outlives the configuration that produced them; a full cache is
 * reset rather than grown.
 */
const GLOB_CACHE_LIMIT = 256
const globCache = new Map<string, readonly GlobAtom[]>()

/**
 * Split a glob into atoms, mirroring the original character-by-character
 * translation exactly (including its treatment of three or more `*` in a row).
 * @param glob - the pattern, with `\` read as a separator.
 * @returns the atoms, before collapsing.
 */
function tokenizeGlob(glob: string): GlobAtom[] {
  const normalized = glob.replace(/\\/g, '/')
  const atoms: GlobAtom[] = []
  let literal = ''
  const flush = (): void => {
    if (literal.length > 0) {
      atoms.push({ kind: 'literal', value: literal })
      literal = ''
    }
  }
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i] as string
    if (char === '*') {
      flush()
      if (normalized[i + 1] === '*') {
        // `**/` spans directories; `**` alone spans everything.
        if (normalized[i + 2] === '/') {
          atoms.push({ kind: 'dirprefix' })
          i += 2
        } else {
          atoms.push({ kind: 'globstar' })
          i += 1
        }
      } else {
        atoms.push({ kind: 'star' })
      }
      continue
    }
    if (char === '?') {
      flush()
      atoms.push({ kind: 'question' })
      continue
    }
    literal += char
  }
  flush()
  return atoms
}

/**
 * Collapse wildcard atoms a neighbour already covers.
 *
 * Only provable equalities are applied: two adjacent directory prefixes are one
 * directory prefix, a "spans everything" atom next to a segment-run atom is
 * still "spans everything", and two segment-run atoms are one. A pathological
 * pattern such as ten directory prefixes in a row therefore shrinks to a single
 * atom without changing what matches. A segment-run atom followed by an
 * optional directory prefix is deliberately NOT collapsed: that pair matches
 * anything with no separator as well as anything ending in one, which no single
 * atom expresses.
 * @param atoms - tokenized pattern.
 * @returns the collapsed atoms.
 */
function simplifyGlob(atoms: readonly GlobAtom[]): GlobAtom[] {
  const out: GlobAtom[] = []
  for (const atom of atoms) {
    const last = out[out.length - 1]
    if (last === undefined) {
      out.push(atom)
      continue
    }
    if (atom.kind === 'literal' && last.kind === 'literal') {
      out[out.length - 1] = { kind: 'literal', value: last.value + atom.value }
      continue
    }
    if (atom.kind === 'star' && last.kind === 'star') continue
    if (atom.kind === 'dirprefix' && last.kind === 'dirprefix') continue
    if (atom.kind === 'star' && last.kind === 'globstar') continue
    if (
      atom.kind === 'globstar'
      && (last.kind === 'globstar' || last.kind === 'star' || last.kind === 'dirprefix')
    ) {
      out[out.length - 1] = atom
      continue
    }
    out.push(atom)
  }
  return out
}

/**
 * Compile one glob, caching the result.
 * @param glob - the pattern.
 * @returns its atoms.
 */
function compileGlob(glob: string): readonly GlobAtom[] {
  const cached = globCache.get(glob)
  if (cached !== undefined) return cached
  const atoms = simplifyGlob(tokenizeGlob(glob))
  if (globCache.size >= GLOB_CACHE_LIMIT) globCache.clear()
  globCache.set(glob, atoms)
  return atoms
}

/** Regex metacharacters that a literal atom must escape when rendered. */
const REGEX_ESCAPE = /[.+^${}()|[\]\\]/g

/**
 * Glob-to-regexp translation supporting `*`, `?`, and `**​/`.
 *
 * Kept as the printable form of a compiled glob (diagnostics and probes render
 * `.source`), NOT as the matcher: a translated `RegExp` is exactly the
 * backtracking bomb {@link matchesAny} refuses to run, so nothing in the plugin
 * tests values with this. Consecutive wildcard atoms are collapsed first, so
 * the rendered source is also the shortest equivalent one.
 *
 * @param glob - the pattern.
 * @returns an anchored regular expression describing the same language.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (const atom of compileGlob(glob)) {
    switch (atom.kind) {
      case 'literal':
        out += atom.value.replace(REGEX_ESCAPE, '\\$&')
        break
      case 'star':
        out += '[^/]*'
        break
      case 'globstar':
        out += '.*'
        break
      case 'dirprefix':
        out += '(?:.*/)?'
        break
      case 'question':
        out += '[^/]'
        break
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * Ceilings for one match probe.
 *
 * The step budget charges an atom for the value length it scans and a literal
 * for its own length on top, so neither a huge value nor a huge literal pattern
 * can multiply out. Values and patterns past the caps do not match at all: both
 * are orders of magnitude beyond a real tool name or file path, and refusing is
 * what stops a hostile or accidental configuration from stalling the event loop
 * (the old regex path took seconds on the same input).
 */
const MAX_MATCH_VALUE = 8_192
const MAX_MATCH_PATTERN = 4_096
const MAX_MATCH_STEPS = 1_048_576

/**
 * Whether one compiled glob matches a value.
 *
 * A front of reachable value offsets, advanced atom by atom: no position is
 * ever revisited, so the worst case is the bounded step count above rather than
 * an exponential search.
 *
 * One deliberate difference from the translated `RegExp` this replaced: `.` (so
 * `**`) never matched a line terminator, while a glob star here does. A path or
 * name carrying a line terminator is not something a provider or tool name
 * produces, and where it can appear — a resolved file path — matching more only
 * protects more, so the widening is in the safe direction.
 *
 * @param atoms - the compiled pattern.
 * @param value - separator-normalized value.
 * @returns true when the whole value matches.
 */
function matchesCompiled(atoms: readonly GlobAtom[], value: string): boolean {
  const length = value.length
  if (length > MAX_MATCH_VALUE) return false
  let steps = 0
  for (const atom of atoms) {
    steps += (atom.kind === 'literal' ? Math.max(1, atom.value.length) : 1) * (length + 1)
    if (steps > MAX_MATCH_STEPS) return false
  }

  // `reachable[j]` means the atoms consumed so far can match `value.slice(0, j)`.
  let reachable = new Uint8Array(length + 1)
  reachable[0] = 1
  for (const atom of atoms) {
    const next = new Uint8Array(length + 1)
    switch (atom.kind) {
      case 'literal': {
        const size = atom.value.length
        for (let j = 0; j + size <= length; j += 1) {
          if (reachable[j] === 1 && value.startsWith(atom.value, j)) next[j + size] = 1
        }
        break
      }
      case 'question': {
        for (let j = 0; j < length; j += 1) {
          if (reachable[j] === 1 && value[j] !== '/') next[j + 1] = 1
        }
        break
      }
      case 'star': {
        // Open while inside a run of non-separator characters; `open` is read
        // before the closing update so the empty run is a legal match too.
        let open = false
        for (let j = 0; j <= length; j += 1) {
          if (reachable[j] === 1) open = true
          if (open) next[j] = 1
          if (j < length && value[j] === '/') open = false
        }
        break
      }
      case 'globstar': {
        let open = false
        for (let j = 0; j <= length; j += 1) {
          if (reachable[j] === 1) open = true
          if (open) next[j] = 1
        }
        break
      }
      case 'dirprefix': {
        // Empty, or any run ending at a separator: `before` is "some earlier
        // offset was reachable", which is all the non-empty arm needs.
        let before = false
        for (let j = 0; j <= length; j += 1) {
          if (reachable[j] === 1 || (j > 0 && value[j - 1] === '/' && before)) next[j] = 1
          if (reachable[j] === 1) before = true
        }
        break
      }
    }
    reachable = next
  }
  return reachable[length] === 1
}

/**
 * Match one value against a list of glob patterns.
 * @param value - candidate string, compared after separator normalization.
 * @param patterns - glob patterns.
 * @returns true when any pattern matches the value or its basename.
 */
export function matchesAny(value: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false
  const normalized = value.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  for (const pattern of patterns) {
    if (pattern.length > MAX_MATCH_PATTERN) continue
    const atoms = compileGlob(pattern)
    if (matchesCompiled(atoms, normalized) || matchesCompiled(atoms, base)) return true
  }
  return false
}

/** Well-known argument keys that carry a file path across shipped tools. */
const PATH_KEYS = ['filePath', 'filepath', 'path', 'file', 'filename', 'target', 'targetFile']

/**
 * How many nodes one path scan visits before it stops.
 *
 * This replaces the old `depth > 4` early return, which silently made a path
 * key nested five objects deep invisible (audit STATE-6) — arguments are an
 * arbitrary JSON shape, so nesting was never the right unit to bound. A node
 * budget counts work instead, and the scan is iterative, so no payload depth can
 * overflow the stack either; only a call carrying thousands of nodes (a whole
 * file tree in one argument) is cut short, and the cap is far past any real
 * argument object.
 */
const MAX_SCANNED_NODES = 10_000

/**
 * Pull file paths out of a patch body written by an apply-patch style tool.
 * @param patch - the patch text.
 * @returns every file the patch names.
 */
function pathsFromPatch(patch: string): string[] {
  const found: string[] = []
  const pattern = /^\*\*\* (?:Update|Add|Delete|Move to|Rename to) File: (.+)$/gm
  for (const match of patch.matchAll(pattern)) {
    const value = match[1]?.trim()
    if (value !== undefined && value.length > 0) found.push(value)
  }
  return found
}

/**
 * Collect every file path one tool call touches.
 * @param args - the parsed tool arguments.
 * @param declared - paths the tool itself declared through its call presenter.
 * @param meta - the durable `tool/result` presentation payload, when present.
 * @returns distinct paths, declared ones first.
 */
export function collectFilePaths(
  args: unknown,
  declared: readonly string[] = [],
  meta?: unknown,
): string[] {
  const out = new Set<string>()
  for (const path of declared) if (path.length > 0) out.add(path)

  const queue: unknown[] = [args, meta]
  let visited = 0
  for (let head = 0; head < queue.length && visited < MAX_SCANNED_NODES; head += 1) {
    const value = queue[head]
    if (value === null || value === undefined) continue
    visited += 1
    if (typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const item of value) queue.push(item)
      continue
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string') {
        if (PATH_KEYS.includes(key) && child.length > 0) out.add(child)
        else if (/patch/i.test(key) && child.includes('*** ')) for (const path of pathsFromPatch(child)) out.add(path)
        continue
      }
      queue.push(child)
    }
  }
  return [...out]
}

/** The text bodies of every `<protect>…</protect>` span in a text. */

/** The tool names DCP never prunes, regardless of configuration. */
export const ALWAYS_PROTECTED_TOOLS = ['compact', 'compact_targets', 'recall']

/**
 * Whether one tool call is protected from pruning.
 * @param name - the tool name.
 * @param patterns - configured name globs, on top of {@link ALWAYS_PROTECTED_TOOLS}.
 * @param paths - file paths the call touches.
 * @param pathPatterns - configured file-path globs.
 * @returns true when the call must be left alone.
 */
export function isProtected(
  name: string,
  patterns: readonly string[],
  paths: readonly string[],
  pathPatterns: readonly string[],
): boolean {
  if (ALWAYS_PROTECTED_TOOLS.includes(name)) return true
  if (matchesAny(name, patterns)) return true
  for (const path of paths) {
    if (matchesAny(path, pathPatterns)) return true
  }
  return false
}

/**
 * Maximum characters of one protected body appended to a summary.
 *
 * Lives here rather than at the call site so the cap and the marker that
 * announces it cannot drift apart: the default used to be 4 000 while the
 * caller sliced at 2 000 with no marker at all, which silently dropped the tail
 * of a body the configuration promised to preserve verbatim.
 */
export const PROTECTED_BODY_MAX = 2_000

/**
 * Bound a protected body so one huge `<protect>` span cannot defeat compression.
 * @param text - the body.
 * @param max - maximum characters retained.
 * @returns the possibly truncated body, always carrying a marker when cut.
 */
export function boundBody(text: string, max = PROTECTED_BODY_MAX): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[… truncated …]`
}
