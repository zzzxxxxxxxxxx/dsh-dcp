/**
 * Client-bundle runtime smoke tests.
 *
 * The browser half is plain JavaScript in the module-loader envelope, so
 * nothing type-checks it: a reference to a name that was never defined only
 * fails when the component renders, and the Settings shell turns that failure
 * into an empty page with a `data-slot-error` marker. A shipping build shipped
 * exactly that bug (`ReferenceError: SettingsBoundary is not defined`).
 *
 * These tests evaluate the real bundle against a stub module table and call
 * every component it registers, which is the only way to catch it here. Two
 * stubs model the host contracts the bundle's verdicts depend on:
 *
 * - `inject` runs a body only once every dependency is provided, the way cordis
 *   does, so "the settings service is absent" is a state these tests can mount.
 * - `mutate` applies the installed Host's path-op algorithm, so the card's
 *   write-then-read-back verdict is checked against what the Host really stores.
 *
 * @module dsh-dcp/tests/client-runtime
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')

/**
 * The package name the Host resolves this bundle under.
 *
 * client-modules finds the bundle through the loader row's name and then looks
 * the registration up under exactly that string, so the envelope's `id` is not
 * a free label. Read from the manifest rather than written twice: a rename that
 * misses the envelope is the failure this guards.
 */
const packageName = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name

/** One registration the bundle made. */
interface Registration {
  slot: string
  component: (props: never) => unknown
  face?: Record<string, unknown>
}

/** One path op as the wire carries it. */
interface WireOp {
  op: string
  path: string[]
  value?: unknown
}

/** A JSON-shaped settings layer. */
type Layer = Record<string, unknown>

/** A function component stub. */
type Component = (props: never) => unknown

/** Writes the last mount recorded. */
let currentWrites: WireOp[][] = []

/**
 * Hook state for the render pass under test, and the cursor into it.
 *
 * React keeps a component's state between renders; a stub that always returns
 * the initial value cannot observe a refusal at all, because the verdict
 * arrives from a promise AFTER the first render. The slots persist here so a
 * second render sees what the first one set, and seeding them opens the readout
 * without a click. Every component in one tree shares the cursor and is invoked
 * in the same order on every pass, which is the invariant the indices rely on.
 */
let hookStates: unknown[] = []
let hookCursor = 0

afterEach(() => { vi.restoreAllMocks() })

/** The projection the readout renders. */
const VIEW = {
  blocks: [{ id: 'b1', from: 1, to: 2, nodes: 3, tokens: 1234, topic: 'work' }],
  absorbed: 0,
  prunes: 2,
  prunedTokens: 40,
  notices: 0,
}

/** A form model stub with the surface the card uses. */
class StubFormModel {
  bind() { return { getSnapshot: () => ({}), subscribe: () => () => {} } }
  field() { return { text: 'true', overridden: false, invalid: false } }
  shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false } }
  actions() { return { edit() {}, resetField() {}, save() {}, discard() {} } }
  dispose() {}
}

/**
 * The copy the stub locale serves.
 *
 * The registered component replaces whatever `t` its props carried with the
 * bundle's own locale lookup, so the readout's text only becomes readable once
 * the stub locale translates these. The pill shapes are the ones the
 * assertions read; every other key falls through as itself.
 */
const COPY: Record<string, string> = {
  'pill.blocks': '{count} compacted',
  'pill.absorbed': '{count} absorbed',
  'pill.prunes': '{count} pruned ({tokens} tok)',
}

/** Translate one key the way the page's locale service would. */
const translate = (key: string): string => COPY[key] ?? key

