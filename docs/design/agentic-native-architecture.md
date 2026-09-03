# Agentic Native 插件化蓝图（对话驱动一切）

> 状态：设计定稿（待实现） · 2026-08-31
> 决策：项目所有者（Mode 2，五项裁决见 §1.2） · 调研与起草：agent（四路代码调研）
> 关联：[strategy-tab.md](strategy-tab.md)、[knowledge-graph.md](knowledge-graph.md)、[docs/analysis-roadmap.md](../analysis-roadmap.md)、[docs/skills-guide.md](../skills-guide.md)、Agent Notes：[indicator-plugin-split](../../.agents/notes/implemented/architecture/2026-08-30-indicator-plugin-split.md)、[indicator-agent-tool](../../.agents/notes/implemented/architecture/2026-08-31-indicator-agent-tool.md)、[author-custom-indicators](../../.agents/notes/implemented/feature/2026-08-31-author-custom-indicators.md)、[knowledge-data-plane](../../.agents/notes/implemented/feature/2026-08-31-knowledge-data-plane.md)、[middle-stage-tradingview-views](../../.agents/notes/implemented/architecture/2026-08-30-middle-stage-tradingview-views.md)、[market-data-registry-hot-switch](../../.agents/notes/implemented/architecture/2026-08-30-market-data-registry-hot-switch.md)、[watchlist-add-entry](../../.agents/notes/implemented/architecture/2026-08-31-watchlist-add-entry.md)、[决策记录](../../.agents/notes/proposed/architecture/2026-08-31-agentic-native-plugin-decomposition.md)

## 1. 背景与决策输入

### 1.1 调研结论（2026-08-31）

目标场景是「右侧对话可操纵插件里的一切」。四路代码调研（DSH 宿主工具机制 / 服务与工具面 / 指标·策略·知识·自选四块 / 路线图与铁律）的要点：

1. **宿主机制底牌**：`ctx.tools.register(defineTool(...))` 注册即进 prompt、返回 disposer、增删广播 `tools/change`——运行时动态增删工具是宿主一等能力。审批走 `tools/pre-execute` 瀑布（`{kind:'ask'}` → approval 服务 → 浏览器审批面板，全链 fail-closed）。客户端有 keyed slot `tool.call.toolview`（按工具名接管对话内渲染卡片）。官方 remote 事件转发白名单是常量、第三方插件不可追加。宿主内置 `@deepseek-ai/dsh-tool-cordis`：模型可定义含宿主半+浏览器半的动态包并激活（官方声明信任级等同 bash）。
2. **Agent 工具与 HTTP 桥同源**：都消费 `tradingMarketDataRegistry` 背后的同一 service 层，不存在两套数据面。差距全在「哪些能力被包装成了工具 / 端点 / 仅客户端库」。
3. **四块现状**：指标 Agent 闭环 90%（`indicator_author` + vm 校验 + 落盘 + 桥端点，缺 UI 刷新通道）；知识已可运行时写入（`knowledge_ingest/search`，缺 UI 实时性）；策略有纯函数回测引擎但整条 Agent 产出管线缺失；自选股/标的搜索的 Agent 工具面完全空白（自选存浏览器 localStorage，node 半 Agent 根本触达不了）。
4. **宿主约束**：preset 一经会话产出内容即锁定；KV cache 因 schema 变化失效；无 live 卸载（patchReload 不重载已挂 fiber）；每新增一包需同步全部 profile overrides（已被 `scripts/sync-profile-overrides.mjs` 脚本化）。

### 1.2 项目所有者裁决（2026-08-31，Mode 2）

| # | 问题 | 裁决 |
|---|---|---|
| D1 | 拆包粒度 | **坚持「一切皆插件」核心理念不变**：能力面细粒度插件化，接受包粒度的工程成本（成本已被 sync-profile-overrides 脚本化消除大半） |
| D2 | Agent→UI 通知通道 | **SSE**（在我们自己的 `/dshtrading/api` 桥上） |
| D3 | 自选股存储升位 | **接受**：localStorage → host 侧 file store，含一次性迁移 |
| D4 | 通用工具可见性 | **所有会话可见**：host 平面注册，不设统一 trading preset |
| D5 | dsh-tool-cordis | **对交易场景开放**（以 P0 服务缝闸门为安全前置） |

## 2. 目标与非目标

**目标（In scope）**

