# Agent Note: 桌面壳本地重建与 Electron 启动的环境继承坑（DSH_HOME / ELECTRON_RUN_AS_NODE）

Status: implemented

## Problem

桌面壳本地重建（应用最新客户端优化，如 87847d0 渲染收敛）时发现三个操作层事实：

1. 从 agent/harness 会话 shell 里执行 `open -a "DSH Trading"` 会把 shell 的环境变量带给 GUI app。harness 会话 shell 携带 `DSH_HOME=~/.dsh`，于是 app 内置缺省 home（`~/.dsh-trading`，见 2026-09-08-desktop-default-trading-home）被环境变量覆盖，app 转去处理 `~/.dsh/profiles/trading-web` 这个分家前的陈旧残留 profile；残留的 CLI 时代用户层 `cordis.patch.yml` 引用的 overlay 文件与重装后的 node_modules 不匹配，宿主在 `loadOverlayPatches` 崩溃（ENOENT），app 停在错误页。
2. `~/.dsh-trading/profiles/trading-web` 是 CLI 维护的 user-managed profile（无 `.dsh-desktop-seed.json` 标记，`profileAction` 判 `leave`），桌面壳不 reseed 它——重建 app 载荷后 GUI 服务的是 profile 里的包，需要单独确认它是否吃到新构建。
3. 同一继承通道还泄漏 `ELECTRON_RUN_AS_NODE=1`：harness 自身跑在 Electron 上，它派生的会话 shell 自带该变量。Electron 二进制识别到它就不再启动应用，改把主脚本当纯 Node 跑（main 脚本的 `require('electron')` 走普通模块解析即 MODULE_NOT_FOUND），症状是「点图标没反应/秒退」，且在 `dsh-host.log` 里零痕迹（崩在 `app.whenReady()` 建立日志流之前）。桌面壳只在 `childEnv` 里为自己派生的宿主子树删掉该变量（main.cjs），保护不到 shell 启动 app 这个方向。

## Decision

- 本地重建后重启桌面壳，必须用干净环境启动：`env -u DSH_HOME -u ELECTRON_RUN_AS_NODE open "/Applications/DSH Trading.app"`，或让用户从 Dock 点开（Dock 走 launchd 环境，不带会话变量）；禁止直接从可能携带这两个变量的 shell 裸 `open`。`open --env DSH_HOME=…` 只覆盖 home，其余变量照旧继承，所以发布抽查命令也要 `env -u ELECTRON_RUN_AS_NODE` 包一层（操作入口见 [dsh-trading-release skill](../../../skills/dsh-trading-release/SKILL.md) 第 5 节）。
- 重建验证路径固化为：`cd desktop && npm run prepare-runtime && npm run dist:mac`，随后核对 `dist/mac-arm64/DSH Trading.app/Contents/Resources/runtime/VERSION.json` 的 `builtAt`，再替换 `/Applications`。
- profile 新鲜度不靠 mtime 猜：用 `shasum` 对比工作区 `packages/<pkg>/lib` 产物、`~/.dsh-trading/profiles/trading-web/node_modules`、staged 载荷、已安装 app 载荷四方内容。实证发现 profile 安装与工作区构建产物是 pnpm 硬链接耦合（同 inode），工作区 `pnpm -r build` 后 profile 直接共享新产物——这是本机 pnpm 行为的实证，不是契约，每次仍以哈希对比为准。
- `~/.dsh-trading/profiles/trading-web` 归属不变，继续 CLI 维护：加包/刷新走 `scripts/sync-profile-overrides.mjs` + `dsh plugin --profile trading-web` + `scripts/refresh-trading-web-profile.sh`，app/runtime 与全新 home 走完整安装包。不为启用应用内「立即更新」增量而让桌面壳接管这个 profile（见 Alternatives considered）。

## 补充实证（2026-09-12 新市场 bundle 上桌面壳，PR #98 期货）

