/**
 * Read-only helpers over one session's model-visible surface.
 *
 * The surface is the single source of derived history, so every range DCP
 * selects is expressed as inclusive surface seqs and every decision is
 * re-validated against the CURRENT surface immediately before a write: the
 * surface can change between the model's decision and the tool body that
 * applies it.
 *
 * @module dsh-dcp/surface
 */
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq as seq } from '@deepseek-ai/dsh-session'

/** How one surface node reads to the model. */
export type NodeKind = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

/** One addressable surface node offered to the model. */
export interface SurfaceTarget {
  /** Stable handle, `n<seq>`; copying the handle copies the sequence. */
  id: string
  seq: number
  kind: NodeKind
  /** Heuristic token price from the token meter, when one is available. */
  tokens?: number
  /** First characters of the model-visible text, for boundary identification. */
  preview: string
  /** Whether the cut immediately before this node is tool-pairing balanced. */
  balancedBefore: boolean
  /** Whether the cut immediately after this node is tool-pairing balanced. */
  balancedAfter: boolean
  /** This node is a DCP summary checkpoint (`b<ordinal>`), when it is one. */
  block?: string
}

/** Build the model-facing handle for one sequence. */
export function targetId(sequence: number): string {
  return `n${sequence}`
}

/**
 * Parse a model-supplied handle back into a sequence.
 * @param id - the handle exactly as the target list printed it.
 * @returns the sequence, or `undefined` when the handle is not a DCP target id.
 */
export function parseTargetId(id: string): number | undefined {
  const match = /^n(\d+)$/.exec(id.trim())
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Snapshot the current surface's sequences.
 * @param session - session to read.
 * @returns a mutable copy in model-visible order.
 */
export function surfaceSeqs(session: Session): number[] {
  return [...session.surface.nodes] as number[]
}

/**
 * Read one surface node's event.
 * @param session - session to read.
 * @param sequence - an existing surface sequence.
 * @returns the committed event, or `undefined` when the sequence is unknown.
 */
export function eventAt(session: Session, sequence: number): SessionEvent | undefined {
  return session.eventAt(seq(sequence))
}

/**
 * Classify one surface event by the role its derived message carries.
 * @param event - a committed surface event.
 * @returns the node kind.
 */
export function nodeKind(event: SessionEvent | undefined): NodeKind {
  switch (event?.type) {
    case 'system/message': return 'system'
    case 'developer/message': return 'developer'
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'tool/result': return 'tool'
    default: return 'developer'
  }
}

/**
 * The model-visible content of one event.
 *
 * `user/message` carries the message itself while every other message-bearing
 * event wraps it in `data.message`, so this is the single place that knows the
 * difference.
 * @param event - a committed event.
 * @returns the content blocks, or an empty array for an event without any.
 */
export function contentOf(event: SessionEvent | undefined): readonly ContentBlock[] {
  if (event === undefined) return []
  const data = event.data as { content?: readonly ContentBlock[]; message?: { content?: readonly ContentBlock[] } }
  const content = event.type === 'user/message' ? data.content : data.message?.content
  return Array.isArray(content) ? content : []
}

/**
 * Extract the model-visible plain text of one event.
 * @param event - a committed event.
 * @returns concatenated text blocks, or `''` for an event without text.
 */
export function eventText(event: SessionEvent | undefined): string {
  let text = ''
  for (const block of contentOf(event)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += (text.length > 0 ? '\n' : '') + block.text
    }
  }
  return text
}

/**
 * Render a one-line preview of a node for the target list.
 * @param event - a committed event.
 * @param max - maximum characters to keep.
 * @returns whitespace-collapsed preview text.
 */
export function preview(event: SessionEvent | undefined, max = 72): string {
  const text = eventText(event).replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/**
 * Whether one sequence is on the current surface.
 * @param session - session to read.
 * @param sequence - candidate sequence.
 * @returns true when the sequence is a current surface node.
 */
export function isOnSurface(session: Session, sequence: number): boolean {
  return session.surface.nodes.includes(seq(sequence))
}

/**
 * The index of one sequence within the current surface.
 * @param nodes - a surface snapshot.
 * @param sequence - candidate sequence.
 * @returns the index, or `-1` when absent.
 */
export function indexOfSeq(nodes: readonly number[], sequence: number): number {
  return nodes.indexOf(sequence)
}

/**
 * Whether the shadowed range covers surface node 0 while it holds the system prompt.
 * The session refuses such a replacement unless the writer is a `system/message`
 * over exactly that node, so DCP pre-checks and refuses with a clear message.
 * @param session - session to read.
 * @param startSeq - inclusive range start.
 * @returns true when the range must be refused.
 */
export function coversSystemHead(session: Session, startSeq: number): boolean {
  const nodes = session.surface.nodes
  const head = nodes[0]
  if (head === undefined || head !== seq(startSeq)) return false
  return session.eventAt(head)?.type === 'system/message'
}

/**
 * The current open turn number, as derived by the projection.
 * @param turn - the projection's open-turn value.
 * @param fallback - value to use when no turn is open.
 * @returns a turn number.
 */
export function requireTurn(turn: number | null, fallback = 0): number {
  return turn ?? fallback
}

/** Re-export the branding helper so callers do not import the session package twice. */
export { seq as brandSeq }
export type { SessionSeq }
