# Agent Note: 桌面端 Windows 平台 --import loader 路径规范化为 file:// URL 修复 host 服务崩溃

Status: implemented

## Problem

在引入 commit `6511647`（桌面端注入 `host-symbol-normalizer.mjs` 解决跨实例 `dsh-scope` 符号错位问题）后，Windows 用户安装 0.1.3 桌面版时出现宿主（host）服务无法启动的问题：
- 桌面端启动后主窗口显示错误页：“后台服务进程异常退出，退出码: 1”；
- 宿主进程被派生后瞬间闪退。

### Root Cause
在 Windows 操作系统中，`hostSymbolNormalizerPath()` 返回的是 Windows 本地绝对路径（如 `C:\Users\...\app.asar.unpacked\src\host-symbol-normalizer.mjs`）。
直接以普通绝对路径作为 `--import` 的参数传给 Node.js 运行时：
`node.exe --import "C:\..." ...`
在 Node.js ESM 规范中，`--import` 参数必须为模块 specifier 或合法的 URL。在 Windows 环境下，绝对路径中的驱动器盘符（如 `C:`）会被 ESM loader 解析为 URL 协议（protocol `'c:'`），从而抛出致命异常：
`Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. On Windows, absolute paths must be valid file:// URLs. Received protocol 'c:'`
导致宿主子进程派生后立即以 code 1 崩溃退出。该问题此前在 macOS 上未暴露，是因为 POSIX 绝对路径以 `/` 开头，Node.js 内部能直接识别解析。

## Decision

1. 在 [`desktop/src/runtime.cjs`](../../desktop/src/runtime.cjs) 中实现并导出纯函数 `toNodeImportSpecifier(filePath)`：
   - 采用 `node:url` 的 `pathToFileURL(filePath).href` 将本地文件绝对路径规范化为跨平台安全的 `file://` URL（如 `file:///C:/...`）；
   - 同时自动妥善转义路径中可能包含的空格（如 `Program Files` 编码为 `%20`）及特殊字符。
2. 在 [`desktop/src/main.cjs`](../../desktop/src/main.cjs) 的 `startHost` 中，将待注入的 loader 路径通过 `toNodeImportSpecifier` 转换后再传给 `--import`。
3. 在测试套件中补齐跨平台覆盖：
   - [`desktop/tests/runtime.test.mjs`](../../desktop/tests/runtime.test.mjs)：验证 `toNodeImportSpecifier` 对 Windows 和 POSIX 路径的 URL 转换契约；
   - [`desktop/tests/host-symbol-normalizer.test.mjs`](../../desktop/tests/host-symbol-normalizer.test.mjs)：通过真实的 Node.js 子进程执行 `node --import <fileUrl>` 验证在 Windows 及各平台上加载该 loader 不抛错且能正常启动。

## Alternatives considered

- **直接在 Windows 上禁用 `--import` 注入**：
  - 放弃原因：若在 Windows 上直接跳过 symbol normalizer，会重新触发跨树双实例导致的 `agent-presets: refusing to compose an unscoped context` 缺陷（会话创建与指令无法唤起），破坏跨端一致性。
- **让 loader 保持相对路径**：
  - 放弃原因：子进程的工作目录是用户 `$DSH_HOME`（`~/.dsh`），与应用的安装目录完全独立，无法使用相对路径定位 unpacked loader。

## Consequences

- 彻底修复 Windows 用户安装桌面端后因 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 导致 host 无法启动的致命缺陷。
- 保证 loader 在包含空格的 Windows 路径（如 `C:\Program Files`）下也能安全加载。
- 单元测试与端到端测试均在 Windows 环境下验证通过（`desktop` 测试 14/14 全绿，全仓测试 1064 项全绿）。
