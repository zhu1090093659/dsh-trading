# @dshtrading/client-ui-trading

交易 GUI 壳（专业交易终端的三栏式架构载体），dsh web 宿主双面包插件：

- **node 半**（`src/index.ts`）：声明与兼容 `/dshtrading/api/*` 市场桥路由口径（核心 HTTP 桥已拆分至 `@dshtrading/bot-api` 供 GUI 与无头 bot 共用），经 `connection.requestRejection` 认证栅栏把行情、衍生品、自定义指标、策略/选股器、知识库、自选组、快讯/宏观/预测及交易读写请求路由到宿主服务。**headless 宿主不解析浏览器半区、零副作用**。
- **浏览器半**（`src/client/index.ts`）：
  - 遮蔽 `sidebar.workspaces`（priority -1）→ 左栏全市场自选与导航（`自选 / crypto / us / cn / hk / futures / global` 七标签，标的行展示迷你走势、最新价与涨跌幅，搜索并持久化至 `@dshtrading/watchlist` 宿主账本）；
  - `shell.overlay` 加 `dshtrading-quote-pane` → 中栏舞台 `MiddleStage`：
    - **行情 (`QuoteStage`)**：报价头 + **Lightweight Charts v5 K 线**（多周期蜡烛/A股与港股 5 日分时跨源路由、主/副图指标叠加与 OKX 式参数编辑、**KDAS 关键日右键锚定线**）、衍生品指标面板（持仓量/资金费率/多空比）、盘口深度/逐笔成交、基本面与新闻公告；
    - **策略 (`@dshtrading/client-ui-strategies`)**：6 大经典量化范式与自定义策略回测（`strategy_backtest` / `strategy_author`）、资金曲线与交易明细，以及 5 类预设与自定义选股器；
    - **知识库 (`@dshtrading/client-ui-knowledge`)**：Obsidian 风格力导图谱与结构化投研知识卡片库（检索、聚类漫游、导入导出）。
  - `shell.overlay` 加 `dshtrading-session-rail` → 右缘常驻驾驶舱与会话竖条（定时任务、统一持仓台账 `@dshtrading/holdings`、金十快讯、宏观日历与央行利率、工作区文件、Polymarket FOMC 预测市场）。
  - 中栏几何由 `QuotePane` 实测（左栏右缘 ↔ 会话列/右栏左缘），多视图在单一会话内按状态互斥挂载。

## 指标与扩展点

- 指标定义（类型 + 数学逻辑 + 预置）位于 `@dshtrading/indicators`；预置 MA/EMA/BOLL/MACD/RSI/KDJ 由 `@dshtrading/client-ui-indicators` 在 client 上下文 provide 为 `tradingIndicators` 服务；自定义指标经 `/dshtrading/api/indicators/custom` 与右键 KDAS 锚定线联动。
- 策略与知识库视图通过客户端视图扩展机制挂载进 `MiddleStage`，数据层分别由 `@dshtrading/strategies` 与 `@dshtrading/knowledge` 提供。
- 设计决策见 `.agents/notes/implemented/architecture/` 下对应 Owning Notes。

## 数据与合规（铁律 #5）

- 桥为无状态透传：不缓存、不落盘、不再分发；行情轮询在页面隐藏时自动暂停，单次批量 symbols 封顶 32。
- 自选列表与分组归 `@dshtrading/watchlist` 宿主侧持久化管理。
- 所有下单请求严格经过 `@dshtrading/base` 的 dry-run 与人工/Ed25519 审批闸门。

## 构建

`pnpm build`（node 半 `tsdown` + 浏览器半 `tsdown.client.config.mjs`，与 `client-ui-settings` 同款三段 banner/intro/footer 契约与 CSS module 内联）。
