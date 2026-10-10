# Agent Note: 拆分后主仓文档的事实收敛（删除已迁走能力的复现承诺）

Status: implemented

## Problem

2026-10-03 拆分与 2026-10-07 桌面壳附着模式退役之后，主仓多处文档仍把已经不在本仓的能力写成今天可复现的事实：`docs/current-state.md` 的验证节列着 `scripts/e2e-smoke.mjs` / `pnpm wiring:ledger` / `scripts/systemd-units-check.mjs` / `apps/ios-native` 四条实测 MISSING 的命令，表格里十余行引用已迁走的 `packages/{cockpit,tradectl}` 与 `deploy`；中英 README 的「已交付」节仍在讲 trading-bot profile、A0 通道、网页驾驶舱、桌面壳附着模式，且两语对移动端现状互相矛盾；`docs/README.md` 的手写目录树含三条不存在的路径；`docs/ops/release-checklist.md` 第 1 节仍是已退役的 `file:/link:` 钉版解除流程。

## Decision

- `docs/current-state.md`：把十行卫星仓能力收敛为一行指针（含私有仓链接与切分 note 链接），另立一行记录桌面壳附着模式退役；验证节只保留能在主仓现场复跑的命令（`pnpm gates:all`），并注明演练/单元校验/移动端机检的入口在卫星仓；文档地图四行改为卫星仓指针。
- `README.md` 与 `README_zh.md`：「已交付但默认不启用」只保留仍在本仓的实盘授权平面（`packages/authority`）与行情桥（`packages/bot-api`），自动交易平面改为一句私有卫星仓指针；两语的移动端现状统一为同一句事实。
- `docs/README.md`：删掉手写目录树，保留其后的分类导航（分类导航已是指针形态）。
- `docs/ops/release-checklist.md`：第 1 节改为现在时的解析前提（SDK 走 npm cohort，`pnpm-workspace.yaml` 是唯一家）+ 两条仍有效的检查项。

## Alternatives considered

- **保留历史并加删除线**：交接页读的是现在时事实，划掉的历史仍会让人犹豫能不能跑；历史由 `.agents/notes/` 与 git 承担，落选。
- **把卫星仓状态写进主仓 README 同一节**：等于维护第二份会漂移的事实，落选（只留指针）。
- **更新手写目录树而不是删除**：与分类导航重复且已漂移过一次，落选。

## Consequences

- `node scripts/docs-link-check.mjs`：287 个 markdown、294 条相对链接、基线 13 条，无新增断链。
- 剩余出现 `apps/ios-native` 的位置全部是卫星仓指针（`docs/current-state.md` 两处说明行、`docs/README.md` 既有指针），主仓不再声称持有该工程。
- 若 owner 计划把某些能力迁回主仓，需要新的记录与文案；本记录不预设方向。
