/**
 * Recall: read back what a compaction removed.
 *
 * This is the retrieve side of compression, and it is why compression does not
 * have to be lossy. Shadowed events stay in the session log, so a block's
 * original content is still there after its summary replaced it in context —
 * `recall` renders that content into a normal tool result without touching the
 * surface.
 *
 * That is deliberately different from "decompressing": the summary stays where
 * it is, the retrieval is scoped to the question asked, and the model can go
 * back for a different detail a moment later. A nested block resolves
 * transitively — recalling a summary that absorbed `(b1)` yields `b1`'s
 * original content, not the text of the summary that replaced it.
 *
 * @module dsh-dcp/recall
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { DcpBlockState, DcpState } from './types.ts'
import { contentOf, eventAt, isOnSurface } from './surface.ts'

/** How deep a nested-summary chain is followed before giving up. */
const NESTING_DEPTH_LIMIT = 8

/** Hard cap on the characters one recall returns. */
export const RECALL_MAX_CHARS = 16_000

/** Lines of context kept around a query match. */
const QUERY_CONTEXT = 2

/** The outcome of one recall. */
export interface RecallResult {
  /** Whether the block exists and produced any text. */
  found: boolean
  /** The body to show the model. */
  text: string
  /** Characters actually returned. */
  chars: number
  /** Whether the cap truncated the body. */
  truncated: boolean
  /** How many original nodes were walked. */
  nodes: number
}

/** One rendered node from a block's original content. */
interface RecalledNode {
  seq: number
  type: string
  text: string
}

/**
 * Find one block by its alias.
 * @param state - derived DCP state.
 * @param rawId - the model-supplied alias, with or without the leading `b`.
 * @returns the block, or `undefined`.
 */
export function findBlock(state: DcpState, rawId: string): DcpBlockState | undefined {
  const normalized = rawId.trim().toLowerCase().replace(/^\(|\)$/g, '')
  const id = normalized.startsWith('b') ? normalized : `b${normalized}`
  return state.blocks.find((block) => block.id === id)
}

/** How far a replacement chain is followed before giving up. */
const ORIGINAL_WALK_LIMIT = 16

/**
 * Follow a surface replacement back to the content it ultimately overwrote.
 *
 * A node can be rewritten more than once, and each rewrite cites only its
 * immediate predecessor. The shipped composition does exactly that: the
 * Harness's own tool-result pruner trims a large result, a DCP strategy
 * rewrites the trimmed one, and a compaction then shadows that. Stopping after
 * one hop therefore returns an intermediate the model cannot use — and, worse,
 * looks like a successful read that simply does not contain the line being
 * searched for, which reads as a confident denial rather than a limitation.
 *
 * So walk until an event carries no replacement at all: that one is the
 * original. The `tool/result` filter is deliberate — a checkpoint's other
 * citations are the bracket's own markers, not content.
 *
 * @param raw - the log indexed by sequence, so the walk costs no rescans.
 * @param current - the event the shadowed sequence resolves to.
 * @returns the original node and whether the walk reached the end of the chain,
 *   or `undefined` when nothing was replaced. `complete: false` means the hop
 *   limit stopped the walk, so `event` is an intermediate whose own predecessor
 *   was never read.
 */
function originalAt(raw: ReadonlyMap<number, SessionEvent>, current: SessionEvent): { event: SessionEvent; complete: boolean } | undefined {
  let event = current
  const visited = new Set<number>([event.seq as number])
  for (let hop = 0; hop < ORIGINAL_WALK_LIMIT; hop += 1) {
    const op = (event as { surfaceOp?: unknown }).surfaceOp
    if (op === undefined || op === null) return event === current ? undefined : { event, complete: true }
    const cited = (event as { sourceEventSeqs?: readonly number[] }).sourceEventSeqs ?? []
    let next: SessionEvent | undefined
    for (const candidate of cited) {
      if (visited.has(candidate)) continue
      const found = raw.get(candidate)
      if (found !== undefined && found.type === 'tool/result') {
        next = found
        break
      }
    }
    if (next === undefined) return event === current ? undefined : { event, complete: true }
    visited.add(next.seq as number)
    event = next
  }
  // The walk stopped with a replacement still cited, so what came back is an
  // intermediate. Saying so is the difference between "the line is not there"
  // and "this tool did not read far enough to know".
  return event === current ? undefined : { event, complete: false }
}

