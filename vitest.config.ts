import { defineConfig } from 'vitest/config'

/**
 * Vitest scope for the plugin package.
 *
 * `references/` holds read-only checkouts (the upstream opencode-dcp plugin and
 * a DSH source tree) whose own test suites are not ours to run; only `tests/`
 * belongs to this package.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'lib/**', 'references/**'],
    testTimeout: 20_000,
  },
})