/** The stub module table: the baseline modules the bundle may require. */
function stubs(): Record<string, unknown> {
  const React = {
    // React reports an undefined element type as a minified error at render
    // time; failing here instead names the offending component.
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
      if (type === undefined) throw new Error(`createElement received an undefined element type: ${JSON.stringify(props)}`)
      return { type, props: { ...(props as object ?? {}), children: children.length === 1 ? children[0] : children } }
    },
    Fragment: 'Fragment',
    Component: class { props: unknown; constructor(props: unknown) { this.props = props } },
    useRef: (value: unknown) => ({ current: value }),
    // One slot per hook call, so a state a promise sets later is visible to the
    // next render (see `hookStates`). The cursor is reset by `renderTree`.
    useState: (initial: unknown) => {
      const index = hookCursor
      hookCursor += 1
      if (!(index in hookStates)) hookStates[index] = initial
      return [hookStates[index], (next: unknown) => {
        hookStates[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(hookStates[index]) : next
      }]
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
  }
  const primitives = {
    Tooltip: (props: { children: unknown }) => props.children,
    IconArchiveOutlineRegular: () => null,
    IconChevronDownOutlineRegular: () => null,
    SettingsForm: (props: { children: unknown }) => props.children,
    SettingsValueField: () => null,
    Switch: () => null,
    Menu: (props: { anchor: unknown }) => props.anchor,
    SettingsFormModel: StubFormModel,
    // The panel's placement hooks, from the real spec: an unplaced panel still
    // lays its rows out, which is all these tests read.
    useAnchoredPosition: () => null,
    useAnchoredMaxHeight: () => 420,
    // Mirrors the real spec's conversion: an empty draft clears the field, a
    // finite number sets it, anything else blocks the write.
    settingsNumberField: (field: string) => ({
      field,
      format: (value: unknown) => (typeof value === 'number' ? String(value) : ''),
      parse: (text: string) => {
        if (text.trim() === '') return { kind: 'clear' }
        const value = Number(text)
        return Number.isFinite(value) ? { kind: 'set', value } : undefined
      },
    }),
  }
  return { react: React, 'react-dom': { createPortal: (node: unknown) => node }, '@deepseek-ai/dsh-client-ui-primitives': primitives }
}

/** Read a path out of a settings layer the way the bundle's `readPath` does. */
function readPath(layer: unknown, path: string[]): unknown {
  return path.reduce<unknown>((node, key) => (
    node === null || typeof node !== 'object' ? undefined : (node as Layer)[key]
  ), layer)
}

/** Write a path into a settings layer, creating intermediate objects. */
function setPath(layer: Layer, path: string[], value: unknown): void {
  let node = layer
  for (const key of path.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {}
    node = node[key] as Layer
  }
  node[path.at(-1) as string] = value
}

/** Delete the leaf a path addresses. */
function deletePath(layer: Layer, path: string[]): void {
  let node: Layer = layer
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    if (next === null || typeof next !== 'object') return
    node = next as Layer
  }
  delete node[path.at(-1) as string]
}

/** What a mount provides and what its form scope models. */
interface MountOptions {
  /**
   * Provide the settings service. `false` models a deployment that composes no
   * settings surface at all.
   */
  configForms?: boolean
  /** The composed base layer the Host reports for the namespace. */
  base?: Layer
  /** The user layer the Host reports, and the one a write lands in. */
  user?: Layer
  /** Answer writes with `true` while storing nothing: a Host that accepts and drops. */
  silent?: boolean
  /** Reject every write: the settings wire is down, so `mutate` never settles with a verdict. */
  reject?: boolean
}

/**
 * The settings form scope the card binds through `configForms.get(ns)`.
 *
 * Its snapshot carries the composed `value`, the `base` layer the namespace
 * inherits, and the `user` layer a write lands in; its `mutate` applies the
 * installed Host's path-op algorithm — `set` writes the leaf, any other op
 * restores the value the base layer inherits, or deletes the key when the base
 * has none (`dsh-settings`' non-`set` branch) — and folds the result into the
 * next snapshot, the way the Host's mirror does before `mutate` resolves.
 */
function formScope(options: MountOptions = {}) {
  const base = options.base
  const user = structuredClone(options.user ?? {}) as Layer
  let revision = 1
  return {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      value: { ...(base ?? {}), ...user },
      base,
      user,
      revision,
    }),
    subscribe: () => () => {},
    mutate: (ops: WireOp[]) => {
      // The Host's wire union is `{op:'set'|'unset'}` (dsh-settings types.d.ts,
      // `SettingsPathOpView`). This stub refuses any other spelling, which the
      // real Host only tolerates because it special-cases `set` — so a
      // regression to `{op:'clear'}` fails here instead of in a browser.
      const unsupported = ops.find((op) => op.op !== 'set' && op.op !== 'unset')
      if (unsupported !== undefined) {
        return Promise.reject(new Error(`the Host declares no '${unsupported.op}' path op`))
      }
      currentWrites.push(ops)
      // Recorded before the failure so a test can still see what was attempted.
      if (options.reject === true) return Promise.reject(new Error('the settings wire is down'))
      if (options.silent === true) return Promise.resolve(true)
      for (const op of ops) {
        if (op.op === 'set') {
          setPath(user, op.path, op.value)
          continue
        }
        const inherited = base === undefined ? undefined : readPath(base, op.path)
        if (inherited === undefined) deletePath(user, op.path)
        else setPath(user, op.path, structuredClone(inherited))
      }
      revision += 1
      return Promise.resolve(true)
    },
  }
}

/**
 * The context a browser half receives, recording what it registers.
 *
 * `inject` follows cordis: a body runs only once every requested service is
 * provided, and receives a child scope carrying them. Withholding the body is
 * how this stub reproduces a deployment that composes no settings service —
 * which is exactly the state the hard `configForms` edge used to die on.
 */
