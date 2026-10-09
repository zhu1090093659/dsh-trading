# Agent Note: 拆分后主仓文档的事实收敛（删除已迁走能力的复现承诺）

Status: proposed

## Problem

2026-10-03 拆分与 2026-10-07 桌面壳附着模式退役之后，主仓仍有四处文档把已经不在本仓的能力写成今天可复现的事实。交接页上的错误事实最贵：新会话照着命令跑，只会得到「文件不存在」。

1. `docs/current-state.md:54-63`「怎么验证」列的四条命令里三条已不存在：`scripts/e2e-smoke.mjs`、`pnpm wiring:ledger`、`scripts/systemd-units-check.mjs`、`apps/ios-native/**` 实测全部 MISSING，根 `package.json` 的 scripts 里也没有 `e2e:smoke` 与 `wiring:ledger`。同页 `:15/:21/:23/:26/:77` 仍把 shadow 验收、iOS 原生观测端、systemd 台架、`apps/ios-native/README.md` 当作主仓能力。
2. `README.md:174-184` 与 `README_zh.md:174-184`「已交付但默认不启用」逐条列了 trading-bot profile、A0 带外通道、网页驾驶舱、桌面壳附着模式：前三条已随平面迁往卫星仓，第四条已于 2026-10-07 移除（`.agents/notes/implemented/architecture/2026-09-03-electron-desktop-app.md` 已有替代方案声明）。同节两语的移动端现状互相矛盾：英文 `:184` 说 iOS 原生端在 `apps/ios-native`，中文 `:184` 说 App 本体未做。
3. `docs/README.md:11-43` 的手写目录树与后文 `:109/:113` 的卫星仓指针重复，且树里的 `design/alignment-calibration.md`、`ops/ops-runbook.md`、`client/mobile-app-plan.md` 在主仓不存在。
4. `docs/ops/release-checklist.md:7-24`「SDK 钉版解除」整节仍是已退役的一次性流程（file:/link: overrides 早已换成 npm cohort，见 `pnpm-workspace.yaml`），却以「最硬的闸门」占据清单第一节，会让读者以为本仓仍钉本机绝对路径。

## Proposal

- `docs/current-state.md`：删掉「怎么验证」里已迁走的四条命令与 `:15/:21/:23/:26` 的对应行（或改写为「能力在卫星仓，复现入口见卫星仓 README」），文档地图 `:77` 的移动端行同步。规则：状态页只保留能在主仓现场复跑的命令。
- `README.md` 与 `README_zh.md`：删除该节里三条已迁走的能力与一条已移除的能力；保留仍在本仓的 `packages/authority` 实盘授权平面。两语的移动端现状改为同一条事实（工程在卫星仓，主仓只留契约指针）。
- `docs/README.md`：删掉手写目录树（`:11-43`），保留 `:45` 之后的分类导航——分类导航已经是指针形态，树是第二份会漂移的事实。
- `docs/ops/release-checklist.md`：删掉第 1 节的历史解除过程，保留一条现在时前提（SDK 走 npm cohort overrides，`pnpm-workspace.yaml` 是唯一家）与仍然有效的干净环境检查。
- 四处都只做删除与指针改写，不新增第二份事实。

## Context & Efficiency Impact

- 消失的维护面：约 60-80 行错误文档，以及每次新会话照着跑一次的无效命令。
- 读者路径变短：`current-state.md` 的验证节从 5 条命令收敛到真正可跑的 1-2 条。
- 收益是可执行性：交接页恢复「照着做就能复现」的性质。

## Alternatives considered

- **保留历史叙述并加删除线**：交接页读的是现在时事实，划掉的历史仍会让人犹豫到底能不能跑；历史由 `.agents/notes/` 与 git 承担。落选。
- **把卫星仓能力写进主仓 README 的同一节**：等于在主仓维护第二份卫星仓状态，必然漂移。落选，只留指针。
- **更新 `docs/README.md` 的手写树而不是删除**：树的维护成本与分类导航重复，且已经漂移过一次（三条不存在的路径）。落选。
- **顺手清理 spikes/ 与 docs/archive/**：超出本记录范围；spikes 是真实网络原始响应证据，删除需要单独证据链。落选。

## Verification & Gates

- `node scripts/docs-link-check.mjs`：改完不得新增断链（当前基线 18 条，其中 5 条来自 archived，见同批另一条提案）。
- 现场复跑核对（改前证据）：`test -e scripts/e2e-smoke.mjs scripts/wiring-ledger.mjs scripts/systemd-units-check.mjs apps/ios-native` 应全为 MISSING。
- `grep -n apps/ios-native README.md README_zh.md docs/current-state.md docs/README.md` 改后应为零命中。
- `pnpm gates:all` 绑 HEAD sha 复跑（含 docs-link:check）。

## Risks

- README 是对外门面：删掉「已交付」条目会削弱对外展示。取舍是准确性优先——把能力说成主仓今天可跑，比少说一条更贵；对外展示可改为指向卫星仓。
- 若 owner 计划把某些能力迁回主仓，届时需要新的记录与文案；本记录不预设方向。
