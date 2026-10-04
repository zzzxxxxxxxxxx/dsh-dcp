/**
 * DCP's own producer identity for the messages it injects.
 *
 * Summary checkpoints use the backend-independent `compactCheckpointSource` so
 * the Harness renders them and other checkpoint consumers recognize them; this
 * source kind is only for *ancillary* DCP messages — nudges and notices.
 *
 * @module dsh-dcp/source
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-dcp': {
      kind: 'dsh-dcp'
    } & ContextFormed
  }
}

/** The bare producer identity for an injected DCP context message. */
export const DCP_SOURCE = { kind: 'dsh-dcp' } as const
