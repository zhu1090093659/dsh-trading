# Agent Note: 右栏退役——历史并入 hero 融合容器，入口迁窗口角标

Status: implemented

（承接同日 [会话入口归一](../simplification/2026-08-30-session-entry-unify.md)。该记录
只完成了「剔冗余」；用户随后三次收口：历史搬到左边与 hero 拼一个容器 → 右栏其余
内容（品牌头/新会话/设置）也并入左边 → 折叠与新会话放右上角、设置放左下角。本记录
覆盖最终形态，2.5 记录中「右栏只留历史列表」的决策被本篇取代。）

## Problem

2.5 后右栏只剩历史会话，但仍是一根 272px 独立栏：历史在右、composer 在左，两处
割裂；品牌头/新会话/设置继续占据右栏；会话列自身没有折叠手段。用户裁决：融合成
一个容器、右栏清空退役、入口按窗口角落归位。

## Decision

- **hero 融合容器（HomeHistory，遮蔽 sidebar.workspaces 的 slot 承载）**：面板
  DOM 经 portal 注入 hero 的 `[data-conversation-scroll]`、以 `[data-composer-seat]`
  邻接挂载；composer 卡类名是宿主 CSS module 哈希不可依赖，按「seat 内最靠下的
  可见圆角块」启发式找卡，量几何内联写 width/margin（上缘拼进卡底，卡底边框即
  容器内分隔线），圆角临时抹平、卸载还原，色板从卡片计算样式采样。可见性 =
  当前会话为 blank；byId 瞬缺按未命中处理（宁可抖动藏面板，不可拼到对话流
  composer 上）。挂载面用 sidebar.workspaces（有 useWorkspaces 注入面）但面板
  portal 出去——侧栏折叠/退役都不影响。
- **右栏退役（shell-pad.css 规则 8）**：侧栏轨道归零，原列 `position:absolute;
  left:-3000px` 保持挂载——官方设置弹层是 sidebar.settings 占位组件的子树，
  display:none 会连弹层一起隐藏；移出视口则渲染照旧、`position:fixed` 弹层照常
  盖满视口。QuotePane 右缘测量固定取 children[1]（对话列），退场时其宽 0 自然
  回落 frame 右缘。
- **窗口角标（2.8 用户拍板）**：右上 = 折叠/展开（折叠会话列轨道归零 + 整列隐藏，
  localStorage 持久化，fold-store 单一可观察源）+ 新会话（宿主 startSession 无参
  取当前/最近工作区）；左下 = 设置（程序化 click 退役列内的官方触发器，该触发器
  是侧栏唯一的 `[aria-haspopup=dialog]`）。首页/折叠态右上走 WindowChrome 浮动
  簇（shell.overlay order 60）；会话进行中走官方 conversation.session.header.
  utilities 槽内联（HeaderCornerActions，order 90 排在 Session 日志后＝窗口右上
  角，不遮日志）。
- **session 作用域 slot 的注册位置**：必须在 `ctx.inject(['slots','conversation'],
  scope => …)` 回调里用 `scope.slots.register`——根 ctx 上 slots.inject 该类 slot
  会被渲染器静默忽略（同 ui-agent-preset 的做法）。
- **无当前会话兜底**：右栏退役后无路可走的状态不可接受——HomeHistory 检测
  `sessions.current === undefined && phase ready` 时执行 startSession 重开（宿主
  recentWorkspace 策略），hero 融合容器永远可达。
- **品牌头/版本信息不保留**：hero 自带鲸鱼标与「预览版」徽标；版本号随退役列
  一起消失（需要时开设置或走 dev 工具）。

## Alternatives considered

- 右栏保留空壳（新会话 + 设置）：272px 换两个按钮，用户明确要并入左边，放弃。
- 设置入口自行实现面板：官方设置打开态是 SettingsRoot 组件私有 state，无服务可
  调，只能程序化 click 官方触发器，放弃自绘。
- 折叠会话列后在列内保留 40px 展开 rail：要往宿主 ConversationRoot 里塞自家
  DOM（2.3 教训：root 接管是死路）；改为折叠时浮动簇接管展开入口，放弃。
- in-session 右上入口继续浮层：与 Session 日志 chip 同角重叠；改走 utilities 槽
  内联，放弃浮层。
- 遮蔽 sidebar.settings 自绘触发：会连带杀死官方设置壳，放弃。

## Consequences

- 桌面 trading 壳最终布局：[工具详情 | 行情 | 会话列（含融合容器）]，无侧栏；
  全部入口收敛到四处——hero composer（新对话）、融合面板（切会话）、右上角标
  （折叠/新会话）、左下设置。
- 宿主升级风险点：composer 卡启发式找卡（结构大改时面板退化为不拼接，需重校）、
  `[aria-haspopup=dialog]` 触发器选择器、session 作用域注册模式。均已在
  HomeHistory/index.ts 注释标注。
- 老键 `dshtrading.browser.workspace.v1`（2.4 输入卡）、新增
  `dshtrading.home.history.open.v1`、`dshtrading.chat.folded.v1` 为 localStorage
  约定，无迁移。
- 验证：`pnpm -r build`（22 包）/`pnpm -r test` 全绿；trading-web 实测——首页
  融合容器拼接（面板顶=卡底+1px）、折叠/展开回环与刷新持久化、in-session 头部
  内联按钮、折叠后浮动簇接管、设置弹层开合、QuotePane 填充回落，零 slot 错误。
  已知验证环境坑：后台标签页冻结宿主 grid transition 与 rAF，读数会停在过渡
  中间——先 `transition:'none'` 或激活标签页再量（SessionBrowser 时代的教训，
  本轮再次踩中并修复了启动竞态：RO 回调改为重找卡而非只重量已知卡）。