- 对话可操纵插件的一切用户可见能力；每个能力满足**三元组**：Tool（Agent 工具）× Registry/Store（能力注册表/持久态，host 侧 SSOT）× View（client 插件经注册面呈现，SSE 驱动刷新）。
- 四个通用能力注册表收口：指标（已有）、策略（新建）、知识（已有）、自选（新建升位）；外加标的搜索面。
- SSE 失效信号通道：Agent 写状态 → 已打开的 UI 实时上屏，无需刷新页面。
- dsh-tool-cordis 开放：Agent 可定义动态包（自写工具/服务/浏览器 UI），以服务缝闸门兜底实盘安全。

**非目标（Out of scope）**

- 实盘自动下单循环 / 策略托管执行（不变：策略层永不直接触发 `place_order`，铁律 #3）；
- 破坏数据层契约（铁律 #6：`/dshtrading/api` 桥、`dshtrading` settings、`tradingMarketRouter`/`tradingMarketDataRegistry`、`@dshtrading/api` 类型全部向后兼容，SSE 为纯增量新增）；
- 宏分析工具（roadmap Q2 定稿不变：框架是知识不是代码）；
- 修改官方 remote 事件白名单 / root 接管宿主 UI。

## 3. 架构总览

### 3.1 能力三元组与四轴组合

```
Tool（稳定面）      一两个 author/CRUD 工具，schema 稳定 → KV cache 与 preset 锁定友好
Registry/Store（活的面）  能力实例作为数据流入注册表/文件 store（「数据型动态」）
View（组合面）      client 插件经注册面（服务/slot）呈现，SSE 失效信号驱动 refetch
Bundle（分发面）    base patch insert 行挂载，sync-profile-overrides 同步安装
```

核心定式：**「Agent 自己写一个 X」= 往 X 的注册表里写一条数据，而不是注册一个新工具**。工具面保持稳定，能力实例通过注册表流动——既有的 `indicator_author` → 自定义指标上屏链路就是这个形态的完整先例。

### 3.2 平面归属

| 平面 | 内容 | 依据 |
|---|---|---|
| **host 平面**（bundle patch 行，全会话可见） | 事件总线、指标/策略/知识/自选的 author 与 CRUD 工具、回测、标的搜索、路由状态查询、dsh-tool-cordis | D4；先例：`knowledge_ingest` 双注册中的 host 半 |
| **preset 平面**（`agent.cordis.yml`，会话隔离） | 各市场 connector/kit 工具（行情/新闻/下单…） | 既有语义不变 |
| **client 平面**（浏览器半） | 指标注册表（`tradingIndicators`）、中栏视图注册面（新建 `tradingStageViews`）、SSE 订阅与 refetch | 先例：`tradingIndicators` provide 模式 |

### 3.3 SSE 失效信号通道

```
工具体（任意能力包）写 store ──emit──▶ tradingEvents 服务（进程内 pub/sub + per-store revision）
                                              │
浏览器 EventSource ◀──SSE: store.changed── 桥 GET /dshtrading/api/events（client-ui-trading）
      │
      └─ 按 store 名 refetch 既有 REST 端点 → registry.register / setState
```

- **SSE 只当失效信号，数据仍走 REST**：既有端点契约零改动（铁律 #6），事件负载只含 `{store, revision}`，无兼容负担。
- EventSource 失败自动降级为现状的一次性加载（不比现状差）。
- 桥保持**唯一 HTTP 面**：新端点全部挂在 `/dshtrading/api` 桥上，复用既有 `connection.requestRejection` 认证栅栏；能力包不自挂路由（避免每个包复刻认证）。

## 4. 插件包地图（细粒度拆解）

包粒度原则：**一个包 = 一个可独立装卸的能力单元**；工具跟能力同包；UI 视图独立包经注册面挂载；行 id 全仓唯一、市场无关行由 base 拥有（铁律 #1/#4）。

### 4.1 新增包

| 包 | 类型 | 职责 |
|---|---|---|
| `packages/eventbus` → `@dshtrading/eventbus` | 插件（node 半） | provide `tradingEvents` 服务：`emit(store, payload)` / `subscribe(fn)` / per-store revision 自增。零 HTTP、零数据（P1） |
| `packages/watchlist` → `@dshtrading/watchlist` | 双面插件 | host 侧自选股 file store（`~/.dsh/watchlists.json`，仿 `custom-fs.ts` 原子写）+ 选中标的 selection store（`~/.dsh/selection.json`）+ `./plugin` 子路径注册 `watchlist_list/add/remove/select` 工具（P3） |
| `packages/client-ui-strategies` → `@dshtrading/client-ui-strategies` | client 插件 | 策略视图从 client-ui-trading 拆出，`ctx.inject(['tradingStageViews'])` 注册中栏「策略」tab；引擎经 `@dshtrading/strategies` 纯库子路径 import（P5） |
| `packages/client-ui-knowledge` → `@dshtrading/client-ui-knowledge` | client 插件 | 知识库视图拆出，同上注册「知识库」tab（P5） |

