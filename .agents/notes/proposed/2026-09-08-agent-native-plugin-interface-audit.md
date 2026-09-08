# Agent Note: agent-native 插件接口审计（能力 × 执行者矩阵与增强清单）

Status: proposed

## Problem

2026-09-08 的 holdings 样板（commit `5a61735`）把「台账是导入型记账数据，agent 应当能完全操控，唯一红线是不得下单」落到了工具面：7 个窄工具、description 自带纪律、写后 `tradingEvents.emit('holdings')`。但除 holdings 之外，没有任何一次系统盘点回答过同一个问题：**还有哪些能力只对 UI 或 REST 桥开放，agent 做不了或只能半做。**

实证代价（本次审计期间可在代码里逐条复现）：

- 用户说「把美股行情源换成 Alpaca」，agent 只能回「请到设置面板点」——`routing_get` 只读（`packages/router/src/tools.ts:24-49`），写路径只在设置 UI（`packages/client-ui-settings/src/client/trading-settings-controller.ts:155-157`）。
- 用户说「把自选里的港股单独建个组」，agent 没有分组工具；分组 store 早在 host 侧（`packages/watchlist/src/index.ts:57`），桥有 6 条端点、UI 有 4 个写方法（`packages/client-ui-trading/src/client/index.ts:204-209`）。
- 用户说「用刚写的选股器扫一遍 A 股」，agent 能 `screener_author` 却跑不了：扫描调度只在客户端（`packages/client-ui-strategies/src/client/ScreenerPane.tsx:7-9,282-314`）。
- 用户问「我美股账户现在有哪些委托和成交」，agent 查不到：`/dshtrading/api/trade/orders`、`/trade/fills` 四市场都有（`packages/client-ui-trading/src/bridge.ts:743,751`），工具面只有 OKX 的 `crypto_get_order`/`crypto_get_positions`（`packages/connector-okx/src/index.ts:1143,1174`）。
- 用户说「看一下 BTC 盘口和最近逐笔」，agent 没有对应工具：`MarketDataService.getOrderbook?`（`packages/api/src/index.ts:589`）与 `getRecentTrades?`（:595）都在服务契约里，桥有 `/orderbook`、`/trades`，工具名清单零命中。
- 用户说「把我上次写的那个动量策略再回测一次」，agent 无法枚举自定义策略 id（无 `strategy_list`/`screener_list`），只能让用户报 id 或读文件。

本记录给出可执行的增强清单：逐包三面（agent 工具面 / REST 桥面 / UI 面）判定「可做 / 半做 / 做不到」，把每个缺口归到 A 至 D 风险等级，并明确「该补」与「不该补」。

## Proposal

### 0. 审计口径、运行时验证与基线

- **判据**：`docs/design/agentic-native-architecture.md` 的能力三元组（Tool × Registry/Store × View，SSE 驱动刷新），目标「对话可操纵插件里的一切」；样板 = `packages/holdings/src/tool.ts` 的 7 工具。
- **三面盘点**：agent 面（`defineTool` / `ctx.tools.register`）、桥面（`/dshtrading/api` 全部 60 个端点）、UI 面（`client-ui-*` 里人能做而 agent 做不到的操作）。
- **运行时交叉验证（2026-09-08 实测）**：
  - `dsh-trading --profile trading-web --dump-config` 确认 host 平面挂载行：`@dshtrading/base`、`base/presets`、`router`、`client-ui-settings`、`eventbus`、`strategies/plugin`、`watchlist/plugin`、`indicators/plugin`、`@deepseek-ai/dsh-tool-cordis`、`knowledge/plugin`、`holdings/plugin`、`dsh-i18n`、`client-ui-{trading,indicators,strategies,knowledge,masters-quotes,updater}`，加四个市场 bundle 与其 dataplane 行（crypto: binance/okx/bybit/ccxt；us: yahoo/alpaca/fmp/finnhub/polygon/ibkr；cn: tencent/eastmoney/tushare/akshare/qmt/hithink；hk: tencent/futu/longbridge/tiger）。`kit-*` 不在 host 平面，属 preset 面（`packages/*/assets/preset/*/agent.cordis.yml`）。
  - 真实会话 transcript（`~/.dsh-trading/sessions/--Users-zcl-cowork--/session-cba74730-…/session.jsonl.zstd`，zstd 解压后 grep）确认该会话真实可调用的 dsh-trading 工具 **68 个**（tasks 6、screener 3、strategy 4、indicator 5、knowledge 5、holdings 7、watchlist 4、routing_get、instruments_search、四市场 32），另有宿主 `cordis_*` 7 个。
  - **限制（如实记录）**：本会话是 dsh web 宿主（`DSH_HOME=~/.dsh`），不含 `cordis_inspect_query`，无法调 host/Tool/listTools（实测 `tools.cordis_inspect_query is not a function`）。因此改用「profile dump-config + 真实会话 transcript + 源码」三重交叉：**工具名与可调用性以 transcript 为准，端点与服务能力以源码为准**。
- **基线（本轮只读实测）**：`pnpm test` = 157 个测试文件通过 / 1 跳过，1319 用例通过 / 2 跳过（exit 0）；`node scripts/typecheck-gate.mjs` = 63 个 tsconfig、481 错误（等于基线，棘轮通过）。
- **工作树基线与时效**：审计开始时 `## main...origin/main [ahead 1]`，另有 8 个文件属其他会话的未提交改动（README.md、README_zh.md、desktop/scripts/build-runtime.mjs、desktop/src/runtime.cjs、desktop/tests/runtime.test.mjs、packages/base/cordis.patch.yml、packages/base/package.json、pnpm-lock.yaml）与 1 个未跟踪 note；审计期间该会话把上述改动提交为 `466cbe1`（ahead 2），其中 `packages/base/cordis.patch.yml` 新增三条**非 dsh-trading** host 平面行（`@linxin666/dsh-usage` 使用统计、`@linxin666/dsh-client-ui-plugin-manager` 插件管理、`@linxin666/dsh-client-ui-model-capabilities` 模型能力）。三者均不注册 dsh-trading 工具，本矩阵不受影响；「插件安装/启停」属宿主级人类能力（无 agent 工具），**不在本审计范围**。本审计全程未触碰、未 stage、未清理其他会话的改动；本会话唯一产出即本文件（`git status` 确认工作树仅此一未跟踪文件）。

