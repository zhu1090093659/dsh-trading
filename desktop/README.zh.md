# desktop — DSH Trading 桌面版

[English](README.md) | 中文

一个把 dsh-trading Web GUI 变成可安装桌面应用（macOS / Windows）的 Electron 壳。安装包内置完整工具链——独立 Node.js 运行时（自带 npm 与 pnpm，版本跟随仓库 `packageManager` 钉住）、dsh 宿主和预装好的 trading-web profile（官方 web 界面 + base 与 crypto/us/cn/hk 市场 bundle，由本仓库自有包打包而来），因此在一台从未配置过任何编程环境的电脑上开箱即用。

## 功能

- 双击启动：当 `~/.dsh-trading/profiles/trading-web` 缺失时用内置 profile 种子初始化，用内置 Node 运行时在空闲回环端口启动 dsh 宿主（`dsh --profile trading-web --no-open`），等 GUI 就绪后加载宿主打印的带 token URL（认证门每次进程启动签发一次性 token；会话 cookie 保存在应用窗口内）。
- 自定义安装向导与路径选择：Windows NSIS 安装程序提供中英多语言安装向导（已取消静默一键安装），支持用户自由选择安装磁盘和路径。
- 纯净机 VC++ 运行库静默集成：Windows 安装包内置 Microsoft Visual C++ 2015-2022 运行库（x64），在安装时自动检测系统 64 位注册表，若缺少则执行静默安装，彻底解决纯净设备因缺少 `vcruntime140.dll` 等运行库导致 host 服务崩溃（0xC0000135）的问题。
- 卸载时询问清理数据：Windows 卸载向导弹出提示框，由用户决定是否一并删除交易 home（`~/.dsh-trading`）以及本地日志缓存——dsh web 宿主与 CLI 共享的 `~/.dsh` 永不触碰。
- 移交而非双宿主：当 `http://127.0.0.1:3080` 已有 dsh web GUI 在应答时，应用把该 URL 交给系统浏览器打开（用户浏览器的 cookie 已持有会话）并自行退出。绝不会在同一个 `~/.dsh` 上启动第二个 web 宿主。
- 与已有 dsh 安装共享 `~/.dsh`：由本应用播种的 profile 带 `.dsh-desktop-seed.json` 标记，内置运行时版本变化时会被重新播种；没有该标记的 profile 视为用户自管，永不触碰。用户的 `cordis.patch.yml` 层在重新播种后保留。
- 交易安全语义不变：下单默认 dry-run、走 base 审批闸门，与 CLI 一致（`liveTrading` 仍为显式开关）。
- 单实例：第二次启动只会聚焦已有窗口。关闭窗口即退出应用，并优雅停止由它启动的宿主（POSIX 进程组 SIGTERM，Windows 用 `taskkill /T`，5 秒后强杀）。
- 启动失败会进入错误页，展示精准的异常退出诊断（如针对缺少 VC++ 提供专属说明与一键下载引导）及宿主日志尾部，提供「重试」和「打开日志文件」按钮。完整宿主日志在 Electron `logs` 目录（`dsh-host.log`）。

## 仓库布局

