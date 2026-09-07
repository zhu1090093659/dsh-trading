# Agent Note: 策略/选股器管理 PR 审查修复（#75/#76 合并前整改）

Status: implemented

## Problem

PR #75（策略管理）与 PR #76（选股器管理）审查发现 4 个 Medium + 若干 Low 问题，合并前统一修复：

- **M2（数据安全）**：删除/恢复已修改内置会永久销毁用户覆盖代码且无备份；GUI 删除确认文案「可随时恢复默认找回」误导（恢复只找回出厂代码）。
- **M1（校验缺口）**：`validateCustomScreener` 允许「全部试算场景都返回 null」的无用过滤器通过（guard/阈值笔误静默进入名册）。
- **M3（可用性）**：扫描循环在浏览器主线程同步执行自定义 evaluate，无超时——校验样例（~6 根）通过的死循环在真实 500 根 K 线上会永久卡死页面。
- **M4（测试声明失实）**：「行为等价」往返测试两侧都是新内联代码，只证明 toString/compile 保真，未对 indicators 包做语义对照。
- **Low**：DELETE id 未归一化（PUT/DELETE 不对称）；SSE 突发时旧 load() 响应覆盖新状态；`resolveStrategyDefinition` 对损坏记录抛裸编译错误（GUI 侧同 id 却回落出厂，两侧分歧）；选股器超时文案误写「策略试算」。

## Decision

- **覆盖丢弃一律先归档**：`CustomStrategyStore.remove(id, archive?)` / `CustomScreenerStore.remove(id, archive?)` 扩展（memory 版忽略，file 版追加 JSONL 到 `<path>.archive.jsonl`）；桥 DELETE/reset/save（覆盖顶掉旧覆盖前）与 strategy_delete/strategy_reset/screener_delete/screener_reset/screener_author 工具全部传 `archive: true`。归档失败仅告警不阻断（墓碑语义已生效）。**语义分工**：墓碑恢复出厂代码，归档找回用户代码——两者正交。
- **文案校准 + 恢复加确认**：confirmDelete/confirmOverride/confirmOverrideScreener 明示「修改保存后删除/恢复将不可找回（归档除外）」；已修改内置的「恢复默认」加 `window.confirm`（StrategyView + ScreenerPane 同款 `confirmRestore`）。
- **M1 闸门 + 长样例**：`validateCustomScreener` 追加第 6 个试算场景——300 根确定性长序列（涨→跌→涨多 regime + i%7===5 的 5 倍量脉冲，让 volume-breakout 类条件也有命中机会）；全场景（含长序列）皆 null → 拒绝并给出人话修复指引。长样例同时兜住长窗口内置选股器（above-ma 200 日等在 30 根短场景上合法全 null）与 `bars.length < N` 类 guard 笔误。
- **M3 扫描熔断**：`@dshtrading/strategies` re-export `workerComputeRunner`（client-ui-strategies 不新增 indicators 依赖）；ScreenerPane 扫描循环对**有源码的记录**（自定义 + 已修改内置）走 Worker + 1000ms/符号超时（校验样例 100ms 是 ~6 根小数据，真实 500 根放宽 10 倍）；内置代码常量维持同步直调（旧行为，无源码形态）。
- **M4 parity 测试**：management.test.ts 新增「内联 compute ≡ indicators 包重建」组——用 `@dshtrading/indicators` 的 ema/sma/rsi/bollinger 手工重建 5 个指标类范式的判定逻辑（循环起点/undefined 跳过/谓词逐条对照源实现），信号核心字段（index/time/action/direction/price）逐信号比对；reason/reasonKey 为文案层不在数学等价范围。
- **两侧一致化**：桥 DELETE `/strategies/custom`/`/strategies/screeners` id 归一化（trim+lowercase，与 PUT 对称）；`resolveStrategyDefinition` 编译失败回落出厂内置（自定义 id 回落 undefined），与 GUI 名册语义对齐；StrategyView/ScreenerPane load() 加 generation 令牌（SSE 突发只许最新一代落 setState）；扫描表头按 `scanScreener`（扫描开始时冻结的定义）渲染，SSE 中途换名册不再列错位。
- **顺手清偿**：client-ui-trading tsconfig.client 从 60 → 41（PR #74 合并带进的 5 个 implicit-any + fillComposer exactOptionalPropertyTypes + openSession branded cast 等 19 个既有债）；棘轮 484 < 504 通过。

## Consequences

- `~/.dsh/strategies/` 两个主存储文件各增 sidecar：`custom.json.archive.jsonl` / `custom-screeners.jsonl`——丢弃的 override 可从归档找回（无 GUI 入口，手工读文件；后续可加「归档历史」UI）。
- 校验场景从 5 → 6（浏览器 Worker 每次校验多跑一个 300 根样例，~100ms 级，可接受）。
- 内置选股器往返测试（5 个）在长样例下全部通过：rsi-oversold 在短场景命中，above-ma/near-high/ma-bull-align 依赖长样例，volume-breakout 依赖放量脉冲——长样例的量价结构是刻意设计的。
- 测试：strategies 116、client-ui-trading 297、client-ui-strategies 17 全绿；全仓 build/test/i18n/typecheck-ratchet 通过。