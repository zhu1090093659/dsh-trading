# 网络代理支持（默认跟随系统代理）

- 日期：2026-11-25
- 状态：已实现

## 问题

`@deepseek-ai/dsh-http-proxy` 只在进程启动时读取 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 环境变量，不支持：
1. 读取操作系统代理设置（macOS `scutil --proxy`、Windows `HKCU\...\Internet Settings`、Linux GNOME `gsettings` / KDE `kioslaverc`）；Electron 桌面壳从 Dock / 开始菜单启动时无 shell 环境变量，系统代理开启后全部出站请求依然直连失败；
2. `socks5://` / `socks5h://` 代理（原实现会跳过并直连）；
3. `NO_PROXY` 的 CIDR 网段、IPv4 通配符与 `<local>`；
4. 设置页的代理模式切换、即时热更新与连通性测试。

## 方案与不变量

1. **默认 `system` 模式与跨平台探测（`@dshtrading/router` `src/system-proxy.ts`）**：
   - `dsh-trading-market-router` schema 新增 `proxy`（`mode: 'system' | 'custom' | 'direct'`、默认 `'system'`；`url`；`noProxy`）。无需新增 patch 行 ID。
   - 优先级：`direct` > `custom` > `system`（`system` 下用户显式导出的启动环境变量优先于 OS 系统代理，再其次为 Electron `session.resolveProxy` hint）。
   - Electron 桌面壳通过 `DSH_TRADING_INJECTED_SYSTEM_PROXY=1` 标记其注入的系统代理变量，防止用户在设置页刷新系统代理或改端口时粘住旧启动快照。
2. **全进程动态拦截与热切换（`@dshtrading/router` `src/proxy.ts`）**：
   - `NetworkProxyService`（`tradingNetworkProxy`）基于 `undici` 的 `setGlobalDispatcher` 动态构造 `Agent` + `ProxyAgent` + `Pool`，因此构造期缓存 `globalThis.fetch` 的连接器与 DSH 宿主均实时生效，并在 `loader/volatile-update` 变更 `proxy` 时零重启热切换。
   - 在 `Agent.factory` 内创建 `ProxyAgent` 时显式剥离 `passedOptions.factory`，防止递归栈溢出。
   - `socks5h://` 在交给 `undici` 前改写为 `socks5://`（undici `Socks5Client` 默认走 `ATYP=DOMAIN` 远端解析）。
   - **子进程安全**：同步环境变量时若任一活跃槽位为 SOCKS5，只写 `ALL_PROXY`/`all_proxy` 并清除 `HTTP_PROXY`/`HTTPS_PROXY` 且不设 `NODE_USE_ENV_PROXY=1`，避免 Node 子进程启动因遇到 SOCKS 协议报错退出。
   - **回环强制免代理**：`127.0.0.0/8`、`localhost`、`*.localhost`、`::1`、`::`、`0.0.0.0`、`::ffff:127.0.0.0/8` 始终直连，并支持 IPv4 CIDR、IPv4 `.*` 通配符、`<local>` 与 `:port`；外部工具 CLI `packages/bot-api/bin/dsh-trading-tool.mjs` 在存在代理环境变量时自动补齐 loopback 到 `NO_PROXY`。
3. **Electron 桌面引导（`desktop/src/proxy.cjs` + `desktop/src/main.cjs`）**：
   - 启动 `dsh` 子进程前读取 `cordis.patch.yml` 已存 `proxy` 配置、结合 OS 探测与 `session.resolveProxy` 结果构建 `childEnv` 覆写，使宿主进程启动第 0 毫秒即可通过系统代理连通模型与市场数据接口；所有日志均先经 `redactProxyUrl` 脱敏凭据。
4. **设置页桥接与 UI（`@dshtrading/client-ui-settings`）**：
   - host 半挂载 `/dshtrading/api/proxy/status`（支持 `?refresh=1`）与 `/dshtrading/api/proxy/test`（只接受 `okx | binance | yahoo | github` 枚举目标，防 SSRF），受 `connection.requestRejection` 认证栅栏保护。
   - 浏览器半在「通用」分组下展示「网络代理」全宽卡片，提供 `系统代理` / `自定义代理` / `直连` 切换、实时 URL 校验、绕过列表与带草稿预览的连通性测试。

## 验收方式

- 单测：`packages/router/test/system-proxy.test.ts`、`packages/router/test/proxy-runtime.test.ts`（真实本地 HTTP 与 SOCKS5 代理）、`packages/client-ui-settings/test/proxy-settings.test.ts`、`desktop/tests/proxy.test.mjs`、`packages/bot-api/test/tool-gateway-proxy.test.ts`。
- 界面组件验收：`node scripts/ui-component-check.mjs --harness packages/client-ui-settings/harness/proxy-settings.harness.tsx`。
- 全仓门禁：`pnpm gates:all`。
