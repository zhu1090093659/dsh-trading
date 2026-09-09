# Agent Note: FX 汇率取数同 base 在途去重

Status: implemented

## Problem

`createFxService.getRates`（`packages/holdings/src/fx.ts`）缓存过期瞬间，并发调用各自独立打一轮 frankfurter 上游 + 重写缓存文件——多标签页/多面板的 `/fx` 轮询在 1h TTL 到期后必然撞出重复请求。桥内基本面路径早有同键 in-flight 去重先例（bridge.ts:1189-1224），FX 路径没有（只读审计 P5）。

## Decision

`fx.ts` 加 `inflight: Map<FxBase, Promise<FxCacheEntry>>`：miss 时在途已有同 base 任务则直接共享其结果；创建者分支内 await+finally 负责清理（不挂裸 .finally 派生 promise，避免未处理拒绝）。失败时各并发方各自进入既有失败链（过期内存 → 文件缓存 → 恒等兜底），语义不变。桥内兜底 fetcher（`createFallbackFxFetcher`）复用同一 `createFxService` 单实例，自动继承去重，无需改动。

## Alternatives considered

- **桥层 /fx 端点处去重**：host 注入正式 fetcher 时桥层根本不经手实现（`host.fetchFxRates ?? fallback`），去重放在服务层才能同时覆盖 `fx_get` 工具与桥端点两条通路，否决桥层方案。
- **失败也共享兜底结果**：各调用方独立走失败链是现状语义（内存态可能不同），共享失败结果会扩大变更面，否决。

## Consequences

- 行为变化：同 base 并发 miss 只打一轮上游、写一次缓存文件；并发方拿到同一份 fresh 结果。
- 测试：`fx.test.ts` +2 例——同 base 并发只一轮上游（挂起 20ms 的 mock fetch 制造真实重叠，tracker 计数）+ 失败并发各自兜底且清理后可重试；包级 76 用例全绿。
- 收益量级：TTL 到期瞬间的并发浪费从 N 轮上游降为 1 轮（base 白名单 3 个，绝对量小；风险为零，改动 10 行）。
