# Agent Note: 插件主题跟随与切换主题右侧聊天区空白修复

Status: implemented

## Problem

用户报告（2026-09-02）：
1. 插件主题不能跟随聊天区（DSH 宿主）的主题变化而变化；
2. 切换主题时右侧聊天区直接消失；
3. 点击右缘竖条的“折叠/展开会话列”会导致插件崩溃、页面白屏回退到官方默认三栏（图2）。

### 根因归因

1. **主题 Token 矩阵缺失暗色定义**：`tokens.css` 仅在 `:root` 中定义了硬编码浅色 `--dsw-futu-*` 变量，未定义宿主暗色模式标记 `body[data-ds-dark-theme]` 与 `[data-theme='dark']` 对应的暗色色盘。
2. **TvChart 硬编码浅色且未监听主题切换**：`TvChart.tsx` 初始化时写死了浅色背景 `#ffffff` 与网格线 `#f5f6f8`，且未监听宿主主题变化，切换时没有调用 `chart.applyOptions`。
3. **HomeHistory 的 Observer 反馈死循环导致 Crash**：`HomeHistory.tsx` 原先使用 `ResizeObserver` / `MutationObserver` 观察包含自身 Portal 容器的父节点 `scrollBody`，并在尺寸变化时直接写入内联样式。在折叠/展开或主题切换时引发无限反馈重排循环（Infinite Mutation/Resize Feedback Loop），导致 React ErrorBoundary 触发或 Slot Overlay 崩溃卸载，页面因此回退到 DSH 原生布局。
4. **对话列显隐过度依赖脆弱的 `sessions.current`**：`QuotePane.tsx` 与 `shell-pad.css` 原先将对话列与 `sessions.current !== undefined` 强绑定。无会话、首页或切换主题瞬态时 `sessions.current` 为空，触发 `body:not([data-dshtrading-chat='on']) ... display: none`，导致右侧聊天区直接被隐藏。

## Decision

1. **Token 矩阵补齐深色规范 (`tokens.css`)**：
   - 增加 `body[data-ds-dark-theme], [data-theme='dark'], :root[data-theme='dark']` 深色设计变量（富途/TradingView 专业暗色黑蓝基调：`#131722` / `#1e222d` / `#2a2e39` / `#d1d4dc` / `#787b86`）。
2. **TvChart 主题响应与平滑切换 (`TvChart.tsx`)**：
   - 引入 `isDarkTheme()` 与 `getChartThemeOptions()`。
   - 增加 MutationObserver 监听 `document.body` 上的 `data-ds-dark-theme` 属性变化及系统主题 MediaQuery。
   - 触发时动态调用 `chart.applyOptions()` 平滑切换图表背景与网格，无需重置或重新拉取 K 线。
3. **彻底切断 HomeHistory 的反馈环并加入 Diff Guard (`HomeHistory.tsx`)**：
   - 移除对 `scrollBody` 的 `ResizeObserver`，`MutationObserver` 仅收敛观察 `[data-composer-seat]`；
   - `fuse()` 仅在计算值发生实际变动时才写入 `style.width` / `style.marginLeft` / `style.marginTop`；若尺寸为 0 则直接退出，杜绝崩溃。
4. **对话列默认常驻展开，统一由 `chatFolded` 控制 (`shell-pad.css` & `QuotePane.tsx`)**：
   - 将 `--dshtrading-chat-w` 默认值设为 380px，移除对 `sessions.current` 的强制 `display: none`；
   - 仅在用户主动点击折叠按钮（`body[data-dshtrading-chat-folded='on']`）时收起到 0px，保证首页、切换会话、切换主题期间右侧聊天区恒常稳定可见。
5. **周边模块清理硬编码浅色背景**：
   - 清理 `market-sidebar.module.css`、`quote-pane.module.css`、`quote-stage.module.css`、`market-provider-panel.module.css` 中残留的硬编码 `#ffffff`。

## Verification

- `pnpm test`：90 个测试套件，637 个用例全绿通过。
- `pnpm build`：全 monorepo 44 个 workspace 包零报错编译成功。
