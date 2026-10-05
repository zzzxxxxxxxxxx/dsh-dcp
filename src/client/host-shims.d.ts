/**
 * Ambient declarations for what the browser half receives from the harness at
 * runtime.
 *
 * `src/client/index.js` is plain JavaScript shipped as a dynamic client bundle.
 * It deliberately declares no dependency on React: the host's client module
 * table hands `react`, `react-dom` and the UI primitives to the bundle's
 * `factory(require)` when the bundle loads. `tsc` cannot resolve any of that
 * from this package, so the file used to sit outside type checking entirely.
 *
 * These declarations are the minimum that makes checking it useful rather than
 * noisy: the loader entry point, and a `require` whose `react` result carries
 * the one member the code subclasses. Everything else stays `any` on purpose —
 * the point is to catch mistakes in *this* file, not to re-type React.
 *
 * This is a global script (no imports, no exports) so the declarations apply to
 * the bundle without it importing anything.
 */

/** The instance surface a `React.Component` subclass in this bundle may use. */
interface HostComponent {
  props: any
  state: any
  setState(next: any): void
}

/** The subset of the host React this bundle relies on for typing. */
interface HostReact {
  /** The error-boundary base the settings section subclasses. */
  Component: new (props: any) => HostComponent
  /** Every other React API the bundle reaches for stays untyped. */
  [key: string]: any
}

/** The `require` the host passes to a dynamic client bundle's factory. */
interface HostRequire {
  (name: 'react'): HostReact
  (name: string): any
}

/**
 * `require('react')` is resolved as a module reference even inside the bundle,
 * so the ambient module is what actually supplies the type; the `HostRequire`
 * overload above documents the same contract at the call site.
 */
declare module 'react' {
  const React: HostReact
  export = React
}

/** One dynamic client bundle registration. */
interface ModuleLoaderEntry {
  /** The package name the host looks the registration up under. */
  id: string
  /** Builds the bundle's exported surface from the host module table. */
  factory: (require: HostRequire) => unknown
}

interface Window {
  /** Installed by the harness web client before any dynamic bundle loads. */
  __ModuleLoader__: { load(entry: ModuleLoaderEntry): void }
}
