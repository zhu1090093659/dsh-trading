# Agent Note: 指标适用范围（applyScope：按市场独立开关 + 独立 K 线级别选择）

- 日期：2026-10-09
- 状态：已实现（feature）
- 归属：本 note 拥有「指标适用范围的存储契约与读侧判据」。参数按标的覆盖归 [symbol-params](2026-09-07-symbol-params.md)，按标的显示/隐藏归 [symbol-visibility](2026-09-07-symbol-visibility.md)；三者正交，同一实例可叠加。

## 背景

指标激活名册是「每 id 单实例、所有标高所有周期都画」（issue #63）。实践里同一指标往往只在一部分市场或一部分周期上有意义：EMA 只在美股日 K 与港股 15m 用，加密与 A 股不需要。此前只能靠 hiddenScopes 按标的隐藏，或干脆全局卸载，表达不了「在哪个市场的哪个 K 线级别生效」。

## Decision

`IndicatorInstance` 增加可选 `applyScope?: Record<market, { enabled: boolean; intervals: string[] }>`：**每个市场一份独立配置**（该市场是否启用 + 在该市场适用的 K 线级别列表），不是所有市场共用一套级别集合。

**缺席语义（零迁移的关键）**：`applyScope` 整个字段缺失、或某市场没有条目 = 该市场**全部级别应用**。因此存量名册（无此字段）与新建实例（默认无此字段）行为完全不变，无迁移；只有用户显式改过的市场才落条目。

**空选择 ≠ 全部**：`{ enabled: true, intervals: [] }` 表示「该市场启用但未选任何级别」= 该市场不应用，界面显式显示「未选择级别」。判定实现上走「长度 0 直接不命中」，不写任何 fallback 成全部的分支。

**生效判据 = 三者同时满足**：指标自身已启用（在名册）+ 当前市场 `enabled` + 当前 K 线级别在 `intervals` 内。关掉某市场只停应用，**实例、参数与已选级别全部保留**，重新开启即恢复原选择。

- 共享助手（@dshtrading/indicators）：`isInstanceApplicableOn(instance, market?, interval?)` 读侧判据（市场或级别缺失视为适用，交给调用方全局语义）；`withMarketScope(instance, market, scope)` 纯函数写条目（scope 为 undefined 删除条目；无变化返回原引用）；`effectiveMarketScope(instance, market, supported)` 取某市场有效值（缺席补齐为「启用 + 全部支持级别」）；`sanitizeApplyScope` 清洗（坏形状条目整条丢弃、intervals 去重去空白、空表整字段消失）；`sanitizeInstance` 全链路保真（内存/文件 store 与迁移导入）。
- 写入边界：桥 `PUT /chart/indicators` 接受 `applyScope` 整表替换（空表清空字段回归全部应用；实例缺席幂等 no-op 不反向创建；优先于 params/clearSymbol）；`indicator_activate` / `indicator_author` 的全局写与覆盖写都保留 applyScope。三者共用 `carryInstanceExtras(base, next)`——**只用于「写全局 params、其它正交字段保持不动」的写入**；clearSymbol 等「要真的删掉某字段」的写入显式构造，不走该继承规则，否则会反向补回被清掉的字段。
- 客户端：`chart-state.setMarketScope(id, market, scope)`；`host-chart-sync` host-first 接管（PUT 成功才改本地镜像）；注入面 `setIndicatorScope` 经 QuotePane → MiddleStage → QuoteStage 逐层透传。`indicator-scope.ts` 收拢写入侧纯逻辑：`SCOPE_MARKETS`（= 系统支持市场）、`normalizeMarketScope`（启用且勾满该市场全部支持级别 → 归一为缺席，让上游后续新增级别自动跟随；空选择绝不归一）、`selectApplicableInstances`（图表渲染集唯一判据，主图叠加与副图共用）。
- UI（「适用范围」按钮，行内单开）：每市场一行「启用开关 + 级别摘要 + 展开」，展开后按 MARKET_INTERVALS 勾选级别，另有「全部级别」「清空」。级别集只取系统支持的周期，不新增数据源或级别。市场行取原始名册行而非按标的可见集，故指标在当前标的被隐藏时面板照常可开（适用范围是跨标的全局设置）。

## Alternatives considered

- **所有市场共用一套级别集合**：改动最小，但「美股只要日 K、港股只要 15m」这种最常见的诉求表达不了，与本需求动机直接冲突。否决。
- **缺失市场按「不应用」解释**：语义更「显式」，但存量名册缺字段会被读成全市场不应用——上线即静默关掉用户所有指标，必须迁移。否决，改为缺席 = 全部应用。
- **空选择当全部应用**：省一次「清空即失效」的解释，但用户清空级别后指标仍到处在，与其操作意图相反且无从表达「这个市场我不想要」。否决。
- **为每个市场复制一份指标实例**：模型直觉但破坏「每 id 单实例」SSOT（参数覆盖、编辑器、读数行都假设单实例），且「切市场自动恢复」要靠实例增删实现。否决。

## Consequences

- 预置与自定义指标都可用；`indicator_list` 的 active 名册自动带出 applyScope（agent 可读当前适用范围）。
- 图表侧靠渲染集收缩实现：`selectApplicableInstances` 变小时 TvChart 结构 diff 走 `_internal_removeSeries`，空副图 pane 由 lightweight-charts 自动摘除；切回适用市场/级别即重新加回，不残留绘制、不留空副图。
- 读数行、参数编辑、选择器勾选态仍消费「按标的可见集」（visibleInstances）——适用范围管「是否应用」，不改变「是否激活」；被范围排除时其设置仍可编辑。
- 底部快捷词条带的启用态消费「适用集」（applicableInstances）：词条的「已启用」表示「此刻在这张图上真正生效」，与图表/读数行同源。若只按可见性判定，仅港A生效的指标（KDAS）在美股图会误显已启用而其副图并未出现（2026-10-09 owner 报告后修正）。
- 修复一处存量写入缺陷：只重建 `{id, params, symbolParams}` 的写路径会静默丢 hiddenScopes（本次改动前已存在），现全部写入边界共用 `carryInstanceExtras`。
- 已知边界：supertrend 是社区 spike 包（非 `presetDefinitions()` 成员），host `resolveIndicatorSpec` 不认该 id，`indicator_activate`/桥 PUT 一律 `TRADING_UNKNOWN_INDICATOR`，故它只有浏览器半侧注册、无法挂载——与本适用范围机制无关（改动前后一致）。
- 测试：indicators 包 applyScope 清洗/适用性/withMarketScope/有效值/持久化/全局写保留；bot-api 桥 applyScope 写入与 import 保真；client-ui-trading chart-state setMarketScope 持久化、写入侧归一与渲染集（含六市场矩阵与主/副图切换）、UI 面板渲染与两处回归（隐藏指标仍可开面板、关闭市场仍显示保留级别数）。门禁 build / -r test / test:audit / i18n:check / coverage:check / typecheck 全绿。
