/**
 * Build the publishable halves of `dsh-dcp`.
 *
 * - `lib/index.js`     host plugin (ESM). Every `@deepseek-ai/*` package stays
 *                      external: the Harness resolves them from its own
 *                      installation, and shipping a second copy breaks service
 *                      identity. `zod` stays external too: it is a real runtime
 *                      dependency (declared in `dependencies`), and inlining it
 *                      added ~750 KB of the ~830 KB bundle.
 * - `lib/invariant.js` optional invariant companion, same rules.
 * - `lib/client.js`    browser half. It is authored directly in the Harness
 *                      client-module envelope (`window.__ModuleLoader__.load`),
 *                      so it is copied verbatim rather than bundled; it may
 *                      only `require` modules the page's module table offers.
 * - `lib/types/**`     declaration files emitted by `tsc`.
 *
 * The build is staged and swapped, never written in place: esbuild, the client
 * copy and `tsc` all target a staging directory, and `lib/` is replaced by two
 * renames only after every step succeeded. A failed step therefore leaves the
 * previous `lib/` intact (a half-written artifact set would otherwise ship new
 * JS next to stale declarations). `npm run verify` re-checks the result.
 *
 * The staging directory sits beside `lib/` in the package root, never under
 * `node_modules/`: a clean checkout, a read-only dependency layer, or a build
 * run before `npm ci` has no writable `node_modules`, and the swap has to stay
 * on one filesystem for `rename` to be atomic.
 *
 * @module dsh-dcp/scripts/build
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { clientEntry, declarationProject, entryPoints, shared } from './build-options.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')
/** Staged beside `lib/` (same filesystem, so the swap is a rename). */
const buildDir = join(root, '.dsh-dcp-build')
const staging = join(buildDir, 'lib-staging')
const backup = join(buildDir, 'lib-previous')

rmSync(staging, { recursive: true, force: true })
rmSync(backup, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

let failure = null
/** Set when the swap failed AND the restore failed: the old lib/ lives at `backup`. */
let preservedAt = null
try {
  await build({ ...shared, entryPoints: [join(root, entryPoints.host)], outfile: join(staging, 'index.js') })
  await build({ ...shared, entryPoints: [join(root, entryPoints.invariant)], outfile: join(staging, 'invariant.js') })

  cpSync(join(root, clientEntry), join(staging, 'client.js'))

  const tsc = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p', join(root, declarationProject),
      // Emit into the staging tree; `tsconfig.build.json` names `lib/types`.
      '--outDir', join(staging, 'types'),
    ],
    { stdio: 'inherit', cwd: root },
  )
  if (tsc.status !== 0) throw new Error(`declaration emit failed (tsc exit ${tsc.status ?? 1})`)

  let movedAside = false
  if (existsSync(lib)) {
    renameSync(lib, backup)
    movedAside = true
  }
  try {
    renameSync(staging, lib)
  } catch (error) {
    if (movedAside && !existsSync(lib) && existsSync(backup)) {
      try {
        renameSync(backup, lib)
      } catch (restoreError) {
        preservedAt = backup
        throw restoreError
      }
    }
    throw error
  }
  rmSync(backup, { recursive: true, force: true })
} catch (error) {
  failure = error
} finally {
  // Only the staging tree is transient. `backup` is deleted right after a
  // successful swap, and on a failed restore it is deliberately left in place.
  rmSync(staging, { recursive: true, force: true })
  if (!existsSync(backup)) rmSync(buildDir, { recursive: true, force: true })
}

if (failure !== null) {
  console.error(
    preservedAt === null
      ? `build: ${failure.message}; the previous lib/ is unchanged`
      : `build: ${failure.message}; the previous lib/ could NOT be restored and is kept at ${preservedAt}`,
  )
  process.exit(1)
}

console.log('build: wrote lib/index.js, lib/invariant.js, lib/client.js, lib/types/**')
