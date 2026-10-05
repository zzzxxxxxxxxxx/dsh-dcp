/**
 * Strategy tests: duplicate-call pruning (successes and failures alike),
 * protection, glob matching, and idempotence — exercised over a real `Session`
 * with the real write path.
 *
 * @module dsh-dcp/tests/strategies
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { runStrategies } from '../src/runner.ts'
import type { StrategyDeps } from '../src/runner.ts'
import { pruneToolResult } from '../src/prune.ts'
import type { EstimateMessage } from '../src/prune.ts'
import { collectToolPairs } from '../src/strategies/index.ts'
import { initialDcpState } from '../src/types.ts'
import { PRUNE_OUTPUT_PLACEHOLDER } from '../src/types.ts'
import { applyDcpEvent } from '../src/projection.ts'
import { Config as ConfigSchema, resolveConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { collectFilePaths, matchesAny } from '../src/protected.ts'

const SOURCE = { provider: 'test', model: 'test' }

/** One scripted tool call. */
interface Call {
  name: string
  args: string
  result: string
  isError?: boolean
  tool?: string
  /** Non-text blocks after the text one, the way a media-returning tool sends them. */
  media?: readonly ContentBlock[]
  /** Send no text block at all, so the result is attachment-only. */
  omitText?: boolean
  /** The durable `tool/result` presentation payload. */
  meta?: unknown
}