- **桌面壳不重建安装包也能吃新市场**：GUI 的行情/工具插件全部来自 `~/.dsh-trading/profiles/trading-web`（CLI 维护、`file:` 指工作区），应用自带 runtime 只承载 host 包与首次播种；「新 market bundle 生效」= 刷新该 profile + 干净重启，无需 `prepare-runtime`/`dist:mac`（后者只影响全新 home / 新装分发载荷；本次未重建，已装 app 仍为 2026-09-11T03:07Z 载荷）。
- **给 profile 加新 bundle 的正确姿势**：① `node scripts/sync-profile-overrides.mjs --profile trading-web`（新包的 `workspace:*` 依赖靠 overrides 解析）；② `dsh plugin --profile trading-web add file:<repo>/packages/<bundle>`——**必须显式 `file:`**，裸目录等价 `link:`，pnpm 不会安装其传递依赖（preset 行解析不到 kit 包，实测 `@dshtrading/kit-futures` 缺失）；③ `rm -rf <profile>/node_modules/@dshtrading/*` + `dsh plugin install` 刷新全部副本（file: 拷贝不随工作区重建自动跟进，哈希对比确认）；④ `scripts/profile-config-preflight.sh trading-web` 预检。`dsh plugin add` 会按包内 `dsh.bundle` 声明自动并入 `dsh.profile.bundles`，无需手改 marker。
- **DSH_HOME 从 agent shell 泄漏同样命中 CLI**：会话 shell 携带 `DSH_HOME=~/.dsh` 时，`dsh plugin ...` 的 profile 路径解析会走到旧 home `~/.dsh/profiles/trading-web`（help 输出实证）。所有 CLI 指令必须显式 `DSH_HOME="$HOME/.dsh-trading"`——wrapper `~/.local/bin/dsh-trading` 只在未设置时补缺省值，不会覆盖已泄漏的值。
- **base/presets 只写角色预设**（trader / instrument-researcher / risk-reviewer / master）：`~/.dsh-trading-presets/<market>-trader/` 是统一角色预设重构前的遗留目录，不再随新市场生成；新市场能力体现在角色预设的 connector/kit 行与技能白名单里（本次实测 `trader` 已含 futures 连接器行、kit 行与四技能白名单）。
- **验证链**（本次全过）：`/dshtrading/api/markets` 返回 `{"id":"futures","provider":"hithink"}`；`dsh --profile trading-web --dump-config` 可见 futures installer/dataplane 两行；桥 `/dshtrading/api/tickers?market=futures&symbols=RB00.SHF` 返回真实行情（3000/3020）与日K OHLC；headless 截图左栏「期货」页签渲染；profile 副本哈希与工作区一致；`@deepseek-ai/*`（含嵌套）全部归一为指向应用 runtime 的 symlink。

- **载荷重建的同版本陷阱（已修）**：`desktop/runtime/profile-trading/` 的生成 `pnpm-lock.yaml` 会把上一次打包的 tarball 完整性钉住——同版本号重打包时 pnpm 直接从 store 复用旧内容，新增文件静默缺失（2026-09-12 实证：新 `connector-hithink` tarball 含 `futures-plugin`，staged 安装仍只有旧 lib）。`build-runtime.mjs` 已在 profile install 前清掉生成态 `pnpm-lock.yaml` + `node_modules`（host 的 tracked lockfile 不受影响）。
- **本次载荷交付**：`prepare-runtime` + `dist:mac`；`VERSION.json builtAt 2026-09-12T03:32Z`、`trading` 清单含 `@dshtrading/futures`，包内 seed profile 含 futures/kit-futures 与 `connector-hithink/lib/futures-plugin.js`；产物 `dist/dsh-trading-desktop-0.2.1-mac-arm64.{dmg,zip}`（11:34）并替换 `/Applications/DSH Trading.app`（旧包备份 `/tmp/DSH-Trading-0.2.1-old-20260912.app`）。全新 home 冒烟（`open --env DSH_HOME=/tmp/…`）实测 seed 直接可用：`/markets` 返回 5 市场含 `futures:hithink`；用户 home 正常启动同样在线。

## 补充实证（2026-09-30：ELECTRON_RUN_AS_NODE 泄漏与「立即更新」通道不可用）

