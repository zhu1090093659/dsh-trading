# Agent Note: 指标激活实例按标的参数覆盖（symbolParams）

Status: implemented

## Problem

某些自定义指标的参数天然是按标的的（锚点类指标：每个标的有自己的一套锚点参数）。激活名册原模型是「每 id 一个实例一套全局 params」（issue #63），切标的后参数不变，这类指标无法按标的区分，退化为所有标的共用一套参数。

## Decision

`IndicatorInstance` 增加可选 `symbolParams: Record<"${market}:${symbol}", Record<string, number>>`（issue #72）：命中当前标的时该套参数**整体替代**全局 params，无覆盖回退全局。覆盖记录始终是 clamp 后的完整参数集（clampActivationParams 缺失键补默认值），不存在「部分覆盖再合并」的歧义。

- 存储层：`sanitizeInstance` 统一深拷贝规范化（symbolParams 非法键/值只丢该字段不连累实例），内存/文件 store 与迁移导入（parseChartInstances 行保留语义不变）全链路保真。
- 写入边界：bridge `PUT /chart/indicators` 与 `indicator_activate` 工具接受 market+symbol 写单标的覆盖（clearSymbol 删除）；不带 scope 写全局 params 且保留已有覆盖（修复旧行为整体覆盖会抹掉 symbolParams 的隐患）。**新实例的首个按标的写入，其全局 params 取 schema 默认值**——首个标的的覆盖不得泄漏成全局值。
- 客户端：QuoteStage 计算指标用 `effectiveInstanceParams(instance, market, symbol)`；参数编辑器初值 = 当前标的生效参数，存在覆盖时展示「专属参数」提示（i18n key indicator.symbolOverride）；Apply 在已有覆盖时写覆盖、否则写全局。chart-state.setParams 增加可选 scopeKey，host-chart-sync 解析 scopeKey 透传 bridge。

## Alternatives considered

- **compute 第三参传 {market, symbol} 上下文、指标源码内嵌「标的→参数」映射**：改动最小（不动存储/桥/工具），但每次参数更新都要重新创作指标源码落库，参数脱离激活名册 SSOT，且映射表随源码分发，维护性与隐私边界都更差。
- **部分覆盖（只存差分键、渲染时与全局合并）**：省存储但引入合并语义与「全局改键后覆盖意图漂移」的歧义；整体替代心智模型简单且 clamp 本就补全 schema。

## Consequences

- 通用机制，预置与自定义指标均可按标的调参；`indicator_list` 的 active 名册自动带出 symbolParams。
- GUI 暂不能在「无覆盖的标的」上直接创建覆盖（走 agent 工具或 bridge），编辑器提示只在已有覆盖时出现——后续如需 GUI 建覆盖，加「仅当前标的」开关即可，数据模型已就绪。
- 测试：indicators 包 4 个 symbolParams 用例 + activate 工具按标的写/全局保留用例；client-ui-trading 桥端点 scope/clearSymbol/import 保真用例、chart-state scopeKey 用例。门禁 pnpm build / pnpm test / i18n:check 全绿。

## Review hardening（2026-09-07 PR #73 复审修正）

自查发现四个旁路问题，同分支修复：

- **indicator_author activate:true 重挂不再抹覆盖**（tool.ts）：与 indicator_activate 全局写同语义——保留已有 symbolParams；re-author 改 schema 时按**新 schema 重 clamp** 每套覆盖（旧键丢弃、缺键补默认、越界收敛），stale 覆盖不直通 compute。
- **读侧 clamp 兜底**（QuoteStage）：compute 前对生效参数按当前 definition schema 再 clamp（`indicators.clampParams`）——任何路径漏进的 stale 覆盖（手改 localStorage、老版本迁移）在渲染层最后收敛。
- **bridge 半参 scope 业务拒绝**（`TRADING_INVALID_SCOPE`）：market/symbol 只给其一原来会静默落**全局**写（影响所有标的）；现与 indicator_activate 工具同规则成对校验。
- **clearSymbol 对未挂载 id 是无操作**：原来会反向创建 schema 默认实例挂上图；现直接返回当前名册不写 store。

裁决：bridge / indicator_activate 的全局写**保留**（不重 clamp）已有覆盖——读侧 clamp 已兜住渲染，store 保持「哑存储 + 写入边界 clamp」分层，避免每次写都隐式改写无关标的数据。
