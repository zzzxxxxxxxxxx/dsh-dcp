/**
 * Client-bundle integrity tests.
 *
 * The browser half is plain JavaScript in the module-loader envelope, so
 * nothing type-checks it and nothing renders it in CI. These tests cover the
 * two failure modes that have actually happened: a class used in markup with no
 * rule behind it (the layout silently degrades instead of erroring), and a wire
 * field read without a guard (a version skew prints `NaN`).
 *
 * @module dsh-dcp/tests/client
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')

/**
 * The row conditions, lifted out of the bundle and made callable.
 *
 * `false` means the row renders disabled — it stays on screen, so the reader
 * does not have to go looking for a setting that vanished.
 *
 * The predicates are self-contained on purpose — one parameter, no captured
 * names — so this table can be evaluated instead of pattern-matched. A regex
 * over the source would pass on a predicate that reads the wrong field.
 */
function rowRequires(): Record<string, (on: (field: string) => boolean) => boolean> {
  const block = /const ROW_REQUIRES = \{([\s\S]*?)\n    \}/.exec(source)?.[1] ?? ''
  return new Function(`return {${block}}`)() as Record<string, (on: (field: string) => boolean) => boolean>
}

/** A `switchOn` resolver for the switches named in `on`. */
const switches = (...on: string[]) => (field: string): boolean => on.includes(field)

/** The rules the bundle ships. */
const styles = /const STYLES = `([\s\S]*?)`/.exec(source)?.[1] ?? ''

/** Every class name the markup applies. */
// A className may carry several classes; the sheet must cover each of them.
const used = new Set([...source.matchAll(/className: '([^']+)'/g)]
  .flatMap((match) => (match[1] as string).split(/\s+/)))

/** Every class name the stylesheet defines. */
const defined = new Set([...styles.matchAll(/\.([a-z][\w-]*)\s*[{:]/g)].map((match) => match[1] as string))

/**
 * The keys the markup renders.
 *
 * The lookbehind matters: `ctx.get('locale')` ends in the same characters as a
 * `t('locale')` call, and a looser pattern silently invents a key.
 */
function renderedKeys(): Set<string> {
  return new Set([...source.matchAll(/(?<![\w.])t\('([\w.]+)'\)/g)].map((match) => match[1] as string))
}

/** The keys one language block declares. */
function keysOf(language: string): string[] {
  const block = new RegExp(`${language}: \\{([\\s\\S]*?)\\n      \\},`).exec(source)?.[1] ?? ''
  return [...block.matchAll(/'([\w.]+)':/g)].map((match) => match[1] as string)
}

/** The `SETTINGS_FIELDS` table block, lifted out of the bundle. */
function settingsFieldsBlock(): string {
  return /const SETTINGS_FIELDS = \[([\s\S]*?)\n    \]/.exec(source)?.[1] ?? ''
}

/** The fields the card offers, in render order. */
function offeredFields(): string[] {
  return [...settingsFieldsBlock().matchAll(/field: '([\w.]+)'/g)].map((match) => match[1] as string)
}

/** Every choice id the field table names. */
function offeredChoices(): string[] {
  return [...settingsFieldsBlock().matchAll(/choices: \[([^\]]*)\]/g)]
    .flatMap((match) => [...(match[1] ?? '').matchAll(/'([\w-]+)'/g)].map((one) => one[1] as string))
}

/** The `SETTINGS_GROUPS` table block, lifted out of the bundle. */
function settingsGroupsBlock(): string {
  return /const SETTINGS_GROUPS = \[([\s\S]*?)\n    \]/.exec(source)?.[1] ?? ''
}

/**
 * The keys the card COMPOSES from its tables at render time.
 *
 * Built by evaluating those tables, not by a `field.`/`choice.`/`group.` prefix
 * test: a prefix test exempts any key that merely looks composed, which is how
 * `field.on` and `field.off` — two entries nothing ever rendered — survived a
 * test named "free of keys nothing renders".
 */
