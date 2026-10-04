/**
 * Container-level activation tests.
 *
 * Every other test hands `apply()` a hand-written configuration object. That is
 * exactly how this plugin shipped with ten `.volatile()` fields that did
 * nothing: schemastery parses a volatile field into a stable REFERENCE, and only
 * a real cordis container delivers it that way. Reading one as a value is
 * silently always wrong — `manualFor()` was permanently `false`, and
 * `Math.floor(config.compaction.nudgeFrequency)` was `NaN`, so `nodesSince >=
 * NaN` never held and no nudge ever fired. No test noticed, because no test
 * went through a container.
 *
 * These tests mount the real schema in a real container, so the delivery shape
 * cannot drift out from under the runtime again.
 *
 * @module dsh-dcp/tests/container
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema, manualFor, resolveConfig } from '../src/config.ts'
import { strategiesAllowed } from '../src/strategies/index.ts'
import { initialDcpState } from '../src/types.ts'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'

/** A fully-armed deployment: every volatile field set to a NON-default value. */
const RAW = {
  pruneNotification: 'off',
  turnProtection: { enabled: true, turns: 99 },
  manualMode: { enabled: true, automaticStrategies: false },
  compaction: {
    nudgeFrequency: 4,
    maxContextLimit: '80%',
    minContextLimit: 1234,
    protectUserMessages: true,
  },
  commands: { protectedTools: ['never-touch'] },
  experimental: { allowSubAgents: true, customPrompts: true },
  strategies: { deduplication: { enabled: false } },
} as const

/** What one `apply()` run tried to register. */
interface Recorded {
  projections: number
  tools: string[]
  commands: string[]
  listeners: string[]
}

/** A context that records registrations instead of mounting them. */
function recordingContext(): { ctx: never; seen: Recorded } {
  const seen: Recorded = { projections: 0, tools: [], commands: [], listeners: [] }
  const disposer = (): void => {}
  const scope = {
    effect: (body: () => unknown) => { body(); return disposer },
    systemPrompt: { section: () => disposer },
    commands: { register: (definition: { name: string }) => { seen.commands.push(definition.name); return disposer } },
  }
  const ctx = {
    effect: (body: () => unknown) => { body(); return disposer },
    on: (event: string) => { seen.listeners.push(event); return disposer },
    get: () => undefined,
    inject: (_deps: string[], body: (child: unknown) => unknown) => { body(scope); return Promise.resolve() },
    logger: { info: () => {}, warn: () => {} },
    sessionProjections: { register: () => { seen.projections += 1; return disposer } },
    tools: { register: (definition: { name: string }) => { seen.tools.push(definition.name); return disposer }, get: () => undefined },
  }
  return { ctx: ctx as never, seen }
}

/**
 * Mount the plugin's real schema in a real container and hand back what the
 * container passes to `apply()` — the shape production actually sees.
 *
 * @param raw - the row configuration to mount with.
 * @param name - plugin name, so two mounts in one file stay distinguishable.
 */
async function deliveredConfigFor(raw: unknown = RAW, name = 'dsh-dcp-container-test'): Promise<Record<string, any>> {
  const ctx = new Context()
  let delivered: unknown
  ctx.plugin({
    name,
    Config: ConfigSchema,
    apply: (_child: unknown, config: unknown) => { delivered = config },
  }, raw as never)
  await new Promise((resolve) => { setTimeout(resolve, 25) })
  expect(delivered).toBeDefined()
  return delivered as Record<string, any>
}

/** The fully-armed deployment's delivered shape. */
async function deliveredConfig(): Promise<Record<string, any>> {
  return deliveredConfigFor()
}

