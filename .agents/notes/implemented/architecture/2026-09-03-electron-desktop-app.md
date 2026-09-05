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
