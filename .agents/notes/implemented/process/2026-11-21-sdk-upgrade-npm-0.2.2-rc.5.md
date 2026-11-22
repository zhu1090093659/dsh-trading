# Agent Note: SDK cohort 升级到 npm @deepseek-ai 0.2.2-rc.5

Status: implemented

## Problem

宿主 CLI 已经是 `0.2.2-rc.5`（npm 的 `latest` 与 `next` 都指向它，2026-11-18 发布），
而仓库 cohort 仍钉 `0.2.2-rc.1`。带 prerelease 的比较器只匹配同一 major.minor.patch
三元组（`satisfies("0.2.2-rc.5", ">=0.2.2-rc.1") === false`），floor 不随 cohort 前移
就是失真声明；profile 里残留旧世代实体拷贝时，`@deepseek-ai/*` 会以两个模块实例并存，
模块级 Symbol 注册表随之割裂（2026-09-01 实测过该类崩溃）。

## Decision

1. **cohort 整块搬移**：`pnpm-workspace.yaml` 的 `overrides` 78 条、`minimumReleaseAgeExclude`
   81 条全部钉到 `0.2.2-rc.5`。配套 cordis 家族本世代**未变**（cordis 4.1.0 / cosmokit 1.9.0 /
   schemastery 3.19.0 / cordis-plugin-loader 1.1.0 / include 1.1.0 / timer 1.2.0 / group 1.1.0），
   依据是 `@deepseek-ai/dsh@0.2.2-rc.5` 的依赖声明与 registry 逐包实证（70 个 dsh 包全部存在
   `0.2.2-rc.5`，0 个停发）。
2. **新增 `@deepseek-ai/dsh-error`**：它首次发布于 rc.4，rc.5 起是 `dsh-llm` 与
   `dsh-working-directory` 的精确 peer，`autoInstallPeers: true` 会物化它；不进 overrides
   与放行清单就是一个新世代缺口（会被发布冷却窗口挡回或落到别处）。同时把此前漏在放行清单外的
   三个传递包（`dsh-fs-patch` / `dsh-official-bundles` / `dsh-tool-executor-native`）一并补进。
3. **声明面前移**：49 个 `package.json` 共 99 条声明——peer floor `>=0.2.2-rc.1 → >=0.2.2-rc.5`
   77 条、编译期 devDep 精确钉同版本 20 条、根 `package.json` 2 条。lockfile 随之重算
   （+74/−74，importers 记的是 override 之后的生效 specifier）。
