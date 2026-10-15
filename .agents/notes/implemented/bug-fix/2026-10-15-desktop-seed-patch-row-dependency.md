# Agent Note: 桌面 seed 的 patch 行必须是 profile 依赖——「机器人」页签在全新 home 上整块消失

Status: implemented

## Problem

全新（桌面壳播种的）home 里宿主每轮启动都打：

```
dsh: warning: 1 entry did not activate
dsh-trading-client-ui-bot-gui (@dshtrading/client-ui-bot-gui): failed to import
```

后果不是一条警告：`client-ui-bot-gui` 是交易终端中栏「机器人」页签的 client 半，插件起不来那个页签整块没有（2026-10-15 用一个全新播种的 home 起桌面壳时实测，「行情/策略/知识库/特殊指标」都在，唯独缺「机器人」）。CLI 维护的 live profile 不受影响——它是 `dsh plugin add file:packages/client-ui-bot-gui` 直装的，它的 `package.json` 里本来就把该包列为直接依赖。

根因是桌面 seed 里三份东西不同步：tracked 的 `desktop/runtime/profile-trading/cordis.patch.yml` 有 insert 行、`PRIVATE_VENDOR_PACKAGES` 有该包（所以 vendor tarball 与 pnpm override 一直都在），但 `DIRECT_TRADING_PACKAGES` 漏了它。seed 的 manifest 由这份清单生成，pnpm 只按**依赖边**安装（overrides 只作用于已存在的边），于是该包从未进 `node_modules`，patch 行解析不到。

## Decision

1. `@dshtrading/client-ui-bot-gui` 补进 `desktop/scripts/build-runtime.mjs` 的 `DIRECT_TRADING_PACKAGES`（与 `client-ui-special-indicators` 同款：私有包 + vendor tgz + patch insert 行）。
2. 同一个构建脚本加 `assertSeedPatchRowsResolve()`：staged seed 的 `cordis.patch.yml` 里每一条 `name:` 必须在 staged `node_modules` 里解析得到，否则**构不出载荷**。判据落在「解析得到」而不是「在清单里」，因此卫星仓 tarball、传递依赖等路径同样被覆盖；构建脚本既有的 seed 自洽断言（vendor 齐备、无构建机 pnpm 状态）与它同类。

## Verification

- 新判据对**修复前**的 staged seed 实测：`patch rows: @dshtrading/client-ui-special-indicators, @dshtrading/client-ui-bot-gui` → 前者 OK、后者 MISS，正是故障点（判据若早就在，这份载荷根本发不出去）。
- 重建后构建日志：`[build-runtime] profile seed self-contained: 14 vendored tarball(s)`、`[build-runtime] seed patch layer resolves: 2 inserted plugin row(s) present in node_modules`。
- 真机（无头，隔离 home）：把新 seed 拷进 `/tmp/<probe>/profiles/trading-web`、按桌面壳同一步骤跑 `normalizeProfileCohort`，再用应用自带的 `node-darwin-arm64` + 宿主 `bin.js --profile trading-web` 起宿主——`did not activate` 0 次、`failed to import` 0 次、token URL 正常打印、无 cookie 的 GET 仍是 401；带 token 换到 cookie 后取 GUI HTML，客户端批里出现 `@dshtrading/client-ui-bot-gui`（修复前该页签不存在）。探针 home 与宿主进程已清理。
- 已把重建后的 `profile-trading` 与 `VERSION.json`（`builtAt 2026-10-15T13:07:44Z`）刷进本机 `/Applications/DSH Trading.app/Contents/Resources/runtime`，两份 `client-ui-bot-gui/package.json` 与 `client-ui-updater/lib/github.js` 的 md5 与工作区载荷一致。

## Alternatives considered

- **"live profile 反正有，不管 seed"**：拒绝。桌面载荷存在的全部意义就是让全新机器/全新 home 直接可用；播种出来的 profile 缺一个页签正是这条链路的交付缺陷。
- **只在 patch 文件里写注释提醒**：拒绝。注释不是机制——这次的三个文件（patch 行、private vendor 集、直接依赖清单）本来就是靠人同步才漏掉的。
- **断言"patch 行 ⊆ DIRECT_TRADING_PACKAGES"**：弱一些。依赖可能在别的路径上被满足（卫星 tarball、传递依赖），断言解析结果既更准也更少假阳。
- **给 seed 装 patch 行时按行补装**：拒绝。安装语义应由 manifest 决定，运行期再补装等于把包管理搬进启动路径。

## Consequences

- 桌面 seed 的 patch 层与依赖清单从此绑定：下次有人在 `cordis.patch.yml` 里插一行而忘了补依赖，构建阶段即失败并点名那个包。
- 修复只影响全新 home 的播种结果与后续安装包；CLI 维护的 live profile 本来就正常，不受影响。
