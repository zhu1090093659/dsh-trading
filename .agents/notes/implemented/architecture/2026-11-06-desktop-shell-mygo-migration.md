# Agent Note: 桌面壳从 Electron 迁到 mygo（Go + 系统 WebView）

Status: implemented

## Problem

现役桌面壳（`desktop/`）基于 Electron 构建，自带完整 Chromium 与 Electron 运行时来承载本地 Web GUI 窗口，同时在外部拉起打包的 `runtime.node/bin/node` 运行独立 Node 宿主进程。桌面壳本身只承担拉起宿主、开窗、维护单实例锁、修剪历史认证 cookie 与暴露 `window.desktop` 桥接契约，不承载插件容器。壳层迁至 `mygo`（Go + 系统 WebView）可消解壳层对 Electron/Chromium 的绑定，同时保持宿主进程与插件体系不变。

## Decision

- **新增 `desktop/mygo/` 与现役 Electron 壳并存**：壳层采用 `mygo`（Go + 系统 WebView）实现，由 `desktop/mygo/main.go`、`desktop/mygo/mygo.json`、`desktop/mygo/cmd/agentctl` 与 `desktop/mygo/internal/{launch,policy,recovery,renderer,hostwait,shell,profile,cohort}`（连同单实例、附着移交与 cookie 修剪包）组成，与现役 Electron 壳并存；Electron 壳的退役条件是对齐验收通过后单独一张卡。
- **插件体系与宿主进程保持原样**：插件容器运行在独立 Node 宿主进程里（`@deepseek-ai/cordis` + `cordis-plugin-loader` + profile 的 `cordis.patch.yml`），壳只负责 spawn、开窗、守 cookie。`dsh` 安装包 `lib/` 内 grep `electron` 零命中，壳只 spawn 打包的 `runtime.node/bin/node`，因此壳层替换不影响插件体系。
- **窗口契约与生命周期对齐现役桌面壳**：
  - `window.desktop` 暴露七个方法（`onStatus`、`onError`、`retry`、`revealLog`、`openVCRedistDownload`、`relaunch`、`quit`），通过 `mygo` 绑定服务与预加载脚本桥接。
  - 启动前修剪同一 loopback origin 上残留的 `dsh-auth-*` 会话 cookie（等价于 Electron 壳修 [2026-09-11 的 431 事故](../bug-fix/2026-09-11-desktop-auth-cookie-header-overflow.md)）。
  - 宿主子进程以独立进程组运行并按进程组回收；异常退出恢复预算为 `Max=3` / `Window=10min`，第 4 次意外退出耗尽预算并停在启动问题页，页面 `Retry` 重置预算。
  - 页面策略限制在 `internal/policy` 与 `internal/shell`：导航只放行 loopback 与 `file:`，其余取消或交系统浏览器；`window.open` 恒 deny；窗口标题不被页面 `<title>` 覆盖；页面权限请求一律拒绝（`mygo` 对被信任 origin 默认放行，必须显式拒绝）；渲染进程 warn/error 经预加载桥接写入宿主日志，行形为 `[renderer] <level> <source>:<line> <message>`。
- **载荷与 profile 播种**：
  - Go 侧 `internal/profile` 负责 `.dsh-desktop-seed.json` 标记与 `seed`/`reseed`/`leave` 判定；`reseed` 保留用户根 `cordis.patch.yml` 及其备份，包内 patch 层照抄。没有标记的 profile 判 `leave`：`dsh` CLI 维护的 live profile（`package.json` 的依赖是 `file:` 指向仓库）不会因换包而更新，升级到新载荷的路径是把它整体移走、启动一次让壳按 `seed` 建新 profile，再把备份里的用户 `cordis.patch.yml` 覆盖回去。
  - `internal/cohort` 把 profile 的 `@deepseek-ai/*` 副本重链到随包运行时。
  - `internal/launch` 的载荷布局为 `runtime/{node,host,profile-trading,VERSION.json}` 与 `ProfileDir`；`DSH_PRIMARY_RUNTIME` 只在 `runtime.json` 存在时下发，缺失即显式缺席、不回落系统 Python。
  - `desktop/scripts/stage-mygo-payload.mjs` 只映射既有载荷、不生成载荷，并在暂存阶段调用 `desktop/scripts/prune-mygo-payload.mjs` 按目标平台裁剪暂存副本：用 39 条「包名 → 目标平台」白名单，在删除前读取每个包 `package.json` 核对 `os`/`cpu`（矛盾即失败），删掉 35 个非目标平台包 823M 与 4912 个 `*.map` 54M，共 877M；源载荷保持完整（多平台是 Electron 一份载荷装三平台的前提），`--keep-all-platforms` 可跳过裁剪。
