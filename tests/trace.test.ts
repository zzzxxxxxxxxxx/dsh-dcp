/**
 * Tests for the opt-in file trace.
 *
 * @module dsh-dcp/tests/trace
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { trace } from '../src/trace.ts'

describe('optional file trace', () => {
  it('writes only when DSH_DCP_TRACE names a file, and never throws', () => {
    const previous = process.env['DSH_DCP_TRACE']
    const dir = mkdtempSync(join(tmpdir(), 'dcp-trace-'))
    const file = join(dir, 'trace.log')
    try {
      delete process.env['DSH_DCP_TRACE']
      trace('test/unset', { a: 1 })
      expect(existsSync(file)).toBe(false)

      process.env['DSH_DCP_TRACE'] = file
      trace('test/set', { a: 1, b: 'x', skipped: undefined })
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('test/set')
      expect(lines[0]).toContain('a=1')
      expect(lines[0]).toContain('b=x')
      // Undefined fields are dropped rather than rendered as "undefined".
      expect(lines[0]).not.toContain('skipped')

      // An unwritable path degrades to no trace; a debug aid must never break a run.
      process.env['DSH_DCP_TRACE'] = join(dir, 'missing', 'trace.log')
      expect(() => trace('test/broken')).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env['DSH_DCP_TRACE']
      else process.env['DSH_DCP_TRACE'] = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
