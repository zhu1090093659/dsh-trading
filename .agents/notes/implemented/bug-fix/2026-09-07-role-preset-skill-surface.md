# Agent Note: 角色预设技能面与 shell 接线（大师可见 content-insight）+ content-insight S4 直接入库

Status: implemented

## Problem

两个同源问题在 2026-09-07 被实证：

1. **角色预设零技能目录**。trading-web 的 PTC 会话能走通 content-insight 全管线（官方 `ptc` 预设在 agent 平面挂了 `dsh-skill-filesystem` + `dsh-tool-skill`，会话有 `<available_skills>` 目录、`skill` 工具和 `run_code`/bash 执行面），而大师会话完全没有技能目录——用户在大师模式发同样的 B 站链接，模型自述「没有终端/shell 工具」只能临时开 cordis 动态包抓 API，content-insight、company-analysis 等 persona 点名的技能全是死引用。根因：web 宿主把 `skill-filesystem`、`tool-skill`、`tool-bash` 三个宿主行全部 disabled（注释明说「presets own local discovery」），官方 ptc/standard 预设各自补挂，而 `@dshtrading/base` 生成的四个角色预设一行都没挂（#70 技能分配只分配了「provider 目录」，没保证「目录可达」）；#70 真机验收遗留项恰好漏验了这一点。
2. **仓库内置 content-insight 落后于全局版**。cowork 侧 PTC 会话已把全局 `~/.agents/skills/content-insight/` 演进出两步：V2 云端 ASR（bili_transcribe.js + z-ai SDK）退役、本地 mlx-whisper 成唯一 ASR 路径；新增 S4「知识库入库」为默认收尾（`knowledge_ingest` 工具优先、直写回退协议、批量对账），而仓库 `.agents/skills/content-insight/` 与 base 分发资产仍是旧版（S3 止步于 markdown 卡片）。

## Decision

- `packages/base/src/presets.ts`：四个角色预设统一追加 `dsh-trading-skill-filesystem`（`@deepseek-ai/dsh-skill-filesystem`）与 `dsh-trading-tool-skill`（`@deepseek-ai/dsh-tool-skill`）两行——官方 preset 同款、注册进宿主注册表、无 isolate realm。master 另加 `dsh-trading-master-bash`（`@deepseek-ai/dsh-tool-bash`）：master 是编排者，content-insight 等会话技能要跑 python/uv 管线；交易面已有 base 审批闸门兜底，bash 不新增交易执行面。trader 保持最小执行面，研究员/风控只读不挂 shell。
- content-insight 仓库版对齐全局演进版：SKILL.md 恢复 S4 默认入库节（`knowledge_ingest` 优先、直写回退协议、批量对账、缓存重启提示）、V2 主路径改为本地 mlx-whisper、故障排查表同步；`whisper_asr.py` 头注释改为「V2 唯一 ASR 路径」。`pnpm build` 经 sync-skills 自动分发到 `packages/base/assets/skills/content-insight.md`（SSOT 单向：`.agents/skills/` → 包资产）。

## Alternatives considered

- 只给 master 挂技能行、其余角色不挂：persona 对 trader/risk-reviewer 同样点名技能（risk-checklist、trading-notes-setup），目录缺失则全是死引用；且 kit 白名单（#70）已按角色收窄目录内容，可达性统一放开不破坏分层——拒绝。
- master 用 cordis 动态包替代 bash 行跑管线：实证过模型会这么自救，但每次现开动态包、结果经工具投影绕一层，慢且不可复现；官方 shell 工具才是正道——拒绝。
- content-insight 维持「S3 产卡片、用户确认后手动入库」：与知识库「不入库=未沉淀」的实战结论相悖，且 knowledge-curation skill 已把 `knowledge_ingest` 定为入库正道——拒绝。

## Consequences

- 16 市场子集组合测试更新：全员断言 `dsh-skill-filesystem`/`dsh-tool-skill` 行，master 额外断言 `dsh-tool-bash` 且其余角色断言无 bash。全仓门禁绿：`pnpm build`、`pnpm -r test` exit 0、typecheck 棘轮 484<504、`i18n:check` OK。
- 真机验收（trading-web :3081，任务 runner 建 master 会话）：技能目录 40 条含 `content-insight` 与 `company-analysis`（来自 user 目录与 base role-skills provider），`skill` 与 `bash` 工具在场（工具面 82→90），验收会话自答「content-insight：有 / bash：有 / skill：有」。验收任务已删，台账无残留。
- **kit 捆绑技能仍未进目录**（crypto-risk-checklist、knowledge-curation、trading-notes-setup、trading-strategy-paradigms 均不在 master 会话目录）：kit provider 在同一预设组合里注册但 catalog 不含——kit 行与 role-skills 行的 scope 层级差异待查（怀疑 kit 插件的 provider 注册落在宿主/组层，未被 `snapshot({scope: agent})` 合并）。此为 #70 时代就存在的存量缺口（扫描全部历史会话无一处 kit 技能进过目录），非本次回归；修复应另立变更，从 dsh-skill 注册表 layer 语义入手。**2026-09-08 更新**：该「scope 层级」怀疑在桌面壳里有了实证解释——桌面宿主曾同时加载两份 `@deepseek-ai/dsh-scope`（profile 核心包指向全局 npm dsh、其余解析到自带 runtime），模块级 `scopeParents` 割裂使预设注册的行看不见 agent 链，症状正是「工具在、提示词段落与事件注入不在」；见 [桌面壳角色预设上下文注入失效](2026-09-08-desktop-preset-context-injection.md)。本次 CLI（:3081）验收是绿的，因为 CLI 宿主与 profile 链接同源，不触发割裂。
- 任务 runner 真机缺陷如实记录（非本仓引入）：钉 `permission` 的任务在 `/permission` 命令步报 `Cannot read properties of undefined (reading 'aborted')`（09-06/09-07 旧执行同样失败）；不钉权限则全链路通。验收采用不钉权限路径。
- content-insight 的 S4 依赖 `knowledge_ingest` 在 master 工具面在场（宿主 host 行注册，全场会话可见，已验证）；直写回退协议保留为工具不可用时的降级路径。