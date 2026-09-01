# Agent Note: 工具面补齐——get_indicators 铺满 + 能力包收口 + routing_get/instruments_search（issue #33 / P4）

Status: implemented

## Problem

调研盘点出「能力已存在但 Agent 不可达」的一批点（设计文档 §4.3）：`<market>_get_indicators` 只有 crypto 接了（us/cn/hk 未接，计算库本就市场无关）；自定义指标删除无工具；标的全集/搜索无工具；路由状态对 Agent 不可见；指标/知识工具存在 kit + client-ui-trading node 半**双注册**（历史 workaround，违背一切皆插件的收口方向）。

## Decision

1. **kit 双注册收口**：新增 `@dsh-trading/indicators/plugin`（patch 行 `dsh-trading-indicators`）与 `@dsh-trading/knowledge/plugin`（patch 行 `dsh-trading-knowledge`），host 平面单点注册 `indicator_author` / `indicator_delete`（新增）/ `knowledge_ingest` / `knowledge_search` / `knowledge_graph`（新增，buildGraph 只读包装）；kit 四包与 client-ui-trading 的重复注册移除，emit 接线（issue #30 通道）随迁。**单实例语义**：两插件 provide `tradingCustomIndicators` / `tradingKnowledgeCards` store 服务（file store 单实例），桥从服务取实例（老部署回退自建）——消除「双实例缓存 stale-flush 分裂」风险；base patch 行序保证 client-ui-trading 后于能力包挂载。
2. **get_indicators 铺满 us/cn/hk**：kit-us / kit-cn / kit-hk 各注册 `<market>_get_indicators`（行情 registry-first、老部署回退市场键）；crypto 由 connector-binance/okx 维持。**纳入自定义指标**：`createGetIndicatorsTool` 新增可选 `customStore`——非预置 id 从 store 查记录 → vm 熔断校验 + 编译 → 计算（记录缺失/校验失败都有可读诊断）。
3. **routing_get / instruments_search**（router 包，host 平面）：`routing_get` 报告各市场 provider 与激活状态（serving / selected-but-missing / none，settings 权威）；`instruments_search` 跨市场检索 = registry 动态全集（listInstruments 可选能力，失败静默）∪ **内置静态字典**（见下）——去重、market 过滤、per-market 截断。
4. **symbol-catalog 升位 host SSOT**：`SYMBOL_CATALOG` 从 client-ui-trading 内部常量（调研发现当前无消费方）迁至 `@dsh-trading/router/catalog`（纯数据子路径，双端安全），客户端原模块改再导出垫片；动态全集（listInstruments）与静态字典并集检索。
5. **测试**：indicators 自定义解析 3 例 + router 工具 5 例；全量 616 通过、build 全绿。

## Alternatives considered

- **get_indicators 接进各连接器（us=alpaca/yahoo/…，hk=futu/longbridge/…）**：一个市场多连接器会互斥重复注册同名工具；kit 天然按市场聚合且已持有 tools 注册面——采纳 kit 承载（crypto 保持连接器先例不动）。
- **store 跨插件共享用模块级单例（按路径缓存）**：repo 明文拒绝模块级单例（registry.ts 双 Map 分裂教训）；cordis Service provide 才是仓内正道——采纳服务化。
- **catalog 放 api 包**：api 是纯类型包（明文设计），运行时数据不入——放 router（路由/检索能力的 owner）+ 纯数据子路径，client bundle 不拖 cordis。
- **client 联想输入改从桥拉取**：调研发现客户端 symbol-catalog 当前**无消费方**（死数据）；升位后由 instruments_search 直接消费，「client 从桥拉取」待联想功能实际接线时再做——如实记录。

## Consequences

- us/cn/hk preset 会话可对规范词汇标的计算 MA/RSI 等指标；custom 指标 id 一并可达（indicator_author 落盘即可算）。
- 同名工具单一注册源（`ctx.tools.get()` 查重保持兼容）；host 平面工具面 +4（indicator_delete / knowledge_graph / routing_get / instruments_search）+ get_indicators ×3，此后冻结（能力实例走注册表）。
- standard 会话可见 routing_get / instruments_search（D4：通用工具全会话可见；均无交易能力）。
- 残余风险：kit 的 get_indicators 在「路由选中连接器未装」时静默不注册（marketData 缺席）——与连接器激活语义一致。
- UI 实机验收同受宿主 checkout 迁移环境阻塞（见 2026-09-01-sse-invalidation-signal.md）；链路由离线测试全覆盖。
- 验证：pnpm build 全绿；pnpm test 616 通过（新增 8）。
