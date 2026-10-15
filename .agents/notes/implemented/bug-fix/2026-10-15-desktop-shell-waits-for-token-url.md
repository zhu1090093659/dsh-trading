# Agent Note: 桌面壳等宿主的 token URL 行，不再兜底加载 401 的裸 URL

Status: implemented

## Problem

Dock 直点（或 `open -a "DSH Trading"`）后窗口渲染的是宿主的鉴权拒绝页，而不是交易终端：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

`~/Library/Logs/dsh-trading-desktop/dsh-host.log` 里同一轮启动的行序指出根因（2026-10-15 本机连续两轮）：

```
[desktop] spawning host on 127.0.0.1:58236
[desktop] pruned 1 stale dsh auth cookie(s)
[desktop] GUI ready, loading the bare URL (no token line seen)
dsh web: http://127.0.0.1:58236/?token=<token>
```

机制：`waitForGui()` 只证明端口在应答——`probeGui()` 收任何 <500 的状态码，宿主鉴权门给的 401 也算通过——而宿主是「先绑 web server，再加载 profile 插件、跑启动审计（`auditStartupEntries`），最后才打印带 token 的 URL 行」。旧实现的 `boot()` 对该行只给 5 秒宽限，超时就加载裸 URL。裸 URL 永远进不去：launch token 是 `@deepseek-ai/dsh-client-connection` 每进程签发的一次性凭据，本轮启动在宿主从未被认证过的端口上没有任何 cookie（`pruneStaleAuthCookies` 又刚清过同端口残留），因此必然 401。

同一份日志里更早的三轮都是 `GUI ready, loading the tokenized URL`：token 行到达时刻随插件加载与磁盘缓存波动（本机修复后实测 3.9 秒，故障轮次晚于 5 秒宽限），故障因此表现为时有时无。

## Decision

- `desktop/src/main.cjs` 的 `boot()` 改调 `waitForTokenUrl()`（`desktop/src/runtime.cjs`，纯函数、依赖以 getter 注入）：端口应答后等宿主的 token URL 行，宿主进程活着就一直等（预算 `READY_TIMEOUT_MS` 180 秒），拿到即加载；宿主退出或超时则抛错，由 `showError()` 给出错误页与宿主日志尾部。**裸 URL 兜底路径删除**——它没有任何能进去的场景。等待期间窗口停在 splash。
- `TOKEN_URL_PATTERN` 放宽为 `/^dsh web: (https?:\/\/\S+)/`：宿主在非回环绑定时把 LAN URL 追加在同一行（`dsh-web-app/lib/index.js` 的 `dsh web: ${authenticatedUrl} (LAN: ${lanUrl})`），锚定行尾的正则会把这种行读成「没有 token 行」，是同一类静默降级到 401 的路径；要求 scheme 同时把宿主另一行 `dsh web: opening the default browser…` 排除在外。

## Verification

- 单测：`desktop/tests/runtime.test.mjs` 新增三例——晚到的 token 行会被等到（读 `readUrl` 多次才给 URL）、带 LAN 后缀的行取回环 URL 且浏览器交接行返回 undefined、宿主退出与超时各自报错而不返回 URL。`cd desktop && npm test` 41/41 通过；`node --check` 两个改动文件通过；`node scripts/test-audit.mjs --check` 无新增测试债。
- 安装位补丁：本机 `/Applications/DSH Trading.app` 的 `app.asar` 只换掉 `src/main.cjs` 与 `src/runtime.cjs`（`asar extract` → 覆盖两文件 → `asar pack`），`asar extract-file` 读回的这两个文件 md5 与工作区源文件一致；`app.asar.unpacked/src/host-symbol-normalizer.mjs` 未动。
- 实机（2026-10-15 20:35，`env -u ELECTRON_RUN_AS_NODE -u DSH_HOME open "/Applications/DSH Trading.app"`）：日志按行带毫秒时间戳，`spawning host` → token 行 3.902 秒，token 行 → `GUI ready, loading the tokenized URL` 0.061 秒；窗口截图（Computer Use `get_window_state`，pid/window 级）读图确认交易终端完整渲染：左栏自选（加密货币/美股/A股/港股）、行情/机器人/策略/知识库/特殊指标页签、K 线 + KDAS 标线、量比分档量能、右栏会话面板、底部指数状态栏。像素点击切到「特殊指标」后复检截图，A 股恐慌指数面板渲染，非鉴权页。
- 证据（本机，不入库）：`.local/acceptance/desktop-token-url-2026-10-15/`。

## Alternatives considered

- **把 5 秒宽限调大**：仍是猜时间，且猜错的表现就是安静的 401 页；token 行到达时刻受 profile 插件数与磁盘缓存影响，没有可依据的上界。改等信号本身才消除这个自由度。
- **从 `dsh-host.log` 抓 token URL**：绕远——宿主把该行写到 stdout，壳已经拿到；从落盘文件回读还要处理写入延迟与多实例的日志混写。
- **让壳自己生成/注入 token**：launch token 由 `@deepseek-ai/dsh-client-connection` 每进程签发、无配置项，宿主本体是只读的 npm 包，壳只能读不能设。
- **附着到已在跑的实例**：token 无法事后获取，Electron 独立 cookie jar 只会永久 401；整窗附着形态已于 2026-10-07 被 owner 否决并物理移除（见 [Electron 桌面版 note](../architecture/2026-09-03-electron-desktop-app.md)）。
- **拿到 token 行前先加载裸 URL、等行到了再导航过去**：多一次必然 401 的导航与一屏鉴权页闪烁，且要额外处理「导航竞态」；直接不加载更简单。

## Consequences

- 正常路径只剩 `GUI ready, loading the tokenized URL`；`loading the bare URL (no token line seen)` 这行从代码里消失，再出现即回归。
- 宿主若真的不再打印 URL 行，窗口会停在 splash 直到 180 秒预算用尽，然后给出错误页 + 宿主日志尾部（旧行为是安静的 401 页）。
- 只改 `app.asar` 内的壳源码时，本机安装位可只换这一个归档（`payload`/profile 不动）；载荷或 profile 变化的更新仍走 [本地重建 note](../process/2026-09-11-desktop-shell-local-rebuild-open-env-pitfall.md) 的 `prepare-runtime` + `dist:mac` 路径。
