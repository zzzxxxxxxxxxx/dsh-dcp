/**
 * Activation-path tests.
 *
 * A failed activation is the most expensive failure this plugin has: it costs
 * the user a plugin toggle, and the only diagnostic is a stack trace in the
 * Harness UI. These tests drive `apply()` against a recording stub context, so
 * every registration it makes — projection unit, tools, prompt section,
 * command, listeners — is exercised without a service container.
 *
 * @module dsh-dcp/tests/activation
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply, inject, name } from '../src/index.ts'
import type { Config } from '../src/config.ts'
import { initialDcpState } from '../src/types.ts'

/** What one `apply()` run tried to register. */
interface Recorded {
  projections: { key?: string; wire?: unknown; stateSchema?: unknown }[]
  tools: string[]
  sections: { name?: string; text?: () => string }[]
  commands: string[]
  listeners: string[]
  injects: string[][]
  infos: string[]
  callbacks: Record<string, ((...args: unknown[]) => unknown)[]>
}

/** A context that records registrations instead of mounting them. */
function recordingContext(): { ctx: never; seen: Recorded; agents: { current?: { inject: (message: unknown) => void } } } {
  const seen: Recorded = {
    projections: [], tools: [], sections: [], commands: [], listeners: [], injects: [], infos: [], callbacks: {},
  }
  const disposer = () => {}
  const scope = {
    effect: (body: () => unknown) => { body(); return disposer },
    systemPrompt: { section: (section: { name?: string }) => { seen.sections.push(section); return disposer } },
    commands: { register: (definition: { name: string }) => { seen.commands.push(definition.name); return disposer } },
  }
  // The agent registry is swappable so a test can model "no live agent yet" —
  // the shape the nudge path has to survive at a turn boundary.
  const agents: { current?: { inject: (message: unknown) => void } } = {}
  const ctx = {
    effect: (body: () => unknown) => { body(); return disposer },
    on: (event: string, callback: (...args: unknown[]) => unknown) => {
      seen.listeners.push(event)
      const list = seen.callbacks[event] ?? (seen.callbacks[event] = [])
      list.push(callback)
      return disposer
    },
    get: (service: string) => {
      if (service === 'tokenMeter') return { measure: () => ({ nodes: [], totalTokens: 100 }), estimateMessage: () => 0 }
      if (service === 'agents') return { get: () => agents.current }
      return undefined
    },
    inject: (deps: string[], body: (child: unknown) => unknown) => { seen.injects.push(deps); body(scope); return Promise.resolve() },
    logger: {
      info: (...args: unknown[]) => { seen.infos.push(args.map(String).join(' ')) },
      warn: (...args: unknown[]) => { seen.infos.push(args.map(String).join(' ')) },
    },
    sessionProjections: {
      register: (definition: { key?: string; wire?: unknown; stateSchema?: unknown }) => {
        seen.projections.push(definition)
        return disposer
      },
      stateOf: () => initialDcpState(),
    },
    tools: {
      register: (definition: { name: string }) => { seen.tools.push(definition.name); return disposer },
      get: () => undefined,
    },
  }
  return { ctx: ctx as never, seen, agents }
}

