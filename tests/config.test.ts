/**
 * Configuration-surface tests.
 *
 * A `.volatile()` field is the only kind the Host serves to a settings form,
 * and a volatile write is applied without remounting. Two mistakes follow from
 * that, and neither fails loudly on its own:
 *
 * - a field marked volatile but absent from the settings card is invisible;
 * - a card control for a non-volatile field saves a value the Host refuses.
 *
 * These tests compare the schema against the card's table so the two cannot
 * drift.
 *
 * @module dsh-dcp/tests/config
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_COMPACTION_PROTECTED_TOOLS } from '../src/config.ts'
import { matchesAny } from '../src/protected.ts'

const client = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')

/** One schemastery node, as much of it as walking a config schema needs. */
interface SchemaNode {
  meta?: { volatile?: boolean; default?: unknown }
  dict?: Record<string, SchemaNode>
}

/** Every path in the schema whose nearest volatile ancestor marks it editable. */
function volatilePaths(node: SchemaNode, prefix: string[] = []): string[] {
  const here = node.meta?.volatile === true
  const children = Object.entries(node.dict ?? {})
  const own = here && prefix.length > 0 ? [prefix.join('.')] : []
  // A volatile group makes each leaf beneath it editable, so keep descending.
  const deeper = children.flatMap(([key, child]) => volatilePaths(child, [...prefix, key]))
  if (here && children.length > 0) return own.length > 0 ? [...own, ...deeper] : deeper
  return [...own, ...deeper]
}

/** The fields the settings card offers. */
function cardFields(): string[] {
  const table = /const SETTINGS_FIELDS = \[([\s\S]*?)\n    \]/.exec(client)?.[1] ?? ''
  return [...table.matchAll(/field: '([\w.]+)'/g)].map((match) => match[1] as string)
}

const volatile = volatilePaths(Config as unknown as SchemaNode).sort()
const card = cardFields().sort()

describe('settings surface', () => {
  it('marks the fields the plugin reads at use time', () => {
    expect(volatile).toEqual([
      'compaction.maxContextLimit',
      'compaction.minContextLimit',
      'compaction.nudgeFrequency',
      'compaction.protectUserMessages',
      'experimental.allowSubAgents',
      'experimental.customPrompts',
      'manualMode.automaticStrategies',
      'manualMode.enabled',
      'pruneNotification',
      'strategies.deduplication.enabled',
      'turnProtection.enabled',
      'turnProtection.turns',
    ])
  })

  it('offers exactly the fields the Host serves', () => {
    expect(card).toEqual(volatile)
  })

  it('leaves the plugin switch to the Plugins page', () => {
    // The Plugins page already switches the whole bundle on and off, so the
    // settings page must not offer a second master switch.
    expect(card).not.toContain('enabled')
    expect(volatile).not.toContain('enabled')
  })

  it('leaves the two remaining config-only switches out of both', () => {
    // Not because a write could not land: `reconcileProfilePatches`
    // (dsh-app-boot) disposes and rebuilds the entry, so `apply()` runs again
    // and a volatile field of ANY kind takes effect — that is how the other
    // seventeen work. These two are held back on purpose.
    //
    // `recall` is on by default and off is a downgrade with no upside in a
    // running session; `permission` still offers `ask`, which this plugin's
    // whole premise argues against. Neither needs a switch in the panel.
    expect(card).not.toContain('compaction.permission')
    expect(card).not.toContain('compaction.recall')
    expect(volatile).not.toContain('compaction.permission')
    expect(volatile).not.toContain('compaction.recall')
  })

  it('protects every delegation tool the presets register', () => {
    // The tool name is per-provider (`dsh-tool-subagent`'s `toolName`), and the
    // shipped presets register four instances. Each returns
    // `started subagent <id>` for a continuable child, and that id is the only
    // handle `send_message` accepts — nothing lists a parent's subagent
    // children. Naming the bare `subagent` protected one of the four and
    // stranded the rest, which is why the default is a glob.
    for (const name of ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code']) {
      expect(matchesAny(name, DEFAULT_COMPACTION_PROTECTED_TOOLS), name).toBe(true)
    }
    expect(matchesAny('skill', DEFAULT_COMPACTION_PROTECTED_TOOLS)).toBe(true)
    // A route catalogue is not a delegation, and a receipt is not a handle.
    expect(matchesAny('list_subagent_models', DEFAULT_COMPACTION_PROTECTED_TOOLS)).toBe(false)
    expect(matchesAny('todo_write', DEFAULT_COMPACTION_PROTECTED_TOOLS)).toBe(false)
  })
})
