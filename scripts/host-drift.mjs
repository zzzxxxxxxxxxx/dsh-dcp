#!/usr/bin/env node
/**
 * Host-drift canary.
 *
 * The dsh runtime refuses to load a plugin whose `peerDependencies` do not
 * admit the running dsh version — it disables the profile row and boots without
 * the plugin, so the failure is silent from the user's side:
 *
 *     dsh: disabling profile plugin row "dsh-dcp": Plugin <name>@<version> is
 *     incompatible with dsh <runtime>: peerDependencies {...}
 *
 * That is how a plugin dies when dsh ships a new RC: the code is fine, the
 * declared range is stale. This script replays the host's own check locally so
 * the mismatch is caught before a release instead of after an upgrade.
 *
 * It reproduces the host rule exactly (`@deepseek-ai/dsh-app-boot`
 * `evaluatePluginCompatibility`):
 *
 *     for (const [name, range] of Object.entries(peerDependencies)) {
 *       if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
 *       const requirement = ['workspace:^','workspace:~','workspace:*'].includes(range) ? runtime : range
 *       if (!semver.satisfies(runtime, requirement, { includePrerelease: true })) -> incompatible
 *     }
 *
 * Only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers are examined — a
 * `@deepseek-ai/cordis` or `schemastery` range is never compared against the
 * dsh version. The runtime version and the semver implementation come from the
 * installed dsh itself, so the answer matches what dsh will decide.
 *
 * Usage:
 *   npm run test:host              # check against the installed dsh
 *   npm run test:host -- --latest  # also ask npm for the newest published dsh
 *
 * Exit 0 when every peer admits the runtime, 1 otherwise.
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { realpathSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const own = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

/** Resolve a module through the installed dsh, so we use its semver. */
function locateDsh() {
  const candidates = []
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN)
  try {
    candidates.push(execFileSync('/bin/sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim())
  } catch {
    /* dsh not on PATH; fall through to the explicit candidates */
  }
  candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const require = createRequire(realpathSync(candidate))
      return { require, version: require('@deepseek-ai/dsh/package.json').version, entry: realpathSync(candidate) }
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

const dsh = locateDsh()
if (dsh === null) {
  console.error('test:host — cannot locate an installed dsh (set DSH_BIN to its lib/bin.js).')
  process.exit(1)
}
const semver = dsh.require('semver')
const runtime = dsh.version

const peers = Object.entries(own.peerDependencies ?? {}).filter(
  // The host ignores every peer that is not part of its own release line.
  ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
)
if (peers.length === 0) {
  console.log('test:host — the package declares no `@deepseek-ai/dsh*` peerDependencies; nothing to check.')
  process.exit(0)
}

console.log(`test:host — dsh runtime ${runtime} (${dsh.entry})`)
console.log(`test:host — replaying the host gate with includePrerelease: true\n`)

const failures = []
for (const [name, range] of peers) {
  // The host's rule, verbatim: workspace: protocols mean "the running runtime".
  const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtime : range
  const ok = semver.satisfies(runtime, requirement, { includePrerelease: true })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(42)} ${range}`)
  if (!ok) failures.push({ name, range })
}

if (failures.length > 0) {
  console.error(
    `\ntest:host — FAIL: ${failures.length} peer ${failures.length === 1 ? 'range does' : 'ranges do'} not admit dsh ${runtime}.`,
  )
  console.error('dsh would DISABLE this plugin on load. Widen the range (e.g. ">=0.2.0-rc.2") before releasing.')
  process.exit(1)
}

console.log(`\ntest:host — PASS: all ${peers.length} peer ranges admit dsh ${runtime}.`)

// Optional: is a newer dsh published that these ranges would admit?
if (process.argv.includes('--latest')) {
  try {
    const specs = [...new Set(peers.filter(([name]) => name.startsWith('@deepseek-ai/dsh-')).map(([name]) => name))]
    const newest = execFileSync('npm', ['view', specs.join(','), 'version', '--json'], { encoding: 'utf8' }).trim()
    const versions = [...new Set(JSON.parse(newest) === null ? [] : [].concat(JSON.parse(newest)))]
    const ahead = versions.filter((v) => semver.gt(v, runtime))
    if (ahead.length === 0) {
      console.log(`test:host — npm has no published dsh peer newer than ${runtime}.`)
    } else {
      const admits = ahead.filter((v) => peers.some(([, range]) => !semver.satisfies(v, range, { includePrerelease: true })))
      console.log(`test:host — newer published: ${ahead.join(', ')}`)
      console.log(
        admits.length === 0
          ? 'test:host — the declared ranges admit every published newer version.'
          : `test:host — the ranges would REJECT: ${admits.join(', ')}`,
      )
    }
  } catch {
    console.log('test:host — skipped the --latest check (npm view unavailable or offline).')
  }
}
