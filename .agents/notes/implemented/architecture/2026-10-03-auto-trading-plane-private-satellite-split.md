# Agent Note: 自动交易平面切分为私有卫星仓，主仓只留接缝

Status: implemented

## Problem

2026-10-03，公开仓 `zhu1090093659/dsh-trading`（PUBLIC，224 stars / 23 forks）在一次推送里带上了自动交易的全部实现——execution core（`tradectl`）、授权平面细分、驾驶舱、bot API、iOS 观测端与 deploy 单元。owner 的要求不是把仓库转私有，而是**把自动交易那部分隔离开、不开源，作为一个私有卫星仓**，同时主仓仍要保留"部署自动交易能力"。

## Decision

选定**甲 松耦合 + 方案 b 不重写公开历史**：不 force-push、不删 fork（已泄漏的历史无法收回，只能保证此后主仓不再含自动交易实现），改用**契约面接缝**把两侧分开。

边界按"谁能独立构建"划，而不是按"哪些文件提到 bot"划：

- **私有卫星仓** `dsh-trading-bot`：`packages/{bot,tradectl,cockpit,contract}` + `apps/ios-native` + `deploy`。
- **主仓（公开）**：辅助交易全量 + `packages/authority` + `packages/bot-api`。authority 是 fail-closed 实盘闸门，18 个公开连接器 `import { liveTradingEnabled }`——私有化会让公开仓无法独立构建；且闸门公开可审计本身是优点。bot-api 名字带 bot，但它是公开 GUI 的服务端半（`/dshtrading/api` 路由只有它注册），2026-10-03 桌面重建误移走后 GUI 左栏立即报「行情桥不可用」，故回迁。

## Seam

卫星仓对主仓 17 个公共包的依赖走 **vendor tgz**（`vendor/dshtrading-*.tgz`，沿用 `client-ui-special-indicators` 的既成先例），而非 npm 版本号。理由：npm 上的 `@dshtrading/api@0.5.0` 是**旧构建**，缺 `isValidCron` / `hasOpenExecution` 等后来加入的运行时导出——**版本号相同、内容不同**，直接依赖会让卫星仓 33 例测试失败。vendor 让边界变硬且不依赖发版授权。

主仓侧的接缝在 `desktop/scripts/build-runtime.mjs` 的 `SATELLITE_OWNED_PACKAGES`：自动交易包存在就装配进 profile，缺席即跳过（不再抛 "no packed tarball"）；`PROFILE_BUNDLES` 同步按实际装配结果裁剪，避免 profile 启动时 `ERR_MODULE_NOT_FOUND`。这样"主仓保留部署自动交易的能力，但不含其源码"。

## 代价与边界

- 耦合点变成 **vendor tgz**：主仓公共包一改，卫星仓要重新打包 tgz。已记录在卫星仓 README。
- **公开历史仍含自动交易代码**（方案 b 的既定代价，owner 已知悉并选择接受）。
- 门禁随之分工：`plane:check` / `bot-closure:check` / `contract-id:check` / `test:ios-evidence` / `e2e:smoke` 随实现迁往卫星仓，在主仓 `ci-wiring-check.mjs` 的 `INTENTIONALLY_UNWIRED` 里逐条记明原因——**豁免必须带原因，否则仍算漏接线**。

## 验证

主仓：`pnpm install` / `pnpm build` / `pnpm gates:all` 13 条门禁全绿（`coverage-baseline.json` 与 `typecheck-baseline.json` 按移除规模下调，走门禁自带的 `--force` / `--update` 显式路径）。

卫星仓：独立 `pnpm install` / `pnpm -r build` 通过；471 例测试 0 失败（bot 9、contract 84、cockpit 23、tradectl 355）；匿名访问 404 确认私有。卫星仓消费主仓打包的 `vendor/dshtrading-bot-api-0.5.0.tgz`（设计文档 §10 的 bot 平面本就含 base + bot-api + bot）。