| 路径 | 内容 |
| --- | --- |
| `src/` | Electron 主进程（`main.cjs`）、可测试的纯函数模块（`runtime.cjs`）、preload、启动页与错误页 |
| `runtime/host/` | 锁定版本的 `@deepseek-ai/dsh` 清单 + pnpm 布局（hoisted、多平台、安装 peers） |
| `runtime/profile-trading/` | profile 种子：清单由构建脚本从 workspace 包生成 |
| `scripts/fetch-node.mjs` | 下载并校验 sha256 的内置 Node 发行版（`resources/runtime/node-<os>-<cpu>/`） |
| `scripts/stage-pnpm.mjs` | 把钉住版本的 pnpm 装进每个暂存 Node 发行版（按平台生成 bin shim），使安装包自带 node + npm + pnpm |
| `scripts/verify-runtime-toolchain.mjs` | 发布闸门：当前平台每个暂存发行版的 node/npm/npx/pnpm 必须存在且可执行 |
| `scripts/build-runtime.mjs` | 全仓构建、逐包打包、安装并暂存载荷 |
| `resources/` | 应用图标 + 生成的运行时载荷（git 忽略） |
| `mygo/` | mygo 壳（迁移目标）：承载窗口、启动器、生命周期、cookie、页面策略、异常恢复、profile 播种、cohort 规范化与 agent 通道的 Go 模块 |
| `scripts/stage-mygo-payload.mjs` | 把载荷暂存进 `mygo/resources/runtime`，把按平台命名的 node 目录映射为 `runtime/node`，并把这份副本裁到目标平台 |
| `scripts/prune-mygo-payload.mjs` | 裁剪本体：「精确包名 → 它服务的那个平台」映射表，逐包核对 `os`/`cpu` 后删掉其他目标的包与 `*.map` |
| `scripts/verify-prune-mygo-payload.mjs` | 在 fixture 载荷上验证裁剪：映射表、拒绝条件、幂等性与命令行 |
| `scripts/restore-mygo-dotfiles.mjs` | 把 `mygo build` 漏在包外的资源补回包内（凡以点开头的名字），补完再重签 |
| `scripts/verify-restore-mygo-dotfiles.mjs` | 在 fixture 包上验证这套补拷：补了什么、拒绝了什么、报告长什么样 |
| `scripts/build-mygo-mac.sh` | 打包 macOS 版 mygo 壳：载荷、`.app` + `.dmg`、签名校验与公证入口 |
| `scripts/set-mygo-version.mjs` | 在 runner 里按发布 tag 重写 mygo 清单的 `version`，使 mygo 磁盘映像与 bundle 版本跟 Electron 壳一样随 tag 走（对应 `scripts/set-desktop-version.mjs`） |

dsh-trading 的插件不发布 npm，因此 `build-runtime.mjs` 把每个 workspace 包打进 `runtime/profile-trading/vendor/`，并把 profile 的直接依赖与 overrides 指到这些 tgz。生成的 profile 清单与 lockfile 不入库；可重现性由本仓库自身的版本承担。

## 构建

### 前提

构建机需要 Node 22+ 与 pnpm 11（仓库工具链）。打包出来的应用本身没有任何环境要求。

### 步骤

```sh
cd desktop
npm install            # electron + electron-builder
npm run prepare-runtime  # 拉取 Node 发行版 + 暂存 pnpm + 构建/打包/安装/暂存载荷
npm run dist:mac       # dist/*.dmg + *.zip（arm64 + x64）
npm run dist:win       # dist/*.exe（nsis）+ *.zip（可从 macOS 交叉构建）
```

`npm start` 基于已暂存的 `resources/runtime/` 以未打包形态运行应用，供开发调试。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | 与 dsh CLI 共享的数据目录（配置、会话、密钥）。仅在隔离测试时设置。 |
| `DSH_DESKTOP_NO_ATTACH` | 未设置 | 设置后跳过默认 URL 的移交检查，总是启动内置宿主。 |

宿主版本锁定在 `runtime/host/package.json`；trading 载荷版本在构建时取自 workspace 包。两者都记录进 `resources/runtime/VERSION.json`。

## 安全模型

- dsh 宿主只绑定回环地址（`127.0.0.1`）；`--host 0.0.0.0` 会被宿主自身拒绝。
- 窗口无 Node 集成，preload 运行在沙箱中；导航被限制在回环地址（以及本地启动页/错误页），外部链接一律交给系统浏览器打开。
- 内置 Node 发行版在构建时按官方 SHASUMS256.txt 校验。
- 交易安全语义原样交付：dry-run 默认、显式 `liveTrading` 开关与 base 审批闸门始终约束每一条下单路径。
- 应用只会写入启动时解析出的 `$DSH_HOME`、Electron `logs` 目录和它自己的安装目录。

## 已知限制

