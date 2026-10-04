/**
 * Opt-in file trace for field debugging.
 *
 * Why this exists: under `dsh web` the boot replaces the cordis logger with an
 * exporter that keeps only warn/error lines for startup diagnostics, so nothing
 * a plugin logs reaches the terminal — and a silent decision (a nudge that
 * declines to fire, an injection that finds no live agent) leaves no other mark
 * anywhere. Diagnosing one of those otherwise needs source archaeology and
 * guesses.
 *
 * Set `DSH_DCP_TRACE` to a file path and every decision the plugin makes is
 * appended there, one line each. Unset (the default), nothing is written, so the
 * documented "no side files" contract still holds. The write is best-effort: a
 * debug trace must never change plugin behaviour, and a trace that throws is
 * worse than no trace.
 *
 * @module dsh-dcp/trace
 */
import { appendFileSync } from 'node:fs'

/** Append one trace line, when `DSH_DCP_TRACE` names a file. */
export function trace(event: string, details: Record<string, unknown> = {}): void {
  const target = process.env['DSH_DCP_TRACE']
  if (target === undefined || target.length === 0) return
  try {
    const fields = Object.entries(details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ')
    appendFileSync(target, `${new Date().toISOString()} ${event}${fields.length > 0 ? ` ${fields}` : ''}\n`)
  } catch {
    // Never let the trace affect the plugin.
  }
}