function stubContext(registrations: Registration[], scope: ReturnType<typeof formScope>, options: MountOptions) {
  const effect = (body: () => unknown) => { body(); return () => {} }
  const slots = {
    inject: (_slot: string, body: () => unknown) => { body(); return () => {} },
    register: (definition: { name: string; inject?: () => Record<string, unknown> }, component: Component) => {
      registrations.push({ slot: String(definition.name), component, face: definition.inject?.() })
      return () => {}
    },
  }
  const locale = { bind: () => translate, register: () => () => {} }
  const services: Record<string, unknown> = { slots, locale }
  if (options.configForms !== false) services['configForms'] = { get: () => scope }
  return {
    get: (service: string) => services[service],
    effect,
    inject: (deps: string[], body: (child: unknown) => unknown) => {
      if (deps.some((name) => services[name] === undefined)) return Promise.resolve()
      body({ ...services, effect })
      return Promise.resolve()
    },
    on: () => () => {},
    logger: { info() {}, warn() {} },
    configForms: services['configForms'],
    slots,
    locale,
  }
}

/** A complete-enough document for a mount that never touches the DOM. */
const STUB_DOCUMENT = { body: {}, addEventListener() {}, removeEventListener() {} }

/** The id the envelope most recently evaluated registered under. */
let registeredId: string | undefined

/** Evaluate the envelope against the stub module table; returns the plugin object. */
function evaluatePlugin(documentStub: unknown): { inject: string[]; apply: (ctx: unknown) => void } {
  let plugin: { inject: string[]; apply: (ctx: unknown) => void } | undefined
  const sandbox: Record<string, unknown> = {
    window: { __ModuleLoader__: { load: (record: { id: string; factory: (require: (name: string) => unknown) => unknown }) => { registeredId = record.id; plugin = record.factory((name: string) => stubs()[name]) as typeof plugin } } },
    console,
    document: documentStub,
  }
  sandbox['globalThis'] = sandbox
  // eslint-disable-next-line no-new-func -- evaluating the shipped envelope is the test.
  new Function('window', 'console', 'document', 'globalThis', source)(sandbox['window'], console, sandbox['document'], sandbox)
  if (plugin === undefined) throw new Error('the bundle registered no plugin')
  return plugin
}

/** Evaluate the envelope and mount the plugin. */
function mount(options: MountOptions = {}): Registration[] {
  const registrations: Registration[] = []
  currentWrites = []
  const plugin = evaluatePlugin(STUB_DOCUMENT)
  plugin.apply(stubContext(registrations, formScope(options), options))
  return registrations
}

/** An element the stub `createElement` produced (children still unrendered). */
interface StubElement {
  type: unknown
  props: Record<string, unknown> & { children?: unknown }
}

/** What a rendered tree holds: primitive elements with their children rendered. */
interface RenderedElement {
  tag: unknown
  props: Record<string, unknown> & { children?: unknown }
  children: unknown
}

/** A class component instance as this stub React drives it. */
interface StubInstance {
  props: unknown
  state?: Record<string, unknown>
  render(): unknown
  componentDidCatch?(error: unknown): void
}

/** Whether one element type is a class component (its prototype carries `render`). */
function isClassComponent(type: unknown): boolean {
  return typeof (type as { prototype?: { render?: unknown } }).prototype?.render === 'function'
}

/**
 * Render one stub tree the way React would.
 *
 * Function components are invoked, class components are instantiated, and a
 * class carrying `getDerivedStateFromError` acts as an error boundary for the
 * subtree it renders. That last part is the only way to observe the bundle's
 * own `SettingsBoundary`: the class lives inside the envelope and the test
 * cannot call it directly.
 *
 * The hook cursor restarts here, so every pass walks the same components in the
 * same order (`hookStates` is deliberately NOT reset: that is the point).
 */
function renderTree(node: unknown): unknown {
  hookCursor = 0
  return walk(node)
}

function walk(node: unknown): unknown {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => walk(child))
  const element = node as StubElement
  const type = element.type
  if (typeof type !== 'function') {
    return { tag: type, props: element.props, children: walk(element.props?.children) } as RenderedElement
  }
  const derive = (type as { getDerivedStateFromError?: (error: unknown) => Record<string, unknown> }).getDerivedStateFromError
  if (typeof derive === 'function') {
    return walkBoundary(element, type as unknown as new (props: unknown) => StubInstance, derive)
  }
  if (isClassComponent(type)) {
    const instance = new (type as new (props: unknown) => StubInstance)(element.props)
    instance.state ??= {}
    return walk(instance.render())
  }
  return walk((type as Component)(element.props as never))
}

/** Render a boundary class the way React does: fall back to its error state. */
function walkBoundary(
  element: StubElement,
  type: new (props: unknown) => StubInstance,
  derive: (error: unknown) => Record<string, unknown>,
): unknown {
  const instance = new type(element.props)
  instance.state ??= {}
  try {
    return walk(instance.render())
  } catch (error) {
    instance.state = { ...instance.state, ...derive(error) }
    instance.componentDidCatch?.(error)
    return walk(instance.render())
  }
}