### 1. 结论摘要：Top 5 最痛缺口（写成「agent 现在做不成什么」）

| # | agent 现在做不成什么 | 现状证据 | 等级 | 建议动作 | 工作量 |
|---|---|---|---|---|---|
| 1 | **读不到账户真实面（持仓 / 挂单 / 成交 / 资金 / 单笔查单）**：四市场只有 OKX 一家有仓位工具，其余只能让用户看 UI 的「委托 / 成交 / 资金」页签 | 桥 `/trade/positions|balances|orders|fills`（bridge.ts:731,735,743,751）；工具面仅 `crypto_get_positions`/`crypto_get_balance`/`crypto_get_order`（connector-okx:1144,1161,1174）；服务层已实现但无工具：alpaca:260、futu:114、qmt:146、longbridge:147、tiger:147、ibkr:145、bybit:262、ccxt:144（getPositions）；listOpenOrders/listTradeFills 见 `packages/api/src/index.ts:622,627` | A/B（只读，无交易语义） | 补 `<market>_get_positions`、`_get_orders`、`_get_fills`、`_get_balance`、`_get_order`（服务未实现时返回 `TRADING_NOT_IMPLEMENTED`，不得返回空数组） | M |
| 2 | **看不到盘口与逐笔成交**：四个市场都没有 orderbook / recent-trades 工具 | 服务契约 `getOrderbook?`（api/src/index.ts:589）、`getRecentTrades?`（:595）；桥 `/orderbook`（bridge.ts:677-689）、`/trades`（:696-712）；实现 binance:126/okx:244/bybit:91/alpaca:167/tencent:114；工具名清单零命中 | A | 补 `<market>_get_orderbook`、`<market>_get_trades` | S |
| 3 | **枚举不了自定义策略 / 选股器，跑不了选股器，也复现不了用户的回测参数**：`strategy_delete`/`screener_delete` 都要 id，agent 拿不到 id；`screener_run` 不存在；`strategy_backtest` 无 params 入参而引擎支持覆盖 | `strategies/src/plugin.ts:742-749` 只注册 author/backtest/delete/reset 与 screener_author/delete/reset；桥有 `GET /strategies/custom`（bridge.ts:1819）、`GET /strategies/screeners`（:1825）、`GET /strategies/tombstones`（:1822）；扫描调度只在客户端 ScreenerPane.tsx:7-9,282-314；纯函数 `ScreenerDefinition.evaluate(bars, params)`（screeners/types.ts:43-56） | A | 补 `strategy_list`、`screener_list`、`screener_run`（+ 可选 `strategy_tombstones`） | M |
| 4 | **管不了自选分组**：能加/删标的，但建组、改名、删组、把标的移进移出组全做不到；也读不到当前选中标的 | 工具面 4 个（watchlist/src/plugin.ts:74,108,149,186）；分组 store 已存在（watchlist/src/index.ts:57,180-205）；桥 6 条端点（bridge.ts:1831,1877,1899,1942,1882,1945）；UI 4 个写方法（client-ui-trading/src/client/index.ts:204-209）；`/selection` 读面（bridge.ts:1834）无工具 | A | 补 `watchlist_group_create/rename/delete`、`watchlist_group_assign`，并让 `watchlist_list` 返回 groups 与当前 selection | S/M |
| 5 | **改不了行情源 / 路由**：`routing_get` 只读，provider 只能到设置面板点 | router/src/tools.ts:24-49（无写工具）；写路径 `client-ui-settings/src/client/trading-settings-controller.ts:155-157`；`'routing'` store 声明了但全仓无 `emit('routing')`（eventbus/src/index.ts:39 vs 全仓零命中，仅测试触发） | B（影响分析结果，必须审计留痕 + 显式回显） | 补 `routing_set(market, provider, reason?)`：写 dshtrading settings + 回显旧→新 + `emit('routing')` + 提示「新建会话生效」 | M（需先定契约） |

### 2. 全量矩阵（插件 × agent 工具 / REST 端点 / UI 能力 / 缺口等级 / 建议动作）

缺口等级：A = 本地记录/纯数据；B = 影响分析结果的配置；C = 交易语义（保持闸门）；D = 凭据/密钥（永不进 agent 面）；`-` = 无缺口。

#### 2.1 能力包（host 平面）