- **签名**：本机 macOS 构建按钥匙串里自动发现的 Apple Development 身份签名（`Identifier=com.dsh-trading.desktop`，团队 `3H4FK5CBYJ`）并启用 hardened runtime，因此 macOS 的隐私授权可以跨重建保留。授权本身仍是人工步骤——在**系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制**里加入 `/Applications/DSH Trading.app`；embedded 模式下驱动不会主动弹窗。开发签名仍会被 Gatekeeper 拒绝，所以**发布产物保持未签名**，直到 Developer ID 证书 + 公证落地；因此下载安装仍需要**系统设置 → 隐私与安全性 → "仍要打开"**（首次被拦后出现）或 `xattr -cr "/Applications/DSH Trading.app"`。Windows 有 SmartScreen 提示（更多信息 → 仍要运行）。用 `CSC_NAME=<证书 SHA-1>` 可固定签名身份；在没有任何可用身份的机器上构建时产物与从前一致，并在日志里打出显式横幅。
- **Windows arm64 与 Linux** 暂不构建；运行时布局已支持后续加入。
- 全新机器首次启动会花几秒钟把预装 profile 拷贝进 `~/.dsh`（一次性）。
- 内置载荷由 workspace 检出状态构建；拉取更新后需重新构建，才能把连接器或策略更新带进安装包。

## mygo 壳（迁移目标）

`mygo/` 是对当前 Electron 壳的 mygo 重写：窗口与启动器、单实例锁、附着移交、cookie 修剪、页面策略、重启预算与 `window.desktop` 桥接位于 `mygo/internal/shell`，载荷、打包与 agent 通道部分则补齐了 profile 播种、cohort 规范化、primary-runtime 闸门、macOS 应用包与自动化客户端。两个壳并存交付；mygo 壳拥有独立的应用名（`DSH Trading Mygo`）、用户数据目录与 bundle identifier，因此两者不会共用 cookie 存储或单实例锁。

### 载荷

载荷直接取 `prepare-runtime` 为 Electron 暂存的那份，拷贝进 mygo 工程时把按平台命名的 node 目录映射为 `runtime/node`：

```sh
node scripts/stage-mygo-payload.mjs --platform darwin-arm64
# -> mygo/resources/runtime/{node,host,profile-trading,VERSION.json}
```

`mygo/resources/runtime/` 已加入 git 忽略（`mygo/.gitignore`）：Node 发行版、宿主闭包与 profile 种子均属构建产物，不进仓库。脚本在构建启动前会拒绝不完整的载荷（校验 node/npm/npx、宿主入口、种子清单与 patch 层），`--from` 也接受已安装应用的运行时目录（`/Applications/DSH Trading.app/Contents/Resources/runtime`），该目录本身就是映射后的布局——没有检出 workspace 的 Mac 就靠它暂存同一份载荷。

运行期壳层就地读取载荷（`mygo/internal/launch/runtime.go`）：`runtime/node/bin/node`、`runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js`、`runtime/profile-trading` 与 `runtime/VERSION.json`。

### 一次构建只带一个平台

载荷按桌面版覆盖的每个目标安装——`runtime/host/pnpm-workspace.yaml` 的 `supportedArchitectures` 钉住 darwin + win32 与 x64 + arm64，因为 Electron 那份要同时供 mac arm64、mac x64 与 win32——而 mygo 构建只发一个平台。因此两个暂存入口（`stage-mygo-payload.mjs`、`build-mygo-mac.sh`）都只裁自己暂存的那份副本、绝不动源载荷，裁剪逻辑在 `scripts/prune-mygo-payload.mjs`。以 2026-10-21 的载荷实测，mac arm64 构建从 1824MB 里去掉 823MB：darwin-x64、win32-x64、win32-arm64 三套 LibreOffice kit、sharp 与 libvips、sherpa-onnx、koffi、ripgrep、QQ 邮箱 CLI、computer-use 驱动、ubjs 与 N-API 绑定，外加 54MB 的 `*.map`。

裁剪不按通配符匹配：`PLATFORM_PACKAGES` 逐条写明包名与它服务的那个平台，`host/` 与 `profile-trading/` 下每个包都会被读出来，让包自己的 `os`/`cpu` 声明去反驳映射表。映射表里没有的按平台包、表里写着某平台而 `package.json` 钉的是另一个平台、以及符号链接形态的包（pnpm store 布局而非 hoisted 布局），都会在删除任何东西之前让构建失败。`@deepseek-ai/dsh-win32-process` 刻意不入表：`dsh-subprocess-local/lib/index.js` 在每个平台都静态 import 它，darwin 构建里也要留。源载荷与 `node/` 整套保留——win32 构建暂存同一棵树、反向裁剪，随包分发的 node 发行版则带着 pnpm 自己的按平台绑定。

