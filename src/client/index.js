window.__ModuleLoader__.load({
  // The envelope's id is the PACKAGE name, not the short entry id. The host's
  // client-modules half locates this bundle through the loader row's name and
  // then looks the registration up under exactly that string, so `dsh-dcp`
  // here made the browser boot refuse the plugin — `client-modules: could not
  // load "@zzxxxxxx/dsh-dcp": ... loaded without registering
  // "@zzxxxxxx/dsh-dcp"` — while the server half stayed up and green. The entry
  // id is still `dsh-dcp`; that is a different namespace, used by the settings
  // form and the patch layer.
  id: '@zzxxxxxx/dsh-dcp',
  /**
   * Browser half of dsh-dcp.
   *
   * Authored directly in the module-loader envelope so no client build step can
   * drift from the contract: the factory is lazy, `require` reaches only the
   * page's module table, and registration happens inside `apply`.
   *
   * It contributes two things: a pill in the composer band, beside the host's
   * own stats pills, which reports what DCP itself compacted and pruned for
   * this session; and a card on the Settings page, on the host's
   * `settings.section` seat (id `dsh-dcp`).
   *
   * The card is NOT generated from the plugin's schema: this file draws it and
   * carries its own wording in the COPY table below, because a bundle the
   * profile merely links in never reaches the Plugins page's configuration
   * ledger. Under the web profile the host's own compaction is live beside
   * DCP, so the readout stays DCP's own counts and nothing more.
   *
   * Compaction is triggered with the `/dcp-compact` command, which coexists
   * with the host's `/compact`; there is no button elsewhere and no
   * client-side command plumbing to keep in step.
   *
   * Session-scoped slots deliver `props.sessionId`, `props.useSession`, and
   * `props.useProjection`, the host-computed projection values addressed by
   * key; the pill renders the `dcp` projection and nothing else.
   *
   * Styling copies the host components that own this band — `StatsPills.module.css`
   * for the pill, `stat-dialog.module.css` for the panel it opens — reduced to
   * theme tokens, and is installed once per document as a `<style>` tag keyed
   * the way the host's own bundles key theirs.
   */
  factory(require) {
    const React = require('react')
    // `ui-primitives` is a baseline module of the client module table, so the
    // shared Tooltip is available to every dynamic bundle and this half must not
    // grow its own copy of it.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    // The page's module table publishes react-dom, but a client half that
    // throws on a missing module would take the whole pill down with it, so the
    // portal is optional and the panel renders inline without it.
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch (error) {
      console.warn('[dsh-dcp] react-dom unavailable; the detail panel will not be portaled', error)
    }
    const h = React.createElement

    const NS = 'dsh-dcp'
    const PROJECTION_KEY = 'dcp'

    /** Copy for the pill and its detail panel. */
    const COPY = {
      zh: {
        'pill.blocks': '{count} 段已压缩',
        'pill.absorbed': '{count} 段已合并',
        'pill.prunes': '清理 {count} 次（{tokens} tok）',
        'pill.tip': 'dsh-dcp 本会话的压缩与清理；点击查看明细，输入 /dcp-compact 立即压缩一次',
        'panel.title': 'DCP 上下文',
        'panel.blocks': '活跃压缩块',
        'panel.absorbed': '已合并',
        'panel.blockTokens': '压缩收起',
        'panel.prunes': '清理工具输出',
        'panel.prunedTokens': '清理 tokens',
        // Not "nudges": the projection counts EVERY DCP notice (src/projection.ts
        // increments on any DCP-source user message), and in practice they are
        // the prune notices. The wire field keeps its name; the label cannot
        // claim more than the number says.
        'panel.notices': '通知次数',
        'settings.title': 'DCP 上下文',
        'form.unavailable': '该插件当前未加载，暂时无法配置。',
        'form.unbound': '设置页未能绑定到配置表单，请把这条消息报告给插件作者。',
        'form.readOnly': '本部署的设置为只读。',
        'form.saveFailed': '本部署没有接受这些值，已保留供你修改。',
        'group.nudge': '提醒与手动模式',
        'group.dedup': '去重与清理',
        'group.compact': '压缩',
        'group.experimental': '实验性',
        'field.manualMode.enabled.label': '手动模式',
        'field.manualMode.enabled.hint': '停止主动提醒，只在明确要求时压缩。',
        'field.manualMode.automaticStrategies.label': '手动模式下仍自动去重',
        'field.manualMode.automaticStrategies.hint': '保留去重；它不替模型下判断。',
        'field.strategies.deduplication.enabled.label': '去重',
        'field.strategies.deduplication.enabled.hint': '把被后续调用取代的工具输出换成占位符。',
        'field.compaction.nudgeFrequency.label': '提醒间隔',
        'field.compaction.nudgeFrequency.hint': '每多少个节点最多注入一次上下文上限提醒。',
        'field.turnProtection.enabled.label': '保护最近的轮次',
        'field.turnProtection.enabled.hint': '不把最新的几轮列入清理候选。',
        'field.turnProtection.turns.label': '保护的轮数',
        'field.turnProtection.turns.hint': '保护多少轮。',
        'field.pruneNotification.label': '清理通知',
        'field.pruneNotification.hint': '清理后是否向模型报告：不报告，或一行计数。',
        'field.compaction.minContextLimit.label': '弱提醒阈值',
        'field.compaction.minContextLimit.hint': '低于它完全不提醒；它到强提醒阈值之间是弱提醒，只说“可以考虑压缩”。填绝对 token 数，或 “80%” 这样的百分比。',
        'field.compaction.maxContextLimit.label': '强提醒阈值',
        'field.compaction.maxContextLimit.hint': '高于它转为强提醒，要求立刻跑一次压缩。同样接受 token 数或百分比。',
        'field.compaction.protectUserMessages.label': '逐字保留用户消息',
        'field.compaction.protectUserMessages.hint': '用户消息原样保留；粘贴的大段提示词因此不会被压掉。',
        'field.experimental.allowSubAgents.label': '也压缩子代理会话',
        'field.experimental.allowSubAgents.hint': '让 DCP 处理子代理的会话。',
        'field.experimental.customPrompts.label': '自定义提示词',
        'field.experimental.customPrompts.hint': '启用 $DSH_HOME/dcp-prompts/ 下的提示词覆盖；开关与覆盖文件的改动即时生效（提醒文案与工具描述都会跟着换）。',
        'choice.off': '不报告',
        'choice.minimal': '一行',
      },
      en: {
        'pill.blocks': '{count} compacted',
        'pill.absorbed': '{count} absorbed',
        'pill.prunes': '{count} pruned ({tokens} tok)',
        'pill.tip': 'dsh-dcp compaction and pruning for this session; click for details, type /dcp-compact to compact now',
        'panel.title': 'DCP context',
        'panel.blocks': 'Active blocks',
        'panel.absorbed': 'Absorbed',
        'panel.blockTokens': 'Held by summaries',
        'panel.prunes': 'Tool outputs pruned',
        'panel.prunedTokens': 'Pruned tokens',
        'panel.notices': 'Notices',
        'settings.title': 'DCP context',
        'form.unavailable': 'This plugin is not loaded, so it cannot be configured right now.',
        'form.unbound': 'The settings page could not bind to its form; please report this message.',
        'form.readOnly': 'Settings are read-only in this deployment.',
        'form.saveFailed': 'This deployment did not accept these values; they were kept for you to correct.',
        'group.nudge': 'Nudges and manual mode',
        'group.dedup': 'Deduplication and pruning',
        'group.compact': 'Compaction',
        'group.experimental': 'Experiments',
        'field.manualMode.enabled.label': 'Manual mode',
        'field.manualMode.enabled.hint': 'Stop nudging; compact only when explicitly asked.',
        'field.manualMode.automaticStrategies.label': 'Keep deduplicating in manual mode',
        'field.manualMode.automaticStrategies.hint': 'Deduplication keeps running; it makes no judgement calls.',
        'field.strategies.deduplication.enabled.label': 'Deduplication',
        'field.strategies.deduplication.enabled.hint': 'Replace tool output a later call superseded with a placeholder.',
        'field.compaction.nudgeFrequency.label': 'Nudge interval',
        'field.compaction.nudgeFrequency.hint': 'Inject the context-limit nudge at most once every this many nodes.',
        'field.turnProtection.enabled.label': 'Protect recent turns',
        'field.turnProtection.enabled.hint': 'Keep the newest turns out of the pruning candidates.',
        'field.turnProtection.turns.label': 'Protected turns',
        'field.turnProtection.turns.hint': 'How many turns stay protected.',
        'field.pruneNotification.label': 'Prune notice',
        'field.pruneNotification.hint': 'Whether a prune pass reports itself to the model: nothing, or the count on one line.',
        'field.compaction.minContextLimit.label': 'Weak nudge threshold',
        'field.compaction.minContextLimit.hint': 'Below it nothing nudges. Between it and the strong threshold the model only gets a weak nudge — compaction may be worth considering. An absolute token count, or a percentage like "80%".',
        'field.compaction.maxContextLimit.label': 'Strong nudge threshold',
        'field.compaction.maxContextLimit.hint': 'Above it the nudge turns strong and asks for a compaction pass right away. Takes a token count or a percentage too.',
        'field.compaction.protectUserMessages.label': 'Keep user messages verbatim',
        'field.compaction.protectUserMessages.hint': 'User messages are preserved word for word, so a large pasted prompt never compresses away.',
        'field.experimental.allowSubAgents.label': 'Compact subagent sessions too',
        'field.experimental.allowSubAgents.hint': 'Let DCP handle a subagent session as well.',
        'field.experimental.customPrompts.label': 'Custom prompts',
        'field.experimental.customPrompts.hint': 'Enable prompt overrides under $DSH_HOME/dcp-prompts/. Turning it on, or editing an override file, applies immediately — reminder texts and tool descriptions both follow.',
        'choice.off': 'Nothing',
        'choice.minimal': 'One line',
      },
    }

    /**
     * Rules for the pill and its panel.
     *
     * The pill repeats `StatsPills.module.css`; the panel repeats
     * `stat-dialog.module.css`, the skin the host's other stat pills open into,
     * so this reads as one more member of that row rather than a visitor.
     *
     * Four of these rules are contracts rather than taste:
     * - `corner-shape:round` pairs `border-radius:999px`. The theme broadcasts
     *   `corner-shape:superellipse(1.5)` to `*,:before,:after`
     *   (ui-theme/lib/client.js:1145), so a pill radius without the pairing is
     *   deformed by it; the host's own pill carries both
     *   (ui-chat/lib/client.js:6893).
     * - Focus rings ride the theme's tokens, `--dsw-focus-ring-width` and
     *   `--dsw-focus-ring-color` (ui-theme/lib/client.js:1151). The colour is
     *   the theme's switch: it is set to `transparent` for pointer input, so a
     *   hardcoded colour would light a ring the theme asked to suppress.
     * - The label shrinks and ellipsizes the way the host's does: `min-width:0`
     *   plus `max-width:100%` on the root and `text-overflow:ellipsis` on the
     *   label (ui-chat/lib/client.js:6893). Without them a long readout in a
     *   narrow dock pushes the context meter out of the row.
     * - The invalid line is the host's own settings error skin
     *   (ui-primitives/lib/settings-form/fields.module.css line 133).
     */
    const STYLES = `
/* The pill family is the stats pill, on purpose: this dock row also carries the
   host's own counting pill (241M tok, cache hit) and this component is the same
   kind of thing. The context meter's trigger next to it is a different family
   (radius-sm and no -1px on the font), and that difference was reviewed and kept
   — the counting neighbour is the one this has to sit beside. */
.dsh-dcp-root{display:inline-flex;align-items:center;box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.dsh-dcp-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;corner-shape:round;max-width:100%;padding:1px 8px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}
.dsh-dcp-pill:hover,.dsh-dcp-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-dcp-pill svg{width:14px;height:14px;flex:none}
.dsh-dcp-label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.dsh-dcp-panel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));overflow:auto;padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default}
.dsh-dcp-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-dcp-titleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dsh-dcp-titleLabel svg{width:14px;height:14px;flex:none}
.dsh-dcp-titleValue{font-variant-numeric:tabular-nums}
.dsh-dcp-rule{margin-bottom:10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-dcp-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}
.dsh-dcp-details dt,.dsh-dcp-details dd{min-width:0;margin:0}
/* The detail values are brighter than the host's stat-dialog, and right-aligned,
   on purpose: that dialog lists route and reasoning, while these are the figures
   the panel exists to show (blocks, prunes, reclaimed tokens). Everything else in
   the panel — padding, line-height, width policy, the title and rule rules — is
   that dialog's own. */
.dsh-dcp-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
/* The input controls take the harness's own numeric-control width: its
   FontSizeRow stepper is min-width:72px; height:36px on the same module
   surface (ui-theme, its _stepper rule), and this card already copies the rest
   of that row's metrics. The choice button is deliberately NOT included: the
   harness sizes its own selectors to their label, because a 72px pill cannot
   hold "One line" plus a chevron. (No backticks in this sheet: it is one
   template literal.) */
.dsh-dcp-form{--dsh-dcp-control-width:72px;display:flex;flex-direction:column}
/* Row metrics are the Harness's own settings rows: ui-theme's FontSizeRow and
   ui-permission-presets' PermissionRow, which every General-settings row
   repeats. The controls are filled pills on the module surface, not bordered
   inputs. */
.dsh-dcp-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dsh-dcp-row:last-child{border-bottom:none}
.dsh-dcp-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}
.dsh-dcp-rowLabel{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-dcp-rowControl{display:inline-flex;align-items:center;gap:8px}
.dsh-dcp-hint{margin:0;font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* One group of settings. The heading is the host's own: 13px/600 in the
   primary label colour (ui-settings-subagent/lib/client.js, its _heading rule).
   No backticks in here — this whole sheet is one template literal. */
.dsh-dcp-group{display:flex;flex-direction:column;margin:0}
.dsh-dcp-group+.dsh-dcp-group{margin-top:24px}
.dsh-dcp-groupTitle{color:var(--dsw-alias-label-primary);margin:0 0 4px;font-size:13px;font-weight:600;line-height:1.5}
/* A row none of whose switches can take effect right now. The control is
   disabled by its own primitive; the text steps down one token each so the row
   reads as one thing rather than a live label over a dead switch. */
.dsh-dcp-row[data-inert="true"] .dsh-dcp-rowLabel{color:var(--dsw-alias-label-secondary)}
.dsh-dcp-row[data-inert="true"] .dsh-dcp-hint{color:var(--dsw-alias-label-caption)}
/* A write the Host did not keep: the same red the settings fields module uses. */
.dsh-dcp-invalid{margin:0;font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dsh-dcp-control{box-sizing:border-box;height:36px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
/* The theme's own focus ring, parameters and all: the same width token, the same
   colour token and fallback, and no offset (the theme's :focus-visible rule sets
   colour and width only). The rule exists because the theme suppresses the ring
   for pointer input on everything that is not :read-write, which is every control
   here except the text fields. */
.dsh-dcp-control:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
/* A free-text value at the stepper's width, with no padding — exactly the
   harness's own _value rule, whose 72px stepper leaves the whole box to the
   text. Seven digits of token count fit; a longer value scrolls, as it would in
   the harness's own field. */
.dsh-dcp-text{width:var(--dsh-dcp-control-width,72px);text-align:center}
/* A disabled control keeps its shape and loses its contrast, which is what the
   harness's own disabled controls do (ui-theme, its arrow rule). Only the Switch
   looked disabled before this: that one is a primitive that styles itself, while
   the number input and the select are markup this bundle draws and were merely
   inert. Being unable to act is not the same as looking unable to act. */
.dsh-dcp-control:disabled,.dsh-dcp-value:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.dsh-dcp-stepper{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:var(--dsh-dcp-control-width,72px);min-width:var(--dsh-dcp-control-width,72px);height:36px;padding:0 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.dsh-dcp-value{box-sizing:border-box;min-width:18px;padding:0;border:none;background:transparent;text-align:center;font:inherit;font-size:14px;line-height:22px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsh-dcp-value:focus{outline:none}
/* The host marks a rejected draft on the input itself as well
   (ui-primitives/lib/settings-form/fields.module.css line 129). */
.dsh-dcp-value[aria-invalid="true"]{color:var(--dsw-alias-state-error-primary)}
.dsh-dcp-stepper:focus-within{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
/* The choice button is the harness's own selector, copied whole: the permission
   row's selector in General settings (ui-permission-presets) is
   height:36px; border-radius:radius-md; background:bg-module-platform;
   gap:12px; padding:0 14px; font-size:14px; line-height:22px; display:inline-flex
   with the same hover rule, and it fixes the two numbers this rule needs: the
   box is content-sized, so without the gap the chevron touches the label, and
   without the padding the label sits on the rounded edge. */
.dsh-dcp-select{display:inline-flex;align-items:center;gap:12px;box-sizing:border-box;padding:0 14px;cursor:pointer}
.dsh-dcp-select svg{flex:none}
.dsh-dcp-select:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
`

    /**
     * Install the rules once per document, the way every host bundle does it.
     *
     * The host injects one `<style>` per module from module scope, keyed by a
     * `data-plugin-css` id it checks first (ui-chat/lib/client.js:6894). Rules
     * rendered as React children instead would mount a second copy of the sheet
     * for the panel's separate subtree and would carry no owner for the host's
     * dedupe, HMR, and DevTools attribution to key on.
     *
     * Guarded for a page with no DOM at all, and for the partial `document` a
     * smoke test or a pre-render pass hands the bundle — that is what the
     * bundle is evaluated against outside a browser, and it must not throw
     * before the plugin ever mounts. The guard is a capability check rather
     * than the old `createElement`-only probe: a document that can mint a
     * `<style>` but cannot be queried (`querySelector`) or cannot take a child
     * (`head.appendChild`) threw out of the factory, which takes the whole
     * browser half down over decoration. The sheet is decoration, so every
     * missing capability degrades to "no sheet" instead.
     */
    const STYLE_ID = `${NS}/client.css`
    let stylesInstalled = false
    function ensureStyles() {
      if (stylesInstalled) return
      const doc = typeof document === 'undefined' ? undefined : document
      if (doc === undefined || doc === null) return
      if (typeof doc.createElement !== 'function' || typeof doc.querySelector !== 'function') return
      if (doc.head === undefined || doc.head === null || typeof doc.head.appendChild !== 'function') return
      stylesInstalled = true
      const tagId = STYLE_ID
      if (doc.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
      const tag = doc.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = tagId
      tag.textContent = STYLES
      doc.head.appendChild(tag)
    }
    ensureStyles()

    /** Interpolate `{name}` placeholders without pulling in a formatter. */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
    }

    /**
     * Abbreviate a token count the way the neighbouring pills do.
     *
     * A missing value is reported rather than rendered: the browser half is
     * refreshed by a page load while the host half needs a plugin reload, so a
     * newer client can legitimately meet an older wire payload, and `NaN` is
     * never an acceptable thing to show.
     */
    function formatTokens(tokens) {
      if (!Number.isFinite(tokens)) return '—'
      if (tokens < 1000) return String(tokens)
      if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}K`
      return `${(tokens / 1_000_000).toFixed(1)}M`
    }

    /**
     * A count as text.
     *
     * `String(undefined)` is the literal "undefined", and a wire payload that
     * predates a count field is exactly the version skew the formatter above
     * exists for. An unknown figure is reported as unknown instead of printed.
     */
    function formatCount(count) {
      return Number.isFinite(count) ? String(count) : '—'
    }

    /** Viewport margin the placement clamp keeps; the host's own panels use 12. */
    const PANEL_MARGIN = 12
    /** Distance kept between the pill's top edge and the panel's bottom (host: 8). */
    const PANEL_GAP = 8
    /** Design cap for the panel's height; the viewport clamp only lowers it. */
    const PANEL_MAX_HEIGHT = 420
    /** Unplaced panel: hidden but laid out, so the clamp measures real dimensions. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }

    /**
     * The detail panel, portaled to the viewport.
     *
     * The host's own stat pills portal for the same reason: an inline fixed
     * child would be trapped by whichever ancestor creates a containing block
     * (the composer card carries `backdrop-filter`), so anchoring would drift.
     *
     * Placement is the host primitive's job, not this file's: it clamps both
     * axes, keeps the frame's top clearance, and re-measures on scroll (capture
     * phase), on resize, and on the panel's own size changes
     * (ui-primitives/lib/index.js:4459-4510). The last one is what a hand-rolled
     * effect missed — a label that grows when the readout or the locale changes
     * re-clamped against the previous width. The height cap comes from the
     * sibling primitive (ui-primitives/lib/index.js:4418), which folds in the
     * frame's top chrome so a tall panel cannot slide under it.
     */
    function DetailPanel(props) {
      const t = props.t
      const view = props.view
      const anchorRef = props.anchorRef
      const ref = React.useRef(null)
      const placement = primitives.useAnchoredPosition({
        open: true,
        anchorRef,
        panelRef: ref,
        side: 'top',
        gap: PANEL_GAP,
        margin: PANEL_MARGIN,
      })
      const maxHeight = primitives.useAnchoredMaxHeight(ref, PANEL_MAX_HEIGHT, placement, PANEL_MARGIN)

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') props.onClose() }
        const onDown = (event) => {
          if (ref.current?.contains(event.target)) return
          if (anchorRef.current?.contains(event.target)) return
          props.onClose()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onDown, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onDown, true)
        }
      }, [anchorRef, props.onClose])

      // The two token figures are deliberately adjacent and separately
      // labelled: one is what compaction holds in summaries, the other is what
      // the strategies removed outright. They are different mechanisms and
      // differ by orders of magnitude.
      //
      // The payload is read by SHAPE, not just by number: the browser half is
      // refreshed by a page load while the host half needs a plugin reload, so
      // a newer client can legitimately meet an older wire payload. A missing
      // `blocks` used to throw out of the slot entry — the host's error
      // boundary then blanked the whole readout over decoration.
      const blocks = Array.isArray(view.blocks) ? view.blocks : []
      // A block whose own count is missing makes the SUM unknown, not zero:
      // `formatTokens` reports the unknown figure, while adding it as 0 would
      // quietly understate what the summaries hold.
      const heldTokens = blocks.reduce((sum, block) => sum + (Number.isFinite(block?.tokens) ? block.tokens : NaN), 0)
      const rows = [
        [t('panel.blocks'), formatCount(blocks.length)],
        [t('panel.absorbed'), formatCount(view.absorbed)],
        [t('panel.blockTokens'), formatTokens(heldTokens)],
        [t('panel.prunes'), formatCount(view.prunes)],
        [t('panel.prunedTokens'), formatTokens(view.prunedTokens)],
        [t('panel.notices'), formatCount(view.notices)],
      ]

      const panel = h('div', {
        ref,
        className: 'dsh-dcp-panel',
        role: 'dialog',
        'aria-label': t('panel.title'),
        style: placement === null ? MEASURE_STYLE : { ...placement, maxHeight },
      },
      h('div', { className: 'dsh-dcp-title' },
        h('span', { className: 'dsh-dcp-titleLabel' }, h(primitives.IconArchiveOutlineRegular), t('panel.title')),
        h('span', { className: 'dsh-dcp-titleValue' }, fill(t('pill.blocks'), { count: blocks.length }))),
      // A divider carries no meaning to a screen reader; the host marks its own
      // the same way (ui-chat/lib/client.js:6487-6490).
      h('div', { className: 'dsh-dcp-rule', 'aria-hidden': true }),
      h('dl', { className: 'dsh-dcp-details' },
        rows.flatMap(([label, value]) => [h('dt', { key: `${label}-t` }, label), h('dd', { key: `${label}-d` }, value)])))

      if (ReactDOM === null || typeof ReactDOM.createPortal !== 'function') return panel
      return ReactDOM.createPortal(panel, document.body)
    }

    /** Portal an overlay to the viewport when react-dom can, else render in place. */
    function mountOverlay(node) {
      if (ReactDOM === null || typeof ReactDOM.createPortal !== 'function') return node
      return ReactDOM.createPortal(node, document.body)
    }

    /**
     * The composer-band pill.
     *
     * It owns the `useProjection` call so its hook order stays stable; the
     * wrapper below decides whether that hook exists at all. It renders nothing
     * for a session with no DCP activity, so the band never carries a zero.
     */
    function ReadoutBody(props) {
      const t = props.t
      const view = props.useProjection(PROJECTION_KEY)
      const [open, setOpen] = React.useState(false)
      const anchorRef = React.useRef(null)

      if (view === undefined || view === null) return null
      // Shape first, numbers second: an older wire payload (or a host half that
      // has not been reloaded) may omit `blocks` entirely, and the readout must
      // degrade to "nothing to show" rather than throw the slot entry into the
      // host's error boundary.
      const blocks = Array.isArray(view.blocks) ? view.blocks : []
      const parts = []
      if (blocks.length > 0) parts.push(fill(t('pill.blocks'), { count: blocks.length }))
      if (Number.isFinite(view.absorbed) && view.absorbed > 0) parts.push(fill(t('pill.absorbed'), { count: view.absorbed }))
      if (Number.isFinite(view.prunes) && view.prunes > 0) {
        parts.push(fill(t('pill.prunes'), { count: view.prunes, tokens: formatTokens(view.prunedTokens) }))
      }
      // A session with no DCP activity renders nothing at all, so the band
      // never carries a zero.
      if (parts.length === 0) return null

      const label = parts.join(' · ')
      return h('span', { className: 'dsh-dcp-root', ref: anchorRef },
        // Matched to the context meter beside it: same side, same delay, and
        // the same `disabled` while the surface is open — a tip must not sit
        // over the dialog it describes (ui-conversation/lib/client.js:17045-17051).
        h(primitives.Tooltip, { label: t('pill.tip'), side: 'top', delayMs: 200, disabled: open },
          // The readout is one nowrap string, so it gets the host's own
          // shrink-and-ellipsize span instead of a bare text node
          // (ui-chat/lib/client.js:7006,7084 with the root's `min-width:0`).
          h('button', {
            type: 'button',
            className: 'dsh-dcp-pill',
            // Every trigger in this band names itself and says what it opens
            // (ui-chat/lib/client.js:7026-7028, ui-conversation/lib/client.js:17045-17052).
            'aria-label': label,
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => { setOpen((value) => !value) },
          }, h(primitives.IconArchiveOutlineRegular), h('span', { className: 'dsh-dcp-label' }, label))),
        open ? h(DetailPanel, { t, view, anchorRef, onClose: () => { setOpen(false) } }) : null)
    }

    /** Readout used when this client build exposes no projection hook. */
    function ReadoutFallback() {
      return null
    }

    /** Choose a readout shape at render time so the hook call stays unconditional. */
    function Readout(props) {
      if (typeof props.useProjection !== 'function') return h(ReadoutFallback, props)
      return h(ReadoutBody, props)
    }


    /**
     * The Plugins-page settings card.
     *
     * The Host serves a namespace only for the fields a plugin marked
     * `.volatile()`, and a volatile write is applied without remounting — so
     * this card lists exactly the fields the plugin reads at use time. A field
     * decided during `apply()` (tool registration) is deliberately absent:
     * saving it there would look accepted and change nothing.
     */
    const SETTINGS_NS = 'dsh-dcp'

    /**
     * The card's fields, in page order, grouped under the headings they read under.
     *
     * `min` and `step` restate what the schema already says about the numeric
     * fields — `z.number().step(1).min(1)` (src/config.ts:131,169,171) — so
     * the draft is judged here instead of being sent to be refused there. They
     * are a copy, like `fallback`, and the copy is the price of a browser half
     * that has no build step and cannot import the schema.
     */
    const SETTINGS_FIELDS = [
      { field: 'manualMode.enabled', kind: 'switch' },
      { field: 'manualMode.automaticStrategies', kind: 'switch' },
      { field: 'strategies.deduplication.enabled', kind: 'switch' },
      { field: 'pruneNotification', kind: 'choice', choices: ['off', 'minimal'] },
      { field: 'compaction.nudgeFrequency', kind: 'number', fallback: '5', min: 1, step: 1 },
      { field: 'turnProtection.enabled', kind: 'switch' },
      { field: 'turnProtection.turns', kind: 'number', fallback: '4', min: 1, step: 1 },
      { field: 'compaction.minContextLimit', kind: 'text', fallback: '33%' },
      { field: 'compaction.maxContextLimit', kind: 'text', fallback: '67%' },
      { field: 'compaction.protectUserMessages', kind: 'switch' },
      { field: 'experimental.allowSubAgents', kind: 'switch' },
      { field: 'experimental.customPrompts', kind: 'switch' },
    ]

    /**
     * The settings, grouped by what moves together.
     *
     * This is the render order, and the only one: `SETTINGS_FIELDS` stays a
     * metadata table. Grouping is how the dependencies are stated — a switch and
     * the rows it gates sit under one heading, so the reader sees which rows
     * answer to which switch without a sentence telling them. That is what the
     * `ROW_REQUIRES` greying below is for as well; the two say the same thing,
     * one by position and one by state.
     *
     * `nudge`: the thresholds that decide whether to nudge at all, the two
     * nudges themselves, and the manual mode that silences all four.
     * `dedup`: deduplication, the protection that narrows it, and the notice it
     * posts — all four are dead while deduplication is off.
     * `compact`: what a compaction keeps.
     * `experimental`: the opt-in behaviours.
     */
    const SETTINGS_GROUPS = [
      { id: 'nudge', fields: [
        'compaction.minContextLimit',
        'compaction.maxContextLimit',
        'compaction.nudgeFrequency',
        'manualMode.enabled',
        'manualMode.automaticStrategies',
      ] },
      { id: 'dedup', fields: [
        'strategies.deduplication.enabled',
        'turnProtection.enabled',
        'turnProtection.turns',
        'pruneNotification',
      ] },
      { id: 'compact', fields: [
        'compaction.protectUserMessages',
      ] },
      { id: 'experimental', fields: [
        'experimental.allowSubAgents',
        'experimental.customPrompts',
      ] },
    ]

    /**
     * Which rows can take effect at all, given the rest of the configuration.
     *
     * Two switches gate five rows, and a row that cannot do anything is shown
     * disabled rather than hidden: the control stays where the reader last saw
     * it and says by its state that it is not the one to reach for, instead of
     * disappearing and leaving them to wonder where it went.
     *
     *   · `manualMode.automaticStrategies` is read at src/strategies/index.ts:229,
     *     behind a caller that has already returned when deduplication is off
     *     (src/index.ts:746) and behind a manual-mode check of its own. It is
     *     therefore inert in every combination but one — including the shipped
     *     default, where manual mode is off.
     *   · `turnProtection` is read only by `isShielded` (src/strategies/index.ts:190),
     *     whose only caller is the deduplication strategy.
     *   · Manual mode returns null from the nudges before either nudge field is
     *     read (src/nudges.ts:103), so both are inert while it is on.
     *
     * Each predicate takes one argument — a `switchOn(field)` resolver — and
     * refers to nothing else, so the test can lift this table out of the source
     * and exercise it (tests/client.test.ts).
     */
    const ROW_REQUIRES = {
      'manualMode.automaticStrategies':
        (on) => on('manualMode.enabled') && on('strategies.deduplication.enabled'),
      // Both limits are read in the nudge itself (src/nudges.ts:61-62), and
      // manual mode returns null before either is reached.
      'compaction.maxContextLimit': (on) => !on('manualMode.enabled'),
      'compaction.minContextLimit': (on) => !on('manualMode.enabled'),
      'compaction.nudgeFrequency': (on) => !on('manualMode.enabled'),
      'turnProtection.enabled': (on) => on('strategies.deduplication.enabled'),
      'turnProtection.turns':
        (on) => on('strategies.deduplication.enabled') && on('turnProtection.enabled'),
      // The notice follows a prune that happened (src/index.ts:766), and prunes
      // only come from deduplication.
      'pruneNotification': (on) => on('strategies.deduplication.enabled'),
    }

    /**
     * The schema default of each switch the row conditions read.
     *
     * Mirrored from src/config.ts for the same reason `fallback` is mirrored on
     * the numeric rows: this half has no build step and cannot import the schema.
     * It matters because the snapshot carries what the section has STORED, so a
     * field nobody wrote reads as absent — and absent means the schema default,
     * not off. Reading absence as `false` would grey out three rows on a fresh
     * install, where `strategies.deduplication.enabled` ships `true`.
     */
    const SWITCH_DEFAULTS = {
      'manualMode.enabled': false,
      'strategies.deduplication.enabled': true,
      'turnProtection.enabled': false,
    }

    /** Whether one switch is effectively on: what is stored, or its default. */
    function switchOn(state, field) {
      const stored = state[field] === undefined ? undefined : state[field].value
      if (stored !== undefined && stored !== null) return stored === true
      return SWITCH_DEFAULTS[field] === true
    }

    /** The DOM id one field's control carries, when it carries one. */
    function fieldId(entry) {
      return `dsh-dcp-${entry.field.replace(/\./g, '-')}`
    }

    /** Read one field's value out of a snapshot layer by its real path. */
    function readPath(layer, path) {
      let node = layer
      for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[key]
      }
      return node
    }

    /**
     * The value one field's draft text writes.
     *
     * A number is judged against the field's `min`/`step` before it is sent:
     * `Number.isFinite` alone let `0`, `-3`, and `1.7` through to a Host that
     * refuses all three, and a refusal the card can predict is a refusal it
     * should show without the round trip.
     *
     * @returns the value to set, `null` for a clear, or undefined when the text
     *   is not a value this field accepts.
     */
    function parseValue(entry, text) {
      if (entry.kind === 'switch') {
        return text === 'true' ? true : text === 'false' ? false : undefined
      }
      if (entry.kind === 'choice') return entry.choices.includes(text) ? text : undefined
      if (entry.kind === 'text') {
        const trimmed = text.trim()
        if (trimmed === '') return null
        // Mirrors `limitSchema` (src/config.ts): an absolute token count, or a
        // percentage of the routed model's context window. Both shapes are what
        // `resolveLimit` accepts, and the Host refuses everything else — so
        // refuse it here rather than spend a round trip being told.
        //
        // The percentage half has to be exactly as wide as the schema's
        // `/^\s*\d+(?:\.\d+)?\s*%\s*$/`: it allows whitespace between the
        // number and the `%`, and `resolveLimit` reads it that way too, so
        // refusing `80 %` here rejected a value the Host would have stored.
        // (The outer `\s*` of the schema pattern is already spent by `trim`.)
        if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
        if (/^\d+(?:\.\d+)?\s*%$/.test(trimmed)) return trimmed
        return undefined
      }
      if (text.trim() === '') return null
      const value = Number(text)
      if (!Number.isFinite(value)) return undefined
      if (entry.min !== undefined && value < entry.min) return undefined
      if (entry.step !== undefined && Math.abs(value % entry.step) > 1e-9) return undefined
      return value
    }

    /**
     * Bridge one namespace scope onto the page.
     *
     * Reads go through `SettingsFormModel`, writes do not. The model turns a
     * field name into a ONE-segment write path (`path: [field]`), so a nested
     * name like `compaction.nudgeFrequency` reached the Host as a single
     * literal key, failed its `isVolatilePath` check, and every save was
     * refused. `scope.mutate` takes real path arrays, which is what the
     * namespace sections actually are.
     */
    function SettingsCardController(scope) {
      this.scope = scope
      this.form = new primitives.SettingsFormModel(scope, [])
      // Field values come from the snapshot by path: the model addresses a
      // field as one top-level key, so a nested name read back as absent and
      // the page fell back to its hardcoded default.
      this.store = this.form.bind(() => {
        const snapshot = this.scope.getSnapshot()
        const shell = this.form.shell()
        const state = {
          available: snapshot.status === 'ready',
          writable: snapshot.writable === true,
          failed: shell.failed,
        }
        for (const entry of SETTINGS_FIELDS) {
          const path = entry.field.split('.')
          const stored = readPath(snapshot.value, path)
          state[entry.field] = {
            text: stored === undefined || stored === null ? '' : String(stored),
            overridden: readPath(snapshot.user, path) !== undefined,
            invalid: false,
            // The raw stored value too: `text` flattens absence and `false` to
            // the same empty string, and the row conditions must tell them apart.
            value: stored,
          }
        }
        return state
      })
    }

    /**
     * Write one field, addressed by its real path inside the section.
     *
     * @returns whether the Host kept the value.
     */
    SettingsCardController.prototype.write = function write(field, text) {
      const entry = SETTINGS_FIELDS.find((candidate) => candidate.field === field)
      if (entry === undefined) return Promise.resolve(false)
      const value = parseValue(entry, text)
      if (value === undefined) {
        console.error('[dsh-dcp] not a value this field accepts:', field, JSON.stringify(text))
        return Promise.resolve(false)
      }
      const path = field.split('.')
      // `unset`, not `clear`: the Host's wire union is `{op:'set'|'unset'}`
      // (dsh-settings types.d.ts, `SettingsPathOpView`). `clear` only ever
      // worked because the Host's implementation special-cases `set` and lets
      // every other spelling fall into the unset branch — a strict wire
      // validation would have turned every clear into a refusal.
      const op = value === null
        ? { op: 'unset', path }
        : { op: 'set', path, value }
      return this.scope.mutate([op]).then((accepted) => {
        if (accepted !== true) {
          console.error('[dsh-dcp] the Host refused', field, text)
          return false
        }
        // Write, then read the value back, exactly as the host's own account
        // form verifies a save (ui-settings-account/lib/client.js:3208-3210).
        // The Host is the only authority on whether a value landed, and
        // `mutate` folds the accepted view into the snapshot before it
        // resolves (ui-settings/lib/client.js:1186-1192), so the read-back is
        // this write's answer and not a race. The user layer is the one a write
        // lands in; the resolved section carries composition and defaults on
        // top of it, so a clear would compare against a default there.
        //
        // A snapshot with NO user layer is absence of evidence, not evidence of
        // refusal: comparing against it marked every field `aria-invalid` and
        // rendered "save failed" for a write the Host had accepted. Only a
        // readable layer that disagrees is a verdict.
        const snapshot = this.scope.getSnapshot()
        const user = snapshot.user
        if (user === undefined || user === null) return true
        const saved = readPath(user, path)
        // A clear does not mean "the user layer no longer names the field". A
        // field the composed base already carries is INHERITED, not absent, so
        // the Host writes the inherited value back into the user layer
        // (dsh-settings' non-`set` branch). The verdict has to ask the question
        // that matters — does the user layer still hold an override of its own?
        // — which is true when the stored value is gone, or when it is exactly
        // what the layer below already said. Comparing against `undefined`
        // alone reported "save failed" for every accepted clear of a field a
        // profile had set.
        const kept = value === null
          ? saved === undefined || saved === readPath(snapshot.base, path)
          : saved === value
        if (!kept) console.error('[dsh-dcp] the Host did not keep', field, text)
        return kept
      }).catch((error) => {
        // The card treats anything but `true` as a refusal, so this promise must
        // not reject: an unhandled rejection here would leave the control showing
        // a value with no verdict at all.
        console.error('[dsh-dcp] the write failed', field, error)
        return false
      })
    }

    /**
     * The face the page's slot registration injects.
     *
     * `write` hands back its verdict rather than dropping it: the card cannot
     * learn about a refused write any other way, because a refusal leaves the
     * Host snapshot it was refused against untouched.
     */
    SettingsCardController.prototype.inject = function inject() {
      return {
        hooks: { dcpSettings: this.store },
        write: (field, text) => this.write(field, text),
      }
    }

    /** Release accepted-value subscriptions. */
    SettingsCardController.prototype.dispose = function dispose() {
      this.form.dispose()
    }

    /**
     * A count, as a filled pill holding an editable value.
     *
     * The Harness's own stepper shows a display-only value with hover arrows;
     * this one is a text field instead. The arrows were removed deliberately:
     * an absolutely positioned overlay beside a form control lost every click
     * in the browser, and no local test could observe that. Typing commits on
     * Enter or on leaving the field.
     */
    function NumberControl(props) {
      const { entry, field, disabled, invalid, t, onCommit } = props
      const value = field.text === '' ? entry.fallback : field.text
      return h('div', { className: 'dsh-dcp-stepper' },
        h('input', {
          id: fieldId(entry),
          className: 'dsh-dcp-value',
          type: 'text',
          inputMode: 'numeric',
          'aria-label': t(`field.${entry.field}.label`),
          // The host marks the control a rejected draft is sitting in
          // (ui-primitives/lib/settings-form/fields.module.css line 129).
          'aria-invalid': invalid === true ? 'true' : undefined,
          size: Math.max(2, value.length),
          defaultValue: value,
          key: `${field.text}#${entry.fallback}`,
          disabled,
          onBlur: (event) => { if (event.target.value !== value) onCommit(event.target.value) },
          onKeyDown: (event) => {
            if (event.key === 'Enter' && event.currentTarget.value !== value) onCommit(event.currentTarget.value)
          },
        }))
    }

    /**
     * A free-text value.
     *
     * The two limit fields take either an absolute token count or a percentage
     * — `100000` or `"80%"` — so the stepper used for plain numbers cannot carry
     * them: there is no step to take, and the value's shape is whatever was
     * typed. The row still labels an input that exists, so it gets a real
     * `<label htmlFor>` like the numeric one.
     */
    function TextControl(props) {
      const { entry, field, disabled, invalid, t, onCommit } = props
      const value = field.text === '' ? entry.fallback : field.text
      return h('input', {
        id: fieldId(entry),
        className: 'dsh-dcp-control dsh-dcp-text',
        type: 'text',
        'aria-label': t(`field.${entry.field}.label`),
        'aria-invalid': invalid === true ? 'true' : undefined,
        size: Math.max(2, value.length),
        defaultValue: value,
        key: `${field.text}#${entry.fallback}`,
        disabled,
        onBlur: (event) => { if (event.target.value !== value) onCommit(event.target.value) },
        onKeyDown: (event) => {
          if (event.key === 'Enter' && event.currentTarget.value !== value) onCommit(event.currentTarget.value)
        },
      })
    }

    /**
     * A finite choice, opened as the Harness's own menu.
     *
     * A native `<select>` opens the operating system's list, which no theme
     * reaches; `Menu` is the primitive the Harness's settings rows use.
     */
    function ChoiceControl(props) {
      const { entry, field, disabled, t, onPick } = props
      const [open, setOpen] = React.useState(false)
      return h(primitives.Menu, {
        open,
        align: 'end',
        // The settings document scrolls; an in-place list would be cropped.
        portal: true,
        selectedId: field.text,
        items: entry.choices.map((value) => ({ id: value, label: t(`choice.${value}`) })),
        onSelect: (id) => { setOpen(false); onPick(id) },
        onClose: () => { setOpen(false) },
        anchor: h('button', {
          type: 'button',
          className: 'dsh-dcp-control dsh-dcp-select',
          disabled,
          // `Menu` renders `role="menu"`/`role="menuitem"`
          // (ui-primitives/lib/index.js:4203), so the trigger announces a menu
          // and not a listbox — the host's own settings selectors say `menu`
          // (ui-settings-account/lib/client.js:1714, ui-permission-presets/lib/client.js:524).
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => { setOpen((value) => !value) },
          // The icon set's chevron, not a hand-drawn border trick: same glyph,
          // stroke, and cap as the host's rows
          // (ui-permission-presets/lib/client.js:530).
        }, t(`choice.${field.text}`), h(primitives.IconChevronDownOutlineRegular)),
      })
    }

    /**
     * One labelled row: description left, control right.
     *
     * Written here rather than taken from `SettingsForm` because that frame is
     * staged-then-saved, and this page applies each change as it is made.
     *
     * Only the numeric control carries the id a title can point at, so only
     * that row gets a real `<label htmlFor>`; the others get the plain title
     * div the host's own rows use (ui-theme's FontSizeRow, ui-permission-presets'
     * PermissionRow). A label pointing at nothing is worse than no label: it
     * promises a click target that is not there. `Switch` cannot be given one
     * either — it renders its own `button[role=switch]` and forwards no id
     * (ui-primitives/lib/index.js:3394).
     */
    function settingsRow(entry, props, state, t, invalid, report, control, inert) {
      const title = t(`field.${entry.field}.label`)
      return h('div', {
        key: entry.field,
        className: 'dsh-dcp-row',
        // Not `disabled`: this is a div, and the attribute is reserved for the
        // form controls inside it. It is a style hook.
        'data-inert': inert === true ? 'true' : undefined,
      },
        h('div', { className: 'dsh-dcp-rowMain' },
          entry.kind === 'number' || entry.kind === 'text'
            ? h('label', { className: 'dsh-dcp-rowLabel', htmlFor: fieldId(entry) }, title)
            : h('div', { className: 'dsh-dcp-rowLabel' }, title),
          h('p', { className: 'dsh-dcp-hint' }, t(`field.${entry.field}.hint`))),
        h('div', { className: 'dsh-dcp-rowControl' }, control))
    }

    /** One control, applying its value as soon as it is made. */
    function settingsControl(entry, props, state, t, invalid, report) {
      const field = state[entry.field]
      const requires = ROW_REQUIRES[entry.field]
      const inert = requires !== undefined && !requires((name) => switchOn(state, name))
      const disabled = state.writable !== true || state.available !== true || inert
      // `edit` stages and `save` writes, so the pair is what makes this page
      // behave like the Harness's own settings: no save button.
      //
      // This page writes as each control is used, and a refusal changes
      // nothing the card could read back from the Host, so the verdict is
      // rendered from the promise's answer instead of being dropped.
      const commit = (text) => {
        void props.write(entry.field, text).then((kept) => { report(entry.field, kept === true) })
      }
      if (entry.kind === 'switch') {
        return settingsRow(entry, props, state, t, invalid, report, h(primitives.Switch, {
          checked: field.text === 'true',
          onChange: (next) => { commit(next ? 'true' : 'false') },
          label: t(`field.${entry.field}.label`),
          disabled,
        }), inert)
      }
      if (entry.kind === 'text') {
        return settingsRow(entry, props, state, t, invalid, report, h(TextControl, {
          entry, field, disabled, invalid, t, onCommit: commit,
        }), inert)
      }
      if (entry.kind === 'choice') {
        return settingsRow(entry, props, state, t, invalid, report, h(ChoiceControl, {
          entry, field, disabled, t, onPick: commit,
        }), inert)
      }
      return settingsRow(entry, props, state, t, invalid, report, h(NumberControl, {
        entry, field, disabled, invalid, t, onCommit: commit,
      }), inert)
    }

    /**
     * Show what went wrong instead of an empty section.
     *
     * A contribution that throws inside the Settings shell leaves a blank page
     * and a `data-slot-error` marker; this renders the reason instead.
     */
    class SettingsBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('[dsh-dcp] settings section failed', error)
      }

      render() {
        if (this.state.error === null) return this.props.children
        return h('p', { className: 'dsh-dcp-hint', role: 'status' },
          `dsh-dcp: ${this.state.error?.message ?? String(this.state.error)}`)
      }
    }

    /**
     * The Settings section.
     *
     * Deliberately NOT gated on the namespace being served: the shared form
     * renders its own "unavailable" line in that case, so an unserved namespace
     * shows a page that says so instead of no page at all — which is the only
     * way to tell the two failures apart from the outside.
     */
    function SettingsCard(props) {
      const t = props.t
      // The binding is static for the lifetime of the registration, so branching
      // on it here cannot change a hook's position between renders.
      const bound = typeof props.useDcpSettings === 'function'
      const state = bound ? props.useDcpSettings((snapshot) => snapshot) : null
      // Every field whose last write was refused, as a set. A refusal cannot
      // ride the store — it is precisely the write the Host snapshot does not
      // record — so the card is the only place the verdict can live; and it is
      // a SET rather than one slot because one row's success must not erase
      // another row's verdict. That other row still holds an unsaved draft and
      // its configuration is still the old value, so its `aria-invalid` and the
      // page-level notice have to stay until that field itself is written
      // back successfully. Declared with the other hooks, above every return,
      // so the hook order never moves.
      const [failures, setFailures] = React.useState(new Set())
      const report = (field, kept) => {
        setFailures((previous) => {
          const next = new Set(previous)
          if (kept) next.delete(field)
          else next.add(field)
          return next
        })
      }
      if (state === null) return h('p', { className: 'dsh-dcp-hint' }, t('form.unbound'))
      if (state.available !== true) return h('p', { className: 'dsh-dcp-hint', role: 'status' }, t('form.unavailable'))
      return h('div', { className: 'dsh-dcp-form' },
        state.writable === true ? null : h('p', { className: 'dsh-dcp-hint', role: 'status' }, t('form.readOnly')),
        // The shared form's own `failed` only moves when ITS staged save runs;
        // this page writes on use, so both answers are reported here — the only
        // visible feedback a refused value gets, since the draft stays in the
        // control and the configuration no longer matches it. The sentence
        // covers whatever is still in the set; the row it belongs to carries
        // the `aria-invalid` that points at it.
        state.failed === true || failures.size > 0
          ? h('p', { className: 'dsh-dcp-invalid', role: 'status' }, t('form.saveFailed'))
          : null,
        SETTINGS_GROUPS.map((group) => {
          const rows = SETTINGS_FIELDS
            .filter((entry) => group.fields.includes(entry.field))
            .filter((entry) => state[entry.field] !== undefined)
          if (rows.length === 0) return null
          const headingId = `dsh-dcp-group-${group.id}`
          // The host's own grouped settings are a `section` labelled by its `h3`
          // (ui-settings-subagent/lib/client.js:433-438), not a bare heading.
          return h('section', {
            key: group.id,
            className: 'dsh-dcp-group',
            'aria-labelledby': headingId,
          },
          h('h3', { className: 'dsh-dcp-groupTitle', id: headingId }, t(`group.${group.id}`)),
          rows.map((entry) => settingsControl(entry, props, state, t, failures.has(entry.field), report)))
        }))
    }

    return {
      // Only `slots` is a hard edge. `configForms` is NOT: cordis runs `apply`
      // only once every injected service exists, so a hard edge made the whole
      // browser half inert in any deployment that composes no settings surface
      // — the composer readout, which needs neither the settings service nor
      // its page, disappeared with it. The settings card below injects the
      // service dynamically and simply stays unmounted while it is absent,
      // which is the same degradation every other optional capability in this
      // file already has (locale, react-dom, `useProjection`).
      inject: ['slots'],
      apply(ctx) {
        // Read the locale lazily: it may not exist when this plugin activates,
        // and the built-in English copy must still work without it.
        const t = (key) => {
          const locale = ctx.get('locale')
          if (locale !== undefined && typeof locale.bind === 'function') return locale.bind(NS)(key)
          return COPY.en[key] ?? key
        }
        ctx.inject(['locale'], (scope) => {
          scope.effect(() => scope.locale.register(NS, COPY), 'dsh-dcp: copy')
        })

        // `conversation.composer.dock` is the composer footer band: it renders
        // as the first child of the dock row, immediately left of the context
        // meter, and the host's own stats pills share that band. Registered
        // unconditionally: the readout is this plugin's core contribution and
        // must not depend on the settings page existing.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-dcp',
          order: 40,
          locale: NS,
        }, function DcpReadout(props) {
          return h(Readout, { ...props, t })
        }))

        // Settings, not the Plugins page: a bundle the profile merely links in
        // never reaches that page's configuration ledger, so a `plugins.item`
        // card cannot appear for it. A settings section is the seat a
        // third-party plugin can actually occupy.
        //
        // The card lives behind a dynamic dependency on `configForms`: the
        // fiber waits (nothing is registered) until the settings service is
        // provided, and unloads on its own if the service goes away.
        ctx.inject(['configForms'], (scope) => {
          const settings = new SettingsCardController(scope.configForms.get(SETTINGS_NS))
          // The controller subscribes to the namespace scope when it is built
          // (ui-primitives/lib/index.js:7170), so the effect owns releasing it:
          // an unload or an HMR reload would otherwise leave the subscription and
          // its store behind.
          scope.effect(() => {
            const registration = scope.slots.inject('settings.section', () => scope.slots.register({
              name: 'settings.section',
              id: SETTINGS_NS,
              // Not 100, which is what this card used to claim. The shell sorts
              // sections with a bare `a.order - b.order` and no tie-break, so two
              // sections that share an order keep whichever registration landed
              // first — and with separately loaded bundles that flips between page
              // loads. The sidebar plugin claims 100 as well, and this card really
              // did sit above it on one reload and below it on the next. 95 keeps
              // one position.
              order: 95,
              label: () => t('settings.title'),
              locale: NS,
              inject: () => settings.inject(),
            }, function DcpSettingsSection(props) {
              return h(SettingsBoundary, null, h(SettingsCard, { ...props, t }))
            }))
            return () => {
              registration?.()
              settings.dispose()
            }
          }, 'dsh-dcp: settings section')
        })
      },
    }
  },
})
