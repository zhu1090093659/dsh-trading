# Agent Note: Electron 桌面版与内置自洽 dsh 运行时

Status: implemented

## Problem

dsh-trading 以插件包形态分发，且不发布 npm：用户要先装 Node 22+、npm 全局的 `@deepseek-ai/dsh` 宿主、初始化 `~/.dsh`、再以 file: 链接装齐 base 与各市场 bundle。这是开发者工具链，不能要求交易用户自行搭建。目标是做出一个人人可安装、双击即用、完全不用关心环境的桌面版。

## Decision

仓库新增顶层 `desktop/` 目录（不在 pnpm workspace glob 内），承载一个用 electron-builder 构建的 Electron 应用，目标平台为 macOS（dmg/zip，arm64+x64）与 Windows（nsis/zip，x64），内部分发不签名。机制骨架从 dsh-web 仓库的同名工程迁移而来（先落地、后改造），按本仓载荷改造。

**运行时一律内置，绝不假设。** 安装包携带：每个目标平台的官方 Node.js 发行版（构建时按 SHASUMS256.txt 校验 sha256，`resources/runtime/node-<os>-<cpu>/`）、锁定版本的 `@deepseek-ai/dsh` 宿主及其依赖闭包（`runtime/host/`，`autoInstallPeers: true` 以对齐 npm 全局安装的闭包语义），以及预装好的 trading-web profile——bundle 为 `dsh-base` + `dsh-web-app` + `@dsh-trading/base` + `crypto/us/cn/hk`。启动时 Electron 主进程以子进程方式拉起 `<内置 node> <内置宿主>/lib/bin.js --profile trading-web --no-open --host 127.0.0.1 --port <空闲端口>`，待 GUI 就绪后加载宿主在 stdout 打印的带 token URL（认证门每次进程启动签发一次性 token，在应用窗口内换取签名会话 cookie）。

**不发布 npm 的载荷用本地打包 tgz 解决。** `build-runtime.mjs` 先 `pnpm -r build` 全仓，再对每个 workspace 包 `pnpm pack` 进 `runtime/profile-trading/vendor/`，生成 profile 清单：直接依赖与 overrides 全部指向 `file:./vendor/<pkg>.tgz`。生成的清单与 lockfile 不入库，可重现性由本仓库版本承担；拉取更新后重跑构建即可把连接器/策略更新带进安装包。

**一次安装覆盖多平台载荷。** 两棵运行时树都用 pnpm `nodeLinker: hoisted` 加 `supportedArchitectures`（darwin/win32 × x64/arm64）安装，使 sharp、lightningcss 等按平台解析的可选依赖覆盖全部目标，落进同一棵无符号链接的真实文件树——无符号链接是硬性要求，构建脚本会断言暂存树内不存在任何符号链接（`.bin` 命令垫片在暂存时递归剔除）。

**`~/.dsh` 与 CLI 共享，标记制归属。** 应用解析 DSH_HOME 的顺序与宿主一致（`$DSH_HOME` 优先，否则 `~/.dsh`）。trading-web profile 仅在缺失时播种；本应用播种的 profile 带 `.dsh-desktop-seed.json` 标记，内置运行时戳变化时重新播种并保留用户的 `cordis.patch.yml` 层；无标记的 profile 视为用户自管，永不触碰。宿主自身的启动期修复（`$DSH_HOME/profiles/node_modules` 回退链接）让 profile 内插件代码复用宿主的 `@deepseek-ai/*` 模块实例，不存在 cohort 重复。

**移交而非双宿主。** 默认 URL 已有 GUI 应答时，应用把该 URL 交给系统浏览器打开（其 cookie 已持有会话）并退出，绝不在同一 `$DSH_HOME` 上再起第二个 web 宿主；内嵌已运行实例也不可行——token 无法事后获取，Electron 窗口独立 cookie jar 附着只会永久 401。应用自启宿主时拥有该子进程，退出时停止（POSIX 进程组 SIGTERM，5 秒 SIGKILL 兜底；Windows `taskkill /T`）。

**交易安全语义原样交付。** 桌面版不改任何下单路径：dry-run 默认、`liveTrading` 显式开关、base 审批闸门全部由 bundle 自带配置保证，桌面壳无任何绕行。

## Alternatives considered

- **在 Electron 主进程内直接运行 dsh 宿主**（复用 Electron 内嵌 Node）：包体更小，但 dsh 的进程派生、插件加载与文件系统假设将运行在 Electron 补丁版 Node 上，故障难排；内置官方 Node 让宿主与插件测试所基于的 npm 安装拓扑字节级一致。
- **用 `ELECTRON_RUN_AS_NODE=1` 派生 Electron 二进制当纯 Node**：Node 版本被 Electron 发行版钉死，不满足宿主 `^22.19 || >=24` 引擎区间，且依旧跑在补丁版 Node 上。
- **首启在线安装**（应用做小，首启在线拉插件）：违背「安装即用」，离线即失败，且内置环境无 pnpm。
- **隔离 App 专属 DSH_HOME**：卸载更干净，但与 CLI 双配置割裂；共享 `~/.dsh` 加标记制归属既保持单一事实源又不破坏既有数据。
- **只装 `@dsh-trading/all` 元 bundle**：`reconcilePlugins` 只堆 profile 直接依赖的 bundle（acceptance-all 2026-08-31 实证），transitive bundle 不进层栈，必须显式列 base + 各市场。

## Consequences