- **打包与签名**：
  - `mygo build -platform darwin/arm64` 在载荷按目标平台裁剪与点文件补拷后产出 `.app` 与 `dmg`：2026-11-07 用 host `0.2.2-rc.1` 与 `0.6.3` 插件闭包重建为 930 MiB（`node` 218 MiB / `host` 587 MiB / `profile-trading` 97 MiB）与 173 MiB。
  - `mygo` v0.7.4 收集 `resources` 时跳过以 `.` 开头的条目（`cmd/mygo/resources.go`），导致载荷少 184 个文件 + 44 个目录（2.07 MiB），宿主 `llm-pi-ai` 因此报 `ERR_MODULE_NOT_FOUND`。`desktop/scripts/restore-mygo-dotfiles.mjs` 在 `build` 后按「暂存载荷 vs 包内」清单差异补拷、重签、重建 `dmg`，并以 `--check` 作为构建收尾闸门（差异必须为 0）。
  - `mygo build -sign` 对包内每个 Mach-O 重新签名（ad-hoc 亦然），签名追加在文件尾部，包内副本必然大于暂存载荷；闸门把「两侧都是 Mach-O + 包内更大 + `codesign -dv` 认签」记为 `resigned` 而不是漂移，其余内容差异照旧中止构建。没有 `codesign` 的宿主（Windows 轨道）不做这项豁免，比对保持严格。
  - `CFBundleIdentifier` 为 `com.dsh-trading.desktop.mygo`，`CFBundleName` 为 `DSH Trading Mygo`，版本 `0.2.1` 与 `desktop/package.json` 对齐，图标取 `desktop/resources/icon.png`。
  - 产物名为 `dsh-trading-desktop-0.2.1-arm64.dmg`（与 `electron-builder` 的 `dsh-trading-desktop-<version>-mac-<arch>` 差 `-mac-` 段，理由在 `desktop/README.md`）。
  - 默认 ad-hoc 签名通过 `codesign --verify --deep --strict`；真实身份签名与公证入口是 `build-mygo-mac.sh --sign / --notarize`，需在 GUI 会话执行（ssh 会话钥匙串锁定会报 `errSecInternalComponent`）。
