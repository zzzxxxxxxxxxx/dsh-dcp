<div align="center">

<img src="assets/icon.svg" alt="dsh-dcp" width="84" height="84">

# dsh-dcp

**Dynamic context pruning for the DeepSeek Harness — let the model tidy up after itself.**

[![npm](https://img.shields.io/npm/v/@zzxxxxxx/dsh-dcp.svg)](https://www.npmjs.com/package/@zzxxxxxx/dsh-dcp)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2.0--rc.1-6E56CF)](https://github.com/deepseek-ai/deepseek-harness)

**English** | [中文](README.md)

</div>

## Overview

- **Model-driven compaction**: the `compact` tool collapses a span of history into a summary the model authors, committed as a native Harness compaction transaction — the transcript shows the built-in "context compacted" card, so the plugin ships no bespoke UI.
- **`compact_targets` / `recall`**: the first lists the handles `compact` accepts together with their legal cut marks; the second reads back the **original content** a compaction removed, without touching the conversation.
- **Automatic deduplication**: identical calls to the same tool keep only their newest output; older ones become a placeholder. Success and failure count the same, and the newest error text is preserved.
- **Nudges**: when context pressure crosses a threshold the model is reminded to compact — 33% / 67% of the model window by default.
- **Composer readout**: a pill under the input shows this session's compaction and prune counts and opens a detail panel on click.

Every piece of state is derived by folding the session log: apart from the optional prompt-override files, the plugin keeps nothing on the side and adds no session event type. Pruned and compacted originals stay in the log.

Inspired by [opencode-dcp](https://github.com/Tarquinen/opencode-dynamic-context-pruning); licensed AGPL-3.0 (see `LICENSE`).

## Install

Requirements: DeepSeek Harness ≥ `0.2.0-rc.1`, Node `^22.19.0 || >=24.0.0`.

**From npm** (recommended):

```sh
dsh plugin --profile <profile> add @zzxxxxxx/dsh-dcp
```

**From source / local development**:

```sh
git clone https://github.com/zzzxxxxxxxxxx/dsh-dcp && cd dsh-dcp
npm install        # build dependencies; needs network the first time
npm run build      # produces lib/, the plugin entry point (not committed)

dsh plugin --profile <profile> add "$PWD"
```

**Straight from git** (available once the repository is pushed to GitHub; `prepare` builds `lib/` during installation, and pnpm blocks dependency build scripts by default, so authorize it in the profile's `pnpm-workspace.yaml` first):

```sh
dsh plugin --profile <profile> add github:zzzxxxxxxxxxx/dsh-dcp
```

**Restart** `dsh` afterwards (a profile is composed at startup).

- `dsh plugin --profile <p> add ...` only adds a dependency to the profile — the plugin row itself is mounted by the bundle patch this package ships.
- Update: from source, `git pull && npm install && npm run build`; from git, `add` again. Restart either way.
- Remove: `dsh plugin --profile <p> remove @zzxxxxxx/dsh-dcp`, then restart.
- The browser half (the readout pill and the settings page) appears only in profiles with a Web UI; the model tools, compaction and deduplication work everywhere else.

## Usage

- **`/dcp-compact [focus]`** asks the model to run one compaction pass now, with optional focus text to narrow it. The host's own `/compact` is a separate path; the two do not interfere.
- **Model-facing tools**: `compact` (fold a span into a summary the model writes), `compact_targets` (list handles and legal cut marks), `recall` (read an original back; `query` filters lines, `offset` pages through it). Availability follows `compaction.permission`.
- **Automatic**: one deduplication pass per turn boundary; while context pressure is above a threshold the model is reminded at most once every `nudgeFrequency` nodes.
- **Manual mode** (`manualMode.enabled`): nudges stop, and the model may compact once only after you run `/dcp-compact`.
- **Readout**: the pill under the input shows this session's compaction blocks, prune count and tokens saved; click it for the breakdown.

## Configuration

**Settings → DCP context** (the host's `settings.section`, id `dsh-dcp`) lists the 12 fields that can be changed at runtime and applies them immediately; the other 8 live in the plugin row's `config:` and need a restart.

```jsonc
{
  "pruneNotification": "minimal",   // off | minimal
  "protectedFilePatterns": [],
  "turnProtection": { "enabled": false, "turns": 4 },
  "experimental": { "allowSubAgents": false, "customPrompts": false },
  "commands": { "protectedTools": ["subagent*", "skill", "compact", "write", "edit", "plan_enter", "plan_exit"] },
  "manualMode": { "enabled": false, "automaticStrategies": true },
  "compaction": {
    "permission": "allow",          // allow | ask | deny
    "maxContextLimit": "67%",       // share of the window, or absolute tokens
    "minContextLimit": "33%",
    "modelMaxLimits": {}, "modelMinLimits": {},
    "nudgeFrequency": 5,
    "protectedTools": ["subagent*", "skill"],
    "protectUserMessages": false,
    "recall": true
  },
  "strategies": { "deduplication": { "enabled": true, "protectedTools": [] } }
}
```

| Field | Default | Meaning | Hot |
| --- | --- | --- | :---: |
| `pruneNotification` | `"minimal"` | What an automatic prune pass reports: `minimal` is one line, `off` leaves it to the panel | ✓ |
| `protectedFilePatterns` | `[]` | Path globs: matching calls are never rewritten, and their bodies are preserved in a summary's appendix | |
| `turnProtection.enabled` | `false` | Keep the newest turns out of the strategy candidates | ✓ |
| `turnProtection.turns` | `4` | How many turns stay protected | ✓ |
| `experimental.allowSubAgents` | `false` | Let DCP prune subagent sessions too (off leaves them alone) | ✓ |
| `experimental.customPrompts` | `false` | Enable prompt overrides under `$DSH_HOME/dcp-prompts/` | ✓ |
| `commands.protectedTools` | `subagent*` `skill` `compact` `write` `edit` `plan_enter` `plan_exit` | One of the three protection lists; also governs the `/dcp-compact` sweep and the panel | |
| `manualMode.enabled` | `false` | Stop nudging; the model may compact once per explicit request | ✓ |
| `manualMode.automaticStrategies` | `true` | Keep deduplicating while manual mode is on | ✓ |
| `compaction.permission` | `"allow"` | `allow` runs directly; `ask` goes through the Harness approval seam; `deny` leaves the model tools unregistered | |
| `compaction.maxContextLimit` | `"67%"` | Strong threshold: above it the model is told to compact now | ✓ |
| `compaction.minContextLimit` | `"33%"` | Weak threshold: below it nothing nudges | ✓ |
| `compaction.modelMaxLimits` | `{}` | Per-`"provider/model"` override for the strong threshold | |
| `compaction.modelMinLimits` | `{}` | Per-`"provider/model"` override for the weak threshold | |
| `compaction.nudgeFrequency` | `5` | Inject a nudge at most once every N conversation nodes | ✓ |
| `compaction.protectedTools` | `subagent*` `skill` | Bodies are appended verbatim to a summary, and exempt from deduplication | |
| `compaction.protectUserMessages` | `false` | Preserve user messages verbatim (a large pasted prompt never compresses away) | ✓ |
| `compaction.recall` | `true` | Register the `recall` tool | |
| `strategies.deduplication.enabled` | `true` | Rewrite the outputs of older duplicate calls | ✓ |
| `strategies.deduplication.protectedTools` | `[]` | Extra exemptions from deduplication | |

A few semantics:

- A percentage threshold needs the route to report a context window; when it reports none, nothing nudges — the plugin does not fall back to a fixed token count.
- All three protection lists reach deduplication: naming a tool in `compaction.protectedTools`, `commands.protectedTools` or `strategies.deduplication.protectedTools` keeps its older outputs from being rewritten (`commands`' default list is what exempts `write`/`edit`).
- `protectedFilePatterns` governs both deduplication and compaction: matching calls are never rewritten, and their bodies are kept in a summary's appendix. Globs are fail-open: a value over 8192 characters, a pattern over 4096 characters, or a match running past 1,048,576 steps counts as "no match" — that loses protection, never adds it; collecting the paths one call declared scans at most 10,000 nodes.
- With `experimental.customPrompts` on, `$DSH_HOME/dcp-prompts/overrides/<name>.md` overrides 4 prompts (`compact`, `compact-targets`, `context-limit-nudge`, `turn-nudge`); the "not a message from the user" prefix on a nudge is restored at load time and cannot be removed. The switch and the override files apply **immediately** — no restart.
- Debug switch `DSH_DCP_TRACE`: point it at a file path and the plugin appends one line per decision (why a reminder fired, why one was skipped and on which inputs, whether delivery landed, whether a config or prompt reload really happened, what each automatic pass pruned). Unset, it writes nothing at all — with tracing off the plugin leaves no files behind. For host logs (every plugin, not just DCP) use [`dsh-logger-panel`](https://github.com/LingLambda/dsh-logger-panel).
- This plugin is young and may still have bugs. Please report problems in [Issues](https://github.com/zzzxxxxxxxxxx/dsh-dcp/issues) and **attach the log produced by `DSH_DCP_TRACE`** — it spells out the decision path far better than the transcript does.
