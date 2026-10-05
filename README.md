<div align="center">

<img src="assets/icon.svg" alt="dsh-dcp" width="84" height="84">

# dsh-dcp

**DeepSeek Harness 的动态上下文裁剪 —— 把历史交给模型自己收起来。**

[![npm](https://img.shields.io/npm/v/@zzxxxxxx/dsh-dcp.svg)](https://www.npmjs.com/package/@zzxxxxxx/dsh-dcp)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2.0--rc.1-6E56CF)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.en.md) | **中文**

</div>

## 简介

- **模型驱动的压缩**：`compact` 工具把一段连续历史折叠成模型自撰的摘要，落盘为 Harness 原生的 compaction 事务——对话里显示的就是原生的「上下文已压缩」卡片，插件不需要自绘界面。
- **`compact_targets` / `recall`**：前者列出可压缩的句柄与合法切割位置；后者按需把某次压缩移除的**原文**读回来，不动上下文。
- **自动去重**：同一工具、同一参数的重复调用只保留最新一次的输出，更早的换成占位符；调用成功或失败一视同仁，最新那条的报错原文保留。
- **提醒**：上下文压力越过阈值时提醒模型压缩一次，阈值默认是模型窗口的 33% / 67%。
- **底部读数**：输入框下方的 pill 显示本会话的压缩与清理计数，点击展开明细。

所有状态都从会话日志折叠派生：除可选的提示词覆盖文件外，插件不写任何旁挂状态，也不新增会话事件类型；被裁剪与被压缩的原文仍留在日志里。

思路来自 [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)；以 AGPL-3.0 授权（见 `LICENSE`，第三方归属见 `NOTICE`）。

## 安装

要求：DeepSeek Harness ≥ `0.2.0-rc.1`，Node `^22.19.0 || >=24.0.0`。

**从 npm 装**（推荐）：

```sh
dsh plugin --profile <profile> add @zzxxxxxx/dsh-dcp
```

**从源码装 / 本地开发**：

```sh
git clone https://github.com/zzzxxxxxxxxxx/dsh-dcp && cd dsh-dcp
npm install        # 构建依赖，首次需要网络
npm run build      # 产出 lib/（插件入口；仓库里不提交构建产物）

dsh plugin --profile <profile> add "$PWD"
```

**从 git 直接装**（仓库推送到 GitHub 后可用；`prepare` 会在安装时构建 `lib/`，而 pnpm 默认拦下依赖的构建脚本，需先在 profile 的 `pnpm-workspace.yaml` 里授权）：

```sh
dsh plugin --profile <profile> add github:zzzxxxxxxxxxx/dsh-dcp
```

装完后**重启** `dsh`（profile 在启动时组合）。

- `dsh plugin --profile <p> add ...` 只往 profile 加一条依赖，插件行由本包自带的 bundle patch 挂载。
- 更新：源码装则 `git pull && npm install && npm run build`；git 装则重新 `add` 一次。之后都要重启。
- 卸载：`dsh plugin --profile <p> remove @zzxxxxxx/dsh-dcp`，再重启。
- 浏览器半边（读数 pill 与设置页）只在带 Web 界面的 profile 里出现；其他 profile 下模型工具、压缩与去重照常工作。

## 用法

- **`/dcp-compact [focus]`**：让模型立刻跑一次压缩，可选一段 focus 文本收窄范围。宿主的 `/compact` 是另一条独立路径，两者互不干扰。
- **模型侧工具**：`compact`（把区间折成摘要，摘要由模型自己写）、`compact_targets`（列出句柄与合法切割点）、`recall`（读回原文，可用 `query` 过滤、`offset` 翻页）。是否可用由 `compaction.permission` 决定。
- **自动**：每个回合边界跑一次去重；上下文压力越过阈值时按 `nudgeFrequency` 的间隔提醒模型压缩。
- **手动模式**（`manualMode.enabled`）：停发提醒，只有你执行过 `/dcp-compact` 之后，模型才允许压缩一次。
- **读数**：输入框下方的 pill 显示本会话的压缩块数、清理次数与省下的 token，点击展开明细。

## 配置

**设置 → DCP 上下文**（宿主 `settings.section`，id `dsh-dcp`）列出 12 个可热改字段，写入即时生效；其余 8 个写在插件行的 `config:` 里，改完重启。

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
    "maxContextLimit": "67%",       // 窗口百分比，或绝对 token 数
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

| 字段 | 默认 | 说明 | 热改 |
| --- | --- | --- | :---: |
| `pruneNotification` | `"minimal"` | 自动清理后的报告：`minimal` 一行计数，`off` 只留在面板 | ✓ |
| `protectedFilePatterns` | `[]` | 路径 glob：命中的调用不被去重改写，压缩时其正文进摘要附录 | |
| `turnProtection.enabled` | `false` | 不把最近几轮列入清理候选 | ✓ |
| `turnProtection.turns` | `4` | 保护多少轮 | ✓ |
| `experimental.allowSubAgents` | `false` | 让 DCP 也裁剪子代理会话（默认不动它们） | ✓ |
| `experimental.customPrompts` | `false` | 允许 `$DSH_HOME/dcp-prompts/` 下的提示词覆盖 | ✓ |
| `commands.protectedTools` | `subagent*` `skill` `compact` `write` `edit` `plan_enter` `plan_exit` | 三张保护表之一；同时管辖 `/dcp-compact` 的 sweep 与面板 | |
| `manualMode.enabled` | `false` | 停发提醒，只在你显式请求后允许压缩一次 | ✓ |
| `manualMode.automaticStrategies` | `true` | 手动模式下是否继续去重 | ✓ |
| `compaction.permission` | `"allow"` | `allow` 直接执行；`ask` 走宿主审批；`deny` 不注册模型工具 | |
| `compaction.maxContextLimit` | `"67%"` | 强提醒阈值：高于它要求立刻压缩 | ✓ |
| `compaction.minContextLimit` | `"33%"` | 弱提醒阈值：低于它完全不提醒 | ✓ |
| `compaction.modelMaxLimits` | `{}` | 按 `"provider/model"` 覆盖强阈值 | |
| `compaction.modelMinLimits` | `{}` | 按 `"provider/model"` 覆盖弱阈值 | |
| `compaction.nudgeFrequency` | `5` | 每多少个对话节点最多提醒一次 | ✓ |
| `compaction.protectedTools` | `subagent*` `skill` | 正文逐字进摘要附录，并豁免去重 | |
| `compaction.protectUserMessages` | `false` | 用户消息逐字保留（粘贴的大段提示词不会被压掉） | ✓ |
| `compaction.recall` | `true` | 是否注册 `recall` 工具 | |
| `strategies.deduplication.enabled` | `true` | 是否改写重复调用的旧输出 | ✓ |
| `strategies.deduplication.protectedTools` | `[]` | 额外的去重豁免表 | |

几条语义：

- 百分比阈值需要路由上报 context window；上报不了就不提醒，不会退化成固定 token 数。
- 三张「受保护工具」表都会被去重读取：写进 `compaction.protectedTools`、`commands.protectedTools` 或 `strategies.deduplication.protectedTools` 中任意一张，该工具的旧输出都不会被自动改写（`commands` 的默认表因此让 `write`/`edit` 天然免疫去重）。
- `protectedFilePatterns` 同时作用于去重与压缩：命中的调用不会被改写，压缩时其正文进摘要附录。glob 是 fail-open 的：单个待匹配值超过 8192 字符、单条 pattern 超过 4096 字符，或匹配步数超过 1 048 576，一律按「不匹配」处理——后果是少保护，不会多保护；收集一次调用声明的路径时最多扫描 10000 个节点。
- `experimental.customPrompts` 打开后，可用 `$DSH_HOME/dcp-prompts/overrides/<name>.md` 覆盖 4 份提示词（`compact`、`compact-targets`、`context-limit-nudge`、`turn-nudge`）；同时插件会把内置文本播种到 `$DSH_HOME/dcp-prompts/defaults/<name>.md` 作为**参考副本**——`defaults/` 不参与加载，只供对照，整个目录不存在时会重新播种；nudge 的「这不是用户发言」前缀由插件在载入时补回，删不掉。开关与覆盖文件的改动**即时生效**，无需重启。
- 排障开关 `DSH_DCP_TRACE`：设成文件路径后，插件把每次判定按行追加进去（为什么提醒、为什么跳过及其输入、投递结果、配置与提示词是否真的重载、每回合自动清理的产出）。不设就一个字节都不写；没开 trace 时插件不留任何文件。宿主日志（所有插件，不止 DCP）用 [`dsh-logger-panel`](https://github.com/LingLambda/dsh-logger-panel) 看。
- 本插件仍在早期，可能还有 bug。遇到问题请到 [Issues](https://github.com/zzzxxxxxxxxxx/dsh-dcp/issues) 反馈，并**附上 `DSH_DCP_TRACE` 生成的日志**——它把判定过程写得比会话记录清楚得多。