| 包 | agent 工具（数量 / 名称） | REST 端点 | UI 能力 | 缺口等级 | 建议动作 | 证据 |
|---|---|---|---|---|---|---|
| api | 0（纯类型契约） | 0 | 无 | - | 无 | api/src/index.ts:553,605,622,627 |
| base | 2 模板 × N 市场：`<market>_get_ticker`、`_get_klines`；另持审批闸门 | 0 | 无 | -（有文档平面差异，见 §3.5） | 澄清 `base/research-tools` 平面归属 | base/src/research-tools.ts:23,33；presets.ts:109；index.ts:51,91-100 |
| router | 2：`routing_get`、`instruments_search` | 0 | 设置页写 provider（4 市场 × provider 单选） | B：无 `routing_set` | 补 `routing_set`（缺口卡 G6） | router/src/tools.ts:24,55；client-ui-settings/src/client/trading-settings-controller.ts:155-157 |
| eventbus | 0 | SSE `/events` 供源 | 无 | B：`'routing'` 无 emit 生产者 | `routing_set` 落地时同步补 emit | eventbus/src/index.ts:33-42；client-ui-trading/src/index.ts:243-251 |
| watchlist | 4：`watchlist_list/add/remove/select` | 9 条：`/watchlists`（GET/PUT/POST/DELETE）、`/watchlists/import`、`/watchlist-groups`（GET/POST/PUT/DELETE）、`/watchlist-group-members`（POST/DELETE）、`/selection`（GET/PUT） | 左栏增删选、分组下拉、分组 CRUD、自选管理弹窗、拖拽排序（整表 PUT）、激活分组 | A：分组与选中态读面缺失 | 补分组 4 工具 + list 回显 groups/selection（缺口卡 G5） | watchlist/src/plugin.ts:74,108,149,186,238-239；bridge.ts:1828-1834,1871-1888,1896-1904,1936-1947；client/index.ts:204-209 |
| knowledge | 5：`knowledge_ingest/search/get/delete/graph` | 1 条只读 `GET /knowledge/cards` | 只读视图 + 图谱 | -（反向不对称：agent 面是超集） | 无 | knowledge/src/tool.ts:46,223,367,411；plugin.ts:57；bridge.ts:1804 |
| indicators | 6：`indicator_author/delete/list/activate/deactivate` + `<market>_get_indicators`（连接器/kit 注册） | 6 条：`/indicators/custom`（GET/DELETE）、`/chart/indicators`（GET/PUT/DELETE）、`/chart/indicators/import`（POST） | 图表叠加/参数覆盖/隐藏/删除自定义指标 | 低价值缺口：名册迁移导入 | 可不做（`indicator_activate` 可逐条替代） | indicators/src/tool.ts:46,152；plugin.ts:64；chart-tools.ts:22,66,180；bridge.ts:1798-1803,1843-1852,1905-1907,1948-1950 |
| strategies | 7：`strategy_author/backtest/delete/reset`、`screener_author/delete/reset` | 8 条：`/strategies/custom`（GET/PUT/DELETE）、`/strategies/reset`、`/strategies/tombstones`、`/strategies/screeners`（GET/PUT/DELETE）、`/strategies/screeners/reset` | 策略编辑器、回测视图、选股器编辑 + 扫描执行 | A：无 list、无 screener_run、无墓碑读 | 补 `strategy_list`/`screener_list`/`screener_run`（缺口卡 G3/G4） | strategies/src/plugin.ts:117,271,375,439,502,612,676,742-749；bridge.ts:1819-1827,1853-1862,1911-1916,1924-1935 |
| holdings | 7（样板）：`holdings_stage/confirm/discard/add/update/remove/list` | 8 条（契约 §3） | 资产面板全对等 | A：无 FX 读取 | 补 `fx_get`（缺口卡 G7） | holdings/src/tool.ts:173,255,287,354,398,474,554；plugin.ts:76；bridge.ts:1807-1813,1889-1891,1908-1910,1951-1962 |
| dsh-home | 0 | 0 | 无 | - | 无 | src/index.ts:30-35,98-134 |
| dsh-i18n | 0 | 0 | 语言注册 | - | 无 | src/client/index.ts:51,60 |

#### 2.2 client 包（浏览器半）

| 包 | agent 工具 | REST 端点 | UI 能力 | 缺口等级 | 建议动作 | 证据 |
|---|---|---|---|---|---|---|
| client-ui-trading | tasks 6：`tasks_list/meta/create/update/delete/run` | 主桥 53 + SSE + tasks 3（合计 57） | 全量交易台：行情/图表/盘口/逐笔/委托/成交/资金/资产面板/自选/定时任务/更新提示 | A/B：盘口、逐笔、账户读面、FX 无工具（缺口卡 G1/G2/G7） | 见缺口卡 | client-ui-trading/src/index.ts:223-299；tasks/tools.ts:89,104,120,157,190,209；bridge.ts:1740-1963 |
| client-ui-indicators | 0（只 `reflect.provide('tradingIndicators')`） | 0 | 无独立 UI | - | 无 | client-ui-indicators/src/client/index.ts:24-29 |
| client-ui-strategies | 0 | 0（消费主桥） | 策略编辑/回测/选股扫描 UI | A（与 strategies 同源） | 与缺口卡 G3/G4 一起解决 | StrategyView.tsx、ScreenerPane.tsx:7-9 |
| client-ui-knowledge | 0 | 0 | 只读知识视图 | - | 无 | KnowledgeView.tsx:101-104 |
| client-ui-settings | 0 | 0 | 设置「交易」一级菜单：市场 × provider 单选/重置、凭据录入/删除、CryptoPanic key、涨跌配色 | B：provider 写面（缺口卡 G6）；D：凭据与新闻 key（永不开放）；A 低价值：涨跌配色 | 只做 G6；凭据类明确不做 | client-ui-settings/src/client/index.ts:50-86,124-141；MarketProviderPanel.tsx:152-208,402-433；trading-settings-controller.ts:62-121,155-157 |
| client-ui-masters-quotes | 0 | 0 | 语言包（大师金句，仅覆盖 1 个词典键） | - | 无 | package.json description；src/index.ts:12 |
| client-ui-updater | 0 | 3：`/updater/state|check|apply` | 检查更新 / 应用更新 | 刻意不做（人类运维动作） | 维持现状 | client-ui-updater/src/index.ts:79-119 |

#### 2.3 市场 bundle 与 kit（preset 平面）

| 包 | agent 工具 | 缺口等级 | 建议动作 | 证据 |
|---|---|---|---|---|
| crypto / us / cn / hk（bundle） | 0（只导出 preset 行贡献） | - | 无 | crypto/src/index.ts:8 等 |
| kit-crypto | 4：`crypto_funding_rate`、`crypto_get_derivatives`、`_get_fundamentals`、`_get_news` | A/B：衍生品历史无工具；`crypto_funding_rate` 与 okx 同名双源、数据源硬编码 Binance fapi（路由不符） | 补 `crypto_get_derivatives_history`（缺口卡 G8）；收敛同名双源 | kit-crypto/src/index.ts:226,308,338,383；derivatives.ts:32-33 |
| kit-us | 3：`us_get_news`、`_get_fundamentals`、`_get_indicators` | A：盘口/逐笔/账户面缺（同 G1/G2）；`us_get_news` 与 finnhub 同名双源 | 见缺口卡 | kit-us/src/index.ts:228,278,195 |
| kit-cn | 5：`cn_get_news`、`_get_fundamentals`、`_get_limit_up_pool`、`_get_auction_strength`、`_get_indicators` | 同 G1/G2 | 见缺口卡 | kit-cn/src/index.ts:238,288,322,360,204 |
| kit-hk | 3：`hk_get_news`、`_get_fundamentals`、`_get_indicators` | 同 G1/G2 | 见缺口卡 | kit-hk/src/index.ts:232,282,197 |