- **Windows 轨道**：
  - 平台差异全在 build tag 之后：单实例 unix 走 `flock`、Windows 走 `LockFileEx`（`golang.org/x/sys` v0.48.0），锁属于句柄、进程一死内核即释放；两次启动之间的焦点移交走 AF_UNIX socket（`sun_path` 预算 unix 96/107 字节），**Windows 上没有这条通道**：Go 的 `net` 在 Windows 上不实现 AF_UNIX listener（`net.Listen("unix", …)` 报 `bind: invalid argument`，2026-11-07 windows-latest 实测），因此 `handoverListener` 在 `lock_windows.go` 返回 nil：锁照旧决定谁运行，第二个实例直接退出、不再请求聚焦。此前 `Acquire` 把这条 listener 当硬依赖，Windows 轨道会在启动处拿到该错误就返回——一次都起不来；现在单实例语义与 macOS 一致，只有跨实例聚焦在 Windows 缺席。宿主进程树 unix 是进程组 `SIGTERM` → `SIGKILL`，Windows 是 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，宿主启动后立刻 assign，assign 失败即杀宿主，不留一棵没人管的树）加 `taskkill /T` 尽力回收，grace 到期时 `/F /T` 与 `TerminateJobObject` 一并上，整棵树按 job 里的活跃进程数判定。Windows 没有信号，宿主的结束只看退出码，因此一次退出会吃满 5 秒 grace——与 Electron `stopHost`（`desktop/src/main.cjs:191-214`）同款，是平台代价而不是缺陷。
  - 载荷：Windows 的 node 是 `runtime/node/node.exe`，`PATH` 前缀是 `runtime/node`（unix 为 `runtime/node/bin/node` 与 `runtime/node/bin`）；`stage-mygo-payload.mjs` 把 `windows/amd64` 映射成 `node-win32-x64`、prune 标签 `win32-x64`，并要求 `npm.cmd`／`npx.cmd` 同时在，缺一即中止。
  - WebView2 双层检测：安装器读注册表（EdgeUpdate client id 下的 `pv`，64 位 HKLM 视图、32 位视图、HKCU 三处），缺失时跑内置的 Evergreen Bootstrapper `/silent /install`；应用在 `internal/preflight` 里按文件系统再查一次（`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` → `%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application` → `%LOCALAPPDATA%\Microsoft\EdgeWebView\Application`，要求 `msedgewebview2.exe` 与 `EBWebView/<arch>/EmbeddedBrowserWebView.dll` 同时在）。两层各查一处，是因为注册项还在而文件已被删的机器能过安装器、却起不来窗口。
  - 缺 WebView2 时开 mygo 自带的 Win32 TaskDialog（打开下载页／复制地址／退出，关窗即退出、退出码 1、窗口之前先写一行英文日志），不是自绘页：自绘要走 `import mygo/ui`，会给 `go.mod` 添两个依赖，而且那套布局在本机无从验证。非 Windows 上 `Missing()` 恒为 false、启动路径不变。
  - 安装器：`mygo build -platform windows/amd64` 加 `makensis`，Linux/macOS 都能出；按用户装到 `%LOCALAPPDATA%\Programs\DSH Trading Mygo`，写 HKCU 卸载项、开始菜单快捷方式与完成页可选的桌面快捷方式。`mygo.json` 不带语言目录，安装界面只有英文。保留 VC++ 2015-2022 运行库（`desktop/resources/redist/vc_redist.x64.exe`，25,635,768 字节，注册表 `Installed=1` 判过后静默装）的依据是载荷里随包的 MSVC 原生 addon（sharp、koffi、sherpa-onnx、node-addon-require-builtin）在干净 Windows 上需要 `vcruntime140`：payload 的 `node.exe`（v24.20.0，93,381,448 字节）导入表只有系统 DLL，壳自身是 `CGO_ENABLED=0` 的静态 Go 二进制，两者都不需要它。
  - 真载荷来源：已安装 Electron 应用的 runtime 只带运行机那一平台的 node，不能当 Windows 载荷用；必须在检出里跑 `fetch-node.mjs` → `stage-pnpm.mjs` → `build-runtime.mjs`（macOS 可行、Linux 不行），再用 `DSH_MYGO_PAYLOAD_SRC` 指过去。
  - 卸载：MessageBox YESNO 问是否清 `$PROFILE\.dsh-trading` 与 `%APPDATA%`／`%LOCALAPPDATA%\DSH Trading Mygo`（含 WebView2 profile），默认「否」；静默卸载 `/S` 由 `/SD IDNO` 答「否」，一个字节都不删；`$PROFILE\.dsh` 永不触碰。Electron 那次 MessageBox 没有 `/SD`，静默卸载会停在那只框上。
  - 点文件在安装时补：`desktop/scripts/stage-mygo-dotfiles.mjs` 每次构建从暂存载荷写出 `desktop/mygo/build/installer-dotfiles.nsh` 的 `RestoreDotfiles` 宏，由 `installer/windows.nsh` 在 `customInstall` 里插进 `$INSTDIR`，同时把点条目补进 `build/windows-amd64`（直接跑 exe 也完整）；宏缺失时 `windows.nsh` 用 `!error` 中止 makensis，而不是发出一个起不来的应用。
  - 自证：`desktop/scripts/verify-windows-payload.mjs` 以 54 项检查（含负例）覆盖目标映射、裁剪、点文件宏与命令行，`desktop/scripts/build-mygo-win.sh` 在打包前先跑它。