/** Collect the text one rendered tree shows, in document order. */
function collectText(node: unknown, out: string[]): void {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) { node.forEach((child) => collectText(child, out)); return }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
  collectText((node as RenderedElement).children, out)
}

/** The text an already-rendered tree shows. */
function textOf(tree: unknown): string {
  const out: string[] = []
  collectText(tree, out)
  return out.join(' ')
}

/** Invoke every component in a stub tree, returning the text it renders. */
function renderText(node: unknown): string {
  return textOf(renderTree(node))
}

/** Every rendered element whose props satisfy `match`, depth first. */
function findAll(node: unknown, match: (props: Record<string, unknown>) => boolean, found: RenderedElement[] = []): RenderedElement[] {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, match, found))
    return found
  }
  const element = node as RenderedElement
  if (match(element.props)) found.push(element)
  findAll(element.children, match, found)
  return found
}

/** Render the settings card's tree: the caller owns `hookStates` between passes. */
function cardTree(section: Registration, props: Record<string, unknown>): unknown {
  return renderTree(section.component(props as never))
}

/** The card's number/text control for one field. */
function control(tree: unknown, field: string): RenderedElement {
  const id = `dsh-dcp-${field.replace(/\./g, '-')}`
  const element = findAll(tree, (props) => props['id'] === id)[0]
  if (element === undefined) throw new Error(`the card rendered no control for ${field}`)
  return element
}

/** Commit a draft the way a user does: type it and press Enter. */
function commit(element: RenderedElement, text: string): void {
  const onKeyDown = element.props['onKeyDown'] as (event: unknown) => void
  onKeyDown({ key: 'Enter', currentTarget: { value: text } })
}

/** Let the write promise and everything it chains settle. */
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/** The composer readout registration. */
function readout(): Registration {
  const entry = mount().find((candidate) => candidate.slot === 'conversation.composer.dock')
  if (entry === undefined) throw new Error('the composer readout did not register')
  return entry
}

/** The readout's rendered text for one projection payload. */
function readoutText(view: unknown, options: { open?: boolean } = {}): string {
  const entry = readout()
  hookStates = options.open === true ? [true] : []
  return renderText(entry.component({
    sessionId: 's',
    t: translate,
    useProjection: () => view,
  } as never))
}

/** The fields the card offers, lifted from the bundle's own table. */
const OFFERED_FIELDS = [...(/const SETTINGS_FIELDS = \[([\s\S]*?)\n    \]/.exec(source)?.[1] ?? '')
  .matchAll(/field: '([\w.]+)'/g)].map((match) => match[1] as string)

/** One row's projection in the card's store. */
function rowState(): Record<string, unknown> {
  return { text: '', overridden: false, invalid: false, value: undefined }
}

/**
 * The store projection the card binds: every row present, nothing written yet.
 *
 * `failed` is the shared form's own flag, distinct from the refusal the card
 * tracks for itself (a refused write is exactly the one the store never sees).
 */
function cardState(overrides: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  const state: Record<string, unknown> = {
    available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
  }
  for (const field of OFFERED_FIELDS) state[field] = { ...rowState(), ...overrides[field] }
  return state
}

/** The props the Host's slot hands the card, including its own inject face. */
function cardProps(section: Registration, state: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: translate,
    useDcpSettings: (select: (snapshot: unknown) => unknown) => select(state),
    write: section.face?.['write'],
    edit() {}, resetField() {}, save() {}, discard() {},
    ...overrides,
  }
}

/** The settings section's registration. */
function settingsSection(options: MountOptions = {}): Registration {
  const entry = mount(options).find((candidate) => candidate.slot === 'settings.section')
  if (entry === undefined) throw new Error('the settings section did not register')
  return entry
}

/** The card's write face. */
function writeOf(entry: Registration): (field: string, text: string) => Promise<boolean> {
  const write = entry.face?.['write']
  if (typeof write !== 'function') throw new Error('the settings face exposes no write()')
  return write as (field: string, text: string) => Promise<boolean>
}

/**
 * Wait until an observable reaches an expected value, or ~1s.
 *
 * Cordis loads injected fibers asynchronously; polling keeps the test from
 * depending on a fixed delay while still failing (on the assertion that
 * follows) when nothing ever registers.
 */
