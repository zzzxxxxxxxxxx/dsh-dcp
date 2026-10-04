/**
 * Model-free pruning: the writer behind deduplication.
 *
 * Both strategies rewrite a tool result's CONTENT only, which is exactly what
 * the session's `tool/result` replacement rule allows (the rest of the event
 * payload must stay byte-identical, including the message identity). Each
 * rewrite is preceded by a `compaction/prune` shadow-price event, the shared
 * protocol the shipped tool-result pruner also speaks, so a consumer can
 * subtract the removed content from its accounting without per-node state.
 *
 * Rewriting the content replaces TEXT only: an attachment block is the model's
 * handle to what the tool returned, and deduplication is about the duplicated
 * text, so `image`/`file` blocks survive the rewrite (audit M6 / ENG-3).
 *
 * Because the attachments survive, the price a rewrite claims for the
 * `compaction/prune` protocol and the amount the surface actually loses are two
 * different numbers. The protocol keeps the node's price — the meter's O(1) fold
 * reads exactly that — while {@link pruneToolResult} also reports what was
 * really reclaimed, which is what a human-facing notice may say (audit 06 §3.1).
 *
 * @module dsh-dcp/prune
 */
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { PRUNE_OUTPUT_PLACEHOLDER, PRUNE_QUESTION_PLACEHOLDER } from './types.ts'
import { contentOf, eventAt, isOnSurface } from './surface.ts'

/** The shape of one `tool/result` event's data, as far as the writer cares. */
interface ToolResultData {
  turn: number
  step: number
  message: ToolResultMessage
  error?: { name: string; code: string; reason?: string }
  meta?: unknown
}

/**
 * Price one model message with the token meter's estimator.
 *
 * Injected rather than imported: the meter is a Harness service (the plugin
 * reads it through `ctx.get('tokenMeter')`, never by importing the package), and
 * the estimate has to be the meter's own so the two numbers cannot drift apart.
 *
 * `undefined` means "the meter could not price this", which is a different
 * answer from a price of zero: the caller falls back to the protocol figure
 * instead of claiming the whole node as reclaimed.
 */
export type EstimateMessage = (message: ToolResultMessage) => number | undefined

/**
 * What one prune attempt did.
 *
 * `tokens` is the node's heuristic price, which is what the `compaction/prune`
 * event claims: the shadow-price protocol, not a saving. `reclaimedTokens` is
 * what the surface actually lost — the same price minus everything the rewrite
 * kept, so the two differ exactly when the result carried an `image`/`file`
 * block. Report the reclaimed figure to a human and keep the protocol figure
 * for the meter (audit 06 §3.1).
 */
export type PruneOutcome =
  | { ok: true; seq: number; tokens: number; reclaimedTokens: number }
  | { ok: false; reason: 'not-on-surface' | 'not-a-tool-result' | 'already-pruned' | 'failed'; detail?: string }

/** Whether one tool result already carries a DCP placeholder. */
export function isPruned(session: Session, seq: number): boolean {
  const event = eventAt(session, seq)
  if (event?.type !== 'tool/result') return false
  const text = contentOf(event).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  return text.includes(PRUNE_OUTPUT_PLACEHOLDER) || text.includes(PRUNE_QUESTION_PLACEHOLDER)
}

/**
 * Rewrite content down to one placeholder text block, keeping every other block.
 *
 * A non-text block is an ATTACHMENT — the model's only handle to what the tool
 * returned. Replacing the whole array with a single text block, which this
 * writer used to do, dropped an `image`/`file` result off the surface where
 * neither the session nor `recall` could reach it again, even though only the
 * duplicated TEXT was ever meant to go (audit M6 / ENG-3). The placeholder
 * therefore takes the position of the first text block, later text blocks are
 * dropped as before, and every attachment keeps its original position.
 *
 * @param content - the original result content, in order.
 * @param text - the placeholder to write.
 * @returns the replacement content.
 */
function rewrittenContent(content: readonly ContentBlock[], text: string): ContentBlock[] {
  const out: ContentBlock[] = []
  let placed = false
  for (const block of content) {
    if (block.type !== 'text') {
      out.push(block)
      continue
    }
    if (placed) continue
    placed = true
    out.push({ type: 'text', text })
  }
  if (!placed) out.push({ type: 'text', text })
  return out
}

/**
 * Replace one tool result's content with a placeholder.
 *
 * The replacement copies the original payload and swaps only `content`, so the
 * event's message identity, tool-call correlation, error facts, and private
 * `meta` survive verbatim — the session rejects anything else. Within
 * `content`, only text blocks are rewritten; attachments are carried through
 * (see {@link rewrittenContent}).
 *
 * @param session - session holding the node.
 * @param seq - the surface sequence of the `tool/result` node.
 * @param text - the placeholder to write.
 * @param tokens - heuristic price of the node, which the shadow-price event claims.
 * @param estimate - the meter's message estimator, for the reclaimed figure; when
 *   omitted (or unable to price the message), `reclaimedTokens` falls back to
 *   `tokens` rather than guess.
 * @returns what happened.
 */
export function pruneToolResult(
  session: Session,
  seq: number,
  text: string,
  tokens: number,
  estimate?: EstimateMessage,
): PruneOutcome {
  if (!isOnSurface(session, seq)) return { ok: false, reason: 'not-on-surface' }
  const event = eventAt(session, seq)
  if (event?.type !== 'tool/result') return { ok: false, reason: 'not-a-tool-result' }
  if (isPruned(session, seq)) return { ok: false, reason: 'already-pruned' }

  const data = event.data as unknown as ToolResultData
  const message: ToolResultMessage = { ...data.message, content: rewrittenContent(data.message.content, text) }
  const replacement = { ...data, message }

  // A display number must never cost a rewrite: an estimator that throws, or
  // one that cannot price this message, falls back to the protocol price
  // instead of failing the pass or claiming a saving nobody measured.
  let reclaimedTokens = tokens
  if (estimate !== undefined) {
    try {
      const replacementPrice = estimate(message)
      if (replacementPrice !== undefined) reclaimedTokens = Math.max(0, tokens - replacementPrice)
    } catch {
      reclaimedTokens = tokens
    }
  }

  try {
    session.append('compaction/prune', {
      shadowedRange: { start: seq as SessionSeq, end: seq as SessionSeq },
      shadowedSeqs: [seq as SessionSeq],
      shadowedTokenCount: tokens,
    } as never)
    session.append('tool/result', replacement as never, {
      surfaceOp: { op: 'replace', startSeq: seq as SessionSeq, endSeq: seq as SessionSeq },
      sourceEventSeqs: [seq as SessionSeq],
    })
    return { ok: true, seq, tokens, reclaimedTokens }
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The placeholder one deduplication rewrite writes.
 *
 * A function rather than a bare constant so the writer's intent stays named at
 * the call site. `PRUNE_QUESTION_PLACEHOLDER` is deliberately not an option:
 * nothing constructs a `question` reason, and *recognising* that text — which
 * `projection.ts` still does, for logs written before this — is a different job
 * from producing it.
 *
 * @returns the placeholder text.
 */
export function placeholderFor(): string {
  return PRUNE_OUTPUT_PLACEHOLDER
}