`*.d.ts`、包内 `test/` 与 `docs/` 目录只量化不裁：声明 48MB、fixture 9MB，相对按平台包都很小，而且前者是插件作者对着 profile 开发时预期能找到的类型面，后者有包可能读到自己的 fixture。

改传 `--keep-all-platforms` 则暂存全部平台，裁剪前后两个产物的大小就是靠它对比着量的。

### mygo build 漏掉的点文件

`mygo build` 从暂存载荷装配包内资源时会跳过所有以点开头的名字（`cmd/mygo/resources.go:551 hiddenName`，收集在 `:380`、复制在 `:643`）。载荷恰好需要其中一个：`@earendil-works/pi-ai/dist/providers/data/.manifest.json`，它被 `@deepseek-ai/dsh-llm-pi-ai` 静态导入；缺了它，每次启动都会留下 `dsh: warning: 1 entry did not activate` 与指向该路径的 `Cannot find module`。

因此 `build-mygo-mac.sh` 用 `scripts/restore-mygo-dotfiles.mjs` 把「暂存载荷」与「包内 `Contents/Resources/runtime`」的差异补回包内——清单从不手写，且差异里只要出现非点文件就拒绝——然后用与原构建相同的身份重新签名（`codesign --force --deep`，真实身份再加 `--options runtime --timestamp`，与 `mygo build` 一致），并从重签后的 app 重建磁盘映像，保留原映像的 Finder 布局与卷图标。补文件会让签名封失效，所以顺序是固定的：补拷、签名、重建映像。脚本随后校验包内与载荷逐条一致，并把映像挂载起来验证其中的 app 也验签通过。

### Profile、cohort 与 primary runtime

- **播种**（`mygo/internal/profile`）：缺少 profile 的 home 会用载荷里的种子初始化；此前由本应用播种过的 profile，只要载荷身份（`VERSION.json`：node、host、profile 哈希）发生变化就会重新播种；不带 `.dsh-desktop-seed.json` 标记的 profile 视为用户自管，永不触碰。重新播种时替换清单与 `node_modules`，用户自己的 `cordis.patch.yml` 及其备份原样保留。
- **Cohort**（`mygo/internal/cohort`）：profile 解析到的每一份 `@deepseek-ai/*` 副本都会重新链接到内置宿主的那份——两份副本会撕裂模块级状态，导致 preset 保留工具却丢掉人设、工作区 `AGENTS.md` 与技能目录。运行时未随包分发的包，以及归属其他安装位置（仓库检出、pnpm store）的包目录树，一律保持原状。
- **Primary runtime**（`mygo/internal/launch/primary.go`）：仅当 `resources/runtime/primary-runtime` 或 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` 下存在含 `runtime.json` 的载荷时才设置 `DSH_PRIMARY_RUNTIME`。缺失时壳层记录 `primary runtime: absent (Office skills and load_workspace_dependencies stay disabled)`，宿主的这两项官方能力保持显式禁用，而不会回退到系统 Python。用户自行导出的 `DSH_PRIMARY_RUNTIME` 原样透传，且绝不跨去读取宿主的 `~/.dsh` 实例。

### 构建与签名

```sh
PATH=/path/to/go/bin:$PATH desktop/scripts/build-mygo-mac.sh        # ad-hoc 签名的 .app + .dmg
PATH=/path/to/go/bin:$PATH desktop/scripts/build-mygo-mac.sh \
  --sign "Developer ID Application: Name (TEAM)" --notarize         # 分发构建