#### 2.4 connector（preset 平面，工具数 0 至 9）

| 组 | 包 | 工具面 | 缺口等级 | 建议动作 | 证据 |
|---|---|---|---|---|---|
| 有交易工具 | okx(9)、ibkr(5)、qmt(5)、longbridge(5)、tiger(5)、alpaca(3)、futu(3)、binance(4)、tencent(3/市场)、yahoo(3) | 下单/撤单/余额/持仓中的子集 | C：撤单工具不齐（保持闸门，不新增）；A：账户读面工具缺失 | 只补只读（G1）；撤单不补 | 见 §2.4 逐条 |
| 只读工具 | bybit(2)、ccxt(2)、eastmoney(2/市场)、akshare(3)、tushare(3)、finnhub(3)、fmp(3)、polygon(3) | ticker/klines(+市场专属) | A：账户读面（服务有、工具无） | 随 G1 统一补 | bybit/src/index.ts:301,311；ccxt:175,188 |
| 无工具 | hithink | 0（数据仅经 kit-cn 的涨停池/竞价工具消费） | - | 无 | connector-hithink/src/index.ts（无 defineTool） |
| 未挂载 | stooq(3)、template(7) | 定义存在但无 preset/patch 行 | - | 标注为备用或补行 | connector-stooq/src/index.ts:235,311,336；connector-template:572,706,722,756,773,790,804 |

一致性检查结论（四市场 × connector）：
- `get_ticker` / `get_klines` / `place_order` 四市场齐。
- `get_positions` 仅 crypto（okx）；`get_orders` / `get_fills` 四市场全无；`get_order` 仅 okx。
- `orderbook` / 逐笔四市场全无；`derivatives` / `funding_rate` 仅 crypto。
- `get_indicators` 在 crypto 只在 binance/okx 注册（provider=bybit/ccxt 时缺失）。
- `cancel_order` 每市场仅 1-2 家（okx / ibkr / qmt / longbridge+tiger），其余券商服务有工具无——属 C 类，**不补**。
- connector/kit 全部工具 description **零回显纪律**（`rg "回显|提醒用户" connector-* kit-*` 零命中），与 holdings 样板（tool.ts:173-179）不一致；属文案级一致性缺口，不改变权限。

#### 2.5 localStorage-only 状态（16 键纯本地，结论：绝大多数无 agent 需求）

已升位 host SSOT 的 5 键：`dshtrading.selection.v1`、`dshtrading.watchlist.v1`、`dshtrading.watchlist-groups.v1`、`dshtrading.chart.v1`（host 为权威、本地为镜像）；`dshtrading.color_mode.v1`（settings `dshtrading.colorMode` 权威 + 本地热切换镜像）。

纯本地 16 键：`watchlist.active-group.v1`（注释显式「纯本地 UI 态，不进 host」）、`markers.v1`、`interval.<market>`、`orderbook.open`、`tradeDesk.open`、`stage.v1`、`home.history.open.v1`、`chat.width.v1`、`chat.folded.v1`、`market.folded.v1`、`knowledge.view.v1`、`strategy.v1`、`screener.v1`、`trade:mode`、`paper:account:v1`、`holdings:baseCurrency`（证据见各 `client-ui-*/src/client/*`）。

判定：**视图态与折叠/宽度/筛选一律不需要 agent 工具**（无能力语义）；`trade:mode` 与 `paper:account:v1` 属 C 类（§5）；`holdings:baseCurrency` 属显示偏好（A 类但价值极低，不建议单开工具，随 `fx_get`/汇总工具的参数表达即可）。

#### 2.6 反向不对称（agent 能做、UI 不能做）

| 能力 | agent 面 | UI 面 | 说明 |
|---|---|---|---|
| 整市场隐藏指标 | `indicator_deactivate(id, market)`（chart-tools.ts:196-202） | 只支持按标的隐藏（host-chart-sync.ts:96-103） | agent 是超集，无需处理（若要对齐可给 UI 补按钮） |
| 自定义指标创作 | `indicator_author`（indicators/src/tool.ts:153） | 无端点、无编辑器（桥只有 GET/DELETE） | agent 独占 |
| 知识卡片入库/删除 | `knowledge_ingest`/`knowledge_delete`（knowledge/src/tool.ts:47,412） | 只读视图 | agent 独占 |
| 策略/选股器源码编辑 | `strategy_author`/`screener_author` | 也有编辑器（StrategyEditor.tsx:119-186、ScreenerEditor.tsx） | 双向可达 |

这些是「agent 超集」而非缺口，本审计不要求 UI 补齐；记录在此以免后续会话误判。

### 3. 缺口卡片

每张卡片：现状与证据 → agent 现在怎么绕（代价）→ 建议接口签名 → 风险等级 → 验证方式 → 工作量。

#### G1 账户读面工具（positions / orders / fills / balances / 单笔查单）

