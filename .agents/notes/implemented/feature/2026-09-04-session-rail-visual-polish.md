# Agent Note: 会话竖条（SessionRail）视觉打磨

Status: implemented

## Problem

右缘 44px 会话竖条（折叠/新建/设置）是全终端视觉最「裸」的一条：底色直接用 bg-base 纯白，与左侧自选列表的 bg-surface 表面层级脱节；三个图标视觉重量不统一（设置齿轮为 24 网格 + 1.7 描边，渲染描边仅约 1.13px，比另外两个 16 网格 + 1.3 描边的图标更粗更实）；折叠生效只有灰底，缺少「对话列已收起」的激活语义；悬停反馈弱（4% 黑透明度），间距节奏随意（顶 padding 10px、gap 6px、分隔线 20px 与 32px 按钮不对齐）。

## Decision

纯视觉打磨，零行为变化（44px 宽度、固定右缘、四元素结构、aria 语义全部保留），全部走既有 design tokens，深浅色模式自动跟随：

- **图标统一**：`IconSettings` 齿轮路径按 2/3 比例从 24 网格精确缩放重绘到 16 网格、strokeWidth 1.3，与 `IconNewSession`/`IconFoldPanel` 视觉重量一致。
- **表面层级**：竖条底色 bg-base → `--dsw-futu-bg-surface`（浅色 #f7f8fa / 深色 #1e222d），与左侧栏同层级。
- **激活态语义**：`aria-pressed='true'`（折叠生效）与 `data-active='true'`（预留功能页签）统一走 accent 蓝：图标着色 + `--dsw-futu-accent-subtle` 底 + 左缘 2px 指示条（::before，left -6px 贴竖条左缘）。
- **悬停分层**：hover 底色改用更深的 `--dsw-futu-bg-surface-active`，图标 scale(1.06) 微放大，svg transform 补 0.15s ease 过渡（折叠镜像翻转因此也有动画）；折叠激活 + 悬停的组合态显式声明 `scaleX(-1) scale(1.06)` 避免 transform 互相覆盖。
- **节奏对齐**：顶 padding 12px、gap 4px、分隔线加宽至 24px 与按钮中线对齐。

## Alternatives considered

- **新增 hover 专用 token（如 bg-surface-hover-strong）**：tokens.css 是全局契约，为单一组件加 token 收益低；复用 surface-active 已拉开层次。败。
- **激活指示条做成 3px 宽或右侧圆点**：2px 左缘条与富途/TradingView 桌面端选中态惯例一致，更克制。败。
- **顺手做自定义 tooltip 取代原生 title**：超出本次「视觉打磨」范围，属行为/交互层改动，留给后续功能页签落地时一并设计。败。

## Consequences

- 桌面端（DSH Trading.app）下次重载页面即生效（profile 的 file: 副本已用 rsync 同步 lib/，未经 `dsh plugin install`，运行中实例不受影响）。
- 后续在分隔线下方追加功能页签按钮时，激活态直接挂 `data-active='true'` 即获得同款 accent 指示样式。
- 验证证据：托管 HTTP + 无头 Chrome 截图（wide/narrow 前后对比条 + 折叠激活态 + 悬停态），`pnpm build`/`pnpm test` 全绿（113 文件 882 用例）。