### 4.2 既有包职责调整

| 包 | 调整 |
|---|---|
| `packages/strategies` | main 保持纯库导出（浏览器打包零影响）；新增 `./plugin` 子路径（node 半插件：custom strategy store 落 `~/.dsh/strategies/custom.json` + `strategy_author` / `strategy_backtest` 工具 + 写后 emit）。patch 行 `name: '@dshtrading/strategies/plugin'`（dataplane 行同款先例）（P2） |
| `packages/indicators` | 新增 `./plugin` 子路径：`indicator_author` 从 kit/client-ui-trading 双注册收口至此；`<market>_get_indicators` 纳入自定义指标；新增 `indicator_delete`（P4） |
| `packages/knowledge` | 新增 `./plugin` 子路径：`knowledge_ingest/search` 收口至此；新增 `knowledge_graph`（可选）（P4） |
| `packages/client-ui-trading` | 保留 shell（dock / quote 视图 / session rail / 桥）；`MIDDLE_VIEWS` 常量升格为 `tradingStageViews` client 服务（开放注册面）；桥新增 SSE endpoint 与 `/strategies/custom`、`/watchlists` 端点；strategy/knowledge 视图代码迁出（P1/P2/P3/P5） |
| `packages/base` | dependencies 增加新包与 `@deepseek-ai/dsh-tool-cordis`（版本对齐宿主 cohort，SDK 不得领先宿主）；patch insert 行追加：eventbus、watchlist、`strategies/plugin`、`indicators/plugin`、`knowledge/plugin`、`client-ui-strategies`、`client-ui-knowledge`、dsh-tool-cordis（P2 起逐 Phase 随包落） |
| `packages/connector-*`（交易实现者） | TradeService 实现内**服务缝闸门**（见 §5.4）（P0） |
| `packages/kit-*` | 指标/知识工具的双注册在收口后退役（kit 保留市场专属工具 + skill provider）（P4） |

### 4.3 新增 Agent 工具面（host 平面，全会话可见）

| 工具 | 包 | 功能 |
|---|---|---|
| `strategy_author` | strategies/plugin | 提交自定义策略（id/title/horizon/params/computeSource）→ vm 沙箱校验（信号序列专用校验器，不复用指标等长断言）→ 落盘 |
| `strategy_backtest` | strategies/plugin | 对指定策略+标的+周期跑 `run()` 回测，返回 8 指标 + 交易流水（`output.presentationMeta` 携带权益曲线供卡片渲染） |
| `watchlist_list` / `watchlist_add` / `watchlist_remove` | watchlist/plugin | 自选股 CRUD（跨市场） |
| `watchlist_select` | watchlist/plugin | 设置当前选中标的 → SSE → 中栏切图（「看看苹果」→ 图表切 AAPL） |
| `indicator_delete` | indicators/plugin | 删除自定义指标（补齐桥端点已有的删除能力） |
| `knowledge_graph` | knowledge/plugin（可选） | 返回 `buildGraph` 结果 |
| `instruments_search` | client-ui-trading 桥侧（或独立 instruments 包，实现时定） | 跨市场标的搜索：`registry.active(market).listInstruments?` ∪ 静态快照（symbol-catalog 升位为 host 侧 SSOT，client 改为拉取） |
| `routing_get` | router | 返回各市场当前激活 provider 与设置状态 |
| （dsh-tool-cordis 7 工具） | @deepseek-ai/dsh-tool-cordis | `cordis_inspect_*` / `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` |

同时补齐市场面：`<market>_get_indicators` 铺满 us/cn/hk（计算库本就市场无关）。

### 4.4 bundle 挂载与成本

- 每新增一包：base（或市场 bundle）patch insert 行 + `package.json` deps + `node scripts/sync-profile-overrides.mjs --all`（已脚本化、幂等、append-only）。
- UI 拆包与插件重挂载无 live 卸载：验收流程含重启宿主 + 刷新页面（既有纪律）。

## 5. 关键设计

### 5.1 SSE 事件总线（eventbus 包 + 桥 endpoint）

- `tradingEvents` 服务 API：`emit(store: string)`（revision 自增）、`subscribe((evt) => void): disposer`、`revision(store): number`。
- 桥新增 `GET /dshtrading/api/events`（`text/event-stream`）：帧格式 `event: store.changed\ndata: {"store":"indicators","revision":42}\n\n`；心跳 15s；断线由 EventSource 自动重连。
- store 枚举（v1）：`indicators | strategies | knowledge | watchlists | selection | routing`。
- 客户端：client-ui-trading client 半建单例 EventSource → 收到事件 → 对应 fetch → `indicators.register(...)` / setState。替换现有三处「挂载时一次性 fetch」。
- 发布点：`indicator_author`、`strategy_author`、`knowledge_ingest`、watchlist 工具、桥端点写入（DELETE/导入）、routing 设置变更。

