---
name: dynamic-capabilities
description: 一次性批量计算/跨标的聚合与可复用小工具的官方通路指南：0.1.7 宿主已移除 cordis_define/cordis_run 动态包，一次性需求用 bash 跑即弃脚本，可复用助手走官方 cordis preset + Plugin Manager 持久化插件；含优先关系与交易安全边界（禁止规避下单闸门）。
---

# 动态能力指南（dynamic-capabilities）

0.1.7 宿主已移除 `cordis_define` / `cordis_run` 动态包工具（`@deepseek-ai/dsh-tool-cordis`
只剩只读巡检 `cordis_inspect_*`，且由官方 `cordis` preset 挂载）。本技能指导在 trading
profile 中用官方通路完成同类需求。

---

## 1. 需求分流

**数据型、一次性、临时**——现有工具面没有现成能力、且不值得沉淀为正式工具时：

- **临时批量计算**：「把自选列表所有标的的 RSI14 算一遍并排序」；
- **跨标的聚合分析**：「对比自选列表里所有港股的年初至今涨幅，输出表格」；
- **一次性小工具 / 格式转换**：「这个 CSV 两列算相关系数」「回测流水转 markdown 表」。

通路（按会话工具面选择）：

1. **master 角色会话**：master 预设挂有 bash 行——写一个即弃脚本（node/python）执行，
   结果直接回话。脚本不落盘到仓库工作区（用 `/tmp` 或会话临时目录），跑完即弃。
2. **官方 `cordis` preset 会话**：自带 `cordis_inspect_*` 巡检工具、`cordis-plugin-development`
   技能与 Plugin Manager 工具面，适合需要查看宿主服务面再动手的场景。

**可复用小工具**（会被反复使用）→ 不再现场定义：按官方 `cordis-plugin-development`
流程写成持久化 Cordis 插件，经 Plugin Manager 安装进 profile（跨会话存活，比旧动态包
的 session-scoped 更强）。写包前先读 `cordis_inspect_list` 的服务面输出。

## 2. 什么时候不用（优先关系）

**能用手写工具/注册表解决的不写脚本**（成本从低到高依次选择）：

1. 单标的指标计算 → `<market>_get_indicators`（已内置全市场 + 自定义指标）；
2. 策略回测 → `strategy_backtest`（8 指标 + 交易流水，勿自写回测——引擎语义已含
   手续费/滑点/净值处理，重写只会引入不一致）；
3. 自选/选中操作 → `watchlist_add` / `watchlist_select`（驱动 GUI 实时刷新）；
4. 知识检索 → `knowledge_search` / `knowledge_graph`；
5. 以上都不覆盖、且逻辑值得复用 → 先考虑 `indicator_author` / `strategy_author`
   沉淀为正式能力（有校验器、有 UI 名册、可持续复用）；
6. 逻辑值得复用且超出指标/策略范式 → 官方 cordis preset 写持久化插件；
7. 以上都不满足的一次性需求 → 才写即弃脚本。

## 3. 安全边界（红线）

- **bash 信任级**：即弃脚本与 shell 命令同信任级——不引入用户未要求的副作用
  （网络写、文件删除等），不落盘仓库工作区。
- **持久化插件走官方审批面**：Plugin Manager 安装是用户可见、可卸载的持久变更，
  安装前说明用途；不得借脚本绕过安装面把持久代码写进 profile。
- **禁止用于规避下单闸门**（纪律红线）：脚本与插件不得调用 `TradeService.placeOrder/
  cancelOrder` 试图绕过工具层审批——服务缝闸门（P0）已在 `liveTrading !== true`
  时于 TradeService 实现内 fail-closed，绕过工具层也拿不到实盘路径；但**纪律上仍然
  禁止**任何以下单为目的的脚本/插件（bash 信任级不应触碰资金面）。
- **能复用既有数据面工具就不写脚本**：手写工具带校验器与注册表上下文，输出质量
  通常高于即弃脚本。

## 4. 典型流程

1. 判断一次性 vs 可复用（§1），先过 §2 优先关系；
2. 一次性：master 会话写即弃脚本经 bash 执行；需要确认宿主服务面时切官方 `cordis`
   preset 用 `cordis_inspect_list` / `cordis_inspect_query` 查看；
3. 可复用：官方 `cordis` preset 按 `cordis-plugin-development` 写插件 → Plugin Manager
   安装 → 切回交易角色使用；
4. 结果直接回话；一次性产物即弃，持久化产物随 profile 管理。

## 5. 与本仓工具面的关系速查

| 需求 | 首选 | 写脚本/插件？ |
|---|---|---|
| 算指标（单/多标的） | `<market>_get_indicators` | 仅批量跨标的聚合时 |
| 策略回测 | `strategy_backtest` | 否 |
| 自选/切图 | `watchlist_add` / `watchlist_select` | 否 |
| 知识沉淀/检索/图谱 | `knowledge_ingest` / `knowledge_search` / `knowledge_graph` | 否 |
| 搜标的 | `instruments_search` | 否 |
| 看路由状态 | `routing_get` | 否 |
| 一次性聚合/转换 | bash 即弃脚本 | ✅（即弃） |
| 可复用助手 | 官方 cordis preset + Plugin Manager | ✅（持久化） |