- **Agent 通道与发布形态**：
  - `automation` 插件由构建期开关决定（源码 `cmd/mygo/build.go` 的 `keepInspector`：`MYGO_INSPECTOR=1` 保留；且 `-debug` 会丢 `production` 标记，所以发布不用它）。
  - owner 2026-11-06 决定发布构建带 `MYGO_INSPECTOR=1`，即 `automation` 与 web inspector 随包发布，接受理由与代价写在 `desktop/README.md`；另有 `--no-agent-channel` 走 `-tags mygo_noinspector` 产出不带通道的形态。
  - 客户端是 `cmd/agentctl`（`windows`/`eval`/`capture`/`idle`/`tree`），socket 只在 `MYGO_AUTOMATION` 存在时创建、mode `0600`。
- **CI 门禁同步落地**：`.github/workflows/ci.yml` 的 `mygo-shell` job（无 `needs`，job 级 `GOTOOLCHAIN=local`）跑 gofmt、`go vet`、`go test`，并对 darwin/arm64、linux/amd64、windows/amd64 三个目标交叉编译；Windows 专属实现（`internal/instance/lock_windows.go`、`internal/shell/host_windows.go`）另由 `mygo-windows` job（`windows-latest`，`go-version-file` 读 `go.mod`）用 runner 自己的 GOOS 跑 `go vet ./...` 与 `go test ./...`——交叉编译只证明编得过，不证明 Windows 的实现跑得对。两个 job 互不 `needs`；`desktop/mygo` 模块与 `ci.yml` 必须同一 commit 落地（`go:embed` 依赖 hooks 与 `selfcheck.js`）。

  2026-11-07 修 Windows 这条 job 的 11 个红用例，判据是"用例的平台假设"还是"产品的平台缺陷"：路径、载荷布局与文件 URL 的断言改走 goos 缝（新增 `resolveRuntimePathsFor`、`fileURLFor`，配合既有的 `nodeBinDir`／`nodeExecutableName`／`envFor`），两种平台形态在任一宿主上都断言，不再把 macOS 字面量写进用例；`internal/automation` 的用例要拨 AF_UNIX socket，整文件挂 `//go:build !windows`；`instance` 的锁用例在临时目录回收前 `Release`（Windows 删不掉还开着的文件），移交用例按平台拆成 `handover_unix_test.go`（socket 存在、第二个实例到达第一个）与 `handover_windows_test.go`（锁独占、没有 socket、`Acquire` 不因缺通道失败），共用的锁用例留在 `instance_test.go`；`shell` 的 `fakeTree` 在 kill 时置空（Windows 的 reaped 判据是 job 空）。产品侧的真缺陷只有上面那条 handover。验证：Linux 上 `gofmt`／`go vet`／`go test ./...` 全绿，`GOOS=windows go vet ./...` 与 `GOOS=windows go build ./...` 均 0——Windows 侧仍是交叉与静态核验，真机未跑。
- **发布流水线双轨**：
  - `.github/workflows/desktop-release.yml` 新增 `build-desktop-mygo`（`needs: check-version`，`runs-on: macos-latest`，`timeout-minutes: 90`），与既有 `build-desktop` 并存；`github-release` 的 `needs` 扩为 `[npm-publish, build-desktop, build-desktop-mygo]`，三路全绿才创建 Release。
  - 载荷在 job 内现生成：依次运行 `fetch-node.mjs` → `stage-pnpm.mjs` → `build-runtime.mjs` → `verify-runtime-toolchain.mjs` → `stage-mygo-payload.mjs --platform darwin-arm64`，映射完成后删掉 Electron 布局那份（`rm -rf resources/runtime`）。
  - 版本跟 tag：`desktop/scripts/set-mygo-version.mjs` 在 runner 里重写 `mygo.json` 的 `version`，与 Electron 轨的 `scripts/set-desktop-version.mjs` 对称。
  - 产物区分：mygo 的 `.dmg` 上传进 artifact `desktop-mac-mygo`，`.app` 上传进 `mygo-app-bundle`（故意不以 `desktop-` 开头，因为 `.app` 是目录，进入 `dist/` 会同时打断 `sha256sum` 与 `gh release create`）；两壳产物靠 job/artifact 与 `CFBundleIdentifier`（`com.dsh-trading.desktop` 对 `com.dsh-trading.desktop.mygo`）区分，文件名只差 `-mac-` 段，不能靠名字判。
  - 签名凭据全是可选 secret：有身份 secret（`MYGO_SIGN_IDENTITY`）才传 `--sign`，三个 `APPLE_*`（`APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD`）齐了才传 `--notarize`，否则按 ad-hoc 打包并把模式写进日志，不新增必须配置的 secret。
  - 触发条件只有 `v*` tag push，PR 与 `main` 推送不跑；因此这条流水线首次真跑只能等 tag push，本地只能核语法与命令序列。