- **`open` 整份继承调用方环境（探针实证）**：临时 `.app`（`Contents/MacOS` 里一个 dump `env` 的 shell 脚本）由本会话 shell 启动，`FOO_MARKER`、`ELECTRON_RUN_AS_NODE=1`、`DSH_HOME=/Users/zcl/.dsh` 全部原样到达；`open --env DSH_HOME=/tmp/explicit` 只把 `DSH_HOME` 换成显式值，`FOO_MARKER` 与 `ELECTRON_RUN_AS_NODE` 照旧继承。所以「干净启动」必须剥掉两个变量，不能只靠 `--env`。
- **变量确实会废掉 Electron 启动**：`ELECTRON_RUN_AS_NODE=1 "/Applications/DSH Trading.app/Contents/MacOS/DSH Trading" -e …` 实测以 Electron 44.1.1 / Node 24.19.0 身份执行，`require('electron')` 走普通模块解析报 MODULE_NOT_FOUND——即被这样启动的桌面壳不进主进程、不开窗口。
- **交易壳派生的宿主确实干净**：在跑的宿主进程（app 自带 node 起的 `dsh … --profile trading-web`）`ps eww` 环境里没有 `ELECTRON_RUN_AS_NODE`，只有 `DSH_HOME=/Users/zcl/.dsh-trading`——`childEnv` 的删除对它生效；泄漏方向只有 harness 派生的会话 shell 向外启动 Electron 应用（本会话 shell 的父进程为 `/Applications/DeepSeek Harness.app`）。
- **桌面 profile 仍是 CLI 安装**：正常启动的 `dsh-host.log` 只有 `[desktop] normalized 14 core package link(s) to the bundled runtime`，没有 `profile action:` 行；profile 根无 `.dsh-desktop-seed.json`（`profileAction` 判 `leave`，桌面壳只做 cohort 归一）。
- **「立即更新」增量通道在该部署不可用**：updater 的 supported 门（[auto-update note](../feature/2026-09-05-auto-update-plugin.md) D5）= 上溯找到 seed 标记 + `node_modules/@dshtrading` 可写，无标记即 false。live 宿主 `GET /dshtrading/api/updater/state` 返回 `{"environment":{"familyVersion":"0.5.0","supported":false},"check":{"status":"idle","available":false},…}`，`~/.dsh-trading/trading-updater/state.json` 不存在（自动检查自关闭，从未跑过检查）；UI 在该状态不渲染检查/「立即更新」按钮，只给「当前环境不支持自动增量更新（仅 DSH Trading 桌面版支持）」+ 发布页链接。缺的是「profile 归桌面壳所有」的凭据，不是发布件：v0.5.0 Release 已附 `trading-update-v0.5.0.zip` 与 `updates-manifest-v0.5.0.json`。

## Alternatives considered

- 给桌面壳加「检测到 DSH_HOME 指向非 trading home 时告警」的启动诊断：能兜底但为一个启动姿势问题改主进程启动逻辑，收益不抵面；先以操作纪律覆盖，若再撞同类坑再评估。
- 删除 `~/.dsh/profiles/trading-web` 残留：属用户数据清理，未获授权不执行；且它在 DSH_HOME=~/.dsh 显式覆盖场景仍有语义，只报告不动。
- 重建后顺手 reseed CLI profile（删标记重装）：多余——硬链接耦合已让 profile 拿到新构建，重装反而引入 cohort 漂移风险。
- **给 CLI 维护的 profile 补 `.dsh-desktop-seed.json` 换 supported=true**：能点亮应用内增量，但等于把这个开发工作流 profile 交给桌面壳所有——下一次 runtime stamp 变更就按 reseed 语义整体重装 node_modules，覆盖 `file:` 工作区链接与 CLI 安装代数（[dual-dsh-scope-symbol](../bug-fix/2026-09-05-desktop-host-dual-dsh-scope-symbol.md) 已因此否决 app 独占/reseed profile），拒绝；桌面端更新继续走 CLI 刷新 + 干净重启。
- **只剥 `DSH_HOME`、不管 `ELECTRON_RUN_AS_NODE`**：只覆盖已实证的一半——探针证明 `open` 整份继承调用方环境，被继承的 `ELECTRON_RUN_AS_NODE=1` 直接把 Electron 应用降级为纯 Node，拒绝；两个变量一起剥。

## Consequences

