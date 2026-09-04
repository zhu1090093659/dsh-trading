# desktop — DSH Trading 桌面版

[English](README.md) | 中文

一个把 dsh-trading Web GUI 变成可安装桌面应用（macOS / Windows）的 Electron 壳。安装包内置独立的 Node.js 运行时、dsh 宿主和预装好的 trading-web profile（官方 web 界面 + base 与 crypto/us/cn/hk 市场 bundle，由本仓库自有包打包而来），因此开箱即用——不需要预装 Node、npm 或 dsh CLI。

## 功能

- 双击启动：当 `~/.dsh/profiles/trading-web` 缺失时用内置 profile 种子初始化，用内置 Node 运行时在空闲回环端口启动 dsh 宿主（`dsh --profile trading-web --no-open`），等 GUI 就绪后加载宿主打印的带 token URL（认证门每次进程启动签发一次性 token；会话 cookie 保存在应用窗口内）。
- 自定义安装向导与路径选择：Windows NSIS 安装程序提供中英多语言安装向导（已取消静默一键安装），支持用户自由选择安装磁盘和路径。
- 纯净机 VC++ 运行库静默集成：Windows 安装包内置 Microsoft Visual C++ 2015-2022 运行库（x64），在安装时自动检测系统 64 位注册表，若缺少则执行静默安装，彻底解决纯净设备因缺少 `vcruntime140.dll` 等运行库导致 host 服务崩溃（0xC0000135）的问题。
- 卸载时询问清理数据：Windows 卸载向导弹出提示框，由用户决定是否一并删除用户交易数据和配置目录（`~/.dsh`）以及本地日志缓存。
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
| `scripts/build-runtime.mjs` | 全仓构建、逐包打包、安装并暂存载荷 |
| `resources/` | 应用图标 + 生成的运行时载荷（git 忽略） |

dsh-trading 的插件不发布 npm，因此 `build-runtime.mjs` 把每个 workspace 包打进 `runtime/profile-trading/vendor/`，并把 profile 的直接依赖与 overrides 指到这些 tgz。生成的 profile 清单与 lockfile 不入库；可重现性由本仓库自身的版本承担。

## 构建

### 前提

构建机需要 Node 22+ 与 pnpm 11（仓库工具链）。打包出来的应用本身没有任何环境要求。

### 步骤

```sh
cd desktop
npm install            # electron + electron-builder
npm run fetch-node     # 一次性下载 Node 发行版
npm run build-runtime  # 构建 + 打包 + 安装 + 暂存载荷
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

- **未签名构建**：macOS 首次打开会被 Gatekeeper 拦截，且 macOS 15+ 已移除"右键 → 打开"绕过。放行方式：**系统设置 → 隐私与安全性 → "仍要打开"**（首次被拦后出现），或清除隔离属性：`xattr -cr "/Applications/DSH Trading.app"`。Windows 有 SmartScreen 提示（更多信息 → 仍要运行）。签名与公证是后续计划。
- **需要 pnpm 的应用内插件安装**（如 `dsh plugin add` 流程）在内置环境中不可用；资产式安装是纯文件拷贝，不受影响。
- **Windows arm64 与 Linux** 暂不构建；运行时布局已支持后续加入。
- 全新机器首次启动会花几秒钟把预装 profile 拷贝进 `~/.dsh`（一次性）。
- 内置载荷由 workspace 检出状态构建；拉取更新后需重新构建，才能把连接器或策略更新带进安装包。