async function settleUntil(observed: () => unknown, expected: unknown): Promise<void> {
  for (let attempt = 0; attempt < 200 && observed() !== expected; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

/** A real cordis Context that records the slot registrations made on it. */
function cordisHost(registered: string[]): Context {
  const ctx = new Context()
  ctx.provide('slots', {
    inject: (_slot: string, body: () => unknown) => { body(); return () => {} },
    register: (definition: { name: string }) => { registered.push(definition.name); return () => {} },
  } as never)
  return ctx
}

/** Load one envelope as a cordis plugin, exactly as the module loader does. */
function cordisLoad(ctx: Context, plugin: { inject: string[]; apply: (ctx: unknown) => void }): void {
  ctx.plugin({
    name: `dsh-dcp-test-${Math.random()}`,
    inject: plugin.inject,
    apply: (child: unknown) => { plugin.apply(child) },
  } as never, undefined as never)
}

describe('client bundle at runtime', () => {
  it('registers under the package name the Host resolves', () => {
    // The boot loads the chunk addressed by the loader row's package name and
    // then requires that the same string was registered. Registering the short
    // entry id instead loads the code and fails the page:
    // `client-modules: could not load "@zzxxxxxx/dsh-dcp": ... loaded without
    // registering "@zzxxxxxx/dsh-dcp"`. Nothing else here can catch it — the
    // stub used to read `factory` and drop `id` on the floor.
    evaluatePlugin(STUB_DOCUMENT)
    expect(registeredId).toBe(packageName)
  })

  it('registers the composer readout and the settings section', () => {
    expect(mount().map((entry) => entry.slot).sort()).toEqual(['conversation.composer.dock', 'settings.section'])
  })

  it('renders the composer readout', () => {
    expect(readoutText(VIEW)).toContain('1 compacted')
    expect(readoutText(VIEW)).toContain('2 pruned (40 tok)')
  })

  it('renders a payload that is missing its shape instead of throwing', () => {
    // `view.blocks.length` used to throw out of the slot entry; the host's error
    // boundary turned the entry into `data-slot-error` and the whole readout
    // disappeared. A newer client meeting an older payload is expected, so a
    // missing field means "nothing to report", never a crash.
    for (const payload of [{}, { blocks: null }, { blocks: [], absorbed: 0, prunes: 0, prunedTokens: 0 }]) {
      expect(() => readoutText(payload)).not.toThrow()
      expect(readoutText(payload)).toBe('')
    }
    // A partial payload still reports what it does carry.
    expect(readoutText({ absorbed: 3 })).toBe('3 absorbed')
  })

  it('reports an unknown count instead of printing "undefined"', () => {
    // The panel's rows read counts the pill may never have touched; absence is
    // reported the way the token formatter reports it, not as the literal
    // string "undefined".
    const text = readoutText({ blocks: [{ tokens: undefined }], absorbed: 3 }, { open: true })
    expect(text).not.toMatch(/undefined|NaN/)
    expect(text).toContain('—')
  })

  it('writes a nested field as a path, not as a dotted name', async () => {
    const section = settingsSection()
    // The Host matches each op path against the schema's volatile nodes; a
    // single-segment path never matches a nested field, which is why every save
    // used to be refused.
    expect(await writeOf(section)('compaction.nudgeFrequency', '7')).toBe(true)
    expect(currentWrites[0]?.[0]).toEqual({ op: 'set', path: ['compaction', 'nudgeFrequency'], value: 7 })
  })

  it('clears a field with the wire op the Host declares', async () => {
    // The Host's union is `{op:'set'|'unset'}`; `clear` is not in it. The stub's
    // `mutate` rejects any other spelling, so this test fails on a regression
    // instead of relying on the Host's non-`set` fallthrough.
    const section = settingsSection({ user: { compaction: { nudgeFrequency: 7 } } })
    expect(await writeOf(section)('compaction.nudgeFrequency', '')).toBe(true)
    expect(currentWrites[0]?.[0]).toEqual({ op: 'unset', path: ['compaction', 'nudgeFrequency'] })
  })

  it('accepts a clear of a field the composed base layer carries', async () => {
    // The Host does not delete a cleared field the base layer carries: it writes
    // the inherited value into the user layer (dsh-settings' non-`set` branch).
    // Comparing the user layer against `undefined` alone called that accepted
    // clear a refusal and put "save failed" plus `aria-invalid` on the row.
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const section = settingsSection({ base: { compaction: { nudgeFrequency: 5 } }, user: { compaction: { nudgeFrequency: 7 } } })
    expect(await writeOf(section)('compaction.nudgeFrequency', '')).toBe(true)
    expect(failures).not.toHaveBeenCalled()
  })

  it('still reports a clear the Host silently drops', async () => {
    // The looser clear verdict must not become "always kept": a Host that
    // answers `true` and stores nothing is still a refusal, and the user layer
    // disagreeing with the base layer is what proves it.
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const section = settingsSection({
      base: { compaction: { nudgeFrequency: 5 } },
      user: { compaction: { nudgeFrequency: 7 } },
      silent: true,
    })
    expect(await writeOf(section)('compaction.nudgeFrequency', '')).toBe(false)
    expect(failures).toHaveBeenCalled()
  })

  it('renders the settings section', () => {
    const section = settingsSection()
    expect(() => section.component({
      t: (key: string) => key,
      useDcpSettings: (select: (state: unknown) => unknown) => select({
        available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
        enabled: { text: 'true', overridden: false, invalid: false },
      }),
      edit() {}, resetField() {}, save() {}, discard() {},
    } as never)).not.toThrow()
  })

  it('renders the section body for a namespace the Host does not serve', () => {
    const section = settingsSection()
    expect(() => section.component({
      t: (key: string) => key,
      useDcpSettings: (select: (state: unknown) => unknown) => select({
        available: false, writable: false, dirty: false, invalid: false, saving: false, failed: false,
      }),
      edit() {}, resetField() {}, save() {}, discard() {},
    } as never)).not.toThrow()
  })

  it('keeps the readout alive in a deployment with no settings service', () => {
    // `inject: ['slots', 'configForms']` was a hard cordis edge: with no
    // settings surface composed, `apply` never ran and the readout vanished
    // with the card. The readout is registered unconditionally now, and the
    // card waits on a dynamic dependency instead.
    const registrations = mount({ configForms: false })
    expect(registrations.map((entry) => entry.slot)).toEqual(['conversation.composer.dock'])
    expect(readoutText(VIEW)).toContain('1 compacted')
  })

  it('activates before configForms arrives (real cordis)', async () => {
    // The same contract against the real cordis, because the hard edge was a
    // cordis activation rule and not a stub behaviour: `apply` runs with only
    // `slots` provided, and the settings section appears once the service is
    // provided later.
    const registered: string[] = []
    const ctx = cordisHost(registered)
    cordisLoad(ctx, evaluatePlugin(STUB_DOCUMENT))
    await settleUntil(() => registered.length, 1)
    expect(registered).toEqual(['conversation.composer.dock'])

    ctx.provide('configForms', { get: () => formScope() } as never)
    await settleUntil(() => registered.length, 2)
    expect(registered).toEqual(['conversation.composer.dock', 'settings.section'])
  })

  it('registers both halves when the settings service is there from the start (real cordis)', async () => {
    // The ordinary deployment: every service is provided before the loader
    // mounts the plugin, and the dynamic dependency resolves in the same load.
    const registered: string[] = []
    const ctx = cordisHost(registered)
    ctx.provide('configForms', { get: () => formScope() } as never)
    cordisLoad(ctx, evaluatePlugin(STUB_DOCUMENT))
    await settleUntil(() => registered.length, 2)
    expect(registered.slice().sort()).toEqual(['conversation.composer.dock', 'settings.section'])
  })

  it('installs its stylesheet into a document that can take one', () => {
    const appended: { dataset: Record<string, string>; textContent: string }[] = []
    const doc = {
      createElement: () => ({ dataset: {} as Record<string, string>, textContent: '' }),
      querySelector: () => null,
      head: { appendChild: (tag: { dataset: Record<string, string>; textContent: string }) => { appended.push(tag) } },
      body: {},
      addEventListener() {},
      removeEventListener() {},
    }
    expect(() => evaluatePlugin(doc)).not.toThrow()
    expect(appended).toHaveLength(1)
    expect(appended[0]?.dataset['pluginCss']).toBe('dsh-dcp/client.css')
    expect(appended[0]?.textContent).toContain('.dsh-dcp-pill')
  })

  it('degrades to no stylesheet instead of throwing on a partial document', () => {
    // The bundle is evaluated outside a browser by smoke tests and pre-render
    // passes. A document that can mint a `<style>` but cannot be queried, or
    // that has no head to append to, used to throw out of the factory and take
    // the whole browser half with it — over decoration.
    expect(() => evaluatePlugin(undefined)).not.toThrow()
    expect(() => evaluatePlugin({ createElement: () => ({ dataset: {} }) })).not.toThrow()
    expect(() => evaluatePlugin({ createElement: () => ({ dataset: {} }), querySelector: () => null })).not.toThrow()
  })

  it('installs one stylesheet per document, however often the bundle loads', () => {
    // A reload or an HMR swap re-evaluates the envelope against the same page.
    // The host keys its own sheets by `data-plugin-css` and checks before
    // inserting; this half must not stack a second copy of the same rules, and
    // must not even mint the tag when the sheet is already there.
    const tags: { dataset: Record<string, string>; textContent: string }[] = []
    let created = 0
    const doc = {
      createElement: () => { created += 1; return { dataset: {} as Record<string, string>, textContent: '' } },
      querySelector: (selector: string) => tags.find((tag) => selector.includes(tag.dataset['pluginCss'] ?? '\u0000')) ?? null,
      head: { appendChild: (tag: { dataset: Record<string, string>; textContent: string }) => { tags.push(tag) } },
      body: {},
      addEventListener() {},
      removeEventListener() {},
    }
    expect(() => evaluatePlugin(doc)).not.toThrow()
    expect(() => evaluatePlugin(doc)).not.toThrow()
    expect(tags).toHaveLength(1)
    expect(created).toBe(1)
    expect(tags[0]?.dataset['pluginCss']).toBe('dsh-dcp/client.css')
  })

  it('refuses a draft no field accepts, without writing to the Host', async () => {
    // `parseValue` is the browser's own pre-check. It mirrors the schema's
    // min/step and the two limit shapes so a draft it can already see is
    // invalid never spends a round trip. A refusal is a resolved `false` and a
    // log line — not a throw, and not a wire op.
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const section = settingsSection()
    const write = writeOf(section)
    const rejected: [string, string][] = [
      ['compaction.nudgeFrequency', 'abc'],   // not a number
      ['compaction.nudgeFrequency', '0'],     // below min
      ['compaction.nudgeFrequency', '1.7'],   // off the step
      ['turnProtection.turns', '-1'],         // below min
      ['compaction.minContextLimit', 'soon'], // neither a count nor a percentage
      ['compaction.maxContextLimit', '1e3'],  // exponent notation is not a count
      ['pruneNotification', 'detailed'],      // not one of the choices
      ['manualMode.enabled', 'maybe'],        // not a boolean
      ['not.a.field', '7'],                   // not a settings row at all
    ]
    for (const [field, text] of rejected) {
      await expect(write(field, text), `${field}=${JSON.stringify(text)}`).resolves.toBe(false)
    }
    expect(currentWrites).toEqual([])
    // The unknown field is refused before any parse, so it is the one draft
    // that never reaches the logger.
    expect(failures).toHaveBeenCalledTimes(rejected.length - 1)
  })

  it('writes the value it parses out of the draft, by field kind', async () => {
    // The accepted half of the same table, including both shapes the two limit
    // fields take: an absolute token count and a percentage. The percentage
    // keeps whatever whitespace the user typed between the number and the `%`,
    // because the schema (`limitSchema`, src/config.ts) and `resolveLimit` both
    // accept it — a browser refusal there rejected a value the Host would store.
    const section = settingsSection()
    const write = writeOf(section)
    expect(await write('compaction.nudgeFrequency', '7')).toBe(true)
    expect(await write('compaction.minContextLimit', '80%')).toBe(true)
    expect(await write('compaction.maxContextLimit', '100000')).toBe(true)
    expect(await write('compaction.minContextLimit', '80 %')).toBe(true)
    expect(await write('pruneNotification', 'off')).toBe(true)
    expect(await write('manualMode.enabled', 'true')).toBe(true)
    expect(await write('turnProtection.turns', '')).toBe(true)
    expect(currentWrites.map((ops) => ops[0])).toEqual([
      { op: 'set', path: ['compaction', 'nudgeFrequency'], value: 7 },
      { op: 'set', path: ['compaction', 'minContextLimit'], value: '80%' },
      { op: 'set', path: ['compaction', 'maxContextLimit'], value: 100000 },
      { op: 'set', path: ['compaction', 'minContextLimit'], value: '80 %' },
      { op: 'set', path: ['pruneNotification'], value: 'off' },
      { op: 'set', path: ['manualMode', 'enabled'], value: true },
      { op: 'unset', path: ['turnProtection', 'turns'] },
    ])
  })

  it('marks the row a refused write belongs to and clears it once a write is kept', async () => {
    // A refusal changes nothing the Host snapshot records, so the card is the
    // only place it can live, and the row is the only place the reader sees it:
    // the draft stays in the control and the configuration no longer matches it.
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const section = settingsSection()
    hookStates = []
    const props = cardProps(section, cardState())

    let tree = cardTree(section, props)
    commit(control(tree, 'compaction.nudgeFrequency'), '0')
    await flush()
    tree = cardTree(section, props)
    expect(textOf(tree)).toContain('form.saveFailed')
    expect(findAll(tree, (props) => props['aria-invalid'] === 'true').map((element) => element.props['id']))
      .toEqual(['dsh-dcp-compaction-nudgeFrequency'])

    // The same row with a value the Host keeps: the verdict is cleared, so the
    // page does not keep accusing a row that has just been saved.
    commit(control(tree, 'compaction.nudgeFrequency'), '7')
    await flush()
    tree = cardTree(section, props)
    expect(textOf(tree)).not.toContain('form.saveFailed')
    expect(findAll(tree, (props) => props['aria-invalid'] === 'true')).toEqual([])
    expect(failures).toHaveBeenCalled()
  })

  it('keeps a refused row marked while a different row saves', async () => {
    // One refusal must not be erased by an unrelated success: the refused row
    // still holds an unsaved draft and its configuration is still the old
    // value, so its `aria-invalid` and the page-level notice stay until THAT
    // field is written back successfully.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const section = settingsSection()
    hookStates = []
    const props = cardProps(section, cardState())

    let tree = cardTree(section, props)
    commit(control(tree, 'compaction.nudgeFrequency'), '0') // refused by the browser pre-check
    await flush()
    tree = cardTree(section, props)
    expect(findAll(tree, (attrs) => attrs['aria-invalid'] === 'true').map((element) => element.props['id']))
      .toEqual(['dsh-dcp-compaction-nudgeFrequency'])

    // A different row saves cleanly; the refused row is untouched.
    commit(control(tree, 'compaction.minContextLimit'), '80%')
    await flush()
    tree = cardTree(section, props)
    expect(textOf(tree)).toContain('form.saveFailed')
    expect(findAll(tree, (attrs) => attrs['aria-invalid'] === 'true').map((element) => element.props['id']))
      .toEqual(['dsh-dcp-compaction-nudgeFrequency'])

    // Only that row's own successful write clears it.
    commit(control(tree, 'compaction.nudgeFrequency'), '7')
    await flush()
    tree = cardTree(section, props)
    expect(textOf(tree)).not.toContain('form.saveFailed')
    expect(findAll(tree, (attrs) => attrs['aria-invalid'] === 'true')).toEqual([])
  })

  it('does not accuse a row whose clear the Host inherited from the base layer', async () => {
    // The same M9 judgement seen end to end: the clear is ACCEPTED, the Host
    // writes the value the base layer already carries into the user layer, and
    // the row must not put "save failed" and `aria-invalid` on a save that just
    // worked. The pre-fix bundle fails this on both counts (it sends `clear`,
    // and it reads the user layer against absence).
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const section = settingsSection({
      base: { compaction: { nudgeFrequency: 5 } },
      user: { compaction: { nudgeFrequency: 7 } },
    })
    hookStates = []
    const props = cardProps(section, cardState({ 'compaction.nudgeFrequency': { text: '7' } }))

    const tree = cardTree(section, props)
    commit(control(tree, 'compaction.nudgeFrequency'), '')
    await flush()
    const after = cardTree(section, props)
    expect(textOf(after)).not.toContain('form.saveFailed')
    expect(findAll(after, (attrs) => attrs['aria-invalid'] === 'true')).toEqual([])
    expect(failures).not.toHaveBeenCalled()
  })

  it('marks the row invalid when the Host accepts the call but not the value', async () => {
    // A Host that answers `true` and stores nothing: the call succeeded and the
    // value did not land, so the read-back verdict is the one that must reach
    // the row. This is the "not kept" side of the M9 judgement rendered on the
    // page; the accepted-clear side lives in the face-level tests.
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const section = settingsSection({ silent: true })
    hookStates = []
    const props = cardProps(section, cardState())

    const tree = cardTree(section, props)
    commit(control(tree, 'compaction.nudgeFrequency'), '7')
    await flush()
    const after = cardTree(section, props)
    expect(textOf(after)).toContain('form.saveFailed')
    expect(findAll(after, (props) => props['aria-invalid'] === 'true').map((element) => element.props['id']))
      .toEqual(['dsh-dcp-compaction-nudgeFrequency'])
    expect(failures).toHaveBeenCalledWith('[dsh-dcp] the Host did not keep', 'compaction.nudgeFrequency', '7')
  })

  it('reports a rejected write instead of leaving the row without a verdict', async () => {
    // `mutate` may reject — the settings wire is down. The face must resolve
    // `false` rather than reject (the card renders a verdict; it does not
    // handle an unhandled rejection), and the catch has to reach the same row
    // the refusal would.
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const section = settingsSection({ reject: true })
    hookStates = []
    const props = cardProps(section, cardState())

    const tree = cardTree(section, props)
    commit(control(tree, 'compaction.nudgeFrequency'), '7')
    await flush()
    await expect(writeOf(section)('compaction.nudgeFrequency', '7')).resolves.toBe(false)

    const after = cardTree(section, props)
    expect(textOf(after)).toContain('form.saveFailed')
    expect(findAll(after, (props) => props['aria-invalid'] === 'true').map((element) => element.props['id']))
      .toEqual(['dsh-dcp-compaction-nudgeFrequency'])
    // Both attempts reached the Host, and the failure is reported, not thrown.
    expect(currentWrites).toHaveLength(2)
    expect(failures).toHaveBeenCalledWith('[dsh-dcp] the write failed', 'compaction.nudgeFrequency', expect.any(Error))
  })

  it('renders the failure inside the boundary instead of a blank section', () => {
    // A contribution that throws while rendering leaves the Settings shell with
    // a blank page and a `data-slot-error` marker. The bundle's own boundary is
    // the only thing between the reader and that blank page, so the error text
    // has to come back through it.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const section = settingsSection()
    hookStates = []
    const tree = cardTree(section, cardProps(section, cardState(), {
      useDcpSettings: () => { throw new Error('the store binding exploded') },
    }))
    const text = textOf(tree)
    expect(text).toContain('dsh-dcp: the store binding exploded')
    expect(findAll(tree, (props) => props['role'] === 'status')).toHaveLength(1)
    expect(logged).toHaveBeenCalledWith('[dsh-dcp] settings section failed', expect.any(Error))
  })
})