## 实测验证

在 macOS 27.0.1 arm64 上基于真实 `DSH Trading.app` 的 bundled runtime 与隔离 `DSH_HOME` 实测结果如下：

- **渲染与插件挂载**：渲染引擎为 `AppleWebKit/605.1.15`（`WKWebView`，非 Chromium），页面 title 为 `"DeepSeek Harness"`，client UI 插件样式 54 个挂载，page errors 为 0。
- **桥接契约**：`window.desktop` 七个方法（`onStatus` / `onError` / `retry` / `revealLog` / `openVCRedistDownload` / `relaunch` / `quit`）各自被调用一次且可观察。
- **Cookie 修剪**：连续两次启动 `authCookiesBefore/Pruned/After = 1/1/1`（等价于 Electron 壳修 2026-09-11 的 431 事故）。
- **进程组回收**：`killMs` 为 69~156ms、`hostExit=reaped`、`processGroupGone=true`、无孤儿。
- **恢复预算**：`Max=3` / `Window=10min`；第 4 次意外退出耗尽并停在启动问题页，页面 `Retry` 重置预算。
- **页面策略与渲染日志**：导航只放行 loopback 与 `file:`，其余取消或交系统浏览器；`window.open` 恒 deny；标题不被页面 `<title>` 覆盖；权限一律拒绝；渲染进程 warn/error 落日志，行形 `[renderer] <level> <source>:<line> <message>`。
- **载荷 stage、按平台裁剪与隔离 home 播种**：无参构建从 `/Applications/DSH Trading.app` 现取 runtime 暂存副本，由 `desktop/scripts/prune-mygo-payload.mjs` 按 39 条「包名 → 目标平台」白名单核对各包 `package.json` 的 `os`/`cpu` 后删掉 35 个非目标平台包 823M 与 4912 个 `*.map` 54M（共 877M，源载荷保持完整，`--keep-all-platforms` 可跳过裁剪）；隔离 home 首次播种 `profile-trading` 170 MiB，日志输出 `profile action: seed` 与 `primary runtime: absent`。
- **点文件补拷、打包与签名校验**：`desktop/scripts/restore-mygo-dotfiles.mjs` 在 `mygo build -platform darwin/arm64` 后按「暂存载荷 vs 包内」清单差异补拷被 `cmd/mygo/resources.go` 跳过的 184 个文件 + 44 个目录（2.07 MiB）、重签并重建 `dmg`，`--check` 收尾闸门差异为 0，修后宿主日志 `did not activate` 与 `Cannot find module` 均为 0；产出 `.app` 955 MiB（`node` 217 MiB / `host` 542 MiB / `profile-trading` 170 MiB）与 `dsh-trading-desktop-0.2.1-arm64.dmg` 196,123,648 B（187 MiB），ad-hoc 签名通过 `codesign --verify --deep --strict`。
- **Agent 通道与 `cmd/agentctl`**：`mygo` 的 `automation` 插件（Unix socket + NDJSON，mode `0600`）经 `cmd/agentctl` 实测 `eval` 取到 `title=DeepSeek Harness`、`plugins=203`，`capture` 产出 560613 字节 2880x1656 PNG，`tree` 对网页窗口返回 `unsupported`（文档亦如此）。
- **Windows 轨道：交叉编译与静态核验，真机未验证**。Windows 侧没有真机：这一段的事实来自 Linux 构建机（与上面 macOS 的实测不是同一台机器），全部是交叉编译或静态核验，没有一次在 Windows 上实跑。已核验：`CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...` 编得过；`desktop/scripts/verify-windows-payload.mjs` 54 项全绿（含负例：缺 `npm.cmd` 中止、只带其他平台 node 的载荷中止、删掉点文件宏后 makensis 报错停下）；`desktop/scripts/build-mygo-win.sh` 用替身载荷产出 `DSH Trading Mygo.exe` 12,270,080 字节与 `dsh-trading-desktop-setup-0.2.1-amd64.exe` 56,549,995 字节（约 56.5 MB，含 VC++ 运行库 25,635,768 字节与 WebView2 引导程序 1,897,688 字节；bootstrapper 在 `$PLUGINSDIR` 与 `$INSTDIR` 根各一份，因为 mygo 把 `resources/windows-amd64` 当作平台资源并入 app）；WebView2 引导程序实测 sha256 为 `cf2f2445fef0c5c14e372045f84998771eeb8bb01d59be4afd00692fa160082e`；7z 解析本安装器会在一条指令处停下（`BadCmd=13`），因此列不出 `Uninstall.exe` 条目——它由安装时的 `WriteUninstaller` 生成，不是缺件。未验证、只能等真机：Job Object、`LockFileEx`、Toolhelp32/PEB 读取、`WM_CLOSE`、TaskDialog，以及 NSIS 的安装与卸载流程。owner 在真机上的两件事：装本安装包并启动；用 drill 的 `proctree` 取进程树前后对照 JSON（`go build -o mygo-drill.exe ./cmd/drill`，再 `mygo-drill.exe proctree -shell "%LOCALAPPDATA%\Programs\DSH Trading Mygo\DSH Trading Mygo.exe" -out .\drill`，报告落在 `.\drill\proctree-<pid>.json`，退出码 0 表示壳按请求退出且树里没有进程活下来）。