- **现状与证据**：桥四端点齐（bridge.ts:731,735,743,751），服务层多家已实现（getPositions：alpaca:260、futu:114、qmt:146、longbridge:147、tiger:147、ibkr:145、bybit:262、ccxt:144、okx；listOpenOrders：okx:654、bybit:266、alpaca:269、futu:181、qmt:159；listTradeFills：okx:687、bybit:270、alpaca:278、futu:185、qmt:163），但工具面只有 `crypto_get_positions`/`crypto_get_balance`/`crypto_get_order`（okx:1144,1161,1174）。
- **agent 目前怎么绕**：让用户看 UI 页签并口述；或从台账（holdings）读——但台账是导入型记录，与券商真实状态无关（契约 §1），且不含挂单与成交。代价：账户对账只能人工，agent 的「先核对账户再记账」纪律无法闭环。
- **建议接口**（每个市场一组，参数极窄）：
  - `<market>_get_positions()` → JSON `{ok,market,provider,positions:[...]}`；description 要点：只读；provider 未实现 → `TRADING_NOT_IMPLEMENTED`，不得用空数组表示「无持仓」；核对真实持仓必须用本工具而非台账。
  - `<market>_get_orders()`、`<market>_get_fills(limit?)`、`<market>_get_balance()`、`<market>_get_order(orderId)` 同构。
- **风险等级**：A（纯只读，无交易语义，不进闸门）。注意 `ORDER_GATE_PATTERN = /^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/`（base/src/index.ts:51）不含这些名字，天然放行。
- **验证方式**：各 connector 单测断言「未实现 → TRADING_NOT_IMPLEMENTED」「已实现 → 字段形状」；建议测试名 `test/account-tools.test.ts`；命令 `pnpm --filter @dshtrading/connector-okx test`。
- **工作量**：M（工具工厂 + 逐连接器接线 + 四市场命名一致性测试）。

#### G2 盘口与逐笔（orderbook / recent trades）

- **现状与证据**：契约 `getOrderbook?`（api:589）、`getRecentTrades?`（api:595）；桥 bridge.ts:677-689、696-712；实现 binance:126、okx:244、bybit:91、alpaca:167、tencent:114；UI OrderbookPane 已消费。
- **agent 目前怎么绕**：无。只能让用户描述盘口；或用 K 线近似流动性（精度不足）。代价：日内交易/大单判断只能人工。
- **建议接口**：`<market>_get_orderbook(symbol, depth?)` → JSON `{ok,market,provider,orderbook:{bids,asks,ts}}`；`<market>_get_trades(symbol, limit?)` → JSON `{ok,trades:[{price,size,side,ts}]}`，limit 1..100（与桥同口径 bridge.ts:701）。description 要点：只读快照、非实时流；未实现 → `TRADING_NOT_IMPLEMENTED`。
- **风险等级**：A。
- **验证方式**：`connector-*/test/orderbook.test.ts`；桥层已有端点测试可复用；命令 `pnpm --filter @dshtrading/connector-binance test`。
- **工作量**：S。

#### G3 策略 / 选股器名册读取 + 回测参数覆盖

- **现状与证据**：`strategies/src/plugin.ts:742-749` 只注册 7 个写/回测工具，无 list；桥有 `GET /strategies/custom`（bridge.ts:1819）、`GET /strategies/screeners`（:1825）、`GET /strategies/tombstones`（:1822）。另有参数缺口：`strategy_backtest` 参数只有 strategyId/market/symbol/interval/limit（plugin.ts:278-302），而回测引擎支持 `paramsOverride`（engine.ts:36,66），UI 侧策略参数覆盖是 localStorage-only（StrategyView.tsx:221-230,294）。
- **agent 目前怎么绕**：读 `~/.dsh-trading/strategies/custom.json`（如果知道路径）；或让用户报 id。参数只能按策略落盘时的默认值回测，无法复现用户在 UI 里调过的参数组合。代价：`strategy_delete`/`screener_delete`/`strategy_backtest` 需要 id，agent 无法自助；「按我调的那组参数再回测一次」做不到。
- **建议接口**：`strategy_list()` → JSON `{ok,paradigms:[{id,title,horizon}],custom:[{id,title,horizon,updatedAt}],deleted:[id]}`；`screener_list()` 同构；`strategy_backtest` 增可选 `paramsJson`（JSON 对象串，覆盖引擎 `paramsOverride`，回显实际生效参数）。description 要点：先 list 再 author/delete/backtest；墓碑 id 表示内置已删除、`strategy_reset` 可恢复；覆盖参数必须回显。
- **风险等级**：A。
- **验证方式**：`packages/strategies/test/plugin-list.test.ts`、`packages/strategies/test/backtest-params.test.ts`；命令 `pnpm --filter @dshtrading/strategies test`。
- **工作量**：S。

#### G4 选股器执行（screener_run）

- **现状与证据**：纯函数契约 `ScreenerDefinition.evaluate(bars, params)`（screeners/types.ts:43-56）；扫描调度（名册 fetchSymbols → 截断扫描池 → 受限并发拉 500 根日 K → evaluate）只在客户端 ScreenerPane.tsx:7-9,282-314。
- **agent 目前怎么绕**：逐个标的调 `<market>_get_klines` 再自己算——受 composer 输出长度与轮次限制，扫 30 个标的即不可行。代价：选股器等于只对 UI 可用。
- **建议接口**：`screener_run(screenerId, market, limit?)` → JSON `{ok,screenerId,market,scanned,matched:[{symbol,name,metrics,reason}]}`；description 要点：只读扫描、不产生交易信号、结果上限与扫描池上限显式回显；数据不足的标的静默跳过（契约语义）。
- **风险等级**：A（读行情 + 纯函数计算，无交易语义）。
- **验证方式**：`packages/strategies/test/screener-run.test.ts`（含并发上限、超时、结果截断、NOT_IMPLEMENTED 降级）；命令 `pnpm --filter @dshtrading/strategies test`。
- **工作量**：M（需要 host 侧复刻扫描调度 + 并发/超时护栏）。

#### G5 自选分组 + 选中态读取