describe('cordis container delivery', () => {
  it('hands volatile fields over as references, not values', async () => {
    // The hazard itself, pinned. If a future schemastery starts inlining these,
    // this test fails and the boundary in `resolveConfig` can be reconsidered.
    const raw = await deliveredConfig()
    expect(typeof raw['manualMode'].enabled).toBe('object')
    expect(typeof raw['manualMode'].enabled.get).toBe('function')
    expect(typeof raw['compaction'].nudgeFrequency).toBe('object')
    expect(raw['manualMode'].enabled === true).toBe(false)
    // Every field the settings card can write arrives this way, so each new row
    // is one more place `resolveConfig` has to unwrap.
    for (const value of [
      raw['compaction'].maxContextLimit,
      raw['compaction'].minContextLimit,
      raw['compaction'].protectUserMessages,
      raw['experimental'].allowSubAgents,
    ]) {
      expect(typeof value).toBe('object')
      expect(typeof value.get).toBe('function')
    }
  })

  it('resolves every volatile field to the configured value', async () => {
    const config = resolveConfig(await deliveredConfig())
    expect(config.pruneNotification).toBe('off')
    expect(config.turnProtection?.enabled).toBe(true)
    expect(config.turnProtection?.turns).toBe(99)
    expect(config.manualMode?.enabled).toBe(true)
    expect(config.manualMode?.automaticStrategies).toBe(false)
    expect(config.compaction?.nudgeFrequency).toBe(4)
    expect(config.strategies?.deduplication?.enabled).toBe(false)
    expect(config.compaction?.maxContextLimit).toBe('80%')
    expect(config.compaction?.minContextLimit).toBe(1234)
    expect(config.compaction?.protectUserMessages).toBe(true)
    expect(config.experimental?.allowSubAgents).toBe(true)
    expect(config.experimental?.customPrompts).toBe(true)
  })

  it('leaves the arithmetic the runtime does on those fields finite', async () => {
    // The expression that was `NaN` in production.
    const config = resolveConfig(await deliveredConfig())
    expect(Number.isFinite(Math.max(1, Math.floor(config.compaction?.nudgeFrequency ?? 5)))).toBe(true)
    expect(Number.isFinite(config.turnProtection?.turns ?? 4)).toBe(true)
    expect(Math.max(1, Math.floor(config.compaction?.nudgeFrequency ?? 5))).toBe(4)
  })

  it('makes the switches they gate actually switch', async () => {
    const config = resolveConfig(await deliveredConfig())
    expect(manualFor(config)).toBe(true)
    // `manualMode.automaticStrategies: false` means the strategies stand down.
    expect(strategiesAllowed(config, { ...initialDcpState(), turn: 2 })).toBe(false)
  })

  it('applies the schema defaults a container fills in for an empty row', async () => {
    // The container, not `resolveConfig`, has to be what supplies these: every
    // assertion below also holds for `resolveConfig(undefined)`, because
    // `resolveConfig` carries the same fallbacks. Asserting the DELIVERED shape
    // first is what makes this a container test rather than a tautology.
    const delivered = await deliveredConfigFor({})
    expect(delivered['pruneNotification']).toBeDefined()
    expect(typeof delivered['compaction'].nudgeFrequency.get).toBe('function')
    expect(delivered['compaction'].nudgeFrequency.get()).toBe(5)

    // `maxContextLimit` ships as a number and takes a percentage, so the
    // default has to survive the union as a number.
    expect(delivered['compaction'].maxContextLimit.get()).toBe('67%')

    const config = resolveConfig(delivered)
    expect(config.pruneNotification).toBe('minimal')
    expect(config.compaction?.maxContextLimit).toBe('67%')
    expect(config.compaction?.minContextLimit).toBe('33%')
    expect(config.compaction?.protectUserMessages).toBe(false)
    expect(config.experimental?.allowSubAgents).toBe(false)
    expect(config.compaction?.nudgeFrequency).toBe(5)
    expect(config.turnProtection?.turns).toBe(4)
    expect(config.strategies?.deduplication?.enabled).toBe(true)
    expect(manualFor(config)).toBe(false)
  })

  it('still accepts a hand-written configuration', () => {
    // Tests build configurations by hand; the boundary must pass those through.
    const config = resolveConfig({ manualMode: { enabled: true }, turnProtection: { turns: 2 } })
    expect(manualFor(config)).toBe(true)
    expect(config.turnProtection?.turns).toBe(2)
    expect(config.compaction?.nudgeFrequency).toBe(5)
  })

  it('mounts the real plugin against the container-delivered configuration', async () => {
    // The end-to-end path: a container-parsed config reaches `apply()` and
    // everything it registers still comes up. A boundary that threw on the real
    // shape would fail here.
    //
    const { ctx, seen } = recordingContext()
    const config = await deliveredConfig()
    expect(() => apply(ctx, config as unknown as Config)).not.toThrow()
    expect(seen.projections).toBe(1)
    expect(seen.tools.sort()).toEqual(['compact', 'compact_targets', 'recall'])
    expect(seen.commands).toEqual(['dcp-compact'])
    expect(seen.listeners).toContain('session/event')
  })
})