/** Build a session whose single turn produced the given calls. */
function build(session: Session, calls: readonly Call[]): { turn: number } {
  let state = initialDcpState()
  const feed = (event: Parameters<typeof applyDcpEvent>[1]): void => {
    state = applyDcpEvent(state, event)
  }
  feed(session.append('turn/start', { turn: 1 }))
  feed(session.append('user/message',
    createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' }))

  calls.forEach((call, index) => {
    const callId = `call-${index}` as unknown as ToolCallId
    feed(session.append('assistant/message', {
      turn: 1,
      step: index + 1,
      message: createAssistantMessage({
        content: [
          { type: 'tool-call', id: callId, name: call.name, arguments: call.args } as never,
        ],
        source: SOURCE,
      }),
      stream: [],
    }, { surfaceOp: 'append' }))
    feed(session.append('tool/call', { turn: 1, step: index + 1, callId: callId as never, name: call.tool ?? call.name, arguments: call.args }))
    feed(session.append('tool/result', {
      turn: 1,
      step: index + 1,
      message: createToolResultMessage({
        callId,
        content: call.omitText === true
          ? [...(call.media ?? [])]
          : [{ type: 'text', text: call.result }, ...(call.media ?? [])],
        isError: call.isError === true,
      }),
      ...(call.meta === undefined ? {} : { meta: call.meta as never }),
    }, { surfaceOp: 'append' }))
  })
  return { turn: state.turn ?? 1 }
}

/** A strategy-pass dependency set with a fixed turn for the current clock. */
function deps(config: Config, currentTurn: number | null): StrategyDeps {
  return {
    config,
    stateOf: () => ({ ...initialDcpState(), turn: currentTurn }),
    priceOf: () => () => 7,
    declaredPaths: () => [],
  }
}

/** Every model-visible text block of the derived history. */
function texts(session: Session): string[] {
  return session.deriveMessages().flatMap((message) =>
    message.content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text))
}

/** Every image/file block the derived history exposes, in order. */
function mediaBlocks(session: Session): ContentBlock[] {
  return session.deriveMessages().flatMap((message) =>
    message.content.filter((block) => block.type === 'image' || block.type === 'file'))
}

/** A screenshot-shaped image block with a stable attachment identity. */
function imageBlock(id: string): ContentBlock {
  return {
    type: 'image',
    attachment: { attachmentId: id, mediaType: 'image/png', bytes: 2_048, width: 32, height: 32, name: 'shot.png' },
  } as unknown as ContentBlock
}

/** A file-shaped attachment block. */
function fileBlock(id: string): ContentBlock {
  return {
    type: 'file',
    attachment: { attachmentId: id, name: 'report.pdf', bytes: 4_096 },
  } as unknown as ContentBlock
}

describe('deduplication', () => {
  it('rewrites the older duplicate and keeps the newest result', () => {
    const session = Session.create('dedup' as never)
    build(session, [
      { name: 'read', args: '{"path":"a.ts"}', result: 'first read of a.ts' },
      { name: 'read', args: '{"path":"b.ts"}', result: 'only read of b.ts' },
      { name: 'read', args: '{"path":"a.ts","offset":null}', result: 'second read of a.ts' },
    ])

    const report = runStrategies(session, deps({}, 5))
    expect(report.pruned).toBe(1)

    const text = texts(session)
    // The older duplicate's body is gone; the newest one and the unrelated read survive.
    expect(text.some((item) => item.includes('first read of a.ts'))).toBe(false)
    expect(text.some((item) => item.includes('second read of a.ts'))).toBe(true)
    expect(text.some((item) => item.includes('only read of b.ts'))).toBe(true)
    expect(text.some((item) => item.includes(PRUNE_OUTPUT_PLACEHOLDER))).toBe(true)
  })

  it('is idempotent: a second pass writes nothing', () => {
    const session = Session.create('dedup-twice' as never)
    build(session, [
      { name: 'read', args: '{"path":"a.ts"}', result: 'first' },
      { name: 'read', args: '{"path":"a.ts"}', result: 'second' },
    ])
    const before = session.snapshotEvents().length
    expect(runStrategies(session, deps({}, 5)).pruned).toBe(1)
    const afterFirst = session.snapshotEvents().length
    expect(afterFirst).toBeGreaterThan(before)
    expect(runStrategies(session, deps({}, 5)).pruned).toBe(0)
    expect(session.snapshotEvents().length).toBe(afterFirst)
  })

  it('leaves protected tool names alone', () => {
    const session = Session.create('dedup-protected' as never)
    build(session, [
      { name: 'write', args: '{"path":"a.ts","content":"x"}', result: 'wrote a.ts' },
      { name: 'write', args: '{"path":"a.ts","content":"x"}', result: 'wrote a.ts again' },
    ])
    const report = runStrategies(session, deps({
      strategies: { deduplication: { enabled: true, protectedTools: ['write'] } },
    }, 5))
    expect(report.pruned).toBe(0)
  })

  it('respects turn protection', () => {
    const session = Session.create('dedup-turns' as never)
    build(session, [
      { name: 'read', args: '{"path":"a.ts"}', result: 'first' },
      { name: 'read', args: '{"path":"a.ts"}', result: 'second' },
    ])
    const report = runStrategies(session, deps({
      turnProtection: { enabled: true, turns: 4 },
    }, 2))
    expect(report.pruned).toBe(0)
  })
})

describe('errored output', () => {
  it('leaves a lone failure alone, however old it is', () => {
    // The `purgeErrors` strategy used to replace a failed call's output no
    // matter how old it was: that kept the arguments it could not use and
    // discarded the error text the model needs. Nothing prunes a failure that
    // was never repeated.
    const session = Session.create('purge-removed' as never)
    build(session, [
      { name: 'read', args: '{"path":"missing.ts"}', result: 'ENOENT: no such file missing.ts', isError: true },
      { name: 'read', args: '{"path":"ok.ts"}', result: 'fine' },
    ])

    // Turn 9 against a failure made in turn 1: far past any threshold the old
    // strategy defaulted to, and still nothing is touched.
    expect(runStrategies(session, deps({}, 9)).pruned).toBe(0)
    const text = texts(session)
    expect(text.some((item) => item.includes('ENOENT: no such file missing.ts'))).toBe(true)
    expect(text.some((item) => item.includes(PRUNE_OUTPUT_PLACEHOLDER))).toBe(false)
  })

  it('deduplicates repeated failures like any other call, keeping the newest error', () => {
    // Deduplication keys on the call signature, not on `isError`: two identical
    // failing calls are one repeated call, so the older repetition is
    // superseded and the newest error text survives verbatim.
    const session = Session.create('dedup-failures' as never)
    build(session, [
      { name: 'read', args: '{"path":"missing.ts"}', result: 'ENOENT: no such file missing.ts', isError: true },
      { name: 'read', args: '{"path":"missing.ts"}', result: 'ENOENT: retried, still missing', isError: true },
    ])

    expect(runStrategies(session, deps({}, 9)).pruned).toBe(1)
    const text = texts(session)
    expect(text.some((item) => item.includes('ENOENT: retried, still missing'))).toBe(true)
    expect(text.some((item) => item.includes('ENOENT: no such file missing.ts'))).toBe(false)
    expect(text.some((item) => item.includes(PRUNE_OUTPUT_PLACEHOLDER))).toBe(true)
  })

  it('does not let a repeated failure supersede an earlier success', () => {
    // A newer FAILURE is different evidence from an older SUCCESS, so it does
    // not supersede it. A pruned node has no recall path (only compaction
    // blocks are addressable), so pruning here would lose the only good output
    // the group ever produced after one transient failure.
    const session = Session.create('dedup-failure-vs-success' as never)
    build(session, [
      { name: 'bash', args: '{"command":"npm test"}', result: 'all green' },
      { name: 'bash', args: '{"command":"npm test"}', result: 'ETIMEDOUT', isError: true },
    ])

    expect(runStrategies(session, deps({}, 9)).pruned).toBe(0)
    const text = texts(session)
    expect(text.some((item) => item.includes('all green'))).toBe(true)
    expect(text.some((item) => item.includes('ETIMEDOUT'))).toBe(true)
    expect(text.some((item) => item.includes(PRUNE_OUTPUT_PLACEHOLDER))).toBe(false)
  })

  it('still supersedes stale successes when the newest result failed', () => {
    // The newest success survives next to the newest failure, but the
    // repetitions older than that success are still stale and still go.
    const session = Session.create('dedup-failure-keeps-newest-success' as never)
    build(session, [
      { name: 'bash', args: '{"command":"npm test"}', result: 'first green' },
      { name: 'bash', args: '{"command":"npm test"}', result: 'second green' },
      { name: 'bash', args: '{"command":"npm test"}', result: 'ETIMEDOUT', isError: true },
    ])

    expect(runStrategies(session, deps({}, 9)).pruned).toBe(1)
    const text = texts(session)
    expect(text.some((item) => item.includes('second green'))).toBe(true)
    expect(text.some((item) => item.includes('ETIMEDOUT'))).toBe(true)
    expect(text.some((item) => item.includes('first green'))).toBe(false)
  })

  it('lets a newest success supersede an earlier failure', () => {
    const session = Session.create('dedup-success-supersedes-failure' as never)
    build(session, [
      { name: 'bash', args: '{"command":"npm test"}', result: 'ETIMEDOUT', isError: true },
      { name: 'bash', args: '{"command":"npm test"}', result: 'green on retry' },
    ])

    expect(runStrategies(session, deps({}, 9)).pruned).toBe(1)
    const text = texts(session)
    expect(text.some((item) => item.includes('green on retry'))).toBe(true)
    expect(text.some((item) => item.includes('ETIMEDOUT'))).toBe(false)
  })
})

describe('strategiesAllowed', () => {
  it('stands down when manual mode disables the automatic strategies', () => {
    const session = Session.create('allowed-manual' as never)
    build(session, [
      { name: 'read', args: '{"path":"a.ts"}', result: 'first' },
      { name: 'read', args: '{"path":"a.ts"}', result: 'second' },
    ])
    expect(runStrategies(session, deps({
      manualMode: { enabled: true, automaticStrategies: false },
    }, 5)).pruned).toBe(0)
    // Manual mode alone keeps the model-free strategies running, by design.
    expect(runStrategies(session, deps({
      manualMode: { enabled: true, automaticStrategies: true },
    }, 5)).pruned).toBe(1)
  })

  it('does nothing while a compaction transaction is open or in manual mode', () => {
    const session = Session.create('allowed' as never)
    build(session, [
      { name: 'read', args: '{"path":"a.ts"}', result: 'first' },
      { name: 'read', args: '{"path":"a.ts"}', result: 'second' },
    ])
    // Denying the compact TOOL does not disable the model-free strategies.
    expect(runStrategies(session, deps({ compaction: { permission: 'deny' } }, 5)).pruned).toBe(1)
    // Manual mode's own switch is what stands them down. There used to be a
    // top-level `enabled` master switch as well; it was removed because it only
    // reached this gate and the nudge gate, while leaving the model-facing tools
    // registered and erroring.
    expect(runStrategies(session, deps({
      manualMode: { enabled: true, automaticStrategies: false },
    }, 5)).pruned).toBe(0)
  })
})

describe('media-bearing results', () => {
  it('keeps image and file blocks when the older duplicate is rewritten', () => {
    const session = Session.create('dedup-media' as never)
    build(session, [
      { name: 'screenshot', args: '{"url":"https://example.test/a"}', result: 'rendered once', media: [imageBlock('sha256:one')] },
      { name: 'screenshot', args: '{"url":"https://example.test/a"}', result: 'rendered twice', media: [imageBlock('sha256:two'), fileBlock('sha256:doc')] },
    ])
    const before = mediaBlocks(session).map((block) => block.type)
    expect(before).toEqual(['image', 'image', 'file'])

    expect(runStrategies(session, deps({}, 5)).pruned).toBe(1)

    // Deduplication removes the duplicate TEXT; an attachment is the model's
    // only handle on what the call returned, so the rewrite carries every
    // non-text block through (M6 / ENG-3).
    expect(mediaBlocks(session).map((block) => block.type)).toEqual(before)
    const text = texts(session)
    expect(text.some((item) => item.includes(PRUNE_OUTPUT_PLACEHOLDER))).toBe(true)
    expect(text.some((item) => item.includes('rendered once'))).toBe(false)
    expect(text.some((item) => item.includes('rendered twice'))).toBe(true)
  })

  it('writes the placeholder for an attachment-only result without dropping the attachment', () => {
    const session = Session.create('dedup-media-only' as never)
    build(session, [
      { name: 'screenshot', args: '{"url":"https://example.test/b"}', result: '', omitText: true, media: [imageBlock('sha256:only')] },
      { name: 'screenshot', args: '{"url":"https://example.test/b"}', result: '', omitText: true, media: [imageBlock('sha256:newest')] },
    ])
    expect(runStrategies(session, deps({}, 5)).pruned).toBe(1)
    expect(mediaBlocks(session)).toHaveLength(2)
    expect(texts(session).some((item) => item.includes(PRUNE_OUTPUT_PLACEHOLDER))).toBe(true)
  })
})

describe('protected tool routing', () => {
  it('exempts a tool listed in compaction.protectedTools from deduplication', () => {
    const session = Session.create('dedup-compaction-protected' as never)
    build(session, [
      { name: 'my_tool', args: '{"path":"a.ts"}', result: 'first' },
      { name: 'my_tool', args: '{"path":"a.ts"}', result: 'second' },
    ])
    // "outputs are appended verbatim to a summary instead of being condensed
    // away" is a promise deduplication can break as well, so the pass reads this
    // list too (CORE-5 / STATE-4). The control below shows the calls really are
    // one duplicate when nothing protects them, so this asserts the wiring and
    // not a fixture that could never be pruned.
    expect(runStrategies(session, deps({ compaction: { protectedTools: ['my_tool'] } }, 5)).pruned).toBe(0)
    expect(runStrategies(session, deps({}, 5)).pruned).toBe(1)
  })

  it('keeps the default commands list (write/edit) out of deduplication', () => {
    const buildWrite = (name: string): Session => {
      const session = Session.create(name as never)
      build(session, [
        { name: 'write', args: '{"path":"a.ts","content":"x"}', result: 'wrote a.ts' },
        { name: 'write', args: '{"path":"a.ts","content":"x"}', result: 'wrote a.ts' },
      ])
      return session
    }
    // The schema default is what shields `write`; emptying the list leaves the
    // older receipt eligible, so the shield is the list and not the fixture.
    expect(runStrategies(buildWrite('dedup-defaults'), deps(resolveConfig(ConfigSchema({})), 5)).pruned).toBe(0)
    expect(runStrategies(
      buildWrite('dedup-defaults-emptied'),
      deps(resolveConfig(ConfigSchema({ commands: { protectedTools: [] } })), 5),
    ).pruned).toBe(1)
  })
})

describe('glob matching', () => {
  it('keeps the documented pattern language', () => {
    expect(matchesAny('src/deep/path/file.test.ts', ['**/*.test.ts'])).toBe(true)
    expect(matchesAny('src/deep/path/file.ts', ['**/*.test.ts'])).toBe(false)
    // `**/` is optional, so the bare filename matches too.
    expect(matchesAny('file.test.ts', ['**/*.test.ts'])).toBe(true)
    // `*` never crosses a separator, and the basename is tried on its own.
    expect(matchesAny('src/a/b.ts', ['a/*.ts'])).toBe(false)
    expect(matchesAny('a/b/c.ts', ['a/*/c.?s'])).toBe(true)
    expect(matchesAny('subagent_codex', ['subagent*'])).toBe(true)
    expect(matchesAny('todo_write', ['subagent*', 'skill'])).toBe(false)
  })

  it('collapses repeated wildcard runs without changing the language', () => {
    expect(matchesAny('a/b/c.ts', ['**/**/**/*.ts'])).toBe(true)
    expect(matchesAny('a/b/c.tsx', ['**/**/**/*.ts'])).toBe(false)
    expect(matchesAny('a/b/c.ts', ['**/*.ts'])).toBe(true)
  })

  it('spans line terminators with `**`, the safe direction of one difference', () => {
    // The translated `RegExp` this replaced used `.`, which never crosses a line
    // terminator; a glob star does. A protected PATH is the value that can carry
    // one, and matching it means protecting it, so the widening only ever
    // prunes less (see matchesCompiled in src/protected.ts).
    expect(matchesAny('secrets/a\nb', ['secrets/**'])).toBe(true)
    expect(matchesAny('a\nb/c.ts', ['**/*.ts'])).toBe(true)
  })

  it('matches pathological patterns without backtracking', () => {
    // These two used to cost ~1.2 s and ~1.8 s per call inside the agent's event
    // loop, synchronously and with no timeout (audit STATE-5). The bound is
    // loose enough to stay stable on a loaded machine and tight enough to catch
    // a translated `RegExp` coming back.
    const started = Date.now()
    expect(matchesAny('a'.repeat(32), ['*a*a*a*a*a*a*a*a*b'])).toBe(false)
    expect(matchesAny('a/'.repeat(20) + 'b', ['**/**/**/**/**/**/**/**/**/**/x'])).toBe(false)
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('refuses inputs past the match budget instead of scanning them', () => {
    // A value or a pattern no real tool name or path reaches: the probe gives up
    // rather than walk the pair (see MAX_MATCH_VALUE / MAX_MATCH_PATTERN in
    // src/protected.ts).
    expect(matchesAny('a'.repeat(9_000), ['*'])).toBe(false)
    expect(matchesAny('a', [`${'a'.repeat(5_000)}*`])).toBe(false)
  })
})

describe('path protection sources', () => {
  /** Two identical bash calls whose results carry the path only in `meta`. */
  const metaPathSession = (name: string): Session => {
    const session = Session.create(name as never)
    build(session, [
      { name: 'bash', args: '{"command":"cat secrets/credentials.env"}', result: 'redacted', meta: { filePath: 'secrets/credentials.env' } },
      { name: 'bash', args: '{"command":"cat secrets/credentials.env"}', result: 'redacted', meta: { filePath: 'secrets/credentials.env' } },
    ])
    return session
  }

  it('reads a path that only the tool result meta carries', () => {
    // Neither the arguments nor a tool declaration names a path, so only the
    // durable result payload can shield the pair; before STATE-6's fix the
    // producer never passed it on.
    expect(runStrategies(metaPathSession('dedup-meta-path'), deps({ protectedFilePatterns: ['secrets/**'] }, 5)).pruned).toBe(0)
    // Control: with no path pattern the same calls are one duplicate.
    expect(runStrategies(metaPathSession('dedup-meta-path-control'), deps({}, 5)).pruned).toBe(1)
  })

  it('finds a path key below the old depth cap', () => {
    // The walk used to return at depth > 4, so this key was silently invisible.
    expect(collectFilePaths({ a: { b: { c: { d: { e: { f: { path: 'deep/file.ts' } } } } } } })).toContain('deep/file.ts')
    expect(collectFilePaths({ query: 'x' }, [], { filePath: 'secrets/credentials.env' })).toContain('secrets/credentials.env')
  })

  it('collects declared paths first and reads patch bodies', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch'
    expect(collectFilePaths({ patch }, ['declared/b.ts'])).toEqual(['declared/b.ts', 'src/a.ts'])
  })
})

describe('reclaimed token accounting', () => {
  /** Two identical screenshot calls, so the older result is a candidate. */
  const mediaSession = (name: string): Session => {
    const session = Session.create(name as never)
    build(session, [
      { name: 'screenshot', args: '{"url":"https://example.test/c"}', result: 'body text', media: [imageBlock('sha256:one')] },
      { name: 'screenshot', args: '{"url":"https://example.test/c"}', result: 'body text', media: [imageBlock('sha256:two')] },
    ])
    return session
  }

  it('separates the protocol price from what the rewrite actually removed', () => {
    const session = mediaSession('reclaimed-media')
    const [target] = collectToolPairs(session)
    expect(target).toBeDefined()
    if (target === undefined) return
    // A stand-in for the meter's estimator with the shape V measured: the kept
    // attachment costs 59, everything else nothing (179 whole node, 120 freed).
    const estimate: EstimateMessage = (message) => message.content.some((block) => block.type === 'image') ? 59 : 0

    const outcome = pruneToolResult(session, target.resultSeq, PRUNE_OUTPUT_PLACEHOLDER, 179, estimate)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.tokens).toBe(179)
    expect(outcome.reclaimedTokens).toBe(120)

    // The event keeps claiming the NODE's price — the meter's O(1) fold reads
    // exactly that field, so the display figure must not leak into it.
    const prune = session.snapshotEvents().filter((event) => event.type === 'compaction/prune').at(-1)
    expect((prune?.data as { shadowedTokenCount: number }).shadowedTokenCount).toBe(179)

    // And the attachment really is still on the surface, which is why the two
    // numbers differ at all.
    const rewritten = session.snapshotEvents()
      .filter((event) => event.type === 'tool/result' && (event.surfaceOp as { op?: string } | undefined)?.op === 'replace').at(-1)
    const content = (rewritten?.data as { message: { content: ContentBlock[] } }).message.content
    expect(content.map((block) => block.type)).toEqual(['text', 'image'])
  })

  it('falls back to the protocol price when no estimator is supplied', () => {
    const session = Session.create('reclaimed-fallback' as never)
    build(session, [
      { name: 'read', args: '{"path":"a.ts"}', result: 'first' },
      { name: 'read', args: '{"path":"a.ts"}', result: 'second' },
    ])
    const [target] = collectToolPairs(session)
    if (target === undefined) throw new Error('no tool pair')
    const outcome = pruneToolResult(session, target.resultSeq, PRUNE_OUTPUT_PLACEHOLDER, 42)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Guessing would be worse than repeating the protocol price the caller gave.
    expect(outcome.tokens).toBe(42)
    expect(outcome.reclaimedTokens).toBe(42)
  })

  it('never reports a negative reclaim when the estimators disagree', () => {
    const session = mediaSession('reclaimed-negative')
    const [target] = collectToolPairs(session)
    if (target === undefined) throw new Error('no tool pair')
    const outcome = pruneToolResult(session, target.resultSeq, PRUNE_OUTPUT_PLACEHOLDER, 179, () => 1_000)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.reclaimedTokens).toBe(0)
  })

  it('reports the reclaim a real meter measures, through a whole pass', () => {
    // The meter folds step/start..step/end around every assistant message, so
    // this fixture is built here rather than by `build()`.
    const session = Session.create('reclaimed-meter' as never)
    const args = '{"page":"home"}'
    session.append('turn/start', { turn: 1 })
    for (let index = 0; index < 2; index += 1) {
      const step = index + 1
      const callId = `call-${index}` as unknown as ToolCallId
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', {
        turn: 1,
        step,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'screenshot', arguments: args } as never],
          source: SOURCE,
        }),
        stream: [],
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step, callId: callId as never, name: 'screenshot', arguments: args })
      session.append('tool/result', {
        turn: 1,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: `a long rendered body ${'x'.repeat(400)}` }, imageBlock(`sha256:${index}`)],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }

    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    const meter = new TokenMeter(ctx)
    const prices = new Map(meter.measure(session).nodes.map((node) => [node.seq as number, node.heuristicTokens]))
    const before = meter.measure(session).totalTokens

    const report = runStrategies(session, {
      config: {},
      stateOf: () => ({ ...initialDcpState(), turn: 1 }),
      priceOf: () => (seq) => prices.get(seq),
      estimateMessage: (message) => meter.estimateMessage(message),
      declaredPaths: () => [],
    })

    const measured = before - meter.measure(session).totalTokens
    expect(report.pruned).toBe(1)
    // The number a notice would state is the one the meter itself measures —
    // the writer's own arithmetic is not trusted for this.
    expect(report.reclaimedTokens).toBe(measured)
    // A media-carrying node keeps its image, so the reclaim is strictly smaller
    // than the shadow price the `compaction/prune` event claims.
    expect(report.tokens).toBeGreaterThan(report.reclaimedTokens)
    const prune = session.snapshotEvents().filter((event) => event.type === 'compaction/prune').at(-1)
    expect((prune?.data as { shadowedTokenCount: number }).shadowedTokenCount).toBe(report.tokens)
  })
})
