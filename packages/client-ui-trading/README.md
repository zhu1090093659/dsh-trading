# @dshtrading/client-ui-trading

交易 GUI 壳（专业交易软件的三栏式架构载体），dsh web 宿主双面包插件：

- **node 半**（`src/index.ts`）：注册 `/dshtrading/api` 前缀路由，把客户端行情请求透传给
  对应市场的 `MarketDataService`（connector-binance/yahoo/tencent）。依赖 `webServer` +
  `connection`（`ctx.inject` 子插件声明），**headless 宿主永不解析、零副作用**。
  路由挂在 `connection.requestRejection` 认证栅栏后（与 `/api` 同一浏览器 cookie）。
- **浏览器半**（`src/client/index.ts`）：
  - 遮蔽 `sidebar.workspaces`（priority -1）→ 左栏市场页签（自选/crypto/us/cn/hk）+
    标的行（迷你走势、最新价、涨跌幅，红涨绿跌）、搜索加自选（localStorage 持久化）；
  - `shell.overlay` 加 `dshtrading-quote-pane`（order 50）→ 中栏舞台
    `MiddleStage`（3.0）：视图注册表（行情 | 量化占位）+ 顶部切换条；行情视图 =
    报价头 + **lightweight-charts v5 K线**（主图蜡烛 + 叠加指标，副图成交量 +
    指标，周期页签，crypto 支持分钟级）+ OKX 式技术指标选择器（3.1：单按钮
    展开，主/副图两组勾选 + 行内参数编辑）；
  - `shell.overlay` 加 `dshtrading-session-rail`（order 60）→ 右缘常驻会话竖条
    （折叠/新会话/设置，2.9）。
  - 中栏几何由 QuotePane 实测（自选停靠右缘 ↔ 对话列/竖条左缘），视图互斥挂载。

## 指标系统（3.1 插件化）

- 指标 definition（类型 + math + 预置）在纯库 `@dshtrading/indicators`；预置
  MA/EMA/BOLL/MACD/RSI/KDJ 由 `@dshtrading/client-ui-indicators` 插件在
  client 上下文 provide 为 `tradingIndicators` 服务（cordis reflect.provide）。
- 本包持有本地注册表（`indicator-registry.ts` 单例）+ 可选桥接（`ctx.inject`
  服务可用才合并 definition）；插件未安装时行情视图零指标正常工作。
- definition 的 title/label 是普通字符串（宿主 locale 命名空间单占，外部插件
  无 i18n 通道）；社区指标 = 交付纯数据 definition 并 inject 服务 register。
  设计与备选：`.agents/notes/implemented/architecture/2026-08-30-indicator-plugin-split.md`。

## 数据与合规（铁律 #5）

- 桥是无状态透传：不缓存、不落盘、不再分发；频率由客户端轮询控制
  （自选批量 8s/市场、行情页 5s，页面隐藏时暂停），单次批量 symbols 封顶 32。
- 行情源是各连接器的公共端点（Yahoo/腾讯/Binance），ToS 边界见根 README 数据源表。
- 自选列表只存浏览器 localStorage（`dshtrading.watchlist.v1`），不上传。

## 已知边界（上游改进候选）

1. **视图切换没有跨组件通路**：`conversation.view` 的激活视图是宿主按会话持久化的
   私有 store，外部无法程序化切 tab——左栏点击标的后，若当前不在「行情」tab，需手动点
   一次（之后按会话保持）。上游若把视图切换暴露成 ctx 服务即可消除。
2. **无会话时中栏是宿主 hero**（选择工作区 + 新会话输入框）：`conversation.view` 只在
   会话内渲染，属宿主结构；在官方 composer 直接输入即建会话进入。历史会话面板
   已 portal 并入该 hero 容器拼成同一张卡（HomeHistory），设置/新会话/折叠收敛在
   右缘常驻会话竖条（SessionRail，2.9）。
3. 右栏面板是浮层（`shell.overlay`），非占位列——展开时覆盖中栏右缘；折叠为 34px 细轨。
   真正的停靠列需要宿主 AppFrame 扩展（上游建议）。
4. `Ticker` 契约无 name 字段：搜索添加的标的以代码为显示名（种子列表带中文名）。

## 构建

`pnpm build`（node 半 tsdown + 浏览器半 tsdown.client.config.mjs，与 client-ui-settings
同款三段 banner/intro/footer 契约与 CSS module 内联）。
