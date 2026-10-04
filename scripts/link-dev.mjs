/**
 * Link the installed DeepSeek Harness packages into this workspace so that
 * `tsc` and `vitest` resolve `@deepseek-ai/*` exactly the way the Harness
 * loader does at runtime.
 *
 * Runtime code must keep importing these packages BY NAME (they are marked
 * external in the build): the Harness installs a module-resolution
 * interception that maps them from the installation and the active profile.
 * This script only creates development-time symlinks; it is never part of the
 * published package.
 *
 * The relink is transactional. The previous scope is never deleted up front:
 * the new tree is built in a staging directory beside it, entries the workspace
 * owns (real npm-installed packages, files) are carried over, and only then is
 * the scope swapped by two renames — with a restore if the second one fails.
 * A failure anywhere leaves the previous scope exactly as it was, so a broken
 * run cannot strand the workspace with half a scope.
 *
 * One writer at a time. The swap is two renames, and a second relink starting
 * between them would rename the scope out from under the first (or swap in a
 * staging tree the first is about to replace) and leave the workspace with two
 * scopes fighting over one name. A lock directory beside the scope serialises
 * the whole run; see {@link acquireLock} for what the holder leaves behind and
 * how a lock whose process died is reported.
 *
 * @module dsh-dcp/scripts/link-dev
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeModules = join(root, 'node_modules')
const scope = join(nodeModules, '@deepseek-ai')

/**
 * The mutual-exclusion lock. It sits beside the scope it guards (never inside
 * it: the scope itself is renamed during the swap) and is created with
 * `mkdir`, the one filesystem primitive that is atomic on every platform this
 * package runs on — no `flock`, no dependency.
 */
const lockDir = join(nodeModules, '.dsh-dcp-link-dev.lock')
const lockOwner = join(lockDir, 'owner')

/** Candidate locations of the Harness installation's package scope. */
const candidates = [
  process.env.DSH_INSTALL_SCOPE,
  '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
].filter((value) => typeof value === 'string' && value.length > 0)

const source = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isDirectory())
if (source === undefined) {
  console.error(
    'link-dev: no Harness package scope found.\n'
    + 'Searched:\n'
    + candidates.map((candidate) => `  - ${candidate}`).join('\n')
    + '\nSet DSH_INSTALL_SCOPE to the directory holding the installed @deepseek-ai/* packages.',
  )
  process.exit(1)
}

/**
 * Packages every Harness scope carries. Their absence means the directory
 * exists but is not the scope this script expects — link it and `tsc` would
 * fail later with an unrelated "cannot find module", after the workspace's
 * previous scope had already been replaced.
 */
const MARKERS = ['dsh-session', 'dsh-tools']
const missing = MARKERS.filter((name) => !existsSync(join(source, name)))
if (missing.length > 0) {
  console.error(
    `link-dev: ${source} does not look like the Harness package scope`
    + ` (missing ${missing.join(', ')}).\nRefusing to relink; check DSH_INSTALL_SCOPE.`,
  )
  process.exit(1)
}

/** What the current lock holder recorded, or why it could not be read. */
function readLockHolder() {
  let text
  try {
    text = readFileSync(lockOwner, 'utf8')
  } catch {
    return { pid: null, alive: false, readable: false }
  }
  const pid = Number(/^pid (\d+)$/m.exec(text)?.[1])
  if (!Number.isInteger(pid) || pid <= 0) return { pid: null, alive: false, readable: true }
  let alive = true
  try {
    process.kill(pid, 0)
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists, owned by someone else.
    alive = error.code === 'EPERM'
  }
  return { pid, alive, readable: true }
}

/**
 * Take the lock, or refuse to run.
 *
 * The directory is created with `mkdirSync` (not recursive), so `EEXIST` is the
 * atomic "someone else holds it" answer. The holder writes its pid inside; a
 * lock left behind by a killed process is REPORTED with its pid and the command
 * that clears it, never stolen silently — a stale-looking pid is not proof that
 * the other run is gone (pid reuse, another user, a paused process), and taking
 * the lock over is exactly the interleaving this lock exists to prevent. The
 * caller releases it in its `finally`; the process exits non-zero on refusal.
 */
