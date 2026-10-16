# Agent Note: 桌面 seed 的 patch 行必须解析得到——vendor 行补 DIRECT_TRADING_PACKAGES、registry 行补 REGISTRY_DEPENDENCIES

Status: implemented

## Problem

全新（桌面壳播种的）home 里宿主每轮启动都打：

```
dsh: warning: 1 entry did not activate
dsh-trading-client-ui-bot-gui (@dshtrading/client-ui-bot-gui): failed to import
```

后果不是一条警告：`client-ui-bot-gui` 是交易终端中栏「机器人」页签的 client 半，插件起不来那个页签整块没有（2026-10-15 用一个全新播种的 home 起桌面壳时实测，「行情/策略/知识库/特殊指标」都在，唯独缺「机器人」）。CLI 维护的 live profile 不受影响——它是 `dsh plugin add file:packages/client-ui-bot-gui` 直装的，它的 `package.json` 里本来就把该包列为直接依赖。

根因是桌面 seed 里三份东西不同步：tracked 的 `desktop/runtime/profile-trading/cordis.patch.yml` 有 insert 行、`PRIVATE_VENDOR_PACKAGES` 有该包（所以 vendor tarball 与 pnpm override 一直都在），但 `DIRECT_TRADING_PACKAGES` 漏了它。seed 的 manifest 由这份清单生成，pnpm 只按**依赖边**安装（overrides 只作用于已存在的边），于是该包从未进 `node_modules`，patch 行解析不到。

同样的坏法在 registry 插件上是第二个入口：profile 工作区按 `autoInstallPeers: false` 安装，peer 什么都不拉进种子，一个只被 patch 行引用的 registry 包同样不会进 `node_modules`。

## Decision