describe('plugin activation', () => {
  it('registers the projection unit with a client view and a state schema', () => {
    const { ctx, seen } = recordingContext()
    apply(ctx, {} as Config)
    expect(seen.projections).toHaveLength(1)
    expect(seen.projections[0]?.key).toBe('dcp')
    expect(seen.projections[0]?.wire).toBeDefined()
    expect(seen.projections[0]?.stateSchema).toBeDefined()
  })

  it('registers the three model-facing tools', () => {
    const { ctx, seen } = recordingContext()
    apply(ctx, {} as Config)
    expect(seen.tools.sort()).toEqual(['compact', 'compact_targets', 'recall'])
  })

  it('leaves the compact tool unregistered when compaction is denied', () => {
    const { ctx, seen } = recordingContext()
    apply(ctx, { compaction: { permission: 'deny' } } as Config)
    expect(seen.tools).toEqual([])
  })

  it('stops teaching the tool vocabulary that deny mode never registers', () => {
    const denied = recordingContext()
    apply(denied.ctx, { compaction: { permission: 'deny' } } as Config)
    const deniedText = denied.seen.sections[0]?.text?.() ?? ''
    expect(deniedText).not.toContain('compact collapses')
    expect(deniedText).toContain('Compaction is disabled')

    // The pruning path keeps running under deny, so the section still names it.
    expect(deniedText).toContain('duplicate tool outputs')

    const allowed = recordingContext()
    apply(allowed.ctx, {} as Config)
    expect(allowed.seen.sections[0]?.text?.()).toContain('compact collapses a contiguous span')
  })

  it('drops the recall tool when it is switched off', () => {
    const { ctx, seen } = recordingContext()
    apply(ctx, { compaction: { recall: false } } as Config)
    expect(seen.tools.sort()).toEqual(['compact', 'compact_targets'])
  })

  it('contributes one prompt section and one command, and subscribes to session events', () => {
    const { ctx, seen } = recordingContext()
    apply(ctx, {} as Config)
    expect(seen.sections.map((section) => section.name)).toEqual(['dsh-dcp'])
    expect(seen.commands).toEqual(['dcp-compact'])
    expect(seen.listeners.filter((event) => event === 'session/event').length).toBeGreaterThanOrEqual(1)
    expect(seen.injects).toContainEqual(['systemPrompt'])
  })

  it('declares the services it needs and a stable name', () => {
    expect(name).toBe('dsh-dcp')
    expect(inject).toEqual(['tools', 'sessionProjections'])
  })

  it('rejects a misspelled setting at load time', () => {
    const { ctx } = recordingContext()
    expect(() => apply(ctx, { compaction: { modes: 'range' } } as never)).toThrow(/unknown setting/)
  })

  it('keeps the nudge diagnostic per application, not per module', () => {
    const first = recordingContext()
    apply(first.ctx, {} as Config)
    const second = recordingContext()
    apply(second.ctx, {} as Config)

    // One closed turn with no thresholds configured: a verdict of `null` whose
    // reason is worth exactly one log line per session.
    const session = Session.create('nudge-diagnostic' as never)
    session.append('turn/start', { turn: 1 })
    const event = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    const fire = (seen: Recorded): void => {
      for (const listener of seen.callbacks['session/event'] ?? []) listener(session, event)
    }
    fire(first.seen)
    fire(second.seen)

    expect(first.seen.infos.some((line) => line.includes('no nudge'))).toBe(true)
    // The seen-set used to be a module-level WeakMap, so the second application
    // inherited the first one's memory of this session and said nothing at all.
    expect(second.seen.infos.some((line) => line.includes('no nudge'))).toBe(true)
  })

  it('re-delivers a nudge the turn boundary could not inject', async () => {
    const { ctx, seen, agents } = recordingContext()
    // Absolute thresholds put any non-empty session inside the weak band.
    apply(ctx, { compaction: { minContextLimit: 1, maxContextLimit: 1_000_000, nudgeFrequency: 1 } } as Config)

    const injected: string[] = []
    const session = Session.create('nudge-retry' as never)
    session.append('turn/start', { turn: 1 })
    session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    const start = session.append('turn/start', { turn: 2 })

    const fire = (event: unknown): void => {
      for (const listener of seen.callbacks['session/event'] ?? []) listener(session, event)
    }
    const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10) })

    // At the boundary there is no live agent: `inject` cannot land, and that used
    // to be the end of it — the reminder was simply lost, silently.
    fire(end)
    await tick()
    expect(injected).toHaveLength(0)

    agents.current = { inject: (message: unknown) => {
      const content = (message as { content?: readonly { type?: string; text?: string }[] }).content ?? []
      injected.push(content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'))
    } }
    fire(start)
    await tick()

    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('The conversation is long enough')
    expect(injected[0]).toContain('[dsh-dcp] Automatic context reminder')
  })

  it('re-reads prompt overrides and re-mounts the tools when the switch flips', async () => {
    // `experimental.customPrompts` used to be read once, at mount: the switch was
    // live but the files were not, so enabling it (or editing an override) did
    // nothing until the next plugin reload. Both halves are live now, and the tool
    // descriptions come from the same store, so the tools are re-registered.
    const home = mkdtempSync(join(tmpdir(), 'dcp-hot-prompts-'))
    const previousHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    try {
      const overrides = join(home, 'dcp-prompts', 'overrides')
      mkdirSync(overrides, { recursive: true })
      writeFileSync(join(overrides, 'turn-nudge.md'), 'OVERRIDE: consider compacting soon.\n', 'utf8')

      let enabled = false
      const boxed = <T>(read: () => T): { get: () => T } => ({ get: read })
      const { ctx, seen, agents } = recordingContext()
      apply(ctx, {
        compaction: {
          minContextLimit: boxed(() => 0),
          maxContextLimit: boxed(() => 1_000_000),
          nudgeFrequency: boxed(() => 1),
        },
        experimental: { customPrompts: boxed(() => enabled) },
      } as never)

      const injected: string[] = []
      agents.current = { inject: (message: unknown) => {
        const content = (message as { content?: readonly { type?: string; text?: string }[] }).content ?? []
        injected.push(content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'))
      } }

      const session = Session.create('hot-prompts' as never)
      session.append('turn/start', { turn: 1 })
      session.append('user/message',
        createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
        { surfaceOp: 'append' })
      const assistant = session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'hi' }],
          source: { provider: 'test', model: 'test' },
        }),
        stream: [],
      }, { surfaceOp: 'append' })
      const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
      const fire = (event: unknown): void => {
        for (const listener of seen.callbacks['session/event'] ?? []) listener(session, event)
      }
      const registrations = (name: string): number => seen.tools.filter((tool) => tool === name).length
      const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10) })

      fire(end)
      await tick()
      expect(injected).toHaveLength(1)
      expect(injected[0]).toContain('The conversation is long enough')
      expect(injected[0]).not.toContain('OVERRIDE')

      // The flip is noticed on the next event that reads the configuration, and
      // the tools are re-mounted right there — not lazily, on the next reminder,
      // which a deployment below the band might never see.
      enabled = true
      const beforeFlip = registrations('compact')
      fire(assistant)
      await tick()
      expect(registrations('compact')).toBe(beforeFlip + 1)
      expect(injected, 'a mid-turn event decides no reminder').toHaveLength(1)

      fire(end)
      await tick()

      expect(injected).toHaveLength(2)
      expect(injected[1]).toContain('OVERRIDE: consider compacting soon.')
      // The prefix is restored even though the override does not carry it.
      expect(injected[1]).toContain('[dsh-dcp] Automatic context reminder')
      // …and the tools were re-mounted, because their descriptions read the store.
      expect(seen.tools.filter((name) => name === 'compact')).toHaveLength(2)
      expect(seen.tools.filter((name) => name === 'compact_targets')).toHaveLength(2)
    } finally {
      if (previousHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