- **现状与证据**：分组 store 完整（watchlist/src/index.ts:57,180-205；assignGroup/stripGroup 见 index.ts:138-168）；桥 6 条端点（bridge.ts:1831,1877,1899,1942,1882,1945）；UI 4 个写方法（client-ui-trading/src/client/index.ts:204-209）；agent 4 工具不含分组（watchlist/src/plugin.ts:74,108,149,186）。现状注释「注册表只有桥读写（agent 工具面不暴露分组）」（client-ui-trading/src/index.ts:150-153），而该功能的决策记录把「agent 工具行为不变」列为当时变更的**范围选择**（`.agents/notes/implemented/feature/2026-09-08-watchlist-groups-manager.md` Consequences），并非原则性禁止。`/selection` 读面（bridge.ts:1834）无工具。
- **agent 目前怎么绕**：只能按市场加/删行；分组归属靠用户点。代价：跨市场组织自选这一核心用法 agent 完全不可达。
- **建议接口**：
  - `watchlist_group_create(name)` → `{ok,id,name}`；`watchlist_group_rename(id, name)`；`watchlist_group_delete(id)`（description 必须要求先回显成员数，删组会 `stripGroup` 清成员但保留行，index.ts:159-168）。
  - `watchlist_group_assign(id, market, symbol, member)` → `{ok,assigned|removed,materialized}`（未入组的种子行会自动物化，bridge.ts:1414 同语义）。
  - `watchlist_list` 增加 `groups` 与 `selection` 字段（与 UI 同源）。
- **风险等级**：A。
- **验证方式**：`packages/watchlist/test/groups-tools.test.ts`（CRUD、成员幂等、删组连带语义、跨区 id 提示）；命令 `pnpm --filter @dshtrading/watchlist test`。
- **工作量**：S/M（4 个窄工具 + list 扩展 + 桥/工具共用同一 store 实例，注意双 store 数据丢失前科见 review-fixes note）。

#### G6 路由写入（routing_set）

- **现状与证据**：`routing_get` 只读（router/src/tools.ts:24-49）；写路径只在设置 UI（trading-settings-controller.ts:155-157）；settings namespace `dshtrading.markets.<market>.provider`（本机 `~/.dsh-trading/settings.yaml:212-221` 实测 crypto=okx、us=yahoo、cn=tencent、hk=futu）；`'routing'` 无 emit 生产者（eventbus/src/index.ts:39）。
- **agent 目前怎么绕**：无。只能让用户去设置面板；或手改 settings.yaml（不在 agent 常规路径，且手编文件监听不可靠——exchange-routing.md §2.2 已记录该边界）。
- **建议接口**：`routing_set(market, provider, reason)` → `{ok,market,from,to,effective:"new-session"}`；description 要点：这是影响分析结果的配置，必须回显旧→新与原因；provider 值由 settings schema 校验；会话内工具面不切换，提示新建会话生效；写成功 `emit('routing')`。
- **风险等级**：B（审计留痕 + 显式回显，禁止静默改）。
- **验证方式**：`packages/router/test/tools-set.test.ts`（非法 provider 拒写、回显字段、emit 触发、无 settings 时降级）；命令 `pnpm --filter @dshtrading/router test`。
- **工作量**：M（需先定 settings 写契约与 `routing` 事件语义；属 packages/api 或设计文档先行项）。

#### G7 FX 汇率读取（fx_get）

- **现状与证据**：`GET /fx?base=`（bridge.ts:1810-1813），FxService 在 holdings/plugin.ts:90-102，桥经 `ctx.get` 注入（client-ui-trading/src/index.ts:106-116）；`holdings/src/tool.ts` 无 fx/rate 引用。
- **agent 目前怎么绕**：用公开汇率源自行取数（口径与台账不一致，且台账的 stale 语义丢失）。代价：多币种汇总只能估算。
- **建议接口**：`fx_get(base?)` → `{ok,base,rates,asOf,stale}`；description 要点：rates[c] = 1 单位 c 折合多少 base（契约 §4）；stale=true 时必须向用户标注近似。
- **风险等级**：A。
- **验证方式**：`packages/holdings/test/tool-fx.test.ts`；命令 `pnpm --filter @dshtrading/holdings test`。
- **工作量**：S。

#### G8 衍生品历史序列

- **现状与证据**：契约 `getDerivativesHistory?`（api:583），实现 binance:199、okx:325、bybit:152，桥 `/derivatives/history`（bridge.ts:1771），仅 UI 趋势卡消费（client/api.ts:75），无工具。
- **agent 目前怎么绕**：用 `crypto_get_derivatives` 现值 + 自算趋势，缺历史序列。
- **建议接口**：`crypto_get_derivatives_history(symbol, limit?)`。
- **风险等级**：A。**验证**：`packages/kit-crypto/test/derivatives-history.test.ts`。**工作量**：S。

#### G9 图表指标名册迁移导入（低价值，可不做）

- **现状与证据**：`POST /chart/indicators/import`（bridge.ts:1948）一次性迁移本地名册；`indicator_activate` 可逐条替代（chart-tools.ts:66）。
- **建议**：不新增工具；如确有批量需求，再评估。

#### G10 更新器（明确不做）

- **现状与证据**：`/updater/state|check|apply`（client-ui-updater/src/index.ts:95,99,104），该包不注册任何工具。
- **判定**：应用自更新会替换 profile 内包并触发重启，属人类运维动作，且与「交易能力面」无关。**明确不做**（见 §5）。

### 4. 实施顺序

**Wave 1：照 holdings 范式一次做完（A 类，无公共契约变更，可并行）**

| 项 | 依赖 | 并行性 | 说明 |
|---|---|---|---|
| G5 自选分组 + 选中态读 | 无 | 可与 G3/G7 并行 | 直接仿 holdings：4 个窄工具 + list 扩展 + emit('watchlists') |
| G3 策略/选股器名册 | 无 | 并行 | 纯读，store 已有 list |
| G7 fx_get | 无 | 并行 | FxService 已有，仅加工具包装 |
| G2 盘口/逐笔 | 无 | 可与 G1 同批 | 工具工厂 + 各连接器接线，按市场分别提测 |
| G8 衍生品历史 | 无 | 并行 | kit-crypto 单点 |

**Wave 2：必须先定契约（`packages/api` 或设计文档先行）**