## 当前状态

payload/profile 分发（含暂存阶段按目标平台裁剪与 build 后点文件补拷闸门）、打包与签名、agent 通道接线、`desktop-release.yml` 双轨、Windows 轨道（平台层、WebView2 双层检测与引导窗口、NSIS 安装包、安装时点文件补拷、CI 门禁）均已落地，Windows 侧的真机证据（安装并启动、`proctree` 进程树）待 owner 补；当前仍未落地的部分只剩：Electron 壳退役。

## Alternatives considered

- **直接移除 Electron 壳单轨切换**：Electron 壳退役及 Windows 分支尚未落地，直接移除现有 Electron 壳会破坏当前桌面端交付链路，因此采用 `desktop/mygo/` 与 Electron 并存（含 `desktop-release.yml` 双轨同批打包），Electron 退役条件是对齐验收通过后单独一张卡。
- **沿用 `mygo` 对被信任 origin 的默认权限放行**：`mygo` 对被信任 origin 默认放行权限请求，而桌面壳必须把 GUI 所在 loopback origin 设为被信任 origin 以挂载桥接；若不显式拦截，页面会获得超出 Electron 沙箱窗口的权限，因此显式拒绝全部权限请求。
- **发布构建默认剔除 `automation` 与 web inspector（不设 `MYGO_INSPECTOR=1`）**：不带 `MYGO_INSPECTOR=1` 时 `mygo` 默认注入 `-tags mygo_noinspector`，产出的发布包无法通过 `cmd/agentctl` 对安装态产物执行端到端验收；owner 2026-11-06 决定发布构建默认带 `MYGO_INSPECTOR=1`（socket 仅在 `MYGO_AUTOMATION` 存在时创建且权限为 `0600`），同时由 `build-mygo-mac.sh --no-agent-channel` 提供走 `-tags mygo_noinspector` 的无通道形态。
- **WebView2 缺失时自绘一张引导页**：自绘要走 `mygo/ui`，会给 `go.mod` 添两个依赖，而那套布局在本机（没有 Windows）无从验证，等于把只能在用户机器上第一次见到效果的界面发出去；因此改用 mygo 自带的 Win32 TaskDialog（打开下载页／复制地址／退出三个按钮，关窗即退出、退出码 1，窗口之前先写一行英文日志）。
- **把 `desktop/mygo` 模块与 `ci.yml` 拆开提交**：代码中的 `go:embed` 依赖 `internal/shell/hooks/*.mjs` 与 `cmd/drill/selfcheck.js`，且 Go 模块不在 pnpm workspace 门禁内，拆分提交会产生无 CI 门禁或缺内嵌文件的提交，因此模块与 `ci.yml` 必须同一 commit 落地。

