# Agent Note: 桌面壳启动页/报错页的脚本被自家 CSP 拦掉——状态与按钮全不工作

Status: implemented

## Problem

`desktop/src/splash.html` 与 `desktop/src/error.html` 各自带 CSP meta `default-src 'self'; style-src 'unsafe-inline'`，而两个页面把行为写在 **inline `<script>`** 里（splash 另有 inline `onerror` 处理器）。CSP 不含 `unsafe-inline` 也不含该脚本的 hash，于是这些 inline 代码一律不执行：

- **启动页状态永远停在 `Starting…`**：`window.desktop.onStatus(...)` 从未注册，主进程发来的 `desktop:status`（"Installing the bundled web profile…" / "Starting the dsh host…"）无人接收。证据：健康启动唯一的一条 `[renderer]` 行就是这个违规——`[renderer] error file:///…/app.asar/src/splash.html:31 Executing inline script violates the following Content Security Policy directive 'default-src 'self''…`。
- **启动失败页是一张死页面**：`onError` 没注册 ⇒ 报错文案与宿主日志尾部（`#message`/`#log`）始终为空；Retry / Reveal log file / 下载 VC++ 运行库 / Quit **四个按钮全部点了没反应**。宿主起不来时唯一的兜底面等于不存在。

两页同源同 CSP，故障同因：把「页面行为」当成 inline 脚本写在带 CSP 的页面里。

## Decision

1. 页面行为移出页面：新增 `desktop/src/splash.js` 与 `desktop/src/error.js`，由 `<script src="./splash.js">` / `<script src="./error.js">` 加载（`default-src 'self'` 允许同目录子资源——同页的 `./assets/icon.png` 一直加载正常，日志里没有它的违规行）。splash 的 inline `onerror` 一并改成 `addEventListener('error', …)`。
2. 加静态契约测试 `desktop/tests/startup-pages.test.mjs`：两页出现任何 inline `<script>`（无 `src`）或 inline `on*` 处理器即失败；被引用的脚本文件必须存在、非空、且调用 preload 桥（`window.desktop`）。这样「再加一个 inline 处理器」会在单测层被挡住，而不是靠人肉发现页面变哑。

## Verification

- 单测：`cd desktop && npm test` 44/44（含上述两条契约用例）。
- 启动页（实机，安装位）：`DSH_HOME=<隔离 home> open "/Applications/DSH Trading.app"` 启动途中窗口级截图读图，状态行显示主进程真实文案 `Starting the dsh host…`（不再是 `Starting…`）；同一轮 `dsh-host.log` 里**没有** splash 的 CSP 违规行（补丁前每轮都有一条）。
- 报错页（实机，隔离探针）：用真实 `src/error.html` + 真实 `preload.cjs` 起一个一次性 Electron 窗口并送一条 `desktop:error` 载荷，读图确认标题、"探针：bundled dsh host is missing" 文案、日志尾部两行、三个按钮（VC++ 按钮按 `isMissingVCRedist:false` 正确隐藏）都已渲染；再点 Retry，主进程收到 `desktop:retry`（补丁前该按钮是死的）。探针目录已删除。
- 证据（本机，不入库）：`.local/acceptance/desktop-token-url-2026-10-15/{splash-status-after-fix,error-page-after-fix}.png`。

## Alternatives considered

- **放宽 CSP（加 `script-src 'unsafe-inline'`）**：为两个只显示文字与按钮的静态页打开 inline 执行，等于把这两页的 CSP 保护拆掉换便利；外置一个文件成本更低。
- **只给 inline 脚本算 hash**：hash 随脚本改动失效，改一行文案就静默退化回「页面变哑」，正是这次要避免的故障形态。
- **不测、只靠 review**：这种故障的表现是「页面在、但什么都没有」，截图之外没有任何红灯；静态契约测试是唯一便宜的确定性门禁。
- **把报错页换成原生 Electron 对话框**：可绕开 CSP，但丢掉日志尾部展示与「Reveal log file」入口，且改动面更大。

## Consequences

- 启动页会显示主进程逐步状态，宿主慢启动时用户能看到"在做什么"；宿主起不来时错误页有文案、有日志、四个按钮可用。
- `desktop/src/*.js` 与两个 HTML 一起打进 `app.asar`（`files: src/**`）；只改这些文件时安装位仍可只换 `app.asar`（见 [本地重建 note](../process/2026-09-11-desktop-shell-local-rebuild-open-env-pitfall.md)）。
- 与 [桌面壳等 token URL 行](2026-10-15-desktop-shell-waits-for-token-url.md) 同批交付：那条修的是"窗口不该落到 401 页"，这条修的是"真出错时要看得见错在哪"。