| 项 | 前置契约 | 说明 |
|---|---|---|
| G1 账户读面 | `TradeService` 可选方法的语义与「未实现」错误码统一（api:605-627 已有可选方法，需补 `TRADING_NOT_IMPLEMENTED` 的工具层约定）；同时裁决「账户只读数据是否需审计留痕」 | 涉及四市场 × 多连接器，是本次最大工作量 |
| G4 screener_run | 扫描池上限、并发、超时、结果截断与取消语义（现在只在客户端约定） | 需在 `docs/design/strategy-tab.md` 或 api 层写死 |
| G6 routing_set | settings 写契约 + `'routing'` 事件语义 + 回显格式 | 属 B 类，必须有审计留痕与显式回显 |

**Wave 3：文档与一致性**

- 补 connector/kit 工具的 description 纪律文案（下单/撤单工具加「操作后必须回显」与实盘口径说明）——纯文案，不改权限。
- 收敛同名双源工具（`crypto_funding_rate`：kit-crypto:226 vs okx:1099；`us_get_news`：kit-us:228 vs finnhub:217），或在 description 标注来源。
- 更新 `docs/design/agentic-native-architecture.md` §5.6 的「工具面冻结」纪律：记录本次窗口重开与新增工具清单。
- 同步 holdings-ledger.md §5 之外的契约文档（strategy-tab.md 等）。

### 5. 明确不做清单（C 与 D 类，逐条理由）

**C 类：交易语义，保持闸门，不得开放**

| 项 | 现状证据 | 不做理由 |
|---|---|---|
| 新增任何下单/撤单/改单工具（含补齐 tencent(cn/hk)、binance、alpaca、yahoo、futu、bybit、ccxt 的 `cancel_order`） | 闸门正则 `/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/`（base/src/index.ts:51）；现有撤单工具仅 okx:1126、ibkr:255、qmt:282、longbridge:260、tiger:258 | 铁律 #3：交易语义只能经统一审批闸门；补撤单工具等于扩大实盘动作面，收益不足以抵风险。现有缺口按「provider 不支持」处理 |
| `liveTrading` 开关 | 仅存在于 connector config 默认 false（base/src/presets.ts:83；connector-binance/src/index.ts:35-40） | 实盘授权的显式声明，必须由用户改配置文件/预设，不进 agent 面，也不做 UI 开关 |
| paper / live 模式切换 | localStorage `dshtrading:trade:mode`（client-ui-trading/src/client/trade-mode-store.ts:5） | 交易语义开关；UI 唯一通路保持不变 |
| 模拟盘（paper）下单与 paper 持仓读取 | paper store 在客户端（`dshtrading:paper:account:v1`，client-ui-trading/src/client/paper-trading-store.ts:37,118） | 下单动作归 C 类；若未来要开放，需新命名空间（如 `paper_*`）且明确不命中闸门族（架构 §5.6「任何新工具不得命中或仿冒该命名族」），属独立裁决 |
| GUI 桥下单路径（`POST /trade/order`，dryRun 缺省 false，bridge.ts:764-790） | 与界面文案「本面板只做模拟与只读查询」（locales.ts:408）矛盾；该路径不经 base 工具层审批，只过服务缝 `liveTrading` 三态检查 | 属 C 类安全语义，**本轮只记录不动代码**；建议用户裁决是改文案还是改路径（见「架构差距」第 7 条） |
| 定时任务权限确认（`confirm-permission`） | 桥 action 存在（client/tasks-protocol.ts:184），工具刻意不注册（tasks/tools.ts:12-14） | 人类唯一通路，刻意保留；agent 只能创建/更新任务并看到「待人工确认」状态 |

**D 类：凭据/密钥，永不进 agent 面**

| 项 | 现状证据 | 不做理由 |
|---|---|---|
| 券商/交易所 API key、secret、passphrase | 录入面在设置 UI：`client-ui-settings/src/client/MarketProviderPanel.tsx:125-208`（password 输入 + 保存/删除）+ 字段词表 `trading-settings-controller.ts:62-121`（18 个 provider 的 apiKey/apiSecret/secretKey/passphrase/token/appKey/appSecret/accessToken/privateKey 等）；落点 settings `dshtrading.credentials`（router/src/index.ts:96-97,123-124）；连接器只存 ref 名（connector-binance 头注、okx-dual-connector note）；`~/.dsh-trading/.credentials.yaml` 为 600 权限 | 铁律 #5：不内置密钥；凭据面开放等于把账户控制权交给模型，且无回滚语义 |
| 凭据的列举 / 测试连接 / 轮换 | 同上 | 同上；轮换属人类运维 |

**其它不做**：更新器 state/check/apply（人类运维，见 G10）；`/watchlists` 整表 PUT 与 `/watchlists/import`（GUI 拖拽排序与一次性迁移，工具面可用单行增删循环替代）；`/chart/indicators/import`（G9）。

## 架构差距（agentic-native-architecture.md 目标 vs 现状）

