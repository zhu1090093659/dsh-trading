---
name: dynamic-capabilities
description: dsh-tool-cordis 动态包使用指南：何时用 cordis_define/cordis_run 定义一次性动态包（临时批量计算、跨标的聚合分析等数据型需求），何时不用；信任级、生命周期与安全边界（禁止规避下单闸门、浏览器半必须人工审批）。
---

# dsh-tool-cordis 动态包使用指南（dynamic-capabilities）

本技能指导 Agent 在 trading profile 中正确使用宿主内置的 `@deepseek-ai/dsh-tool-cordis`
动态包能力（`cordis_inspect_*` / `cordis_define` / `cordis_run` / `cordis_stop` /
`cordis_undefine`）：模型可定义含宿主半 + 浏览器半的动态包并激活，实现一次性小工具的
自举执行。

---

## 1. 什么时候用动态包

**数据型、一次性、临时**的需求——现有工具面没有现成能力、且不值得沉淀为正式工具时：

- **临时批量计算**：如「把自选列表所有标的的 RSI14 算一遍并排个序」（单次 get_indicators
  只对一个 symbol；批量循环用动态包一次完成）；
- **跨标的聚合分析**：如「对比自选列表里所有港股的年初至今涨幅，输出表格」；
- **一次性小工具**：如「把这个 CSV 的两列算个相关系数」「对某策略回测结果做自定义统计」；
- **格式转换/数据搬运**：如「把刚才回测的交易流水转成 markdown 表格」。

## 2. 什么时候不用（优先关系）

**能用手写工具/注册表解决的不开动态包**（成本从低到高依次选择）：

1. 单标的指标计算 → `<market>_get_indicators`（已内置全市场 + 自定义指标）；
2. 策略回测 → `strategy_backtest`（8 指标 + 交易流水，勿自写回测——引擎语义已含
   手续费/滑点/净值处理，重写只会引入不一致）；
3. 自选/选中操作 → `watchlist_add` / `watchlist_select`（驱动 GUI 实时刷新）；
4. 知识检索 → `knowledge_search` / `knowledge_graph`；
5. 以上都不覆盖、且逻辑值得复用 → 先考虑 `indicator_author` / `strategy_author`
   沉淀为正式能力（有校验器、有 UI 名册、可持续复用）；
6. 以上都不满足的一次性需求 → 才用动态包。

## 3. 安全边界（红线）

- **信任级 = bash**（官方声明）：动态包宿主半的代码与 shell 命令同信任级，写包前
  三思内容，不引入用户未要求的副作用（网络写、文件删除等）。
- **session-scoped、重启即散**：动态包不跨会话存活；不要用动态包做任何需要持久化
  的事情（持久化请用 indicator_author / strategy_author / knowledge_ingest）。
- **浏览器半必须走人工审批**：定义含浏览器半的动态包时，宿主会弹审批卡——这是
  预期行为，不得试图绕过；headless 部署无审批应答者时浏览器半天然不可用。
- **禁止用于规避下单闸门**（纪律红线）：动态包不得调用 `TradeService.placeOrder/
  cancelOrder` 试图绕过工具层审批——服务缝闸门（P0）已在 `liveTrading !== true`
  时于 TradeService 实现内 fail-closed，绕过工具层也拿不到实盘路径；但**纪律上仍然
  禁止**任何以下单为目的的动态包（信任级等同 bash 的包不应触碰资金面）。
- **能复用既有数据面工具就不开动态包**：动态包的宿主半没有 skill/注册表上下文，
  输出质量通常低于手写工具。

## 4. 典型流程

1. `cordis_inspect_*` 查看当前会话可用的服务面（如 tradingCryptoMarketData）；
2. `cordis_define` 定义动态包：宿主半 inject 所需服务（如注册表行情服务）+ 浏览器半
   （如需 GUI 呈现，会触发人工审批）；
3. `cordis_run` 激活执行，读取返回结果；
4. 结果直接回话（或经工具链二次加工）；一次性需求无需 undefine（session-scoped）。

## 5. 与本仓工具面的关系速查

| 需求 | 首选 | 动态包？ |
|---|---|---|
| 算指标（单/多标的） | `<market>_get_indicators` | 仅批量跨标的聚合时 |
| 策略回测 | `strategy_backtest` | 否 |
| 自选/切图 | `watchlist_add` / `watchlist_select` | 否 |
| 知识沉淀/检索/图谱 | `knowledge_ingest` / `knowledge_search` / `knowledge_graph` | 否 |
| 搜标的 | `instruments_search` | 否 |
| 看路由状态 | `routing_get` | 否 |
| 一次性聚合/转换 | —— | ✅ |