### 5.2 自选股升位（watchlist 包）

- 存储：`~/.dsh/watchlists.json`（多列表模型对齐现 localStorage v1 结构）；selection 单值落 `~/.dsh/selection.json`。写入全部 tmp+rename 原子替换。
- 迁移（D3）：客户端启动时若 localStorage 有 `dshtrading.watchlist.v1` 且 host store 为空 → `POST /dshtrading/api/watchlists/import` 一次性导入（幂等：非空拒绝）；localStorage 降级为缓存镜像，不再作为 SSOT。
- 桥端点：`GET/PUT/POST/DELETE /dshtrading/api/watchlists`（列表与行操作）+ `PUT /dshtrading/api/selection`。
- 工具（§4.3）+ SSE：`watchlist_add` 后左栏实时出现行情行；`watchlist_select` 驱动中栏切图。
- 市场规范词汇纪律不变（docs/symbol-vocabulary.md）。

### 5.3 策略管线（strategies 转双面插件）

- `CustomStrategyRecord`：`{ id, title, horizon, summary, paramsJson, computeSource }`（`compute(bars, params) → StrategySignal[]`，与 StrategyDefinition 契约一致）；file store 落 `~/.dsh/strategies/custom.json`。
- 校验器：**新写**（信号序列语义：index 单调、time 匹配 bar、action/direction 合法、i 收盘确认 i+1 开盘成交可复算）；Node 侧 vm 沙箱 + 超时熔断（仿 `validate-node.ts`）；浏览器侧编译执行同样补超时护栏（现有 `new Function` 裸执行的既知缺口一并补）。
- `strategy_backtest`：node 半直接调 `run()`（同一引擎，与浏览器端 StrategyView 结果确定性一致）。
- StrategyView 名册从静态 `strategyParadigms` 改为「范式 ∪ 自定义合并」（SSE 驱动刷新）。
- 实盘自动化红线不变：策略层永不触发 `place_order`。

### 5.4 服务缝闸门与 dsh-tool-cordis 开放（D5 的安全前置）

**问题**：base 审批闸门与工具内三态检查都在**工具层**（正则 `/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/` + `evaluateOrderGate`）。dsh-tool-cordis 动态包的宿主半可以 inject TradeService 直接调用，绕过工具层。

**设计**：闸门语义**下推到服务缝**——各 connector 的 `TradeService.placeOrder/cancelOrder` 实现内第一步执行 `evaluateOrderGate` 三态检查：`liveTrading !== true` → dry-run 模拟/拒绝（服务级 fail-closed）；工具层现有 ask 交互保留，形成双保险。之后无论经工具、经动态包、还是未来经任何新消费面，实盘单都过闸。

**残余风险（如实记录）**：`liveTrading: true` 时动态包直调服务可绕过交互审批（服务层没有 approval 上下文）。接受理由：liveTrading 本身是用户对实盘的显式授权声明（默认 false）；动态包信任级 = bash（官方声明）；动态包 session-scoped、重启即散；skill 指南（P6）约束使用场景。

**挂载**：base patch insert 行（id 全仓唯一，如 `dsh-trading-dynamic-capabilities`，name `@deepseek-ai/dsh-tool-cordis`）；客户端可订阅 `cordis/dynamic-package` 事件（在官方 remote 转发白名单内）显示「动态包已激活」提示（可选）。

### 5.5 对话内工具卡片（`tool.call.toolview`）

按工具名注册 keyed slot，接管对话内渲染（先例：官方 `dsh-client-ui-tool`）：

- `strategy_backtest` → 权益曲线 sparkline + 8 指标 mini 卡；
- `*_place_order` → 订单参数 + 模拟/实盘标识 + 审批状态；
- `watchlist_add` / `watchlist_select` → 标的 chip；
- `strategy_author` / `indicator_author` → 校验结果 + 参数摘要。

实现位置随视图归属（client-ui-trading / client-ui-strategies 等 client 插件）。

### 5.6 工具命名与闸门边界

