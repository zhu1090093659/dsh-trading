# Agent Note: 桌面壳本地重建与 open 启动的 DSH_HOME 环境继承坑

Status: implemented

## Problem

桌面壳本地重建（应用最新客户端优化，如 87847d0 渲染收敛）时发现两个操作层事实：

1. 从 agent/harness 会话 shell 里执行 `open -a "DSH Trading"` 会把 shell 的环境变量带给 GUI app。harness 会话 shell 携带 `DSH_HOME=~/.dsh`，于是 app 内置缺省 home（`~/.dsh-trading`，见 2026-09-08-desktop-default-trading-home）被环境变量覆盖，app 转去处理 `~/.dsh/profiles/trading-web` 这个分家前的陈旧残留 profile；残留的 CLI 时代用户层 `cordis.patch.yml` 引用的 overlay 文件与重装后的 node_modules 不匹配，宿主在 `loadOverlayPatches` 崩溃（ENOENT），app 停在错误页。
2. `~/.dsh-trading/profiles/trading-web` 是 CLI 维护的 user-managed profile（无 `.dsh-desktop-seed.json` 标记，`profileAction` 判 `leave`），桌面壳不 reseed 它——重建 app 载荷后 GUI 服务的是 profile 里的包，需要单独确认它是否吃到新构建。

## Decision

- 本地重建后重启桌面壳，必须用干净环境启动：`env -u DSH_HOME open -a "DSH Trading"`，或让用户从 Dock 点开；禁止直接从可能携带 `DSH_HOME` 的 shell 裸 `open`。`open -a "DSH Trading" --env DSH_HOME=…` 仅作显式覆盖用途（AGENTS.md 已有此行，本条是它的反面案例）。
- 重建验证路径固化为：`cd desktop && npm run prepare-runtime && npm run dist:mac`，随后核对 `dist/mac-arm64/DSH Trading.app/Contents/Resources/runtime/VERSION.json` 的 `builtAt`，再替换 `/Applications`。
- profile 新鲜度不靠 mtime 猜：用 `shasum` 对比工作区 `packages/<pkg>/lib` 产物、`~/.dsh-trading/profiles/trading-web/node_modules`、staged 载荷、已安装 app 载荷四方内容。实证发现 profile 安装与工作区构建产物是 pnpm 硬链接耦合（同 inode），工作区 `pnpm -r build` 后 profile 直接共享新产物——这是本机 pnpm 行为的实证，不是契约，每次仍以哈希对比为准。

## 补充实证（2026-09-12 新市场 bundle 上桌面壳，PR #98 期货）

- **桌面壳不重建安装包也能吃新市场**：GUI 的行情/工具插件全部来自 `~/.dsh-trading/profiles/trading-web`（CLI 维护、`file:` 指工作区），应用自带 runtime 只承载 host 包与首次播种；「新 market bundle 生效」= 刷新该 profile + 干净重启，无需 `prepare-runtime`/`dist:mac`（后者只影响全新 home / 新装分发载荷；本次未重建，已装 app 仍为 2026-09-11T03:07Z 载荷）。
- **给 profile 加新 bundle 的正确姿势**：① `node scripts/sync-profile-overrides.mjs --profile trading-web`（新包的 `workspace:*` 依赖靠 overrides 解析）；② `dsh plugin --profile trading-web add file:<repo>/packages/<bundle>`——**必须显式 `file:`**，裸目录等价 `link:`，pnpm 不会安装其传递依赖（preset 行解析不到 kit 包，实测 `@dshtrading/kit-futures` 缺失）；③ `rm -rf <profile>/node_modules/@dshtrading/*` + `dsh plugin install` 刷新全部副本（file: 拷贝不随工作区重建自动跟进，哈希对比确认）；④ `scripts/profile-config-preflight.sh trading-web` 预检。`dsh plugin add` 会按包内 `dsh.bundle` 声明自动并入 `dsh.profile.bundles`，无需手改 marker。
- **DSH_HOME 从 agent shell 泄漏同样命中 CLI**：会话 shell 携带 `DSH_HOME=~/.dsh` 时，`dsh plugin ...` 的 profile 路径解析会走到旧 home `~/.dsh/profiles/trading-web`（help 输出实证）。所有 CLI 指令必须显式 `DSH_HOME="$HOME/.dsh-trading"`——wrapper `~/.local/bin/dsh-trading` 只在未设置时补缺省值，不会覆盖已泄漏的值。
- **base/presets 只写角色预设**（trader / instrument-researcher / risk-reviewer / master）：`~/.dsh-trading-presets/<market>-trader/` 是统一角色预设重构前的遗留目录，不再随新市场生成；新市场能力体现在角色预设的 connector/kit 行与技能白名单里（本次实测 `trader` 已含 futures 连接器行、kit 行与四技能白名单）。
- **验证链**（本次全过）：`/dshtrading/api/markets` 返回 `{"id":"futures","provider":"hithink"}`；`dsh --profile trading-web --dump-config` 可见 futures installer/dataplane 两行；桥 `/dshtrading/api/tickers?market=futures&symbols=RB00.SHF` 返回真实行情（3000/3020）与日K OHLC；headless 截图左栏「期货」页签渲染；profile 副本哈希与工作区一致；`@deepseek-ai/*`（含嵌套）全部归一为指向应用 runtime 的 symlink。

## Alternatives considered

- 给桌面壳加「检测到 DSH_HOME 指向非 trading home 时告警」的启动诊断：能兜底但为一个启动姿势问题改主进程启动逻辑，收益不抵面；先以操作纪律覆盖，若再撞同类坑再评估。
- 删除 `~/.dsh/profiles/trading-web` 残留：属用户数据清理，未获授权不执行；且它在 DSH_HOME=~/.dsh 显式覆盖场景仍有语义，只报告不动。
- 重建后顺手 reseed CLI profile（删标记重装）：多余——硬链接耦合已让 profile 拿到新构建，重装反而引入 cohort 漂移风险。

## Consequences

- 桌面壳从 shell 启动时继承的任何 `DSH_HOME` 都会压过内置缺省；排障时先看 `dsh-host.log` 的 `[desktop] dsh home:` 行确认实际 home。
- 「Failed to load plugins / failed to import loader entry」的真实根因是 dsh 会话 cookie 按端口累积、撑爆宿主请求头预算（HTTP 431），见 [auth cookie note](../bug-fix/2026-09-11-desktop-auth-cookie-header-overflow.md)；本条早期把同一现象归因于 profile cohort 链接漂移属误判——Electron cookie jar 持久化在 user-data-dir，重启 app 不清，归一后仍复现。
- `~/.dsh/profiles/trading-web` 残留现状：已被本次误启动 reseed 成新载荷 + 旧用户层 patch，处于「若用 DSH_HOME=~/.dsh 启动会崩 overlay」状态；正常 Dock 启动（`~/.dsh-trading`）不触碰它。
- 本次重建已交付：`dsh-trading-desktop-0.2.1-mac-arm64.dmg/.zip` 与已安装 `/Applications/DSH Trading.app` 均为 2026-09-11T03:07Z 载荷，GUI 实测渲染正常。
