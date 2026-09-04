# Agent Note: 历史会话面板行操作菜单（重命名/分叉/归档）

Archived: 2026-09-04
Status: implemented

## Problem

HomeHistory（hero 融合容器的历史半区）遮蔽官方 WorkspaceBrowser 后，会话行只剩「点击打开」一个动作；官方侧栏的重命名、分叉会话、归档会话三个管理动作在交易布局下全部不可达，用户无法整理历史会话。

## Decision

在历史行上补齐官方同款三动作，交互按 owner 裁决：悬停 ⋯ 按钮 + 右键双触发，重命名走行内编辑（Enter 提交 / Esc 取消 / blur 提交，IME 合成态不截获 Enter）。

- 触发与关闭：行容器 onContextMenu 与行尾 ⋯ 按钮（悬停/focus-within 才显形）都开同一个 fixed 定位菜单（面板 overflow:hidden，菜单必须脱离文档流，开合时按估算外框钳位防出屏）；外点 pointerdown 捕获、Esc、任意滚动关闭。
- 动作接线（inject 面扩三个方法，全部官方通路）：rename = `sessions.binding(id)?.session.rename(title)`（显式标题，钉住自动生成，失败 reject 由组件呈报 console.warn）；fork = `sessions.fork({ sessionId, increaseTitle: true })` 后 open 新会话；archive = `ctx.get('uiWorkspace').archiveSession(id)`（与 startSession 同款惰性解析纪律——apply 时序不保证，点击时才取服务）。
- 归档可见性：归档写入的是宿主 workspace 快照的 archivedSessionIds 集合，历史列表过滤时必须归并该集合，否则归档行在面板里留尸（首轮实测即命中此漏）。
- SessionId 是 branded 类型而 dsh-session 非本包依赖：从已引入的 ISessions 面派生 `Parameters<ISessions['open']>[0]`，inject 面字符串 id 在边界断言一次，不新增模块解析。
- 文案键 `browser.menu.{aria,rename,fork,archive}` 中英双字典入 contract.ts 封闭键集；四个图标（⋯/铅笔/分支/归档盒）入 icons.tsx 内联矢量族。

## Alternatives considered

- 模态对话框重命名（官方侧栏方案）：首页融合布局里弹窗视觉过重，owner 裁决行内编辑更轻。
- `ctx.workspaces`（WorkspaceController）做归档：与 uiWorkspace.archiveSession 同语义但多一个 inject 依赖；uiWorkspace 已在注入面里，复用零成本。
- 直接 import dsh-session 的 SessionId 品牌类型：dsh-session 不在本包依赖树，tsc 解析不到（TS2307），放弃。

## Consequences

- 面板行为与官方侧栏对齐：归档当前会话由 uiWorkspace 负责清空选择进新会话态，面板无需特判。
- 重命名失败仅 console.warn（无行内错误条），与仓库既有「失败内吞 + 可观测」模式一致；若用户反馈需要再行内呈报。
- 菜单外框尺寸是估算常量（152×118）用于出屏钳位，条目数变动时需同步调整。

## Verification

- `pnpm -r build` 全绿；typecheck 棘轮门禁 547 ≤ 基线 549（本包 63 = 基线，零新增）；`pnpm test` 750 通过。
- trading-web profile 实测（headless Chromium + CDP，3081）：右键与 ⋯ 双通路菜单弹出截图验收；重命名提交→改名生效→还原；分叉→生成「标题 (1)」并打开；归档→行从列表消失（同时验证了归档过滤修复）。验收分叉会话已归档清理，被改名的会话已还原原标题。
