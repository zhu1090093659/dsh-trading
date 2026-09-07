# Agent Note: 策略 store 双实例收口（tradingStrategies Service 化）

Status: implemented

## Problem

`strategies/plugin.ts` 的 `apply()` 与 `client-ui-trading/src/index.ts` 各自 `createFileCustomStrategyStore(同一路径)`——两个实例、两份进程内缓存互不感知。后果（策略管理功能的正确性前提）：`strategy_author` 落盘后桥的 GET 读到陈旧缓存；桥 DELETE 后工具实例仍可回测已删策略；tmp+rename 双写互踩窗口。indicators / knowledge / holdings / watchlist 均已走 issue #33 的「能力包 provide Service + 桥解包 `.store`」收口，strategies 是唯一漏网。

## Decision

照 indicators 先例（`CustomIndicatorsService`）：`@dshtrading/strategies/plugin` 增 `StrategiesStoreService`（cordis Service，服务键 `tradingStrategies`），`apply()` 以 file store 单实例 provide；`client-ui-trading` 桥装配改为 `ctx.get('tradingStrategies')` 解包 `.store`（后续策略管理再补 `.tombstones`），服务缺席（老部署）回退自建同路径 file store（旧行为不劣化）。

## Consequences

- 工具写入与桥读取共享同一缓存与失效语义，跨实例 stale 窗口消除。
- 桥装配行不硬依赖新插件版本：Service 缺席时回退路径与 issue #33 各域一致，老部署零迁移。
- 教训固化：**新增持久化域时，file store 实例从第一天就 Service 化**——「先双实例跑起来、后收口」会留出难以复现的陈旧读窗口。
