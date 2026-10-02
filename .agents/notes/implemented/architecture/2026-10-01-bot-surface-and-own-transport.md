# bot surface：自己的 startup provider 与自己的传输服务名

日期：2026-10-01 · 阶段：P2 步骤 1 · 卡片：21b6b892

## 事实

`@dshtrading/bot` 提供 bot profile 的常驻面，两个子入口 + 两行 patch：

| 行 id | 入口 | 职责 |
|---|---|---|
| `@dshtrading/bot/startup` 行 `dsh-trading-bot-startup` | `@dshtrading/bot/startup` | `inject: [cmdlineArgs]` + `parseCmdline`（官方 `@deepseek-ai/dsh-web-app/startup` 同款范式），解析 `--host/--port/--trusted-host` 并 `ctx.provide(botStartup)`；`--host 0.0.0.0` 显式拒绝 |
| `@dshtrading/bot/http` 行 `dsh-trading-bot-http` | `@dshtrading/bot/http` | `node:http` 传输行：路由表（exact/prefix，`register` 返回注销器）、Host 白名单栅栏、`/healthz`；`inject: [botStartup]` |

传输行提供的服务叫 `@dshtrading/bot` 自己的名字：**`botHttp`**（传输）与 **`botFence`**（栅栏）——不是官方的 `webServer` / `connection`。

## why

1. **不踩官方 web 栈**：官方 `webserver` / `connection` / `modules` 三行进全局必需集，任一失败会 dispose 整个 app；bot 面要在没有任何浏览器客户端时照常跑，所以自带传输行，行 id 走 `dsh-trading-*` 命名空间。
2. **服务名不能冒充（实测教训）**：最初 bot 面 provide 的是官方服务名 `webServer` + `connection`，启动立刻 fatal——`TypeError: webCtx.webServer.registerUpgrade is not a function`（官方 `@deepseek-ai/dsh-api-gateway` 行 inject `webServer` 并要求 `registerUpgrade`）。结论：`webServer` 不是一个"名字"，**它就是官方宿主传输契约**；只实现一半却同名提供，等于宣称能满足完整契约，被官方行按完整契约要求是必然的。
3. **bot profile 不叠官方 `@deepseek-ai/dsh-headless`**：`headless-startup` 把 CLI 位置参数当一次性任务，缺任务时 `program.error` 直接退出——常驻面没有任务也必须起来。用整行覆盖（按 id 替换）修被现有门禁挡下：`patch-id-gate` R3「bundle patch 约定 insert-only」，理由成立（替换会抹掉其他层已插入的整行，多 bundle 并存即互相踩踏）。既然"一次性任务"与"常驻面"是两种互斥的 app 形态，正确切法是**换掉而不是叠上**：bot profile 的 bundles 只留 `@deepseek-ai/dsh-base` 与本仓四个 bundle。

## 双宿主挂载（`@dshtrading/bot-api`）

`apply` 里两个 inject 作用域二选一，先到先挂（`bridgeMounted` 闸门保证只挂一次）：GUI 宿主给 `webServer`+`connection`，bot 宿主给 `botHttp`+`botFence`；两边都走同一个 `mountOn`。

## 验证（2026-10-01 实测）

    $ dsh --profile trading-bot
    dsh-trading bot surface: http://127.0.0.1:8899
    dsh: warning: 2 entries did not activate
    dsh-trading-role-presets (@dshtrading/base/presets): pending (waiting for service: agentPresets)
    web-search-exa (@deepseek-ai/dsh-web-search-exa): failed to import

    $ curl -s http://127.0.0.1:8899/healthz
    {"ok":true,"service":"dsh-trading-bot","pid":9403,"uptimeMs":19479,"routes":1}

    $ curl -s http://127.0.0.1:8899/dshtrading/api/tasks/meta
    {"sessionDefaultPermission":"workspace-write","workspaces":[],"agentPresets":[]}

`routes:1` 就是 bot-api 的桥挂上来了；未知路径由桥自己回协议错误（`{"ok":false,"code":"TRADING_PROTOCOL","message":"no such endpoint: /watchlist"}`），说明请求确实穿过栅栏进到桥的路由处理。`packages/bot` 的 9 例行为测试（真起服务器、真发请求，不 mock 不 sleep）覆盖健康面、路由注册/注销、prefix 边界、栅栏与处理器抛错；其中一条测出并修掉实现真 bug：`Promise.resolve(route.handler(req,res))` 会先求值再包装，同步抛错逃出 request 回调导致连接挂死，改为 `Promise.resolve().then(() => handler(...))`。


