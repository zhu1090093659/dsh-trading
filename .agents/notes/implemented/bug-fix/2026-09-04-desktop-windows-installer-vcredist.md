# Agent Note: 桌面端 Windows 安装包向导改造、VC++ 运行库静默集成与 Host 启动故障根治

Status: implemented

## Problem

在纯净 Windows 操作系统设备上，安装本项目桌面端后无法启动，并弹出“服务 host 运行失败”（The dsh host process stopped unexpectedly）的错误提示（日志中显示 `(no host output captured)`）。
同时，现有 Windows 安装包存在以下产品体验缺陷：
1. **默认一键静默安装**：`nsis.oneClick: true` 导致用户无法选择安装磁盘和路径，默认直接释放进当前用户 `%LOCALAPPDATA%`。
2. **缺少 VC++ 运行库检测与安装**：内置官方 Node.js 发行版（`node.exe` v24.20.0）由 MSVC 编译，强依赖微软 Visual C++ 2015-2022 运行库（`vcruntime140.dll` 等）。纯净系统缺少该运行库时，子进程派生时直接抛出 `0xC0000135 (STATUS_DLL_NOT_FOUND)` 闪退，导致 host 服务无法启动。
3. **卸载清理无确认**：卸载时不提示用户是否清理 `~/.dsh` 配置目录及个人交易数据。

## Decision

- **自定义安装向导与路径选择**：在 [`desktop/electron-builder.yml`](../../desktop/electron-builder.yml) 中配置 `oneClick: false`、`allowToChangeInstallationDirectory: true`、`allowElevation: true`，开启支持中英双语（`language: 2052`）的 NSIS 多步安装向导，支持用户自选安装路径。
- **VC++ 运行库静默集成与 64 位注册表检测**：
  - 新增 [`desktop/scripts/fetch-redist.mjs`](../../desktop/scripts/fetch-redist.mjs)，在构建准备阶段自动从微软官方直链拉取 `vc_redist.x64.exe` 存入 `desktop/resources/redist/`。
  - 新增 [`desktop/resources/installer.nsh`](../../desktop/resources/installer.nsh)，在 `customInstall` 阶段使用 `SetRegView 64` 检测注册表 `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64` 的 `Installed` 键值。若未安装，将捆绑的 `vc_redist.x64.exe` 释放并静默执行 `/install /quiet /norestart`。
- **卸载弹窗询问清除数据**：在 `installer.nsh` 的 `customUnInstall` 钩子中，使用 `MessageBox MB_ICONQUESTION|MB_YESNO` 弹窗询问用户是否同时清理 `~/.dsh` 和应用配置缓存，用户确认后递归清理，取消则完整保留。
- **服务 Host 运行与崩溃诊断加固**：
  - 在 [`desktop/src/runtime.cjs`](../../desktop/src/runtime.cjs) 中新增 `formatHostExitDiagnostic` 纯函数，精准识别退出码 `3221225781` / `-1073741515`（`0xC0000135: STATUS_DLL_NOT_FOUND`），并生成友好易懂的诊断信息。
  - 在 [`desktop/src/main.cjs`](../../desktop/src/main.cjs) 中同步 Windows `env.PATH` 与 `env.Path`，避免系统目录丢失；增加 `child.on('error')` 防止进程派生异常引起主进程未捕获异常。
  - 在 [`desktop/src/error.html`](../../desktop/src/error.html) 中增加错误引导与“下载 VC++ 运行库”一键按钮（通过 `ipcMain` 打开微软官方下载直链）。

## Consequences

- 纯净 Windows 设备双击安装后，安装程序将自动检测并补齐 VC++ 运行库，内置 Node 宿主服务可稳定正常启动，彻底杜绝 0xC0000135 崩溃。
- 用户可自由指定安装路径并在卸载时自主决定个人数据去留。
- 即使在特殊环境下仍发生运行库缺失，错误页将直接明确指出“缺少 Microsoft Visual C++ 2015-2022 运行库”并提供一键下载按钮，告别晦涩的 `host stopped unexpectedly`。
- 所有单元测试（`desktop/tests/runtime.test.mjs` 8/8）与全仓门禁（`pnpm test` 113/113 文件，882 项测试）全绿。
