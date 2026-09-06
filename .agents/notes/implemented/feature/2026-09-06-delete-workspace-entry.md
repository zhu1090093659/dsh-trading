# Agent Note: 首页历史面板补工作区删除入口

Status: implemented

## Problem

用户反馈 dsh-trading「没有入口来删除工作区」。实查成立：3.0 融合布局用 HomeHistory
（`sidebar.workspaces` slot，priority -1）整体遮蔽官方 WorkspaceBrowser，官方浏览器上
的工作区行菜单（重命名/删除）随之不可达；HomeHistory 只承载会话级操作
（重命名/分叉/归档），工作区在融合 UI 里只剩 header 作用域名 chip，无任何管理面。

宿主能力其实一直在：`IWorkspaces.delete(workspaceId)`（dsh-api-workspace-controller
0.1.2-rc.1）——「删除工作区注册，不删会话与文件」，官方 WorkspaceBrowser 的
删除弹窗就是它的直通封装（`deleteWorkspace → workspaces.delete`）。缺口纯在 UI 入口。

## Decision

- 入口放 HomeHistory header：toggle 右缘新增常驻低透明度 ⋯ 按钮（作用域工作区存在
  才渲染），打开即确认菜单。常驻而非 hover 显形——本就是被遮蔽后仅存的工作区入口，
  hover-only 等于继续藏功能。
- 确认菜单复刻官方删除弹窗语义：官方同款 desc 文案（注册移除、文件夹与会话保留、
  会话归入「未分组」）+ pending 态防重（`正在删除工作区…`，按钮禁用）+ 失败原位
  呈报（role=alert，错误来自 reject）。pending 期间外点/Esc/滚动不关菜单，与官方
  Modal 的 `deleting` 防误关一致；成功即关，宿主快照移除行后作用域自动回退。
- 接线走 `deleteWorkspace` 注入面：index.ts 点击时惰性 `ctx.get('workspaces')`（与
  `uiWorkspace` 同款纪律——apply 时序不保证，过早捕获永久失效），失败 reject 交
  HomeHistory 呈报（不同于 fork/archive 的内吞 console.warn——删除是破坏性倾向动作，
  静默失败不可接受）。
- 头部结构改为 `.header` 容器 + toggle 兄弟按钮（button 不能嵌 button），toggle 保留
  右侧 30px 保留槽，折叠热区不变。
- locale 新增 `browser.ws.*` 五键（zh/en），文案逐字取自官方 dsh-client-ui-workspace
  词典；补 IconTrash；组件测试 `home-history.test.tsx`（jsdom portal 挂载面）覆盖
  入口存在性、确认面、成功关闭、失败呈报+重试、pending 防误关五条。

## Alternatives considered

- 把「删除工作区」塞进会话行菜单：语义错位（菜单是会话粒度），且目标工作区不跟随
  行所属工作区，未采用。
- 恢复官方 WorkspaceBrowser 或另建工作区列表面板：动 3.0 融合布局定稿，为单一入口
  重建整套列表面不成比例，未采用。
- `window.confirm` 原生确认：样式断裂、文案不可控、jsdom 不可测，未采用。
- 两段式菜单（先「删除工作区」项再确认）：多一次点击，官方弹窗本就是打开即确认面，
  直接对齐更顺，未采用。

## Follow-up（2026-09-06 下午：真实点击无响应修复）

用户实测「点了没反应」。复现与归因：首轮验证用的是 CDP 合成 `el.click()`（直接派发，
**绕过 hit-testing**），坐标级真实点击（`Input.dispatchMouseEvent` + `elementFromPoint`）
复现失败——按钮中心点命中的是官方 `composerStack`。根因：该元素虽 `position: static`，
但是 `z-index: 1` 的 flex 子项（flex item 的 z-index 生效并创建层叠上下文），盒子下缘
盖进本面板 header 行（重叠区 y≈505–537，恰为 header）；本 portal 容器是 static +
z-index:auto，整层被压在下面——面板背景透明所以看得见，header 真实点击全被吃掉。
会话行在重叠区外，故历史行一直可点，问题只炸在新增入口上。

修复：portal 容器建时内联 `position: relative; z-index: 2`（同层叠上下文内盖回，
relative 不动布局，composer 卡输入框/发送键 hit-test 复验无损）。经验沉淀：**合成
click 测不出遮挡类回归，UI 交互验证必须走坐标级真实点击**（`elementFromPoint` +
`Input.dispatchMouseEvent`）。

## Consequences

- 删除语义 = 宿主注册级：工作区从名册移除，目录与会话记录保留，会话回落「未分组」
  分组（官方语义，非物理删除）。
- 融合 UI 目前只能操作「作用域工作区」（当前/最近活动），多工作区全量管理仍需官方
  浏览器回归或其他面板承接；本次只补删除缺口，不扩布局。
- `browser.ws.*` 进 i18n 审计名册（862 zh keys 基线 +5）。