/**
 * The non-text block types whose content a text answer would otherwise lose.
 *
 * Not every non-text block: `tool-call`, `reasoning`, and the tool-change
 * markers are structural, and the model is not missing anything when they are
 * summarised away. `image` and `file` are the ones that carry content.
 */
const MEDIA_BLOCK_TYPES: ReadonlySet<string> = new Set(['image', 'file'])

/**
 * Name the content blocks a text answer cannot carry.
 *
 * `recall` answers in text, so an image or a file attachment cannot be handed
 * back. Dropping them silently made a compacted image indistinguishable from
 * one that was never there — the difference between "the summary lost this" and
 * "this never existed". Naming what is not rendered keeps the answer honest
 * about what it is leaving out.
 *
 * @param blocks - the node's content blocks.
 * @returns a one-line note, or an empty string when everything was rendered.
 */
function nonTextNote(blocks: readonly ContentBlock[]): string {
  const counts = new Map<string, number>()
  for (const block of blocks) {
    if (!MEDIA_BLOCK_TYPES.has(block.type)) continue
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1)
  }
  if (counts.size === 0) return ''
  const parts = [...counts.entries()].map(([type, count]) => `${count} \u00d7 ${type}`)
  return `[not rendered as text: ${parts.join(', ')}]`
}

/**
 * Walk a block's original content, resolving nested summaries transitively.
 *
 * @param session - session holding the log.
 * @param state - derived DCP state.
 * @param block - the block to expand.
 * @param depth - recursion guard, so a malformed log cannot loop.
 * @param raw - the log indexed by sequence, built once per recall.
 * @returns the original nodes in surface order.
 */
function collect(
  session: Session,
  state: DcpState,
  block: DcpBlockState,
  depth = 0,
  raw?: ReadonlyMap<number, SessionEvent>,
): { nodes: RecalledNode[]; truncated: boolean } {
  const out: RecalledNode[] = []
  // A nesting chain deeper than this is not walked. Reported, not silently cut:
  // `found: true` over an incomplete body reads as "that is all there was",
  // which is exactly the wrong conclusion for a reader chasing a detail.
  if (depth > NESTING_DEPTH_LIMIT) return { nodes: out, truncated: true }
  let truncated = false
  const bySeq = new Map(state.blocks.map((item) => [item.seq, item]))
  // One index per recall, not one per shadowed node: `snapshotEvents()` copies
  // the whole log, so doing it inside the loop made recall quadratic in
  // (shadowed nodes × log length).
  const index = raw ?? new Map(session.snapshotEvents().map((event) => [event.seq as number, event]))

  for (const seq of block.shadowed) {
    const nested = bySeq.get(seq)
    if (nested !== undefined && nested.id !== block.id) {
      // A summary node inside the span: its content is what THAT block
      // removed, which is the detail a reader is after.
      const inner = collect(session, state, nested, depth + 1, index)
      out.push(...inner.nodes)
      if (inner.truncated) truncated = true
      continue
    }
    const event = eventAt(session, seq)
    if (event === undefined) continue
    const reached = originalAt(index, event)
    if (reached !== undefined && !reached.complete) truncated = true
    const source = reached?.event ?? event
    const blocks = contentOf(source)
    const text = blocks.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
    const body = [text, nonTextNote(blocks)].filter((part) => part.trim().length > 0).join('\n')
    if (body.trim().length === 0) continue
    out.push({ seq, type: source.type, text: body })
  }
  return { nodes: out, truncated }
}

/** Keep only the lines matching a query, plus a little context. */
function filterByQuery(text: string, query: string): string | undefined {
  const needle = query.toLowerCase()
  const lines = text.split('\n')
  const keep = new Set<number>()
  for (const [index, line] of lines.entries()) {
    if (!line.toLowerCase().includes(needle)) continue
    for (let offset = -QUERY_CONTEXT; offset <= QUERY_CONTEXT; offset += 1) {
      const target = index + offset
      if (target >= 0 && target < lines.length) keep.add(target)
    }
  }
  if (keep.size === 0) return undefined
  const sorted = [...keep].sort((a, b) => a - b)
  let previous = -2
  const parts: string[] = []
  for (const index of sorted) {
    if (index !== previous + 1) parts.push('…')
    parts.push(lines[index] as string)
    previous = index
  }
  return parts.join('\n')
}

