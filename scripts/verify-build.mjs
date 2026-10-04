/**
 * Verify the `lib/` artifacts that `scripts/build.mjs` just produced.
 *
 * `npm run build` stages its output and swaps it in, so a failed step cannot
 * leave a half-written `lib/`. What it cannot see is whether the artifacts are
 * the ones the current `src/` implies — a stale `lib/` (source edited, build
 * forgotten) or a declaration tree out of step with `src/` looks perfectly
 * healthy from the outside. That is what this script checks, by CONTENT:
 *
 * 1. every entry point exists and parses as this package's ESM;
 * 2. `lib/client.js` is byte-for-byte `src/client/index.js`;
 * 3. `lib/index.js` and `lib/invariant.js` are byte-for-byte a fresh esbuild
 *    build of their entry points (same options module as the build, rebuilt in
 *    memory — nothing is written);
 * 4. `lib/types/**` is byte-for-byte a fresh `tsc` declaration emit, file for
 *    file, with no missing and no orphan declaration;
 * 5. every `exports` target exists and is covered by `files`, so the published
 *    surface cannot point at something `npm pack` would not include.
 *
 * Comparison is by sha256 rather than by modification time: a `cp -p`, a tar
 * extraction, or a container layer with pinned mtimes restores a perfectly good
 * `lib/` with old timestamps, and an mtime gate would call that stale. Content
 * cannot lie that way.
 *
 * Run by `npm run verify`, which `npm run check` runs after the build and which
 * `prepack` runs before packing.
 *
 * @module dsh-dcp/scripts/verify-build
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { clientEntry, declarationProject, entryPoints, shared } from './build-options.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Problems found; the script exits non-zero when this is non-empty. */
const problems = []
const check = (ok, message, detail = '') => {
  if (!ok) problems.push(message)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}${detail === '' ? '' : `  [${detail}]`}`)
}

/** Recursively list files under `dir`, relative to it, sorted. */
function listFiles(dir, prefix = '') {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...listFiles(path, `${prefix}${name}/`))
    else out.push(`${prefix}${name}`)
  }
  return out
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const sha256Of = (text) => createHash('sha256').update(text).digest('hex')

console.log('== entry points ==')
const entries = ['lib/index.js', 'lib/invariant.js', 'lib/client.js', 'lib/types/index.d.ts', 'lib/types/invariant.d.ts']
for (const entry of entries) {
  const path = join(root, entry)
  const exists = existsSync(path)
  check(exists && statSync(path).size > 0, `${entry} exists and is non-empty${exists ? ` (${statSync(path).size} B)` : ''}`)
}

console.log('\n== ESM parse ==')
for (const entry of ['lib/index.js', 'lib/invariant.js', 'lib/client.js']) {
  const result = spawnSync(process.execPath, ['--check', join(root, entry)], { encoding: 'utf8' })
  check(result.status === 0, `${entry} parses (${result.status === 0 ? 'node --check' : (result.stderr || '').trim().split('\n')[0]})`)
}

console.log('\n== client half is the source, verbatim ==')
{
  const source = join(root, clientEntry)
  const copy = join(root, 'lib/client.js')
  check(existsSync(source) && existsSync(copy) && sha256(source) === sha256(copy),
    `lib/client.js is byte-identical to ${clientEntry}`)
}

console.log('\n== host bundles reproduce src/ (sha256) ==')
for (const [artifact, entry] of [['lib/index.js', entryPoints.host], ['lib/invariant.js', entryPoints.invariant]]) {
  const path = join(root, artifact)
  if (!existsSync(path)) continue
  const fresh = await build({
    ...shared,
    logLevel: 'silent',
    entryPoints: [join(root, entry)],
    write: false,
  })
  const expected = sha256Of(fresh.outputFiles[0].text)
  const actual = sha256(path)
  check(expected === actual,
    `${artifact} matches a fresh esbuild build of ${entry}`,
    expected === actual ? '' : `expected ${expected.slice(0, 12)}…, found ${actual.slice(0, 12)}… (stale: rebuild with npm run build)`)
}

console.log('\n== declarations reproduce src/ (sha256) ==')
{
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-dcp-verify-'))
  const emit = join(scratch, 'types')
  try {
    const tsc = spawnSync(
      process.execPath,
      [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, declarationProject), '--outDir', emit],
      { encoding: 'utf8', cwd: root },
    )
    check(tsc.status === 0, `a fresh declaration emit succeeds (tsc exit ${tsc.status})`)
    if (tsc.status === 0) {
      const expectedFiles = listFiles(emit)
      const actualFiles = listFiles(join(root, 'lib/types'))
      const missing = expectedFiles.filter((rel) => !actualFiles.includes(rel))
      const orphan = actualFiles.filter((rel) => !expectedFiles.includes(rel))
      check(missing.length === 0, `no declaration is missing${missing.length > 0 ? ` (${missing.slice(0, 3).join(', ')})` : ''}`)
      check(orphan.length === 0, `no orphan declaration${orphan.length > 0 ? ` (${orphan.slice(0, 3).join(', ')})` : ''}`)
      const differing = expectedFiles
        .filter((rel) => actualFiles.includes(rel))
        .filter((rel) => sha256(join(emit, rel)) !== sha256(join(root, 'lib/types', rel)))
      check(differing.length === 0,
        `every declaration matches the fresh emit (${expectedFiles.length} files, sha256)`,
        differing.length > 0 ? `differs: ${differing.slice(0, 3).join(', ')} (stale: rebuild with npm run build)` : '')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n== declarations mirror src/ ==')
{
  const srcFiles = listFiles(join(root, 'src'))
  const expectedTypes = new Set(
    srcFiles.filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.d.ts'))
      .map((rel) => rel.slice(0, -3) + '.d.ts'),
  )
  const actualTypes = new Set(listFiles(join(root, 'lib/types')).filter((rel) => rel.endsWith('.d.ts')))
  const missingTypes = [...expectedTypes].filter((rel) => !actualTypes.has(rel)).sort()
  const orphanTypes = [...actualTypes].filter((rel) => !expectedTypes.has(rel)).sort()
  check(missingTypes.length === 0, `every source module has a declaration${missingTypes.length > 0 ? ` (missing: ${missingTypes.join(', ')})` : ''}`)
  check(orphanTypes.length === 0, `no orphan declarations${orphanTypes.length > 0 ? ` (stale: ${orphanTypes.join(', ')})` : ''}`)
}

console.log('\n== published surface ==')
const files = pkg.files ?? []
const covered = (target) => {
  const bare = target.replace(/^\.\//, '')
  // npm always packs the manifest, whatever `files` says.
  if (bare === 'package.json') return true
  if (files.includes(bare)) return true
  return files.some((entry) => {
    // `locale/*.json`, `lib/**/*.d.ts`: anchor the check at the first wildcard.
    const star = entry.indexOf('*')
    const prefix = (star === -1 ? entry : entry.slice(0, star)).replace(/\/$/, '')
    return prefix.length > 0 && (bare === prefix || bare.startsWith(`${prefix}/`))
  })
}
for (const [key, value] of Object.entries(pkg.exports)) {
  const leaf = typeof value === 'string' ? value : (value.default ?? value.types)
  const targets = leaf.includes('*') ? ['zh', 'en'].map((locale) => leaf.replace('*', locale)) : [leaf]
  const allExist = targets.every((target) => existsSync(join(root, target)))
  check(allExist, `exports["${key}"] -> ${leaf} exists`)
  check(targets.every(covered), `exports["${key}"] -> ${leaf} is covered by files[]`)
}

console.log(`\n${problems.length === 0 ? 'verify-build: all checks passed' : `verify-build: ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`}`)
process.exitCode = problems.length === 0 ? 0 : 1