- 通用工具用能力前缀（`strategy_*`、`watchlist_*`、`instruments_*`、`knowledge_*`、`routing_*`）；市场工具维持 `<market>_*`。
- 下单/撤单闸门正则**不同步开放**（`provider-vocabulary-open` 既定裁决）：任何新工具不得命中或仿冒该命名族；闸门扩展只随市场段增加。
- KV cache 纪律：host 平面工具面一次成型后保持稳定；能力实例走注册表，不再加工具。

## 6. 阶段划分与 Issue 拆解

| Phase | 内容 | 交付物 | 依赖 |
|---|---|---|---|
| **P0** | 服务缝闸门下推 | 各交易 connector（okx/binance/bybit/ccxt/alpaca/ibkr/qmt/futu/longbridge/tiger）TradeService 实现内三态检查 + 单测 + dry-run spike 证据 | 无（安全前置） |
| **P1** | SSE 基建 | `@dshtrading/eventbus` 包 + 桥 `GET /dshtrading/api/events` + 客户端订阅替换三处一次性 fetch + 指标/知识上屏实时化 + 自定义指标删除 UI 入口 | 无 |
| **P2** | 策略管线 | strategies `./plugin` + custom store + `strategy_author`/`strategy_backtest` + 桥 `/strategies/custom` + StrategyView 名册合并 + 信号校验器 | P1（上屏实时性） |
| **P3** | 自选股升位 | `@dshtrading/watchlist` 包 + 桥端点 + 导入迁移 + 4 工具 + MarketSidebar 改造（host SSOT） | P1 |
| **P4** | 工具面补齐 | get_indicators 铺满四市场并纳入自定义指标 + `indicator_delete` + `instruments_search` + `routing_get` + kit 双注册收口到能力包 `./plugin` | P1、P2 |
| **P5** | UI 插件化收口 | `tradingStageViews` 注册面 + client-ui-strategies / client-ui-knowledge 拆包 + toolview 富卡片 | P2、P3 |
| **P6** | dsh-tool-cordis 开放 | base 挂行 + `dynamic-capabilities` skill（使用场景与安全边界指南）+ 动态包激活提示 UI | **P0** |

每 Phase 一个 issue（P0 可按 connector 拆多个 PR）；实现按协作模式外发（主 agent 评审）。

## 7. 端到端验收标准

| # | 对话语句 | 预期 |
|---|---|---|
| 1 | 「帮我写一个 TD9 副图指标挂到图上」 | `indicator_author` 入库；**当前图表无需刷新**即出现该指标（SSE） |
| 2 | 「写一个双均线止损止盈策略，回测 BTC 日线」 | `strategy_author` + `strategy_backtest`；对话内富卡片显示权益曲线与 8 指标；中栏策略 tab 名册出现该策略 |
| 3 | 「把这篇文章沉淀进知识库」 | `knowledge_ingest`；知识库 tab 实时出现新卡片与图谱连边 |
| 4 | 「把 AAPL 加进自选，然后打开它的图」 | 左栏实时新增行情行；中栏切到 AAPL 图表 |
| 5 | 「搜一下名字带腾讯的港股」 | `instruments_search` 返回 `00700.HK` 腾讯控股 |
| 6 | 「写个小工具把自选列表所有标的的 RSI 算一遍」 | dsh-tool-cordis 动态包定义+激活（浏览器半需审批），结果回话 |
| 7 | 回归 | dry-run 默认、liveTrading 显式开关、审批面板行为不变；headless 全链 fail-closed；`liveTrading:false` 时绕过工具直调 TradeService 也被服务缝拒绝 |

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| host 平面工具 schema 增量（~10 个）推高每请求 token | 一次性常驻成本，换取全会话能力（D4 接受）；此后工具面冻结，能力实例走注册表 |
| preset 锁定 + 全会话可见：standard 会话可调通用工具 | 通用工具无交易能力；下单类仍在市场 preset；风险可接受 |
| SSE 连接管理（重连/心跳/多标签页） | EventSource 自动重连 + 心跳；失败降级为一次性加载（不劣于现状）；revision 幂等 refetch |
| watchlist 迁移丢数据 | 空检查幂等导入；localStorage 保留为镜像；导入端点非空拒绝 |
| dsh-tool-cordis 绕过工具层审批 | P0 服务缝闸门为硬前置；信任级声明；session-scoped；skill 指南约束 |
| 拆包成本（overrides / 无 live 卸载） | `sync-profile-overrides.mjs --all` 已脚本化；验收流程含重启+刷新（既有纪律） |
| 新 HTTP 端点认证遗漏 | 桥保持唯一 HTTP 面，新端点全部复用既有 `connection.requestRejection` 栅栏（评审红线） |
| 浏览器端编译执行无超时（现状缺口） | P2 一并补浏览器侧护栏（与 Node vm 熔断对齐） |
