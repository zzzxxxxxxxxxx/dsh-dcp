/**
 * Optional invariant companion for `dsh-dcp`.
 *
 * DCP writes native compaction transactions, so nothing in the Harness
 * validates them unless the `dsh-invariants` registry is mounted (the shipped
 * `dsh-base` does not mount it; tests and slim SDK profiles do). This companion
 * checks the contract DCP claims to follow:
 *
 *   - every `dcp-` transaction opens once and closes once;
 *   - its summary lands before its checkpoint;
 *   - the checkpoint cites every shadowed node;
 *   - a numbered transaction opens for the turn that is actually open;
 *   - a `prune` rewrite never lands outside an open turn.
 *
 * The last rule is what once made a session log permanently unloadable, so it is
 * not trusted. The `compact` checkpoint is deliberately NOT checked for it: the
 * format requires a turn only of a non-append `tool/result`, and
 * `commitCompression` supports a standalone transaction between turns, so
 * checking the checkpoint made a legal write report a violation.
 *
 * @module dsh-dcp/invariant
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { COMPACTION_ID_PREFIX } from './types.ts'

/** Cordis plugin name, used for fiber diagnostics. */
export const name = 'dsh-dcp-invariant'

/** The invariant registry is the companion's whole purpose. */
export const inject = ['invariants']

/** The package whose runtime relationships this companion owns. */
export const PACKAGE = 'dsh-dcp'

/** Another backend's brackets are not ours to check, and our ids say which is which. */
const OWNED_PREFIX = COMPACTION_ID_PREFIX

interface OpenTransaction {
  summarySeen: boolean
  checkpointSeen: boolean
  /** The nodes the summary claimed to shadow, cited again at the checkpoint. */
  shadowedSeqs?: number[]
}

/** Narrow one event's surface operation to a replacement marker. */
function replaceOp(event: SessionEvent): unknown {
  const op = (event as { surfaceOp?: unknown }).surfaceOp
  if (op === null || typeof op !== 'object') return undefined
  return (op as { op?: unknown }).op === 'replace' ? op : undefined
}

