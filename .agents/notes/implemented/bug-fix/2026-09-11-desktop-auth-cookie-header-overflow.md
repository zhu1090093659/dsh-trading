# Agent Note: 桌面壳「Failed to load plugins」根因：dsh 会话 cookie 累积撑爆宿主请求头预算

Status: implemented

## Problem

桌面壳（Dock 直点或 `open -a`）启动后窗口停在错误页：

```
Failed to load plugins
failed to import loader entry <id> (@deepseek-ai/dsh-client-hmr):
client-modules: bundle script /plugins/??<全部客户端插件>&rev=<rev> failed to load
```

宿主侧看不出问题：`dsh-host.log` 无报错、boot 页 200、同一 bundle URL 用 curl 与无头 Chrome（干净 profile）都是 200 且 GUI 正常渲染。故障只发生在桌面壳自带的 Electron 会话里。

CDP 抓 Network 后定位到真实响应：应用批 bundle 请求返回 **HTTP 431**，该请求的 `Cookie` 头 14,362 字节 / 63 条，URL 本身 2,817 字节；同一页面的 bootstrap 批（91 字节 URL）与另一批（340 字节 URL）都是 200。宿主是 Node HTTP 服务，默认 `maxHeaderSize` 16 KiB，请求行 + Cookie + 常规请求头越界即被解析器以 431 拒掉，`<script>` 触发 error 事件，客户端于是报 bundle failed to load。

cookie 的来源：`@deepseek-ai/dsh-client-connection` 的浏览器会话 cookie 名 = `dsh-auth-` + base64url(sha256(请求 authority))，而 authority 含端口（`127.0.0.1:<port>`）；桌面壳每次启动取随机空闲端口，于是每轮启动新增一条 cookie，且没有任何回收路径。cookie jar 持久化在 Electron user-data-dir，累积到 63 条即触顶（jar 里留着 10-03 至 10-11 每轮启动的记录）。

## Decision

1. **启动前清掉上一轮遗留的 dsh 会话 cookie。** `desktop/src/main.cjs` 的 `boot()` 在 `loadURL` 之前调用 `pruneStaleAuthCookies()`，按前缀 `dsh-auth-` 删除 127.0.0.1 上的全部此类 cookie；best-effort，失败只记日志不阻断启动。紧接着加载的 tokenized URL 会 303 下发当轮 cookie，jar 稳定在 1 条。
2. **给派生的宿主进程加 `--max-http-header-size=65536`。** 宿主把全部客户端插件拼成一条 combo URL（本机实测 2.8 KiB），16 KiB 默认预算余量太薄；清 cookie 治本，抬预算兜底同类越界。

## Verification

- 故障复现（旧 app）：CDP 读到应用批 431，`Cookie` 14,362 B + URL 2,817 B > 16,384 B。
- 假设验证：同一实例用 CDP 删掉 63 条 cookie 后重新导航，应用批转 200，GUI 正常渲染。
- 修复验证（新 app）：CDP 注入 81 条 dsh-auth cookie（`Cookie` 头 17,176 B）后应用批仍 200（header 预算生效）；重启 app 日志出现 `pruned 81 stale dsh auth cookie(s)`，GUI 正常。
- 正常路径验证：`env -u DSH_HOME open -a "DSH Trading"` 后日志 `pruned 1 stale dsh auth cookie(s)`，渲染器与宿主保持 7 条 ESTABLISHED 连接，无头 Chrome 截图渲染正常。
- `desktop` 单测（`npm test`，19 项）全绿；`node --check src/main.cjs` 通过。

## Alternatives considered

- **只重启 app / 重载窗口**：无效。jar 持久化在 user-data-dir，重启后 cookie 仍在，实测重启后照样 431（这也是本条推翻早先 cohort 漂移归因的实测依据）。
- **只加 header 预算不清 cookie**：治标。jar 无界增长（每轮约 230 B），64 KiB 也只够再撑两百多轮。
- **只清 cookie 不加 header 预算**：能解决当下故障；combo URL 随客户端插件数线性增长（本机约 45 B/插件），留一档余量成本仅一行。
- **清 127.0.0.1 上的全部 cookie**：会波及同 host 的其他本地开发服务，改为按 `dsh-auth-` 前缀限定。
- **改宿主 cookie 命名或加回收**（上游 `@deepseek-ai/dsh-client-connection`）：宿主是 npm 全局安装的只读本体，仓内不改。

## Consequences

- 桌面壳每轮启动日志出现 `[desktop] pruned N stale dsh auth cookie(s)`（N=0 时不打印），这是 cookie 卫生生效的排障判据。
- **浏览器路径仍有同类风险**：CLI/浏览器打开 trading-web 时，127.0.0.1 的 cookie 同样按端口累积，浏览器 jar 不归本仓管，累积到阈值会在浏览器里出现同样的 "Failed to load plugins"。缓解手段是清浏览器里 127.0.0.1 的 `dsh-auth-*` cookie；上游根因（cookie 名含端口、无回收 + combo URL 逼近 Node 头预算）建议报给 DSH。
- 已重建并替换 `/Applications/DSH Trading.app`（仅 main.cjs 改动，runtime 载荷 `VERSION.json` 的 `builtAt` 仍为 2026-09-11T03:07:30Z）；旧 app 备份在 `/tmp/DSH-Trading-backup-20260911.app`。
- 早先 2026-09-11 记录把同一现象归因于 profile cohort 链接漂移，属误判，已在原记录中更正指向本条。
