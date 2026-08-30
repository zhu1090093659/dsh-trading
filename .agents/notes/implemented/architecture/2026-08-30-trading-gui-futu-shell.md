# Agent Note: 第二阶段 GUI 改造 —— 富途式三栏交易壳（slot 遮蔽 + host 面数据行）

Status: implemented

> **2.3 修订（2026-08-30 同日，用户驱动）**：初版「遮蔽 sidebar.workspaces 放市场面板 +
> shell.overlay 右侧会话面板」的形态被推翻——遮蔽官方 WorkspaceBrowser 丢失其工作区分组/
> 搜索/管理能力，且自建会话面板与官方浏览器并存割裂（会话库全机共享，不按工作区过滤就
> 会混入其他环境的会话）。**定稿形态：「接口不变、位置重排」**：
>
> - 宿主三栏栅格用 `direction: rtl` 整体翻转（[sidebar|conversation|details] → 视觉
>   [details|会话|侧栏]）：**官方会话浏览器原样保留**（工作区分组、搜索、会话管理、
>   设置入口全在），只是移到右缘；不遮蔽任何宿主组件。
> - 左侧空出的轨道停靠**自选面板**（`shell.overlay` 官方浮层通道，自家内容不盖宿主内容），
>   中栏以 padding-left 真实让位（ConversationRoot 自测宽度自动适配）。
> - 右侧侧栏的 `sidebar.workspaces` 座仍被遮蔽，但 occupant 换成**会话区**：历史会话
>   （默认折叠、按所选工作区过滤——WorkspaceView.sessionIds）+ 底部**新对话入口**
>   （工作区选择 + 输入框，走官方 `uiWorkspace.connectWorkspace` + 会话 scope 的
>   `IConversation.send` 直接发出首条消息，绕开宿主 hero）。
> - 中栏双模式（mode store，localStorage 按 profile 持久化）：**quotes（默认）**——
>   会话壳 visibility:hidden + QuotePane 浮层（点自选即行情，无会话也可用）；**chat**——
>   官方会话 UI 原样上屏。切换通路：点自选→quotes；点历史会话/新对话→chat；pane 内
>   「AI 对话」按钮→chat；pending approval 强制 chat（审批卡在 composer 链，不可被
>   行情面板遮盖——安全闸门不降级）。宿主 hero 从此不上屏（空白会话显式进 chat 才见）。
> - 代价明示：rtl 下宿主拖拽手柄坐标错位（隐藏之，列宽拖拽不可用，折叠开关不受影响）；
>   工具详情列落到左侧轨道，自选面板测量其矩形自动避让。
>
> 初版教训（保留作反模式记录）：CSS 按 aria-label 隐藏宿主按钮、自建会话列表平铺全库、
> pane 显隐条件依赖会话非空白（打开会话的瞬间 byId 尚无该行 → 判定抖动回行情，正确条件
> 是「有 current」而非「非空白」）。
>
> **伴生 bug（本轮用户加 HYPE 后整页 slot 崩掉暴露）**：桥的业务错误信封是 HTTP 200 +
> `{ok:false, code, message}`，客户端 `getJson` 未把它转成 rejection——`fetchKlines`
> 把 `undefined` 当成功值返回，`klines.map` 在组件内炸开（HYPE 不被 Binance/OKX 现货
> 支持 → klines 必返业务错误）。修复：getJson 检查 `ok===false` 抛 BridgeError，三个
> fetch 函数再对载荷做默认值兜底；UI 对不支持标的优雅降级（红字 TRADING_UNSUPPORTED_SYMBOL）。
> 另：静态包的 slot 条目崩溃宿主无人上报（监督缝只覆盖动态插件），本包 apply 里挂
> `slots.onEntryError` 打 console——调试期利器，保留。

## Problem

第二阶段目标：把 dsh web GUI 改成富途式交易界面——左栏从「会话/工作区选择」换成
「市场页签 + 自选」，中栏显示标的行情，右栏做可折叠 tab 面板承载新建会话与 AI 对话。
约束：DSH checkout 只读（禁止改宿主源码），一切扩展必须走官方插件机制。

探明宿主事实（vendor/loader、ui-slots、ui-layout、ui-conversation 源码级）：

1. web 壳是 React 三栏 `AppFrame`（sidebar/conversation/details 三个 slot）；插件可
   以更低 priority 遮蔽（shadow）任何 slot 的官方占位者。
2. **root 整框接管不可行**：`ConversationRoot` 是 ui-conversation 包内部组件（不导出），
   且 slot 子声明有归属（`SlotOwnershipError`，已声明子 slot 不可由遮蔽者再声明）——
   接管 root 后 AI 对话（含审批卡、工具卡）无法在任何位置再渲染，自建聊天会丢
   approval 交互面（交易安全闸门的 web 形态），否决。
3. **行情服务在 preset 平面**：连接器行在 agent.cordis.yml（会话隔离）且必须包
   isolate realm 组；host 根作用域不存在 `tradingXxMarketData`——GUI 桥直接 `ctx.get`
   拿不到服务（本轮首次实测 `markets: []` 的根因）。
4. 审批卡在 `conversation.composer` 链、工具详情在 `details` 列——遮蔽 details 会
   降级安全/排障面。

## Decision

**四件套，全部官方机制：**