/** Per-session brackets DCP opened and has not yet closed. */
function install(ctx: Context, fail: (message: string) => never): void {
  const open = new WeakMap<Session, Map<string, OpenTransaction>>()
  /** The turn each session currently has open, as the format defines it. */
  const openTurn = new WeakMap<Session, number | null>()
  /**
   * Sessions whose turn lifecycle this companion has actually observed.
   *
   * A companion can be mounted into a session that is already mid-turn — a
   * resumed log, or a registry mounted after the plugin. Judging the open turn
   * from state it never saw would fire on a perfectly legal transaction, and
   * `fail` throws: the throw would escape into `commitCompression`'s failure
   * path and leave a half-written transaction behind. An invariant must not
   * accuse a writer of violating a rule it had no way to observe, so the turn
   * checks stay silent until the first `turn/start`.
   */
  const turnObserved = new WeakSet<Session>

  const onEvent = (session: Session, event: SessionEvent): void => {
    const brackets = open.get(session) ?? new Map<string, OpenTransaction>()
    open.set(session, brackets)

    // ── Turn bookkeeping ────────────────────────────────────────────────────
    //
    // The storage validator only accepts a non-append `surfaceOp` replacement
    // while a turn is open (`requireTurn` in the format layer). Every write this
    // companion watches is a surface replacement, so it has to know the turn
    // state to check the rule the header advertises.
    if (event.type === 'turn/start') {
      openTurn.set(session, (event.data as { turn?: number }).turn ?? null)
      turnObserved.add(session)
      return
    }
    if (event.type === 'turn/end') {
      openTurn.set(session, null)
      turnObserved.add(session)
      return
    }

    const turn = openTurn.get(session) ?? null
    const turnKnown = turnObserved.has(session)

    if (event.type === 'compaction/start') {
      const data = event.data as { compactionId: string; turn?: number | null }
      const id = data.compactionId
      if (!id.startsWith(OWNED_PREFIX)) return
      if (brackets.has(id)) fail(`dsh-dcp: compaction ${id} opened twice`)
      else brackets.set(id, { summarySeen: false, checkpointSeen: false })
      // A "only one compaction at a time" check used to live here. It is gone on
      // purpose: `brackets` is only ever emptied by a `compaction/end`, so a
      // single bracket that leaked — the closing append is best-effort, and a
      // session released mid-transaction can lose it — turned into a PERMANENT
      // ban, failing every later legal compaction in that session and writing
      // the accusation into the log. A check that converts one lost event into
      // an unusable session costs more than the interleaving it would catch,
      // and interleaving cannot be produced by the writer anyway: it commits one
      // bracket at a time, start to end.
      // The storage format normalises the owner as `data.turn === null ? null :
      // <count>` and requires it to EQUAL the open turn, so a standalone
      // transaction cannot open inside a turn and vice versa.
      const claimed = data.turn === null || data.turn === undefined ? null : data.turn
      if (turnKnown && claimed !== turn) {
        fail(`dsh-dcp: compaction ${id} opened for turn ${claimed ?? 'none'} while turn ${turn ?? 'none'} is open`)
      }
      return
    }

    if (event.type === 'compaction/summary') {
      const data = event.data as { compactionId: string; shadowedSeqs: readonly number[] }
      if (!data.compactionId.startsWith(OWNED_PREFIX)) return
      const bracket = brackets.get(data.compactionId)
      if (bracket === undefined) {
        fail(`dsh-dcp: compaction ${data.compactionId} summarised without a start marker`)
        return
      }
      bracket.summarySeen = true
      bracket.shadowedSeqs = [...data.shadowedSeqs]
      if (data.shadowedSeqs.length === 0) fail(`dsh-dcp: compaction ${data.compactionId} shadowed nothing`)
      return
    }

    // ── The two surface-replacement writes ──────────────────────────────────
    //
    // Both DCP write paths replace the surface: `prune` swaps a tool result's
    // content, and `compact` swaps a span for its checkpoint. The rule is the
    // same for both, and getting it wrong is what once made a session log
    // permanently unloadable, so both are checked here.
    if (event.type === 'tool/result') {
      if (replaceOp(event) === undefined) return
      if (turnKnown && turn === null) {
        fail('dsh-dcp: a tool/result replacement landed outside an open turn')
      }
      return
    }

    if (event.type === 'user/message') {
      if (replaceOp(event) === undefined) return
      // A `user/message` event's data IS the message (`{content, source, role,
      // id}`), so its source sits directly on `data` — unlike `assistant/message`
      // and `tool/result`, whose message hangs under a `message` key.
      const source = (event.data as { source?: Record<string, unknown> }).source ?? {}
      const id = source['compactionId']
      if (typeof id !== 'string' || !id.startsWith(OWNED_PREFIX)) return
      const bracket = brackets.get(id)
      if (bracket === undefined) {
        fail(`dsh-dcp: checkpoint for compaction ${id} landed without a start marker`)
        return
      }
      if (!bracket.summarySeen) fail(`dsh-dcp: compaction ${id} wrote its checkpoint before its summary`)
      // No turn check here: the storage format imposes `requireTurn` only on a
      // non-append `tool/result` (session-format-v3-to-v4 `tool()`, the
      // `event.type === "tool/result"` branch). A `user/message` checkpoint is
      // legal between turns, and `commitCompression` deliberately supports a
      // standalone transaction there — so checking it made a legal write report
      // two violations.
      const cited = new Set((event as { sourceEventSeqs?: readonly number[] }).sourceEventSeqs ?? [])
      for (const seq of bracket.shadowedSeqs ?? []) {
        if (!cited.has(seq)) {
          fail(`dsh-dcp: compaction ${id} did not cite shadowed node ${seq} at its checkpoint`)
        }
      }
      bracket.checkpointSeen = true
      return
    }

    if (event.type === 'compaction/end') {
      const id = (event.data as { compactionId: string }).compactionId
      if (!id.startsWith(OWNED_PREFIX)) return
      const bracket = brackets.get(id)
      if (bracket === undefined) {
        fail(`dsh-dcp: compaction ${id} closed without a start marker`)
        return
      }
      brackets.delete(id)
      const errored = (event.data as { error?: string }).error !== undefined
      if (!errored && !bracket.checkpointSeen) {
        fail(`dsh-dcp: compaction ${id} closed successfully without a checkpoint`)
      }
    }
  }

  // The listener rides the registry's own child fiber: disposing the
  // registration tears it down, so no separate disposer is returned.
  ctx.on('session/event', onEvent, { global: true } as never)
}

/**
 * Register the companion with the invariants registry.
 * @param ctx - plugin context carrying `ctx.invariants`.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.invariants.register(PACKAGE, install),
    'dsh-dcp: invariant companion',
  )
}