- 安装包体积大（运行时载荷约 800MB 未压缩，安装包压缩后数百 MB）：Node 发行版 × 3 目标 + 宿主闭包。内部分发可接受；裁剪留作后续有实测依据的优化。
- 未签名构建触发 Gatekeeper / SmartScreen 提示；签名、公证与自动更新是明确后续，不在本期。（2026-09-05 跟进：自动更新已落地为 @dshtrading/client-ui-updater 插件 + 发布资产增量通道，见 [2026-09-05-auto-update-plugin](../feature/2026-09-05-auto-update-plugin.md)；签名/公证仍属后续。）
- 依赖 pnpm 的应用内插件安装不可用（内置环境无 pnpm）；资产式安装不受影响。
- 载荷由 workspace 检出状态构建：仓库更新后需重跑 `npm run build-runtime` 才会进入安装包。
- dsh-web 仓库保留了同构骨架（其 dev 分支）作为 Web GUI 全家桶桌面版的地基；两侧的 profile 播种与打包脚本各自维护。

## Testing

- `desktop/tests/runtime.test.mjs`（node --test，7 例）覆盖路径解析（打包/未打包布局）、DSH_HOME 查找顺序、seed/reseed/leave 判定与补丁层保留、token URL 行解析、SHASUMS 解析。
- 实机验证（2026-09-03，隔离 `DSH_HOME`）：dev 模式启动播种 → 宿主拉起 → token URL 加载 → trading GUI 完整渲染（行情/策略/知识库/自选/K线指标，截图多模态验证）；宿主 stdout token 行、移交检查、错误页与日志文件按当前实现工作。

## 附着模式决策（P4 步骤 5，2026-10-01 落地决策层）

卡片要求：配了 bot 的机器默认**不再起本地 host**，把现有 handoff 扩到远端 bot URL；没配 bot 时保持现状。

**关键约束来自本仓自己的一次已发布 bug**（main.cjs 头部有记录）：探测端口无法分辨"已在跑的实例服务的是哪个 profile"，**曾经撞上一个普通 web GUI 并把用户自己的 DSH Web 打开**。所以附着**不能**靠探测。

`desktop/src/attach-mode.cjs` 于是做成**显式配置驱动的纯函数**（无 IO、无副作用、不探测端口）：

| 输入 | 结果 | 理由 |
|---|---|---|
| 没配 bot | `local` | 保持现状 |
| 配了内网地址（192.168/10/172.16-31/169.254/回环/`.local` / ULA / link-local） | `attach`，URL 去尾斜杠 | 卡片就是"仅内网可达" |
| 配了公网地址 | `local` + 原因 | **fail-closed**：本系统只承诺内网可达，绝不把执行核的会话交到公网 |
| 非法 URL / 非 http(s) 协议 | `local` + 原因 | 桌面壳**必须还能启动** —— 坏配置不该把 App 挡在门外 |

**测试 5 例**（`desktop/tests/attach-mode.test.mjs`，node:test，无 mock）：四种输入各自的模式与原因，加上回环/私有网段判定的正反例（含 `172.16` 在段内而 `172.32`、`172.15` 在段外的边界）。

**尚未接线**：`main.cjs` 仍在无条件起本地 host —— **这是刻意的**：接线会改变 App 的启动行为，而本机没有可跑的 Electron 验证路径；按"单测绿不等于真路径对"的教训，接线要与**一次可运行的切换演练（含回滚点）**同批做，而不是先接上再说。

**切换演练的准备条件**（卡片硬约束"同一份 $DSH_HOME 同一时刻只允许一个 host 写者"）：演练用**临时 DSH_HOME**，并需要一个"已配置 bot"的配置来源（settings 字段或环境变量 —— 接线时定）。

### 切换演练与接线前的前置（2026-10-01 续）

%%desktop/scripts/attach-drill.mjs%% 是可运行的切换演练（真文件/真环境变量/临时 DSH_HOME/回滚点），6/6 步通过、退出码 0；范围只覆盖"配置 → 决策"层（**不启动 Electron**）。

**接线的前置条件（比预期深）**：远端 bot 的 %%/v1%% 要求 Bearer 设备令牌，所以"把窗口指到 botUrl"并不够 —— 桌面壳需要**自己的设备凭据**（走配对流程 + Keychain），否则只会打开一个未授权的页面。因此接线 = 设备凭据 + 数据源守卫（已就绪）+ 回滚路径，而不是一行 URL 替换。

### 桌面壳设备凭据（2026-10-01 续，接线的第二块）

`desktop/src/device-credential.cjs`：配对 → 落盘 → 取授权头 → 忘记，纯 CJS 无第三方依赖。

三条立场：

1. **凭据与地址绑定**：密钥只在它配对时用的那个地址上使用；换了地址（哪怕只差端口）`authorization()` 返回 undefined。**一次配置改错不该把设备密钥交给另一个 host。**
2. **落盘 0600**：写 ``<DSH_HOME>/attach-device.json` 并显式 `chmod`（`writeFileSync` 的 mode 受 umask 影响）。移动端有 Keychain，桌面端没有等价物，就退而求其次：限制权限 + 地址绑定 + 随时可撤销。
3. **401 ⇒ forget**：被 revoke 后继续拿旧密钥重试是最糟的状态（看起来在跑、每条请求都被拒）。

**测试 5 例对着真实 edge 走真 HTTP**（`desktop/tests/device-credential.test.mjs`，import 构建产物 `packages/tradectl/lib/edge.js`）：配对后端到端读到 A0（`/a0/ping`)；文件权限实测 `0600`；换地址不外发；forget 后 `/a0/ping` 变 401；坏码 ⇒ `PAIRING_CODE_UNKNOWN`、连不上 ⇒ `PAIR_UNREACHABLE`（都不抛错）。

**⑤ 剩余**：把这三块（attach-mode 决策 / device-credential 凭据 / source-guard 守卫）接进 `main.cjs` 的启动分支，并在 Electron 里跑一次（本机尚无该验证路径，接线时要如实标注）。