1. **能力三元组缺 Tool 边**：watchlist 分组、strategies 选股执行、router provider 写三项，Registry/Store 与 View 都在，唯独 Tool 缺席——正是 §3.1 要消除的形态。
2. **`'routing'` 失效通道空转**：store 白名单声明 `'routing'`（eventbus/src/index.ts:39），全仓无生产者（仅 eventbus 测试触发）；§5.1「发布点」列了 routing 设置变更，未落地。
3. **`presentationMeta` 零实现**：全仓 rg 零命中，33 个工具 `output` 一律 `{ schema: { type: 'string' }, render: text }`；§5.5 的富卡片只能靠客户端解析人读文本（client-ui-strategies/src/client/toolview-parse.ts）。
4. **富卡片覆盖不全**：仅 `*_place_order`、`watchlist_add/select`、`strategy_backtest/author` 有 toolview；holdings / knowledge / indicators 工具无卡片（§5.5 未列为强制项，属范围缺口）。
5. **base 行情工具的平面归属与文档不一致**：§4.3 把通用工具列 host 平面，而 `base/research-tools` 由 preset 生成行挂载（base/src/presets.ts:109）——语义上 preset 面更合理（按市场隔离），待确认是否刻意。
6. **工具面「一次成型后冻结」需要重开一次窗口**：§5.6 要求 host 平面工具面稳定以保 KV cache；本次建议新增 6 至 8 个工具，必须在文档层显式记录一次冻结窗口重开。
7. **「实盘下单唯一通道是 Agent 会话」与实际实现矛盾**：界面文案如此声明（client-ui-trading/src/client/locales.ts:408），桥 `placeOrderFromGui` 默认 `dryRun: false` 直通真实连接器（bridge.ts:760-790），客户端请求体亦硬编码 `dryRun: false`（client-ui-trading/src/client/api.ts:201），GUI 侧只剩服务缝 `liveTrading` 三态检查，没有工具层审批交互。待用户裁决。
8. **返回形态纪律不统一**：holdings 用「人读文本 + `[tool] …` 失败前缀」，router/watchlist/strategies 用 JSON 文本，indicators/knowledge 混合。建议新工具跟随所在包既有形态，不强行统一。

## Context & Efficiency Impact

- **工具 schema 常驻成本**：建议新增 6 至 8 个 host 平面工具（分组 4、list 2、screener_run 1、routing_set 1、fx_get 1）+ 若干市场面只读工具（G1/G2 按市场展开）。host 平面工具一次性常驻，换取全会话能力（§8 已接受该取舍）。
- **KV cache**：新增只允许在「冻结窗口」内批量落地，落地后 schema 稳定；参数保持扁平 string/number，避免对象型 schema 引发每请求前缀变化。
- **生效方式**：工具在宿主启动期注册，生效需重建 runtime / 重启宿主（与 holdings note 同款结论）；`routing_set` 的 provider 切换按会话级 preset 语义需新建会话生效。
- **不新增 HTTP 面**：所有建议只补工具，不改桥契约（铁律 #6），不新增端点；`/routing` 也不新增端点（走 settings）。
- **成本护栏**：`screener_run` 与 `<market>_get_orders/fills` 需要结果上限与超时，避免单次调用打爆数据源配额。

## Alternatives considered

- **只按 holdings 样板逐包补，不做全量审计**：无法回答「还有哪些缺口」，且容易把 C/D 类能力一起补上；先出矩阵再挑 A/B 类落地。
- **做一个通用 `trading_mutate(op, payload)` 工具覆盖所有缺口**：schema 无法约束，模型易写错 op 与 payload 形状，回显文案无法按操作定制（holdings note 已否决同款方案）。
- **让 agent 直接打 `/dshtrading/api` REST 端点**：agent 没有带认证栅栏的 HTTP 工具，且桥是 UI 面契约（工具面才有审批与纪律文案）。
- **把 `routing_set` / 账户面读工具纳入审批闸门**：闸门语义是「真实交易前置确认」（铁律 #3）；只读与配置写入纳入会让日常操作也要审批。正确做法是 B 类「审计留痕 + 显式回显」。
- **一次性补全所有缺口（含 C 类撤单、paper 下单）**：直接违反铁律 #3 与 §5。
- **给自选分组单开 cordis 服务**：该功能已定「沿用桥自建 file store」模式（watchlist-groups note Alternatives），工具面复用同一 store 实例即可，不再引入服务先例。

## Verification & Gates

- 基线（本轮只读实测，2026-09-08）：`pnpm test` = 157 文件 / 1319 用例通过（exit 0）；`node scripts/typecheck-gate.mjs` = 481 错误 = 基线（棘轮通过）。任何落地必须同时保持 `pnpm -r build` + `pnpm -r test` + `node scripts/typecheck-gate.mjs` + `pnpm i18n:check` 全绿（CI 五步，见 watchlist-groups note 合并后修正）。
- 每张缺口卡片已给出建议测试文件与 `pnpm --filter` 命令；新增工具必须同时补「注册幂等 + 写后 emit + 失败语义」三类断言（holdings 样板先例：`packages/holdings/test/plugin.test.ts:21,38`）。
- 端到端验收（建议按 §7 风格补对话语句）：
  1. 「把自选里的港股单独建个组」→ 分组出现在左栏且 agent 回显组名与成员数。
  2. 「用动量选股器扫一遍 A 股」→ 返回命中清单，含 reason 与指标列。
  3. 「我美股账户现在有哪些挂单和今天的成交」→ 返回 provider 与条数；provider 未实现时明确 NOT_IMPLEMENTED。
  4. 「把加密行情源换成 binance」→ 回显旧→新 + 提示新建会话生效，settings.yaml 同步落盘。
  5. 「看一下 BTC 盘口前 10 档和最近 50 笔」→ 返回快照与逐笔，标注非实时流。

## Risks

- **provider 覆盖不一**：账户读面工具必须区分「未实现」与「无数据」，否则模型会把空结果当成真实空仓（G1）。
- **screener_run 成本**：全市场扫描 = 名册 × 500 根日 K，需并发上限、超时与结果截断（G4）。
- **routing_set 的会话内不一致**：切换 provider 对已开会话工具面不生效，必须回显「新建会话生效」（G6）。
- **分组删除连带成员**：删组会清成员但保留行（watchlist/src/index.ts:159-168），工具必须先回显成员数（G5）。
- **双 store 数据丢失前科**：watchlist 曾因桥与插件各建一个 file store 导致 agent 写覆盖 GUI 写（`.agents/notes/implemented/feature/2026-09-08-watchlist-groups-manager.md` Addendum、review-fixes note）；分组工具必须复用同一实例。
- **C/D 类边界被后续会话反复重提**：§5 逐条写明理由，后续会话以本文为准。
- **本记录的时效**：工作树另有其他会话的未提交改动（含 `packages/base/cordis.patch.yml`），若该变更改动工具面挂载行，本矩阵需重跑（命令见 §0）。