4. **宿主 floor 面同步**：`desktop/runtime/host/package.json` 钉 `@deepseek-ai/dsh@0.2.2-rc.5`；
   其 `pnpm-lock.yaml` 以 `--lockfile-only` 重算（9350 行，3037 处 rc.5 引用，0 处 rc.1）；
   `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 按解析后的宿主闭包整表重建 338 条
   （较上世代：删 7 个停发名——`dsh-experimental-agent-team` / `-profile` / `-tool-agent-team` /
   `-client-ui-agent-team` 三代更名 + `dsh-api-account-controller` / `dsh-deepseek-account-platform` /
   `dsh-office-to-pdf` 停发——新增 15 个 rc.5 新成员）。
   `desktop/scripts/build-runtime.mjs` 的 `REGISTRY_DEPENDENCIES` 删掉 `@deepseek-ai/dsh-web-search-exa`
   （rc.2 起停发，搜索改由 `dsh-base` 自带的 `dsh-web-search-deepseek` 承接；本仓无任何插件
   value-import 它，也没有 patch 行挂它）。`README.md` / `README_zh.md` 的 DSH Baseline 徽章与
   `docs/` 下四处基线口径同步。
5. **源码适配为零**：官方导出面在 rc.1→rc.5 是纯增量（24 个被消费包 0 删除、0 签名变化），
   `pnpm build` 直接通过，`typecheck-gate` 354 = 基线 354（零新增类型错误）。因此本轮没有
   任何「为通过编译而改源码」的动作。
6. **原生能力去重**（详见下节）：删掉设置侧插件分区借壳、设置打开的两档 DOM 兜底，把图表
   KDAS 右键菜单改挂官方 `ContextMenus`；定时任务平面按「官方装不下的四项义务」保留为薄扩展，
   并顺手修掉一个真缺陷。

## 官方变更记录（取证方式）

`gh api repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.2.2-rc.{2,3,4,5}` 四个 release body
与 `compare/dsh-v0.2.2-rc.1...dsh-v0.2.2-rc.5`（1587 commits；注意 compare 的 `files` 数组上限 300
条且不分页，不能当作完整文件清单）。破坏面集中在 rc.2 的「其他变更」小节：网页搜索换提供方、
AgentTeam 改统一具名子代理、工具失败改明确错误类型、PTC 按运行时限限流、Session 批量追加、
Computer Use 窗口/键盘/授权调整、Office 改原生工具、Zod 4.6.6 与 Stagehand 4.4.0 —— 逐项在
本仓核对后确认无消费面（本仓不读官方错误分类、不写 session log、不接 AgentTeam、不直连模型
API；zod 只作为传递依赖随 lock 从 4.4.3 跟到 4.6.6）。

## 去重台账（native 为基座）

| 官方能力 | 本仓原实现 | 本轮决定 | 判据 |
|---|---|---|---|
| 设置内插件分区 `dsh-client-ui-settings-plugins` | `client-ui-settings/plugins-host.ts`（CSS 变量钉矩形 + MutationObserver 抬 z-index）与 `PluginsSection.tsx` | **删除**（−240 行 + 分区/词典/测试一并退役） | 官方 web-app 已挂该分区；借壳是纯复刻 |
| 设置打开动作 `settings` 槽 store `open()` | store → `[aria-haspopup]` → 菜单文案匹配三档 | **删除后两档**，只留 store | 官方 store 是唯一权威；兜底是随宿主改版即碎的适配面 |
| 浮层定位 `dsh-client-ui-context-menu` | `kdas-menu.ts` 的 `clampRectInto` + `visibility:hidden` 量测帧 + 手写 left/top | **改挂官方**（target 家族 `dshtrading.kdas`），动作推导保留为薄扩展 | `ContextMenuTargetMap` 明示外部插件可扩展 target 家族 |
| 定时任务调度域 `dsh-schedule` | `packages/api` cron 解析 + `bot-api/src/tasks/*` 账本/runner/服务 + 右缘面板 | **保留为薄扩展**（人工确认门 / requestId 幂等 / 有界扇出 / 重启对账四项官方没有；面板是确认门的唯一 UI） | 官方 `ScheduleService` 无投递前否决钩子；且 `packages/api` 被浏览器端共用，不能 import 宿主侧 Node 包 |
| 交易域错误码 / 角色预设 / 插件更新器 | `TRADING_*` 词表、`base/presets.ts` 交易人设、`client-ui-updater` | **记录例外**（官方无对应面） | 官方错误分类正交、无交易角色、插件市场不覆盖离线 zip 与固定组版本校验 |

配套清理：`shell-pad.css` 的「借壳期间主面板保留布局盒」规则（规则 17）与 `quote-stage.module.css`
里 9 个 `.kdasMenu*` 死类删除（`.kdasMenuDot` 保留，官方 `contextMenu.icon` 槽仍在用）；
借壳的 Owning Note 移入 `archived/` 并标 superseded；KDAS 菜单 note 的钳位约束整条改写为
「定位归官方菜单服务」。

## 顺带修掉的缺陷

`bot-api/src/tasks/ledger.ts` 的 `armSchedule` 此前接受「语法合法但日历上永不匹配」的 cron
（如 `0 0 31 2 *`）：`isValidCron` 通过、`nextRunAtMs` 返回 `undefined`，于是存成
`enabled: true` 却永不触发且不留痕迹。现在与官方 occurrence 引擎同语义，在 create/update/
set-schedule 三条入口抛出既有的 `TASKS_CRON_INVALID`（停用路径不校验，保持「停用保留表达式」）。
回归用例 `tasks-ledger-hardening.test.ts`（先红后绿，8 条断言含「失败不落半武装任务」）。

## 已知缺口与后续

- **交易壳内没有可操作的插件管理入口**（owner 2026-11-21 裁决：接受并记录）。官方可装/可更新的
  插件页注册在 `sidebar.panellist`，而交易壳的 `shell-pad.css` 把侧栏整列压掉；设置里官方分区
  只有只读清单。补正式入口要走 `settings.plugins.tab` + `ctx.remote.pluginManager`，属新功能面。
- **定时任务整栈迁移的前置**：① `dsh-api-session-controller → dsh-client-connection` 这条传递
  peer 与「bot 不踩 web 栈」冲突；② 官方无投递前否决钩子。两项都记进
  [seam inventory](../../../../docs/design/dsh-seam-inventory.md) §B1。
- **死词条**：`kdas.menu.{title,listTitle,hint}` 与设置侧 `plugins.*` 共 27 行已无消费方，但
  `dsh-i18n` 的中央词典是构建产物，需与重建同批删除，本轮未动。
- **桌面 Windows lane 未在本机执行**（本机 Linux 无 mygo-windows 运行面）；本机以
  `node desktop/scripts/build-runtime.mjs` 证明载荷可在 rc.5 装配；CI 的 windows-latest 桌面 job 在同一
  提交上实跑通过（见下条）。
- **交易壳 GUI 面未验证**（见验收节）：`ui:check` 的 DOM 断言在本机全红且脚本挂死，未建立改动前
  基线，所以本轮对客户端改动的结论只到「单测 + 类型 + 构建」这一层。

## 发版（2026-11-22，v0.8.0）

按 owner 授权走完整通道（npm 家族 + Electron/mygo 安装包 + GitHub Release）：
tag `v0.8.0` → 提交 `bead16d2`（家族 59 包统一到 0.8.0，`verify-release-version` 通过）→
run `44971476507` 五个 job 全绿（check-version、npm-publish、macos、windows、mygo）→
Release 10 个资产（mac arm64/x64 的 dmg+zip、win x64 exe+zip、mygo arm64 dmg、SHA256SUMS.txt、
自动更新 feed 与 manifest）；npm 59/59 包 `0.8.0` 齐备、`latest` 指向 0.8.0；
`trading-update-v0.8.0.zip` 的 SHA256 与 SHA256SUMS.txt 一致。**这就把桌面钉版送达了用户**——
安装包内嵌的 runtime 由 `prepare-runtime`（`build-runtime.mjs`）在 `bead16d2` 上现生成，
该提交的 `desktop/runtime/host/package.json` 钉 `@deepseek-ai/dsh: 0.2.2-rc.5`。

## 验收（全部在本工作树与最终提交上现场跑过）

- `pnpm install --frozen-lockfile --ignore-scripts` → Already up to date；`pnpm peers check` →
  No peer dependency issues found；根 lock 中 `@deepseek-ai/*` 单一世代（rc.5 + cordis 家族）。
- `pnpm gates:all` → **17 通过 / 0 失败**（GATES_EXIT=0）：build、`-r test`、test:audit、
  test:scripts、test:desktop、coverage:check、patch-id:check、connector-dataplane:check、
  tool-contract:check、live-order:check、live-trading:check、i18n:check、home-guard:check、
  typecheck-gate（354 = 基线 354）、repo-boundary:check、ci-wiring:check、docs-link:check。
- `desktop/scripts/build-runtime.mjs` → "host cohort census: every dsh-* package is
  @deepseek-ai/dsh@0.2.2-rc.5"、"seed patch layer resolves: 4 inserted plugin row(s)"、
  "runtime payload ready: @deepseek-ai/dsh@0.2.2-rc.5"。
- profile cohort 对照（`DSH_HOME=~/.dsh-trading profile-cohort-check.sh trading-web`）：刷新前 7 FAIL
  （rc.1 影子拷贝），`refresh-profile.sh trading-web` 后降到 2 FAIL，再把 profile 自身
  `pnpm-workspace.yaml` 的 8 条 overrides 与放行清单从 rc.1 对齐到 rc.5 并重装 → **0 FAIL /
  9 WARN**（WARN 全是同版本实体拷贝，与宿主同世代，归一成 symlink 需停机，留作维护动作）。
- **GUI 级：未验证（环境阻塞，如实记）**。`pnpm ui:check`（`DSH_HOME=~/.dsh-trading`、
  `DSH_UI_CHROME=/usr/bin/google-chrome`）A 认证栅栏 PASS（未认证 401），但 D（交易面挂载
  `overlay=false watchlistRows=0`）/ B1 / C / E 四项 DOM 断言全红，且脚本在 E 之后挂死。定因证据：
  同一台机器上 headless Chrome 对 `file://` 页面 `--dump-dom` 正常，对本实例页面则超时吐不出 DOM；
  未能在预算内另建基线工作树整树构建做同环境对照。因此**交易壳 GUI 面按未验证处理**，不用单测结果
  冒充它。关闭方式：在能正常渲染的机器（或修好本机 Chrome 页面加载）上重跑 `pnpm ui:check`，先与
  改动前基线对照 D/B1/C/E——基线同样红则是环境问题；只有改动后红则按
  [upstream 检查清单](../../../../docs/ops/upstream-upgrade-checklist.md) §2「寄生 UI 面」逐项复核宿主
  DOM/slot 契约（`[data-shell-overlay]` 栅格锚点、`data-sidebar-collapsed`、
  `button[aria-label="选择工作区"]`）。
