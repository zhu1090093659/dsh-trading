# Agent Note: 桌面壳从 Electron 迁到 mygo（Go + 系统 WebView）

Status: implemented

## Problem

现役桌面壳（`desktop/`）基于 Electron 构建，自带完整 Chromium 与 Electron 运行时来承载本地 Web GUI 窗口，同时在外部拉起打包的 `runtime.node/bin/node` 运行独立 Node 宿主进程。桌面壳本身只承担拉起宿主、开窗、维护单实例锁、修剪历史认证 cookie 与暴露 `window.desktop` 桥接契约，不承载插件容器。将壳层迁至 `mygo`（Go + 系统 WebView）可消解壳层对 Electron/Chromium 的绑定，同时保持宿主进程与插件体系不变。

## Decision

- **新增 `desktop/mygo/` 与现役 Electron 壳并存**：壳层采用 `mygo`（Go + 系统 WebView）实现，由 `desktop/mygo/main.go`、`desktop/mygo/mygo.json` 与 `desktop/mygo/internal/{launch,policy,recovery,renderer,hostwait,shell}`（连同单实例、附着移交与 cookie 修剪包）组成，与现役 Electron 壳并存；Electron 壳的退役条件是对齐验收通过后单独一张卡。
- **插件体系与宿主进程保持原样**：插件容器运行在独立 Node 宿主进程里（`@deepseek-ai/cordis` + `cordis-plugin-loader` + profile 的 `cordis.patch.yml`），壳只负责 spawn、开窗、守 cookie。`dsh` 安装包 `lib/` 内 grep `electron` 零命中，壳只 spawn 打包的 `runtime.node/bin/node`，因此壳层替换不影响插件体系。
- **窗口契约与生命周期对齐现役桌面壳**：
  - `window.desktop` 暴露七个方法（`onStatus`、`onError`、`retry`、`revealLog`、`openVCRedistDownload`、`relaunch`、`quit`），通过 `mygo` 绑定服务与预加载脚本桥接。
  - 启动前修剪同一 loopback origin 上残留的 `dsh-auth-*` 会话 cookie（等价于 Electron 壳修 [2026-09-11 的 431 事故](../bug-fix/2026-09-11-desktop-auth-cookie-header-overflow.md)）。
  - 宿主子进程以独立进程组运行并按进程组回收；异常退出恢复预算为 `Max=3` / `Window=10min`，第 4 次意外退出耗尽预算并停在启动问题页，页面 `Retry` 重置预算。
  - 页面策略限制在 `internal/policy` 与 `internal/shell`：导航只放行 loopback 与 `file:`，其余取消或交系统浏览器；`window.open` 恒 deny；窗口标题不被页面 `<title>` 覆盖；页面权限请求一律拒绝（`mygo` 对被信任 origin 默认放行，必须显式拒绝）；渲染进程 warn/error 经预加载桥接写入宿主日志，行形为 `[renderer] <level> <source>:<line> <message>`。
- **CI 门禁同步落地**：`.github/workflows/ci.yml` 新增 `mygo-shell` job（无 `needs`，job 级 `GOTOOLCHAIN=local`）；`desktop/mygo` 模块与 `ci.yml` 必须同一 commit 落地（`go:embed` 依赖 hooks 与 `selfcheck.js`）。

## 实测验证

在 macOS 27.0.1 arm64 上基于真实 `DSH Trading.app` 的 bundled runtime 与隔离 `DSH_HOME` 实测结果如下：

- **渲染与插件挂载**：渲染引擎为 `AppleWebKit/605.1.15`（`WKWebView`，非 Chromium），页面 title 为 `"DeepSeek Harness"`，client UI 插件样式 54 个挂载，page errors 为 0。
- **桥接契约**：`window.desktop` 七个方法（`onStatus` / `onError` / `retry` / `revealLog` / `openVCRedistDownload` / `relaunch` / `quit`）各自被调用一次且可观察。
- **Cookie 修剪**：连续两次启动 `authCookiesBefore/Pruned/After = 1/1/1`（等价于 Electron 壳修 2026-09-11 的 431 事故）。
- **进程组回收**：`killMs` 为 69~156ms、`hostExit=reaped`、`processGroupGone=true`、无孤儿。
- **恢复预算**：`Max=3` / `Window=10min`；第 4 次意外退出耗尽并停在启动问题页，页面 `Retry` 重置预算。
- **页面策略与渲染日志**：导航只放行 loopback 与 `file:`，其余取消或交系统浏览器；`window.open` 恒 deny；标题不被页面 `<title>` 覆盖；权限一律拒绝；渲染进程 warn/error 落日志，行形 `[renderer] <level> <source>:<line> <message>`。
- **Agent 通道**：`mygo` 的 `automation` 插件（Unix socket + NDJSON）可列窗口、页面内 eval、窗口截 PNG、等 settle；对网页窗口 `tree` 返回 `unsupported`（文档亦如此）。

## 当前状态

以下部分当前尚未落地：payload/profile 分发、打包与签名、agent 通道接线、`desktop-release.yml` 双轨、Windows 分支。

## Alternatives considered

- **直接移除 Electron 壳单轨切换**：payload/profile 分发、打包与签名、agent 通道接线、`desktop-release.yml` 双轨及 Windows 分支尚未落地，直接移除现有 Electron 壳会破坏当前桌面端交付链路，因此采用 `desktop/mygo/` 与 Electron 并存，Electron 退役条件是对齐验收通过后单独一张卡。
- **沿用 `mygo` 对被信任 origin 的默认权限放行**：`mygo` 对被信任 origin 默认放行权限请求，而桌面壳必须将 GUI 所在 loopback origin 设为被信任 origin 以挂载桥接；若不显式拦截，页面会获得超出 Electron 沙箱窗口的权限，因此显式拒绝全部权限请求。
- **将 `desktop/mygo` 模块与 `ci.yml` 拆开提交**：代码中的 `go:embed` 依赖 `internal/shell/hooks/*.mjs` 与 `cmd/drill/selfcheck.js`，且 Go 模块不在 pnpm workspace 门禁内，拆分提交会产生无 CI 门禁或缺内嵌文件的提交，因此模块与 `ci.yml` 必须同一 commit 落地。

## Consequences

- **渲染引擎与调试通道变化**：渲染引擎变成系统 WebView（macOS `WKWebView` / Windows `WebView2` / Linux `WebKitGTK 4.1`），macOS 侧没有 CDP。
- **签名与钥匙串约束**：真实证书签名在 ssh 会话会报 `errSecInternalComponent`（登录钥匙串未解锁），需 GUI 会话或先解锁钥匙串；发布产物仍需 Developer ID + 公证。
- **本地 Go 工具链要求**：本地开发必须设置 `GOTOOLCHAIN=auto`（`desktop/mygo/go.mod` 要求 `1.27.3`，本机 go 为 `1.27.1`）。
- **并存期双份钩子维护**：并存期 `internal/shell/hooks/*.mjs` 与 `desktop/src/*.mjs` 是双份，`desktop/src` 仍是事实来源。
- **CI 独立门禁与同提交约束**：`ci.yml` 新增 `mygo-shell` job（无 `needs`，job 级 `GOTOOLCHAIN=local`），模块与 `ci.yml` 必须同一 commit 落地（`go:embed` 依赖 hooks 与 `selfcheck.js`）。