## 后续修正：bot-closure:check 变成可运行的门禁（2026-10-01）

`pnpm bot-closure:check` 此前**按名称跑必定失败**（脚本强制 `--bot-profile` 参数，npm script 没传）。一个跑不起来的门禁形同虚设 —— 已修为：

- 没给参数时默认到 trading home 的标准 profile（`~/.dsh-trading/profiles/trading-bot`）；
- **继承的宿主 home 一律拒绝猜测**：`DSH_HOME` 存在且不像交易 home 时报错退出并让人显式传参（实测输出：`DSH_HOME=/Users/zcl/.dsh 看起来是宿主实例的 home，不是交易 home；拒绝猜测。`）。这条守卫当场抓到了 agent 会话自身的环境。

修后按名称运行的真实输出：bot 顶层包 54 / 24 个 @dshtrading / **0 个 GUI 平面包 / 0 个 UI 重依赖** / 13.5 MB；GUI 195 / 56 / 8 / 60.7 MB；差 141 包 47.2 MB；**AC1–AC3 通过**。这是在新增加 `@dshtrading/cockpit` 之后重测的 —— 驾驶舱没有污染 bot 闭包。

## 核心与 edge 的进程入口不是 application bin（2026-10-02 补，P5 步骤 1）

`packages/tradectl/bin/core.mjs`（执行核）与 `bin/edge.mjs`（edge 网关）是**库的进程启动器**，不是 §2.2/§2.3 禁的那种 application bin：

- §2.2/§2.3 禁的是**产品面**另起 bin（bot 必须走 `dsh --profile trading-bot` + profile bundle，产品功能进 bundle 不进 bin）；这两个文件不含任何产品功能，只做"读参数 → 用库装配 → 起停"。
- 核与 edge 是**独立 OS principal 的基础设施进程**（§2.1 三进程 / §13 #2 #16 #18）：把它们做成 dsh profile 行会让它们跑在宿主进程里，"核心与宿主不同 uid"就从结构退化成一句注释（§2.1「诚实边界」）。
- 形态与既有 `packages/authority/bin/sign-live-trading.mjs` 一致：private 包、不进 `files`、**不声明 `bin` 字段** ⇒ 不是发布出去的应用，只是本仓的进程启动器；`deploy/systemd` 的 `ExecStart` 指向部署副本 `/opt/dsh-trading/tradectl/bin/*.mjs`。
- 两个入口共用一个 `bin/runtime.mjs` 选实现：`lib/` 比 `src/` 新就用 `lib/`，否则改用源码（Node 类型剥离）——**绝不跑过期构建产物**。
- `bin/core.mjs` 的 `$DSH_HOME` 判定只认"目录名以 `-trading` 结尾"的家：实测宿主 home（`~/.dsh`）里也有 `profiles/trading-web`，拿"有没有 trading profile"当判据会**恰好放过**最该拦的那一种。

## 未验证项（如实标注）

- `dsh-trading-role-presets` 仍 pending：bot profile 没有 `agent-preset-registry` 行（那是 `dsh-web-app` 层的），base 的 presets 行等不到 `agentPresets` 服务。步骤 1 只要求"面起得来"，agent 面归后续步骤。
- `web-search-exa` 导入失败：该行来自 profile 的依赖面，不是 bot 平面，未处理。
- 端口缺省 8899 与 `--trusted-host` 的真实跨机访问未演练（内网暴露面归 P2 步骤 4 的 edge 网关）。

## 被否决的方案

- **把核心/edge 也做成 dsh profile 行**（不用库的进程入口）：那会把三个 OS principal 压回一个宿主进程，§2.1 的 uid 分离与 §13 #2 从结构退化成配置约定。
- **provide 官方服务名 `webServer`/`connection`**：见 why 2，实测 fatal。
- **在 bot bundle 里整行覆盖 `headless-startup`**：被 `patch-id-gate` R3 挡下，理由成立（bundle patch insert-only）。改为不叠 headless。
- **给 bot 面加 `registerUpgrade` 假装完整传输**：那会在 WS 通道上制造"能用"的假象，而升级处理并没有实现——属于 §13 意义上的静默降级，不做。