function composedKeys(): Set<string> {
  const keys = new Set<string>()
  for (const name of offeredFields()) {
    keys.add(`field.${name}.label`)
    keys.add(`field.${name}.hint`)
  }
  for (const choice of offeredChoices()) keys.add(`choice.${choice}`)
  for (const id of [...settingsGroupsBlock().matchAll(/id: '([\w-]+)'/g)].map((match) => match[1] as string)) {
    keys.add(`group.${id}`)
  }
  return keys
}

describe('client bundle', () => {
  it('loads through the module-loader envelope with the package id', () => {
    expect(source).toContain('window.__ModuleLoader__.load({')
    expect(source).toMatch(/id: 'dsh-dcp'/)
  })

  it('requires nothing outside the client module table baseline', () => {
    const baseline = new Set([
      'react',
      'react-dom',
      '@deepseek-ai/dsh-client-ui-primitives',
    ])
    const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1] as string)
    expect(required.filter((name) => !baseline.has(name))).toEqual([])
  })

  it('defines a rule for every class its markup applies', () => {
    const missing = [...used].filter((name) => !defined.has(name))
    expect(missing).toEqual([])
  })

  it('keeps the sheet free of rules nothing uses', () => {
    const orphaned = [...defined].filter((name) => !used.has(name))
    expect(orphaned).toEqual([])
  })

  it('registers only into slots this bundle can actually reach', () => {
    const slots = [...source.matchAll(/slots\.inject\('([^']+)'/g)].map((match) => match[1])
    expect([...slots].sort()).toEqual(['conversation.composer.dock', 'settings.section'])
  })

  it('claims a settings order no other section is known to claim', () => {
    // The shell sorts `settings.section` with a bare `a.order - b.order` and no
    // tie-break (ui-settings-general), so an order shared with another plugin
    // leaves the two nav rows in load order — which flipped between reloads while
    // this card and the sidebar plugin both claimed 100.
    const order = /order: (\d+),\s*\n\s*label: \(\) => t\('settings\.title'\)/.exec(source)?.[1]
    expect(order, 'the settings section declares its order').toBeDefined()
    expect(order).toBe('95')
  })

  it('keeps both dictionaries free of keys nothing renders', () => {
    const rendered = renderedKeys()
    const composed = composedKeys()
    for (const language of ['zh', 'en']) {
      const unused = keysOf(language).filter((key) => !rendered.has(key) && !composed.has(key))
      expect(unused, language).toEqual([])
    }
  })

  it('documents every settings field it offers, in both languages', () => {
    const names = offeredFields()
    const choices = offeredChoices()
    expect(names.length).toBeGreaterThan(0)
    for (const language of ['zh', 'en']) {
      const keys = new Set(keysOf(language))
      for (const name of names) {
        expect(keys.has(`field.${name}.label`), `${language} label for ${name}`).toBe(true)
        expect(keys.has(`field.${name}.hint`), `${language} hint for ${name}`).toBe(true)
      }
      for (const choice of choices) {
        expect(keys.has(`choice.${choice}`), `${language} copy for choice ${choice}`).toBe(true)
      }
    }
  })

  it('judges every numeric row in the browser before the Host has to', () => {
    // `parseValue` refuses what the schema's `min`/`step` would refuse, so a
    // numeric row that loses its bounds silently starts spending a round trip
    // on every rejected draft — and lets a fractional value through to be
    // refused there. The bounds are a copy of the schema's, so nothing but this
    // test keeps the copy honest.
    const rows = settingsFieldsBlock().match(/\{ field: '[\w.]+', kind: 'number'[^}]*\}/g) ?? []
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row, row).toMatch(/min: \d+/)
      expect(row, row).toMatch(/step: \d+/)
    }
  })

  it('declares every key it renders in both languages', () => {
    const rendered = renderedKeys()
    const zh = new Set(keysOf('zh'))
    const en = new Set(keysOf('en'))
    for (const key of rendered) {
      expect(zh.has(key), `zh is missing ${key}`).toBe(true)
      expect(en.has(key), `en is missing ${key}`).toBe(true)
    }
  })

  it('never renders a non-finite number', () => {
    // A guarded formatter is the only place a count becomes text.
    expect(source).toMatch(/if \(!Number\.isFinite\(tokens\)\) return/)
  })

  it('mounts its settings section without waiting to be served', () => {
    // Gating the section on the namespace would hide the page entirely, and an
    // unserved namespace would then be indistinguishable from a broken one.
    expect(source).toContain("slots.inject('settings.section'")
    expect(source).not.toContain('whileServed')
  })

  it('keeps the settings service off the activation gate', () => {
    // cordis runs `apply` only once every hard-injected service exists, so a
    // hard `configForms` edge silences the readout too in a deployment that
    // composes no settings surface. The card takes the service dynamically and
    // stays unmounted while it is absent.
    expect(source).toMatch(/inject: \['slots'\]/)
    expect(source).not.toMatch(/inject: \[[^\]]*'configForms'/)
    expect(source).toMatch(/ctx\.inject\(\['configForms'\]/)
  })

  it('sends only the path ops the Host declares', () => {
    // The Host's wire union is `{op:'set'|'unset'}` (dsh-settings types.d.ts,
    // `SettingsPathOpView`). `clear` only ever worked because the Host's
    // implementation special-cases `set` and lets every other spelling fall
    // into the unset branch.
    const ops = [...source.matchAll(/op: '([a-z]+)'/g)].map((match) => match[1] as string)
    expect(ops.length).toBeGreaterThan(0)
    expect(ops.filter((op) => op !== 'set' && op !== 'unset')).toEqual([])
  })
  it('disables a row while the switches it depends on are off', () => {
    const rows = rowRequires()
    const dedup = 'strategies.deduplication.enabled'
    const manual = 'manualMode.enabled'

    // `manualMode.automaticStrategies` only ever matters in one of the four
    // combinations: manual mode on AND deduplication on. The shipped default is
    // manual mode off, so the row is greyed out on a fresh install rather than
    // sitting there looking operational.
    expect(rows['manualMode.automaticStrategies']?.(switches(dedup))).toBe(false)
    expect(rows['manualMode.automaticStrategies']?.(switches(manual))).toBe(false)
    expect(rows['manualMode.automaticStrategies']?.(switches())).toBe(false)
    expect(rows['manualMode.automaticStrategies']?.(switches(manual, dedup))).toBe(true)

    // Both turn-protection rows are read only inside the deduplication strategy.
    expect(rows['turnProtection.enabled']?.(switches())).toBe(false)
    expect(rows['turnProtection.turns']?.(switches(dedup))).toBe(false)
    expect(rows['turnProtection.turns']?.(switches(dedup, 'turnProtection.enabled'))).toBe(true)

    // Manual mode returns null from the nudges before either field is read.
    expect(rows['compaction.nudgeFrequency']?.(switches())).toBe(true)
    expect(rows['compaction.nudgeFrequency']?.(switches(manual))).toBe(false)
  })

  it('names only fields the card actually offers', () => {
    const offered = new Set(offeredFields())
    for (const field of Object.keys(rowRequires())) {
      expect(offered.has(field), `${field} is not a settings row`).toBe(true)
    }
  })

  it('files every settings field under exactly one group', () => {
    const offered = offeredFields()
    // Only the entries of each `fields` array: the group ids are strings too.
    const filed = [...settingsGroupsBlock().matchAll(/fields: \[([\s\S]*?)\]/g)]
      .flatMap((match) => [...(match[1] ?? '').matchAll(/'([\w.]+)'/g)].map((one) => one[1] as string))

    // A field left out of every group would silently stop rendering, and the
    // group table is the render order, so nothing else would notice.
    expect([...filed].sort()).toEqual([...offered].sort())
    expect(new Set(filed).size, 'a field is filed twice').toBe(filed.length)
  })

  it('names every group in both languages', () => {
    const ids = [...settingsGroupsBlock().matchAll(/id: '([\w-]+)'/g)].map((match) => match[1] as string)
    expect(ids.length).toBeGreaterThan(1)
    for (const language of ['zh', 'en']) {
      const keys = new Set(keysOf(language))
      for (const id of ids) expect(keys.has(`group.${id}`), `${language} heading for ${id}`).toBe(true)
    }
  })

  it('shows a disabled control as disabled', () => {
    // `Switch` is a primitive that styles its own disabled state. The number
    // input and the select are this bundle's markup, so nothing greys them
    // unless the sheet says so — and a control that is only inert still looks
    // ready to use.
    expect(styles).toMatch(/\.dsh-dcp-control:disabled/)
    expect(styles).toMatch(/\.dsh-dcp-value:disabled/)
  })

  it('sizes its inputs to the harness stepper width', () => {
    // The harness's own numeric control is `min-width:72px; height:36px` on the
    // module surface (dsh-client-ui-theme, its _stepper rule). This card copies
    // that row's metrics, so its inputs take the same width instead of sizing
    // themselves (they were 104px and 72px, and the card read as two columns).
    const rule = (selector: string): string =>
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(styles)?.[1] ?? ''
    const widthOf = (selector: string): string => /(?:^|;)width:([^;]+)/.exec(rule(selector))?.[1] ?? ''

    expect(rule('.dsh-dcp-form')).toMatch(/--dsh-dcp-control-width:\s*72px/)
    for (const selector of ['.dsh-dcp-stepper', '.dsh-dcp-text']) {
      expect(widthOf(selector), selector).toContain('var(--dsh-dcp-control-width')
    }
    // The choice button stays content-sized, exactly like the harness's own
    // selectors: a 72px pill cannot hold "One line" plus the chevron. Its two
    // numbers are the harness's permission-row selector's
    // (ui-permission-presets, `gap:12px; padding:0 14px`), not invented.
    expect(widthOf('.dsh-dcp-select'), '.dsh-dcp-select must not be fixed').toBe('')
    const select = rule('.dsh-dcp-select')
    expect(select).toContain('padding:0 14px')
    expect(select).toContain('gap:12px')
  })

  it('keeps the row control inline, like the harness row it copies', () => {
    // ui-theme's `_control` is `align-items:center;gap:8px;display:inline-flex`;
    // this was `display:flex`, the one declaration in the card that did not come
    // from that row.
    const rule = (selector: string): string =>
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(styles)?.[1] ?? ''
    expect(rule('.dsh-dcp-rowControl')).toContain('display:inline-flex')
  })

  it('documents the two deviations it keeps on purpose', () => {
    // Reviewed and kept, so a later "make it match the host" pass does not undo
    // them silently: the pill belongs to the stats-pill family because the dock
    // row's counting pill is its neighbour, and the panel's figures are brighter
    // than the stat-dialog's details because they are the point of the panel.
    const rule = (selector: string): string =>
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(styles)?.[1] ?? ''
    expect(rule('.dsh-dcp-pill')).toContain('border-radius:999px')
    expect(rule('.dsh-dcp-root')).toContain('calc(var(--dsh-content-font-size-secondary,13px) - 1px)')
    // The details rule is reached with a plain match: `rule()` stops at the first
    // `dd{`, which is the shared `dt,dd` box rule.
    expect(styles).toMatch(/\.dsh-dcp-details dd\{color:var\(--dsw-alias-label-secondary\)/)
  })

  it('captures the whole sheet, not a truncated literal', () => {
    // A stray backtick inside a comment ends the template literal early, and the
    // extraction then returns a silent PREFIX of the sheet: every rule after the
    // backtick vanishes, which shows up as unrelated failures (orphaned classes,
    // widths that "disappeared"). The last rule is the sentinel.
    expect(styles).toContain('.dsh-dcp-select:hover:not(:disabled)')
    expect(styles.trimEnd().endsWith('}')).toBe(true)
  })

  it('draws its focus ring with the theme parameters', () => {
    // The theme's own rule is `:focus-visible{outline-color:var(--dsw-focus-ring-color,
    // var(--dsw-alias-state-business-primary));outline-width:var(--dsw-focus-ring-width)}`
    // with no offset (dsh-client-ui-theme, focus_css_default). The bundle adds the
    // ring for its own controls because the theme suppresses it for pointer input on
    // everything that is not `:read-write` — so the parameters must stay identical,
    // or the card would focus differently from the fields around it.
    const rule = (selector: string): string =>
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(styles)?.[1] ?? ''
    const ring = 'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))'
    for (const selector of ['.dsh-dcp-control:focus-visible', '.dsh-dcp-stepper:focus-within']) {
      expect(rule(selector), selector).toContain(ring)
      expect(rule(selector), `${selector} must not offset`).not.toContain('outline-offset')
    }
  })

})