/**
 * Read one block's original content back out of the log.
 *
 * @param session - session holding the log.
 * @param state - derived DCP state.
 * @param block - the block to recall.
 * @param query - optional case-insensitive line filter.
 * @returns the rendered body and its accounting.
 */
export function recallBlock(
  session: Session,
  state: DcpState,
  block: DcpBlockState,
  query?: string,
  offset = 0,
): RecallResult {
  const collected = collect(session, state, block)
  const nodes = collected.nodes
  if (nodes.length === 0) {
    return { found: false, text: `No recoverable content for ${block.id}.`, chars: 0, truncated: false, nodes: 0 }
  }

  const trimmed = query?.trim() ?? ''
  let rendered: string
  if (trimmed.length > 0) {
    const matches: string[] = []
    for (const node of nodes) {
      const filtered = filterByQuery(node.text, trimmed)
      if (filtered === undefined) continue
      matches.push(`### ${node.type} · seq ${node.seq}\n${filtered}`)
    }
    if (matches.length === 0) {
      return {
        found: false,
        text: `${block.id} contains no line matching ${JSON.stringify(query)}.`,
        chars: 0,
        truncated: false,
        nodes: nodes.length,
      }
    }
    rendered = matches.join('\n\n')
  } else {
    rendered = nodes.map((node) => `### ${node.type} · seq ${node.seq}\n${node.text}`).join('\n\n')
  }

  // The header must describe the body it introduces, so it reads the same
  // trimmed test the filter does: `query: ""` and `query: "  "` both leave the
  // body unfiltered, and a header claiming `filtered by ""` over an unfiltered
  // body reads as "these are the only matches".
  const header = `${block.id} · original content of seq ${block.spanStart}..${block.spanEnd}`
    + `${block.topic === undefined ? '' : ` · ${block.topic}`}`
    + `${trimmed.length === 0 ? '' : ` · filtered by ${JSON.stringify(query)}`}\n\n`

  // `offset` walks the body in pages. Without it, a truncated answer was a dead
  // end: the reader could see there was more and had no way to ask for it.
  const start = Math.max(0, Math.floor(offset))
  // A page that starts at or past the end has no body at all. Rendering the bare
  // header with `truncated: false` made it identical to "this block is empty",
  // so the reader could not tell a bad offset from a lost original.
  const past = start >= rendered.length
  const window = rendered.slice(start)
  const capped = window.length > RECALL_MAX_CHARS
  const body = past
    ? `[offset ${start} is past the end of this block (${rendered.length} characters); call recall again with offset 0${trimmed.length === 0 ? ' or pass a query' : ''}]`
    : capped
      ? `${window.slice(0, RECALL_MAX_CHARS)}\n\n[… truncated at ${start + RECALL_MAX_CHARS} of ${rendered.length} characters; `
        + `call recall again with offset ${start + RECALL_MAX_CHARS}, or pass a query to narrow the result …]`
      : window
  // Ways to be incomplete, and the caller must be able to tell them apart: a page
  // past the end, hitting the character cap, or a replacement chain too deep to
  // walk. All of them used to look like a complete answer.
  const deep = collected.truncated
    ? '\n\n[… truncated; the summaries nest deeper than this tool will follow …]'
    : ''
  const text = `${header}${body}${deep}`
  return { found: true, text, chars: text.length, truncated: past || capped || collected.truncated, nodes: nodes.length }
}

/**
 * Describe one block for a listing line.
 * @param block - the block.
 * @param session - session the block lives in.
 * @returns a one-line summary.
 */
export function describeBlock(block: DcpBlockState, session: Session): string {
  const state = block.consumedBy === undefined ? '' : ` (absorbed by ${block.consumedBy})`
  const live = isOnSurface(session, block.seq) ? '' : ' (no longer in the conversation)'
  const topic = block.topic === undefined ? '' : ` · ${block.topic}`
  return `${block.id} · seq ${block.spanStart}..${block.spanEnd} · ${block.shadowed.length} nodes${topic}${state}${live}`
}
