# Agent Note: 交付流分级定案——大功能走 PR，小修小补直推 main

Status: implemented

## Problem

[2026-09-02 分支+PR 交付流定案](../../archived/process/2026-09-02-issue-batch-assignment-pr-flow.md)
把「直推废止」写成了普遍规则，实践中被扩大适用：连 root package.json 删一个
重复键也开了 PR（#50）。owner 2026-09-02 明确反馈：每次小改动都走 PR 太冗余
也太复杂，流程需要定义清楚适用边界。

## Decision

交付流按**改动规模与风险面**分两档（有没建 Issue 不是判据，Issue 只是大规模
功能任务的常见形态）：

1. **较大功能开发 → 分支 + PR**：从最新 main 开 `feat/<issue号>-<短名>` 分支，
   PR 描述挂对应 Issue，至少一个审查批准。下列改动一律属此档（不论有无 Issue）：
   - 改公共契约（packages/api）或新增用户可见功能面；
   - 触及交易安全语义（铁律 #3：dry-run 默认、liveTrading 显式开关、base 审批闸门）；
   - 跨多包联动的新功能/重构。
2. **小修小补 → 直接提交 main**（Conventional Commits 照旧）：docs/notes、
   注释、CI 与脚本微调（含门禁基线下调）、单点 bug 修复、依赖 lockfile 维护、
   清理重命名等不改公共契约、不新增功能面的改动。

同线共享文件串行的纪律（#38 → #39）只约束第 1 档的功能线并行。

## Consequences

- AGENTS.md Development Workflow 新增「交付流分级」条目承载本规则；原 note 的
  「直推废止」自此收窄为第 1 档（较大功能开发），不再适用于第 2 档。
- 本决策记录与 AGENTS.md 修改本身即第 2 档改动，直接提交 main，不走 PR——
  这是新规则的第一例应用。