1. `@dshtrading/client-ui-bot-gui` 补进 `desktop/scripts/build-runtime.mjs` 的 `DIRECT_TRADING_PACKAGES`（与 `client-ui-special-indicators` 同款：私有包 + vendor tgz + patch insert 行）。
2. 同一个构建脚本加 `assertSeedPatchRowsResolve()`：staged seed 的 `cordis.patch.yml` 里每一条 `name:` 必须在 staged `node_modules` 里解析得到，否则**构不出载荷**。判据落在「解析得到」而不是「在清单里」，因此卫星仓 tarball、传递依赖等路径同样被覆盖；构建脚本既有的 seed 自洽断言（vendor 齐备、无构建机 pnpm 状态）与它同类。
3. registry 包走另一份清单。`REGISTRY_DEPENDENCIES` 声明 profile 直接依赖里来自 npm 的包：本轮 DSH 自带 Computer Use 的两行（`computer-use` / `computer-use-cua-driver-native`，`@deepseek-ai/dsh-computer-use` 与 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`，两者 `0.2.0-rc.2`）插在 `desktop/runtime/profile-trading/cordis.patch.yml` 的 profile 用户补丁层，两条依赖边补在这份清单里。
4. 那两行**不落 `packages/base`**：base 是市场无关共享行的家，但它同时被 `trading-dev`（4 条依赖）、`trading-all` 等 headless profile 挂载，那些清单里没有任何原生驱动依赖（`@trycua/cua-driver` 等），行插进 base 就在那边解析不到、宿主每轮 `failed to import`。桌面 seed 是唯一能补上这条依赖边的部署。
5. Computer Use 的部署约束写进 patch 层注释：一个部署只允许注册一个 computer-use provider（服务行持有唯一注册槽，原生 Cua Driver provider 占位，不得再挂 `…-cua-driver-mcp`）；挂载行本身不授予任何 macOS 权限——Screen Recording 与 Accessibility 属于启动宿主的应用（`DSH Trading.app`），缺授权时工具照常注册、调用被系统拒绝；截图走持久化附件，所以被选中的模型路由必须声明 image 输入。

## Verification

- 新判据对**修复前**的 staged seed 实测：`patch rows: @dshtrading/client-ui-special-indicators, @dshtrading/client-ui-bot-gui` → 前者 OK、后者 MISS，正是故障点（判据若早就在，这份载荷根本发不出去）。
- 重建后构建日志：`[build-runtime] profile seed self-contained: 14 vendored tarball(s)`、`[build-runtime] seed patch layer resolves: 2 inserted plugin row(s) present in node_modules`。
- 真机（无头，隔离 home）：把新 seed 拷进 `/tmp/<probe>/profiles/trading-web`、按桌面壳同一步骤跑 `normalizeProfileCohort`，再用应用自带的 `node-darwin-arm64` + 宿主 `bin.js --profile trading-web` 起宿主——`did not activate` 0 次、`failed to import` 0 次、token URL 正常打印、无 cookie 的 GET 仍是 401；带 token 换到 cookie 后取 GUI HTML，客户端批里出现 `@dshtrading/client-ui-bot-gui`（修复前该页签不存在）。探针 home 与宿主进程已清理。
- 已把重建后的 `profile-trading` 与 `VERSION.json`（`builtAt 2026-10-15T13:07:44Z`）刷进本机 `/Applications/DSH Trading.app/Contents/Resources/runtime`，两份 `client-ui-bot-gui/package.json` 与 `client-ui-updater/lib/github.js` 的 md5 与工作区载荷一致。
- 2026-10-16 加 Computer Use 两行后重建（`pnpm --dir desktop build-runtime`，exit 0）：`[build-runtime] seed patch layer resolves: 4 inserted plugin row(s) present in node_modules`（2 条 vendor 行 + 2 条 registry 行），staged seed 里 `@deepseek-ai/dsh-computer-use@0.2.0-rc.2`、`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.0-rc.2` 与传递依赖 `@trycua/cua-driver@0.28.0` 均在位，staged 清单含这两条依赖。
- registry 可解析性单独实测：空的 scratch 工作区按 seed 同一组安装参数（`nodeLinker: hoisted`、`autoInstallPeers: false`、`supportedArchitectures` darwin+win32 × x64+arm64）`pnpm install` 两包，exit 0、31 个包；两包与 `@trycua/cua-driver@0.28.0`、`zod@4.6.7`、`@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`、`@deepseek-ai/schemastery@3.18.4` 都解析到实体目录，然后删除 scratch。
- peer 闭包：两包的 peer（`@deepseek-ai/cordis`、`dsh-tools`、`dsh-system-prompt`、`dsh-brand`）按 `autoInstallPeers: false` 不进种子，运行期由宿主的 `$DSH_HOME/profiles/node_modules` 回退符号链接解析（本机实测四者均指向内置宿主树，4.0.4 / 0.2.0-rc.2）。

## Alternatives considered

- **"live profile 反正有，不管 seed"**：拒绝。桌面载荷存在的全部意义就是让全新机器/全新 home 直接可用；播种出来的 profile 缺一个页签正是这条链路的交付缺陷。
- **只在 patch 文件里写注释提醒**：拒绝。注释不是机制——这次的三个文件（patch 行、private vendor 集、直接依赖清单）本来就是靠人同步才漏掉的。
- **断言"patch 行 ⊆ DIRECT_TRADING_PACKAGES"**：弱一些。依赖可能在别的路径上被满足（卫星 tarball、传递依赖），断言解析结果既更准也更少假阳。
- **给 seed 装 patch 行时按行补装**：拒绝。安装语义应由 manifest 决定，运行期再补装等于把包管理搬进启动路径。
- **把 Computer Use 两行插进 base**：拒绝。base 被 headless profile 挂载，那边的清单没有原生驱动依赖，行会在那里解析不到——与本次事故同一个坏法，只是换了个部署受害。

## Consequences

- 桌面 seed 的 patch 层与依赖清单从此绑定：下次有人在 `cordis.patch.yml` 里插一行而忘了补依赖，构建阶段即失败并点名那个包。依赖边有两个来源，判据只有 `assertSeedPatchRowsResolve()` 一条：vendored 私有包漏 `DIRECT_TRADING_PACKAGES`、registry 插件漏 `REGISTRY_DEPENDENCIES`。
- 修复只影响全新 home 的播种结果与后续安装包；CLI 维护的 live profile 本来就正常，不受影响。
- 桌面壳的 profile 种子从此挂 DSH 自带 Computer Use，`cua_driver_native__*` 是交易会话的原生桌面操作面（[UI 验证手法](../process/2026-09-04-ui-verification-hosted-http-headless-chrome.md)依赖它在列）；宿主侧还需要 macOS 授权，挂载本身不给权限。