```

脚本先暂存载荷（默认来源：若已安装 `/Applications/DSH Trading.app` 则取其 runtime，否则取 `desktop/resources/runtime`），除非传 `--keep-all-platforms` 否则把这份副本裁到目标平台，当 `PATH` 上没有 `mygo` 时用 Go 编译 mygo CLI，执行 `mygo build -platform darwin/arm64 -sign …`，最后打印应用包的 `Info.plist`、签名信息、包内各部分载荷体积与产物列表。构建需要 macOS（`codesign`、`hdiutil`）与 Go 工具链：`mygo/go.mod` 钉住 go 1.27.3，`mygo build` 用它编译应用，因此打包机需要该版本（设 `GOTOOLCHAIN=auto` 可自动拉取）。

产物落在 `mygo/build/darwin-arm64/`：

- `DSH Trading Mygo.app`：`CFBundleName` 与 `CFBundleDisplayName` 为 `DSH Trading Mygo`，`CFBundleIdentifier` 为 `com.dsh-trading.desktop.mygo`（与 Electron 应用的 `com.dsh-trading.desktop` 区分开，使两个壳都能各自独立安装和启动），`CFBundleShortVersionString` 与 `desktop/package.json` 一致同为 `0.2.1`，图标取 `desktop/resources/icon.png`（1024×1024，渲染为 `AppIcon.icns`）。
- `dsh-trading-desktop-0.2.1-arm64.dmg`：比 electron-builder 的 `dsh-trading-desktop-<version>-mac-<arch>.dmg` 少一段 `-mac-`。`mygo build` 把磁盘映像命名为 `<slug>-<version>-<arch>.dmg`，不含平台字段，因此 slug 沿用 electron-builder 前缀（`dsh-trading-desktop`）并保留架构后缀；发布工具可以用 `dsh-trading-desktop-*` 通配收集，再按 `.app` 及其 `CFBundleIdentifier` 区分两个壳。

签名：默认为 ad-hoc（`-sign -`），能通过 `codesign --verify --deep --strict`，但不会被 Gatekeeper 放行。正式分发签名由 owner 在 GUI 登录会话中执行：ssh 会话的钥匙串处于锁定状态，`codesign` 会报 `errSecInternalComponent` 失败。`--sign "Developer ID Application: …"` 使用指定身份签名，mygo 随后一并启用 hardened runtime 与时间戳；`--notarize` 用 `notarytool --wait` 提交 `.dmg` 公证，并把票据装订（staple）到应用包和磁盘映像上（凭据取自 `APPLE_ID` + `APPLE_TEAM_ID` + `APPLE_APP_SPECIFIC_PASSWORD`，或 `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`）。mygo 自带的配置路径（`mygo/mygo.json` 中的 `macos.signingIdentity` + `macos.notarize`）仍然可用；入库配置保持 ad-hoc 默认值，使没有签名身份的机器也能打出可运行的应用。

两种形态都是 mygo 的发布构建：`mygo build` 会注入 `-X github.com/egoist/mygo.production=1`，窗口默认关闭开发者工具，产物不是开发包。决定是否保留原生 UI 检查器——以及连带保留由 agent 通道驱动的 automation 插件——的唯一开关是环境变量：`MYGO_INSPECTOR=1` 保留它们（`github.com/egoist/mygo/cmd/mygo/build.go:448`、`:453`），其余情况一律加上 `-tags mygo_noinspector`。`-debug` 虽也会保留它们，但会丢掉 production 标记，因此发布包绝不用 `-debug` 构建。`--no-agent-channel` 打出不含它们的版本（见下文）；`--no-payload` 直接使用已暂存好的载荷构建；`--skip-run-check` 跳过启动应用验证通道在不在产物里的步骤。

脚本末尾会自证构建产物符合所选形态：先读取可执行文件自身的符号标记（插件协议代码，或替身实现的「本构建未包含 automation」提示），再设置 `MYGO_AUTOMATION` 与临时目录下的即弃 `DSH_HOME` 启动一次刚打好的应用，调用 `agentctl windows` 获取窗口列表（因窗口比应用就绪略晚一瞬，会做短暂重试）；不含通道的构建则由应用自身写到 stderr 的那行提示来证实。若当前环境无法启动应用（如无 GUI 会话，或没有 Go 可编译 `agentctl`），脚本会退回仅核对二进制标记，并写明跳过了哪项检查。

### 发布管线：区分两个壳的产物

`.github/workflows/desktop-release.yml` 从同一个 tag 同时打包两个壳。`build-desktop`（`macos-latest` / `windows-latest` 矩阵）继续产出 Electron 安装包，`build-desktop-mygo`（`macos-latest`，仅 arm64）产出 mygo 的 `.app` 与 `.dmg`。CI 上没有现成的 `/Applications/DSH Trading.app` 可供拷贝，因此 mygo job 在任务内现生成载荷：依次运行 `fetch-node.mjs` → `stage-pnpm.mjs` → `build-runtime.mjs`，再用 `stage-mygo-payload.mjs --platform darwin-arm64` 映射布局，最后用 `build-mygo-mac.sh --no-payload` 打包。该 job 只重复执行依赖安装与构建，不再重复跑同一 commit 上发布管线已经跑过的测试——`pnpm test:desktop` 与全量 `pnpm -r test` 由 `npm-publish` 和 `build-desktop` 充当发布门禁，三路 job 全绿才会创建 Release。

文件名区分不开两个壳：mygo 磁盘映像叫 `dsh-trading-desktop-<version>-arm64.dmg`，Electron 版叫 `dsh-trading-desktop-<version>-mac-<arch>.dmg`，两者只差一段 `-mac-`，任何逻辑都不得拿文件名做判断。真正区分两者的维度如下：

| | Electron | mygo |
| --- | --- | --- |
| workflow job | `build-desktop`（macOS + Windows 矩阵） | `build-desktop-mygo`（macOS） |
| Actions artifact | `desktop-mac` / `desktop-win` | `desktop-mac-mygo`（`.dmg`）与 `mygo-app-bundle`（`.app`） |
| `CFBundleIdentifier` | `com.dsh-trading.desktop` | `com.dsh-trading.desktop.mygo` |
| Release 资产 | 各架构 dmg + zip、Windows NSIS exe + zip | arm64 `.dmg` |

`github-release` 只把匹配 `desktop-*` 的 artifact 下载进 `dist/`，计算哈希后一并上传，因此 mygo 的 `.dmg` 与 Electron 产物走同一份 `SHA256SUMS.txt` 发布。mygo 的 `.app` 故意不以 `desktop-` 开头：`.app` bundle 是目录，而 `sha256sum ./*` 与 `gh release create dist/*` 都只接受文件，目录一旦进 `dist/` 会同时把两步打断。

除非仓库配置了可选的签名 secret，否则 mygo 产物保持 ad-hoc 签名：存在 `MYGO_SIGN_IDENTITY` 时才传 `--sign`，`APPLE_ID`、`APPLE_TEAM_ID` 与 `APPLE_APP_SPECIFIC_PASSWORD` 三个同时齐备时才传 `--notarize`；打包步骤会在日志里打印本次采用的签名模式。管线不要求配置任何必选 secret；若要打出 Developer ID 签名包，runner 的钥匙串里还需有对应证书（本工作流不负责导入证书）。mygo 的版本号与 Electron 轨一样跟随 tag：仓库里的 `mygo.json` 保存已提交版本，job 在 runner 内运行 `set-mygo-version.mjs`（对应 `scripts/set-desktop-version.mjs`）就地重写它，使 `CFBundleShortVersionString` 与磁盘映像文件名都与 Release 对齐。

该工作流唯一触发条件是推送 `v*` tag：PR 与推送 `main` 都不触发它，因此 mygo job 无法在本地实跑验证，首次真实执行只能等推 tag。本地机器能核验的是工作流定义本身（YAML 解析、`actionlint`、`pnpm ci-wiring:check`）以及到 macOS 专属步骤为止的命令序列；真实运行时的载荷体积、签名信息、产物名称与 `build-mygo-mac.sh` 打印的 agent 通道自证结论则记录在 Actions 运行日志中。

### Agent 通道

发布包内置了壳层显式导入的 automation 插件（`mygo/automation.go`），因为验收与驱动构建产物走的就是这条 agent 通道：除非传入 `--no-agent-channel`，`build-mygo-mac.sh` 默认导出 `MYGO_INSPECTOR=1`，mygo 随之省去 `-tags mygo_noinspector`，插件的 `init` 便会监听 `MYGO_AUTOMATION` 指定的 Unix socket；未设置该环境变量时插件什么也不做。带上该构建 tag 的编译则会编入插件的 `off.go` 替身实现：不监听任何端口，带 `MYGO_AUTOMATION` 启动时只会在 stderr 打印一行提示，说明当前构建不含该通道。

`mygo/cmd/agentctl` 是本地客户端（在 Mac 上用 `CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o agentctl ./cmd/agentctl` 编译）：

```sh
MYGO_AUTOMATION=/tmp/dsh-mygo.sock \
  "mygo/build/darwin-arm64/DSH Trading Mygo.app/Contents/MacOS/DSH Trading Mygo" &

agentctl windows                      # 以 JSON 列出应用窗口
agentctl eval 'document.title'        # 在页面内执行脚本并返回 JSON 结果
agentctl capture /tmp/window.png      # 把窗口截图保存为 PNG
agentctl idle 5s                      # 等待窗口稳定空闲
```

- `windows` 列出窗口的 id、title、kind、url、bounds、focus 与 visibility。本壳层的窗口类型为 `kind: "page"`。
- `eval <script>` 在页面内执行脚本并打印 JSON 值；`-window <id>` 可指定非焦点窗口。
- `capture <file>` 无需「屏幕录制」权限即可把窗口写出为 PNG（由应用自行渲染自身窗口），并打印字节数与像素尺寸。
- `idle [timeout]` 等待窗口进入稳定空闲状态。

**页面窗口没有无障碍树（accessibility tree）。** 壳层窗口承载的是 GUI 网页，因此 `tree` 会返回 `unsupported`（`"window 7 shows a web page: use eval"`），`act`/`input` 也只适用于原生 UI 窗口。页面呈现的一切都能通过 `eval` 触达——`document.querySelector`、`getComputedStyle` 以及页面挂载的任意 `window.__x`——验收脚本正是对这些结果下断言。需要确认窗口长什么样时用 `capture`，需要确认页面内容是什么时用 `eval`。

#### 随包发布通道的代价

保留检查器的构建开关会把 automation 插件一并编入二进制，因此两者都会随包发到用户端：

- 仅当启动应用时用 `MYGO_AUTOMATION` 指定了路径，socket 才会被创建；插件会先收紧 umask 再以 `0600` 权限创建它（`github.com/egoist/mygo/plugins/automation/listen_unix.go`），只有启动该应用的用户本人能打开。日常双击启动不会监听任何 socket。
- 任何能打开该 socket 的进程都能读取窗口画面并操作页面：读取窗口几何尺寸、截取 PNG，以及在 GUI 页面里执行 `eval`（能触达页面本身能触达的一切，包括页面原本就在调用的 `window.desktop` 桥接）。它不会带来权限提升，也不会在页面既有能力之外打开通往 `$DSH_HOME` 的额外路径。
- 原生 UI 检查器会使二进制体积增加约 250 KB。本壳层的窗口在生产构建中保持关闭 Web 开发者工具（`PageOptions.DevTools` 保持 `DevToolsAuto`，在 `production=1` 时即为关闭），因此面板本身不会成为入口，真正应答请求的是该插件。

之所以接受这一代价，是因为验收直接驱动安装态应用：对被测产物执行 `windows`/`eval`/`capture`/`idle` 是验证发布包端到端可用的唯一手段，而单独打一份 debug 变体测出来的只是没人真正运行的二进制。它只是用户本机上的本地接口，且由用户自己的环境变量显式把关。

`--no-agent-channel` 可打出完全不含这两者的发布包：mygo 会传入 `-tags mygo_noinspector`，由替身实现顶替，产物在 socket 上不做任何应答。若产物必须完全不带本地驱动接口（例如交付给非运维人员的副本，或不希望暴露这层额外接口的分发包），可使用该选项，代价是失去基于实跑的端到端验收（构建脚本仍会启动应用读取替身实现的 stderr 提示，或在无 GUI 会话时核对二进制符号标记，来证实通道确已剔除）。
