# Agent Note: 指标按标的显示/隐藏（symbol visibility）

Status: implemented

## Problem

激活名册的指标开关是全局联动的（issue #63 模型）：在一个标的上开启某指标，切到任何标的它都开启。有些自定义指标只适用于特定市场/标的（如自定义「K大师」只适合港股与 A 股，对美股/加密不合适），需要按标的独立开关显示。

## Decision

`IndicatorInstance` 增加可选 `hiddenScopes?: string[]`——隐藏作用域键两级：「market」（整市场，如 `"us"`）与「`${market}:${symbol}`」（单标的）。命中任一作用域即对该标的隐藏；无隐藏记录 = 跟随全局激活（默认可见），存量名册零迁移。**隐藏 ≠ 取消激活**：实例仍在名册（每 id 单实例 SSOT 不变），只影响渲染。

- 共享助手（@dshtrading/indicators）：`isInstanceVisibleOn(instance, market?, symbol?)` 读侧判定；`withHiddenScopes(instance, scope, visible)` 纯函数切换（幂等，清空后字段整体消失）；`sanitizeInstance` 扩展清洗 hiddenScopes（非空串去重，坏值整字段丢弃），内存/文件 store 与迁移导入全链路保真。
- 写入边界：
  - GUI 复选框/快捷词条 = 当前标的开关：关→记隐藏；开→清隐藏；未挂载→全局挂载；无聚焦标的退回全局开关（旧语义）。共享 handler `toggleIndicatorVisible`，QuoteStage 内 `visibleInstances` memo 是唯一过滤点（图表调度/读数行/发 Agent 快照标题与读数/快捷词条/勾选态全部消费它）。
  - GUI 行内「全局移除」按钮（带确认）= 原 togglePreset 全局卸载语义，保留「关掉所有标的」入口。
  - `indicator_activate(id, market, symbol)` = #72 写参数覆盖语义 + 清除该标的两级隐藏（显示 + 写覆盖）。
  - `indicator_deactivate(id, market, symbol?)` = scope 隐藏（market 级 / symbol 级），实例缺席 no-op 不反向创建；无 scope 仍为全局卸载。
  - 桥 `PUT /chart/indicators` 新增 `visible:boolean`：仅 market 即整市场、market+symbol 即单标的；实例缺席幂等 no-op；visible 缺 market 业务拒绝；不带 visible 时维持 #72 行为（params 覆盖/clearSymbol/全局写，半参仍 `TRADING_INVALID_SCOPE`）。
- 同步链：chart-state 新方法 `setSymbolVisibility(id, market, symbol, visible)`（GUI 只写 symbol 级），host-chart-sync host-first 接管（PUT visible → 成功才改本地镜像）；桥 PUT 成功/工具 onWritten 走既有 emit('chart')，零新增 SSE 接线。

## Alternatives considered

- **按标的独立激活名册**（每标的一份挂载清单）：切换语义直白，但破坏「每 id 单实例」SSOT（参数覆盖、编辑器、instanceKey 都假设单实例），新标的默认名册语义不明，全局开/关与按标的开/关互相打架。否决。
- **仅单标的粒度**：模型最简，但「只适用于港 A」类指标要在每个美股/加密标的上逐个手动关一次，与其动机（市场级不适用）不匹配。加 market 级后 agent 一条 `indicator_deactivate(id, market:'us')` 即可。
- **复选框渐变语义**（首次关=全局卸载，已有隐藏表后=按标的）：省一个按钮，但「保留港 A、只关美加」无法表达（首次关就全局没了）。否决，改为复选框专职按标的 + 行内显式「全局移除」。

## Consequences

- 预置与自定义指标均可按标的隐藏；`indicator_list` 的 active 名册自动带出 hiddenScopes（agent 可读当前隐藏状态）。
- GUI 复选框语义从「全局开关」变为「当前标的开关」——旧全局关路径收敛到行内「全局移除」按钮与 `indicator_deactivate`（无 scope）。
- 隐藏的实例仍占名册与 localStorage/host 存储；「显示但参数不适用」由 symbolParams（#72）与 hiddenScopes 正交组合表达。
- 测试：indicators 包 hiddenScopes sanitize/可见性助手/withHiddenScopes/store 保真 + deactivate 三种 scope 形态 + activate 清隐藏；client-ui-trading 桥 visible 写入（symbol/market 级、缺席 no-op、缺 market 拒绝）、import 保真、chart-state setSymbolVisibility。门禁 pnpm build / pnpm test / i18n:check 全绿。