1. **新包 `@dsh-trading/client-ui-trading`（base bundle 挂行，市场无关行归 base）**，
   浏览器半注册三个 slot：
   - 遮蔽 `sidebar.workspaces`（priority -1）→ 富途式市场页签（自选/已装市场）+
     标的行（SVG 迷你走势、最新价、涨跌幅，红涨绿跌）+ 搜索加自选（localStorage 持久化）；
   - `conversation.view` 加 `quote` 视图（order -10，第一个 tab）→ 报价头 +
     纯 SVG K线（candle + MA5/10/20 + 成交量 + 十字线，无第三方图表库）+ 周期页签；
   - `shell.overlay` 加 `dshtrading-side-panel` → 右侧可折叠停靠面板（新建会话走
     `uiWorkspace.connectWorkspace`，会话列表走标准 `useSessions`）。不用遮蔽
     `details`（保住审批/工具详情面）。
2. **行情 HTTP 桥**：node 半注册 `/dshtrading/api` 前缀路由（webhook-github 先例），
   挂 `connection.requestRejection` 认证栅栏，批量报价/K线透传给市场服务；无状态
   不缓存（铁律 #5），轮询节奏在客户端（自选 8s/市场、行情页 5s，页面隐藏暂停）。
   `ctx.inject(['webServer','connection'])` 子插件声明依赖：web 宿主就绪后注册路由，
   headless 宿主永不解析、挂起无害（双宿主安全）。
3. **host 面数据行（dataplane）**：四个连接器各加 `src/dataplane.ts` 子路径入口
   （loader 走标准模块解析，exports 加 `./dataplane`），只 provide 行情服务、
   **不注册任何工具**（工具面留在 preset 平面，会话隔离铁律不破）；激活语义与
   preset 行一致（binance/okx 走 routeAllows 三态设置路由裁决，yahoo 直接 provide，
   tencent 单包双市场 config.market 分流）。市场 bundle patch 各插一行（crypto 插
   binance+okx 两行并存）。
4. **面板展开让位**：全局 CSS 按 `body[data-dshtrading-panel='open']` 给宿主
   `[data-conversation-scroll]` 及会话 header 加 320px 右 padding（锚点用宿主稳定
   data 属性，非哈希类名）；面板折叠属性翻转，让位消失。

## Alternatives considered

- **root 接管自绘三栏**：对话组件不可迁移（见 Problem #2），审批面必丢，否决。
- **遮蔽 `details` 放右栏 tab**：丢工具详情列，且 approvals 虽在 composer 链但
  详情文本（ApprovalCommand）在 details——安全排障面降级，否决。
- **typert remote 命名空间做数据桥**：host `TypertRemoteService` + client `$mount`
  完全可行（官方 sanctioned），但手写 descriptor 仪式重；webServer 路由有
  webhook-github 先例、可 curl 实证、认证栅栏一行接入，选后者。
- **数据面服务直接在桥插件里 `ctx.plugin(连接器 Service)`**：安装闭包按 profile
  而异（crypto-only profile 没有 yahoo/tencent），硬编码清单会炸；数据行归属各自
  市场 bundle（insert-only）才是组合正确的形态。

## Consequences

- **实测证据（trading-web profile，2026-08-30）**：`/dshtrading/api/markets` 返回
  `{"markets":[{"id":"crypto","provider":"okx"}]}`——用户 settings 把 crypto 路由到
  okx，binance 数据面按 routeAllows 静默、okx 数据面激活，**设置路由在数据面正确
  生效**；tickers/klines 返回 OKX 实时数据；未认证请求 401。浏览器实测：左栏自选
  （迷你走势+实时价+红涨绿跌）、中栏 [行情|对话|轨迹]（行情第一）、K线/MA/成交量
  渲染、右栏会话面板（新建会话+列表+当前高亮）、面板展开中栏让位，全部通过
  （截图 /tmp/dsh-ui-final-open.png 会话期存档）。
- `pnpm -r build` 22 目标绿、`pnpm -r test` 全绿（+36 用例：桥 10、图表布局 7、
  store/format 8、冒烟 3、dataplane 8）。
- 已知边界（上游改进候选，包 README 详列）：① `conversation.view` 激活视图是宿主
  会话级私有 store，跨组件无法程序化切 tab——左栏点标的若当前不在行情 tab 需手点
  一次（按会话保持）；② 无会话时中栏是宿主 hero（空白会话即 hero，发首条消息后
  tab 条才出现）；③ 右栏是浮层非停靠列，真正的停靠需宿主 AppFrame 扩展；
  `Ticker` 契约无 name 字段，搜索添加的标的以代码为显示名。
- 浏览器半构建注意：lightningcss 的 `code` 必须 Buffer（传 string 炸 NAPI
  TypedArray）——settings 包的 css 内联插件从未被执行过、潜伏 bug 随本次复制暴露，
  新包已修（Buffer.from）；该修法未回写 settings 包（其无 CSS 文件，不触发）。
- profile 刷新口径不变：重建后删 `~/.dsh/profiles/trading-web/node_modules/@dsh-trading/*`
  再 `dsh plugin --profile trading-web install`，重启进程。服务管理注意：`pkill -f
  profiles/trading-web` 杀不掉（进程 argv 不含 profile 字样），按端口
  `kill $(lsof -tnP -iTCP:<port> -sTCP:LISTEN)`。