- 桌面壳从 shell 启动时继承的任何 `DSH_HOME` 都会压过内置缺省；排障时先看 `dsh-host.log` 的 `[desktop] dsh home:` 行确认实际 home。
- harness 派生的 shell 启动 Electron 应用（`open`，或从该 shell 起的任何 Electron 进程）被 `ELECTRON_RUN_AS_NODE=1` 降级时，`dsh-host.log` 零痕迹：排查「点图标没反应」要先看启动 shell 的环境，而不是只看 home/profile。
- 本机桌面部署的应用内「立即更新」增量通道不可用（CLI 维护 profile 无 seed 标记）：桌面端拿新版 = `scripts/refresh-trading-web-profile.sh` 刷新 profile + 干净重启，app/runtime 走完整安装包。
- 「Failed to load plugins / failed to import loader entry」的真实根因是 dsh 会话 cookie 按端口累积、撑爆宿主请求头预算（HTTP 431），见 [auth cookie note](../bug-fix/2026-09-11-desktop-auth-cookie-header-overflow.md)；本条早期把同一现象归因于 profile cohort 链接漂移属误判——Electron cookie jar 持久化在 user-data-dir，重启 app 不清，归一后仍复现。
- `~/.dsh/profiles/trading-web` 残留现状：已被本次误启动 reseed 成新载荷 + 旧用户层 patch，处于「若用 DSH_HOME=~/.dsh 启动会崩 overlay」状态；正常 Dock 启动（`~/.dsh-trading`）不触碰它。
- 本次重建已交付：`dsh-trading-desktop-0.2.1-mac-arm64.dmg/.zip` 与已安装 `/Applications/DSH Trading.app` 均为 2026-09-11T03:07Z 载荷，GUI 实测渲染正常。

## 补充实证（2026-10-03：把工具面优化带上桌面壳）

工具注入面优化（R3-B1 Batch 1 输出声明化、S1 描述口径收敛）落地后，桌面端分两条通路吃新版，两条都要各自确认：

- **live profile 通路（桌面壳实际服务的那个）**：GUI 的行情/工具插件全部来自 `~/.dsh-trading/profiles/trading-web`，它不是桌面壳 seed、`profileAction` 判 `leave`，所以 app 重建不影响它。刷新按本记录「补充实证（2026-09-12）」一节的四步（`sync-profile-overrides` → `dsh plugin add file:` → `rm -rf node_modules/@dshtrading/*` + `dsh plugin install` → `profile-config-preflight`），或直接 `scripts/refresh-trading-web-profile.sh`。本次先修了该脚本被死路径挡住的问题（`@dshtrading/bot` 残留，见工具面 Note），刷新后 `base/lib/market-tools.js` 与工作区构建产物 md5 一致。
- **app 自带 seed 通路（全新 home / 新装分发）**：`desktop/resources/runtime/profile-trading` 也要重建，否则新机器播种的是旧载荷。本次 `npm run build-runtime` + `npm run dist:mac`，`VERSION.json` `builtAt 2026-10-03T06:42:18Z`、`profileHash 56ef2856…`；产物 `dsh-trading-desktop-0.2.1-mac-arm64.{dmg,zip}`（`dist/`），已安装 `/Applications/DSH Trading.app` 一并替换（旧包备份 `/tmp/DSH-Trading-0.5.0-old-20261003144557.app`）。脚本已按第 28 行的同版本陷阱在 install 前清生成态 lock+node_modules。
- **验证（本次实测）**：安装位 `profile-trading/.../base/lib/market-tools.js` 与工作区构建产物 md5 同为 `1be4a276…`；`desktop npm test` 29/29；干净启动（`env -u DSH_HOME -u ELECTRON_RUN_AS_NODE open`）后 `dsh-host.log` 出现 `GUI ready`，tokenized URL `curl` 得 303，带 cookie 的 `/dshtrading/api/markets` 返回六市场 `crypto:okx / us:yahoo / cn:tencent / hk:tencent / futures:hithink / global:jin10`；headless Chrome 截图 1600x1000 实测渲染（左栏自选、行情/策略/知识库/特殊指标页签、空态提示），非空白页（unique colors 1571、主色占比 0.949）。冒烟用的临时实例已停止，临时 home 已清理。
- **口径边界**：本次只验证「桌面壳起来、六市场在、UI 正常渲染」这条链路；不构成对"桌面内实际调工具返回值形状"的运行时验收——那属于 headless 侧已记录的证据范围。
