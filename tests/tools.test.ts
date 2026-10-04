/**
 * Tool-definition tests.
 *
 * `defineTool` compiles the declared schema DSL at definition time, so building
 * a definition is the same validation a mounted service container would run.
 * Keeping that check in the suite is what catches a schema written against the
 * wrong DSL — a mistake that otherwise surfaces only as a failed plugin
 * activation in the Harness.
 *
 * @module dsh-dcp/tests/tools
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { compactTool, recallTool, targetsTool } from '../src/index.ts'
import type { PluginRuntime } from '../src/index.ts'
import { Config as ConfigSchema } from '../src/config.ts'
import { NUDGE_PREFIX, loadPrompts } from '../src/prompts/index.ts'
import { SessionMutex } from '../src/runner.ts'

/** The smallest runtime the definitions touch: prompts are read at build time. */
function stubRuntime(): PluginRuntime {
  return {
    ctx: undefined as never,
    config: {},
    prompts: loadPrompts(false, false),
    mutex: new SessionMutex(),
    nudgeBlocks: new WeakMap(),
    stateOf: () => { throw new Error('not used at definition time') },
    priceOf: () => () => undefined,
    // No meter in a definition-time stub, which is exactly what the runtime
    // reports when the service is absent.
    estimateMessage: () => undefined,
    declaredPaths: () => [],
  }
}

describe('tool definitions compile', () => {
  it('accepts every definition the plugin registers', () => {
    const rt = stubRuntime()
    expect(() => compactTool(rt)).not.toThrow()
    expect(() => targetsTool(rt)).not.toThrow()
    expect(() => recallTool(rt)).not.toThrow()
  })

  it('names the tools the prompts and the panel refer to', () => {
    const rt = stubRuntime()
    expect(compactTool(rt).name).toBe('compact')
    expect(targetsTool(rt).name).toBe('compact_targets')
    expect(recallTool(rt).name).toBe('recall')
  })

  it('keeps the configuration schema serializable for the settings page', () => {
    const json = ConfigSchema.toJSON() as { refs?: Record<string, { meta?: { description?: string } }> }
    const described = Object.values(json.refs ?? {}).filter((node) => node.meta?.description !== undefined)
    expect(described.length).toBeGreaterThan(20)
  })

  it('does not store the targets listing twice', () => {
    const tool = targetsTool(stubRuntime())
    const value = { text: 'n1 system ~10tok <>\n'.repeat(80), targets: 12 }
    // `content` already carries the listing to the panel; repeating it here wrote
    // the same ~2 KB into the durable presentation meta of every call.
    expect(tool.output.presentationMeta?.({}, value)).toEqual({ targets: 12 })
  })
})

describe('prompt overrides', () => {
  it('restores the nudge prefix an override tried to drop', () => {
    const home = mkdtempSync(join(tmpdir(), 'dcp-prompts-'))
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    try {
      const overrides = join(home, 'dcp-prompts', 'overrides')
      mkdirSync(overrides, { recursive: true })
      writeFileSync(join(overrides, 'turn-nudge.md'), 'The conversation is getting long; consider compacting.\n')
      const loaded = loadPrompts(true, false)
      expect(loaded.applied).toHaveLength(1)
      expect(loaded.text['turn-nudge']).toContain('consider compacting')
      // Without the prefix the model reads the reminder as the user speaking.
      expect(loaded.text['turn-nudge'].startsWith(NUDGE_PREFIX)).toBe(true)
      // The edit is still the author's: the prefix is added, not replaced.
      expect(loaded.text['turn-nudge']).not.toBe(NUDGE_PREFIX)
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('SessionMutex', () => {
  it('serializes two passes for one session', async () => {
    const mutex = new SessionMutex()
    const session = Session.create('mutex-order' as never)
    const order: number[] = []
    await Promise.all([
      mutex.run(session, async () => { await Promise.resolve(); order.push(1) }),
      mutex.run(session, () => { order.push(2) }),
    ])
    expect(order).toEqual([1, 2])
  })

  it('throws on a nested pass for the same session instead of deadlocking', async () => {
    const mutex = new SessionMutex()
    const session = Session.create('mutex-nested' as never)
    // The inner call would wait for the pass holding the chain — itself — and
    // never settle; an error is the only outcome a caller can act on.
    await expect(mutex.run(session, () => mutex.run(session, () => 'inner'))).rejects.toThrow(/not reentrant/)
    // And the chain is still usable afterwards.
    await expect(mutex.run(session, () => 'after')).resolves.toBe('after')
  })
})
