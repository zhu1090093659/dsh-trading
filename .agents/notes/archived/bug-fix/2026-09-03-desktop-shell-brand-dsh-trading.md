# Agent Note: 桌面壳品牌统一为 DSH Trading（窗口标题固定 + 启动/错误页改名）

Archived: 2026-09-04
Status: implemented

## Problem

用户报告（2026-09-03）：打包版窗口左上角显示 "DeepSeek Harness" 而非
"DSH Trading"。来源有两处：

1. 壳自身：BrowserWindow `title: 'DeepSeek Harness'`、splash.html（title
   + 大标题 h1）、error.html（title + `document.title`）都写着 DeepSeek
   Harness——启动期（splash 阶段）用户直接可见；
2. GUI 加载后，内置 web 前端（`@deepseek-ai/dsh-web-frontend` 的
   index.html `<title>` 与 `dsh-client-ui-layout` DocumentTitle 的
   productTitle）会把 Electron 窗口标题覆盖回宿主品牌。页面内 UI 无
   "DeepSeek Harness" 字样（headless Chrome 截图实证，侧栏顶部为功能名），
   所以品牌泄漏只发生在窗口标题条这一层。

## Decision

改动全部收敛在桌面壳（不改宿主 npm 包、不动 profile）：

- `createWindow`：`title: 'DSH Trading'`，并监听
  `page-title-updated` 调 `preventDefault()` 固定标题条——GUI 页面
  的 document.title 不再改写窗口标题；
- splash.html / error.html 的 title 与展示文本改为 DSH Trading。

宿主前端的 document.title 仍保留宿主品牌（只影响网页内部语义，不影响
壳标题条）；若未来要求页面级品牌，走 sidebar.brand 槽位组合自定义
brand 包，不改壳。

## Consequences

- 窗口标题条全程显示 DSH Trading，包括 GUI 加载完成后；
- 页面内部（会话标题等）不受影响；
- 验证链：`node --check` + desktop 单测 7/7 全绿；重新 `dist:mac` 后从
  app.asar 提取 main.cjs/splash.html 确认新文案在包内；产物
  `dist/dsh-trading-desktop-0.1.0-mac-arm64.dmg`（276 MB，17:24）由
  rebrand 提交之后构建。

