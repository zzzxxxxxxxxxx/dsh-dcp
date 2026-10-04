/**
 * The one description of how this package's host bundles are built, shared by
 * `scripts/build.mjs` (which writes them) and `scripts/verify-build.mjs` (which
 * rebuilds them in memory to prove the on-disk `lib/**` still matches `src/`).
 *
 * Keeping it in one module is what makes that proof meaningful: two copies of
 * these options could drift, and the drift would either make verification fail
 * for no reason or — worse — let it compare the artifact against a different
 * build than the one that produced it.
 *
 * @module dsh-dcp/scripts/build-options
 */

/**
 * Harness packages are resolved by the loader, never bundled: the Harness
 * resolves them from its own installation, and shipping a second copy breaks
 * service identity. `zod` is a normal runtime dependency (declared in
 * `dependencies`) resolved from `node_modules` — inlining it added ~750 KB of
 * the ~830 KB bundle.
 */
export const external = ['@deepseek-ai/*', 'zod']

/** esbuild options shared by both bundle entry points. */
export const shared = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external,
  sourcemap: false,
  logLevel: 'info',
}

/** The bundle entry points, relative to the package root. */
export const entryPoints = {
  host: 'src/index.ts',
  invariant: 'src/invariant.ts',
}

/** The browser half: authored in the loader envelope, copied verbatim. */
export const clientEntry = 'src/client/index.js'

/** Declaration-emit project used for `lib/types/**`. */
export const declarationProject = 'tsconfig.build.json'
