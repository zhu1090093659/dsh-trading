# 发布前检查清单（release checklist）

> 2026-08-30 架构评审整改 #6；2026-09-29 最新基线校准。发布入口由技能 `.agents/skills/dsh-trading-release/SKILL.md` 规范管理。
> 本清单是每次从开发态发版到生产分发态的**核心门禁闸门**——逐条过完才允许进入 Changesets 发布流
> （`@dshtrading/*` fixed 组同族发版，PolyForm Noncommercial 1.0.0 许可协议）。

## 1. SDK 与依赖解析前提（最硬的闸门）

> **版本基线（2026-09-29）**：DSH 0.2.0-rc.2 世代（配套 cordis 4.0.4 / cosmokit 1.8.5 / schemastery 3.18.4）。
> 本仓 SDK（`@deepseek-ai/*`）一律以 peerDependencies 声明，运行时由宿主 `dsh` 提供；开发/测试期从 npm 官方源解析该世代，
> 并由 `pnpm-workspace.yaml` 的 overrides 与 minimumReleaseAgeExclude 精确钉住，保证单一模块实例——该文件是这一事实的唯一家。

发布前确认：

- [ ] `pnpm-workspace.yaml` 的 overrides 没有回退到 file:/link: 本机路径（有则任何其他机器都无法 install 本仓）；
- [ ] 在一台**干净环境**（无本机 checkout 依赖）`pnpm install && pnpm -r build && pnpm -r test` 全绿（CI 即干净环境实证）。

## 2. 功能与合规

- [ ] `pnpm -r build` / `pnpm -r test` 全绿（基线见 README 当前状态节）；
- [ ] trading-web profile 全市场回归（安装/四 preset roster/会话隔离/下单三态闸门/
  设置页/行情桥/布局）—— checklist 见 spikes/acceptance-all/REPORT.md 六项；
- [ ] 数据源 ToS 表（README）逐条复查仍成立（端点可用性、授权口径变化）；
- [ ] `@dshtrading/all` 元 bundle 限制复核：宿主版本是否已支持传递 bundle 展开
  （apps/cli/src/plugin.ts reconcilePlugins），支持则改回「单命令装齐」口径；
- [ ] secrets 审计：全仓 grep 无内置 key/token（凭证一律 BYOK ref，铁律 #3）；
- [ ] license 审计：client bundle 内联 lightweight-charts（Apache-2.0）与 fancy-canvas
  —— 分发物需附带相应 license 文本或 NOTICE（发布物形态定后落实）；
- [ ] 铁律 #5 合规复查：无缓存回传、无再分发；回测本地缓存若已落地，确认不回传
  不共享（2026-08-30 边界精确化口径）。

## 3. 文档与包面

- [ ] 各包 README 的「未实证/备选」标注复查（connector-stooq 等）；
- [ ] docs/ 三手册与实现一致（replication / connector-playbook / exchange-routing）；
- [ ] Agent Notes 活跃树无 proposed 遗留（要么落地要么 rejected）；
- [ ] changeset 为每个有行为变化的包写好发版说明。
