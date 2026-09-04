# Agent Note: 会话入口归一——右栏只留历史会话，新对话统一官方首页 composer

Status: implemented

（2026-08-30 同日补充：右栏最终整体退役、历史并入 hero 融合容器，见
[右栏退役](../architecture/2026-08-30-right-rail-retire-hero-fusion.md)——本篇的
「右栏只留历史会话列表」形态已被取代，「剔冗余入口」的裁决与理由仍有效。
新会话/折叠/设置入口其后进一步收敛为右缘会话竖条，见
[会话竖条](../architecture/2026-08-30-session-rail-vertical-toolbar.md)。）

## Problem

2.4 布局下新对话入口有两处并存：左侧官方 composer（工作区文件夹 + PTC +
模型/effort 全量能力）和右侧会话区底部自绘入口卡（工作区 select + 输入框 +
发送，走 connectWorkspace → open → send 三步）。两处功能重复且能力不对等
（自绘卡无 PTC/模型选择），用户裁决「以左边为主，剔除冗余入口，合并成一
个」；入口卡同时残留「↑ 文本假图标」违例。

## Decision

- `SessionBrowser` 只保留历史会话列表（默认展开）：遮蔽官方
  WorkspaceBrowser 的理由从「紧凑 + 自绘入口」收窄为「宿主形态自带每组
  『+ 新会话』等重复入口」。
- 列表作用域改为派生态：当前会话所在工作区 → 无当前会话时取会话活动最近
  的工作区（宿主 `watchNavigation` 的 `recentWorkspace` 同款策略）→ 兜底
  首个工作区。左侧官方 composer 换文件夹即换右栏列表，两处天然联动。
- `client` 半 `inject` 摘除 `uiWorkspace`；`startConversation` 注入面、
  `pickedWorkspace` localStorage 持久化（`dshtrading.browser.workspace.v1`）、
  `browser.newPlaceholder/send/workspace` 三个 locale 键全部删除。
- chevron 从「▸」文本符号换内联 SVG 矢量；折叠态补 `aria-expanded`/
  `aria-controls`（状态语义直接驱动 CSS）。

## Alternatives considered

- 右栏保留工作区 select 仅作历史过滤：与左侧官方文件夹选择器仍是同一语义
  两处控件，违背「剔除冗余入口」，放弃。
- 撤销遮蔽、回归官方 WorkspaceBrowser：其头部视图选项/添加工作区/每组
  「+」都是新会话或建工作区入口，冗余入口不减反增，放弃。
- 历史列表跨工作区合并平铺：会话库全机共享，混入 harness/dsh-web 等无关
  工作区会话，噪音大，放弃（保留 2.3 教训：按 WorkspaceView.sessionIds 过滤）。

## Consequences

- trading 壳内新建会话只有一条路：官方 composer（对话列内或无会话 hero）；
  官方「新会话」按钮承担「回到 composer」的导航职责。`uiWorkspace` 的
  connect/open/send 三步知识随之退役，client 半对宿主的依赖面变小。
- 老用户的 `dshtrading.browser.workspace.v1` localStorage 键成为死数据
  （无读取方），可留可清，不做迁移。
- 验证：`pnpm -r build` / `pnpm -r test` 全绿（client-ui-trading 30 例）；
  trading-web profile（删副本 → `dsh plugin install` → 重启 3081）实测——
  入口卡消失、历史默认展开含作用域标签、折叠回环正常、点历史行
  `openSession` 后 `body[data-dshtrading-chat]=on`，slot 零崩溃。