## Consequences

- **渲染引擎与调试通道变化**：渲染引擎变成系统 WebView（macOS `WKWebView` / Windows `WebView2` / Linux `WebKitGTK 4.1`），macOS 侧没有 CDP；发布构建默认带 `MYGO_INSPECTOR=1` 随包发布 `automation` 与 web inspector，通过 `MYGO_AUTOMATION`（mode `0600`）与 `cmd/agentctl` 驱动，不需要通道的场景用 `--no-agent-channel` 构建。
- **签名与钥匙串约束**：ad-hoc 签名通过 `codesign --verify --deep --strict`；真实身份签名与公证入口为 `build-mygo-mac.sh --sign / --notarize`，在 ssh 会话会因登录钥匙串锁定报 `errSecInternalComponent`，需在 GUI 会话执行。
- **CI 双轨打包与触发边界**：本地无参构建可直接从 `/Applications/DSH Trading.app` 现取 runtime 并在暂存阶段按目标平台裁剪（删掉 877M 非目标平台包与 `*.map`，源载荷保持完整）、在 build 后补拷点文件（产出 `.app` 955 MiB、`dmg` 196,123,648 B / 187 MiB），而 `desktop-release.yml` 的 `build-desktop-mygo` job 在 runner 内现跑 `fetch-node.mjs` → `stage-pnpm.mjs` → `build-runtime.mjs` → `verify-runtime-toolchain.mjs` → `stage-mygo-payload.mjs --platform darwin-arm64` 生成并裁剪载荷后删掉 Electron 布局副本；因工作流仅由 `v*` tag push 触发（PR 与 `main` 推送不跑），首次真跑只能等 tag push，本地仅能核验语法与命令序列。
- **本地 Go 工具链要求**：本地开发必须设置 `GOTOOLCHAIN=auto`（`desktop/mygo/go.mod` 要求 `1.27.3`，本机 go 为 `1.27.1`）。
- **并存期双份钩子维护**：并存期 `internal/shell/hooks/*.mjs` 与 `desktop/src/*.mjs` 是双份，`desktop/src` 仍是事实来源。
- **CI 独立门禁与同提交约束**：`ci.yml` 的 `mygo-shell` job（无 `needs`，job 级 `GOTOOLCHAIN=local`）跑 gofmt、`go vet`、`go test` 与三个目标的交叉编译，Windows 实现另由 `mygo-windows` job 在 `windows-latest` 上跑 vet/test，模块与 `ci.yml` 必须同一 commit 落地（`go:embed` 依赖 hooks 与 `selfcheck.js`）。
- **Windows 轨的代价**：安装界面只有英文（`mygo.json` 不带语言目录，壳也没有语言包），与 Electron 安装器的 `zh_CN` 缺省不同；产物未签名（`windows.certificate` 未配），首次运行要走 SmartScreen 的「仍要运行」；Windows 没有信号，一次退出会吃满 5 秒 grace 才强杀；bootstrapper 在 `$PLUGINSDIR` 与 `$INSTDIR` 根各存一份、再加 25,635,768 字节的 VC++ 运行库，使替身载荷下的安装包也有 56,549,995 字节；点文件不随 `mygo build` 的资源进包，靠安装时的 `RestoreDotfiles` 宏补进 `$INSTDIR`（同一脚本另补 `build/windows-amd64`），因此绕过安装器取用构建目录时必须先跑它；Windows 的实现只有 `windows-latest` 上的 vet/test 与 ubuntu 上的交叉编译撑着，真机行为待 owner 补证据。
