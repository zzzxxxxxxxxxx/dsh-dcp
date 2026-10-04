/**
 * The `(bN)` placeholder contract for nested compressions.
 *
 * A later compression may cover an earlier summary node. That earlier block's
 * content must survive, so the model is asked to reference it with `(bN)`
 * exactly once; the tool expands each placeholder into the stored body. When
 * the model omits a required placeholder the body is appended instead, so
 * nesting never loses information.
 *
 * @module dsh-dcp/placeholders
 */
import { SUMMARY_HEADER } from './types.ts'

/** Matches one `(bN)` placeholder; `N` is the block's ordinal. */
const PLACEHOLDER = /\(b(\d+)\)/g

/**
 * List the block ids a summary references, in first-appearance order.
 * @param text - the model-supplied summary.
 * @returns distinct block ids, duplicated references collapsed.
 */
export function parsePlaceholders(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(PLACEHOLDER)) {
    const id = `b${match[1]}`
    if (seen.has(id)) continue
    seen.add(id)
    found.push(id)
  }
  return found
}

/** The placeholder validation outcome for one summary. */
export interface PlaceholderCheck {
  /** Required blocks the summary referenced exactly once. */
  present: string[]
  /** Required blocks the summary failed to reference. */
  missing: string[]
  /** Referenced ids that are not required by this range. */
  unknown: string[]
  /** Required ids referenced more than once. */
  duplicated: string[]
}

/**
 * Check one summary against the blocks its range must preserve.
 * @param text - the model-supplied summary.
 * @param required - block ids whose bodies the range covers.
 * @returns which requirement is satisfied, missing, unknown, or duplicated.
 */
export function checkPlaceholders(text: string, required: readonly string[]): PlaceholderCheck {
  const counts = new Map<string, number>()
  for (const match of text.matchAll(PLACEHOLDER)) {
    const id = `b${match[1]}`
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const requiredSet = new Set(required)
  const present: string[] = []
  const missing: string[] = []
  const unknown: string[] = []
  const duplicated: string[] = []
  for (const id of required) {
    if (!counts.has(id)) missing.push(id)
    else if ((counts.get(id) ?? 0) > 1) duplicated.push(id)
    else present.push(id)
  }
  for (const id of counts.keys()) {
    if (!requiredSet.has(id)) unknown.push(id)
  }
  return { present, missing, unknown, duplicated }
}

/**
 * Strip the stored summary's framing so an expanded body reads as prose.
 * @param stored - the block's stored summary text, header and trailing id tag included.
 * @returns the body alone.
 */
export function unwrapSummary(stored: string): string {
  let text = stored.trim()
  if (text.startsWith(SUMMARY_HEADER)) text = text.slice(SUMMARY_HEADER.length)
  text = text.replace(/\n*<dcp-block-id>\s*b\d+\s*<\/dcp-block-id>\s*$/i, '')
  // A trailing `(bN)` is NOT stripped. Only `wrapSummary` frames a stored body,
  // and its frame is the marker stripped above — so a `(bN)` at the end of the
  // body is the model's own text (or a preserved user quotation), and removing
  // it silently shortened the very content the protection was there to keep.
  return text.trim()
}

/**
 * Substitute every `(bN)` with its block body.
 * @param text - the model-supplied summary.
 * @param bodies - block id to stored summary text.
 * @returns the expanded summary; unknown ids are left untouched.
 */
export function expandPlaceholders(text: string, bodies: ReadonlyMap<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, ordinal: string) => {
    const body = bodies.get(`b${ordinal}`)
    return body === undefined ? whole : unwrapSummary(body)
  })
}

/**
 * Append the bodies the model failed to reference.
 * @param text - the summary after placeholder expansion.
 * @param missing - required block ids absent from the summary.
 * @param bodies - block id to stored summary text.
 * @returns the summary with a trailing section per missing block.
 */
export function appendMissingBlocks(text: string, missing: readonly string[], bodies: ReadonlyMap<string, string>): string {
  const sections: string[] = []
  for (const id of missing) {
    const body = bodies.get(id)
    if (body === undefined) continue
    sections.push(`### (${id})\n${unwrapSummary(body)}`)
  }
  if (sections.length === 0) return text
  return `${text.trimEnd()}\n\nThe following previously compacted summaries were also part of this conversation section:\n\n${sections.join('\n\n')}`
}

/**
 * Word the durable block marker appended to a stored summary.
 * @param id - the block's alias.
 * @returns the marker block id form used inside stored summaries.
 */
export function blockMarker(id: string): string {
  return `<dcp-block-id>${id}</dcp-block-id>`
}

/**
 * Frame one summary for storage and for the checkpoint message.
 * @param id - the block's alias.
 * @param body - the expanded summary text.
 * @returns the stored form, header and marker included.
 */
export function wrapSummary(id: string, body: string): string {
  return `${SUMMARY_HEADER}\n${body.trim()}\n\n${blockMarker(id)}`
}