function acquireLock() {
  try {
    mkdirSync(lockDir)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const holder = readLockHolder()
    console.error(
      `link-dev: another relink holds the lock at ${lockDir}\n`
      + (holder.pid === null
        ? `  the lock records no readable owner${holder.readable ? '' : ' file'}; if no link-dev is running, remove it: rm -rf ${lockDir}`
        : holder.alive
          ? `  held by pid ${holder.pid}, which is still running; wait for it to finish`
          : `  held by pid ${holder.pid}, which is NOT running — the lock looks stale;`
            + ` remove it if you are sure: rm -rf ${lockDir}`)
      + '\nrefusing to relink concurrently; nothing was changed.',
    )
    process.exit(1)
  }
  writeFileSync(lockOwner, `pid ${process.pid}\nstarted ${new Date().toISOString()}\nsource ${source}\n`)
}

const staging = join(nodeModules, `.dsh-dcp-link-dev-staging-${process.pid}`)
const backup = join(nodeModules, `.dsh-dcp-link-dev-previous-${process.pid}`)

let failure = null
/** Set when the swap failed AND the restore failed: the old scope lives at `backup`. */
let preservedAt = null
let holdsLock = false
try {
  mkdirSync(nodeModules, { recursive: true })
  acquireLock()
  holdsLock = true

  rmSync(staging, { recursive: true, force: true })
  rmSync(backup, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  let linked = 0
  for (const entry of readdirSync(source).sort()) {
    const from = join(source, entry)
    if (!statSync(from).isDirectory()) continue
    symlinkSync(from, join(staging, entry), 'dir')
    linked += 1
  }

  const broken = MARKERS.filter((name) => !existsSync(join(staging, name)))
  if (broken.length > 0) throw new Error(`staged scope is incomplete (missing ${broken.join(', ')})`)

  // Carry over what the workspace owns only once the new tree is complete:
  // entries in the old scope that are not symlinks (an npm-installed package, a
  // file). Moving them earlier would delete them if a later step failed. A
  // failure here is rolled back for the same reason.
  let carried = 0
  const moved = []
  if (existsSync(scope)) {
    try {
      for (const entry of readdirSync(scope)) {
        const from = join(scope, entry)
        if (lstatSync(from).isSymbolicLink()) continue
        // A real package of the same name as a Harness package: the link wins,
        // and the collision is reported rather than failing the relink.
        if (existsSync(join(staging, entry))) {
          console.warn(`link-dev: workspace-owned ${entry} is replaced by the Harness link`)
          continue
        }
        renameSync(from, join(staging, entry))
        moved.push(entry)
        carried += 1
      }
    } catch (error) {
      for (const entry of moved.reverse()) renameSync(join(staging, entry), join(scope, entry))
      throw error
    }
  }

  let movedAside = false
  if (existsSync(scope)) {
    renameSync(scope, backup)
    movedAside = true
  }
  try {
    renameSync(staging, scope)
  } catch (error) {
    if (movedAside && !existsSync(scope) && existsSync(backup)) {
      try {
        renameSync(backup, scope)
      } catch (restoreError) {
        preservedAt = backup
        throw restoreError
      }
    }
    throw error
  }
  rmSync(backup, { recursive: true, force: true })

  console.log(
    `link-dev: linked ${linked} packages from ${source}`
    + (carried > 0 ? ` (kept ${carried} workspace-owned entries)` : ''),
  )
} catch (error) {
  failure = error
} finally {
  // Only the staging tree is transient. `backup` is deleted right after a
  // successful swap, and on a failed restore it is deliberately left in place.
  rmSync(staging, { recursive: true, force: true })
  // The lock is released on every path out of the body, including a throw: a
  // failed relink must not block the next one.
  if (holdsLock) rmSync(lockDir, { recursive: true, force: true })
}

if (failure !== null) {
  console.error(
    preservedAt === null
      ? `link-dev: relink failed, the previous scope is unchanged (${failure.message})`
      : `link-dev: relink failed and the previous scope could NOT be restored; it is kept at ${preservedAt} (${failure.message})`,
  )
  process.exit(1)
}
