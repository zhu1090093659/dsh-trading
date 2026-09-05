# Agent Note: Windows 打包失败——installer.nsh 非法指令 !ifexists 与无 BOM UTF-8 中文

Status: implemented

## Problem

v0.1.2 重推（run 33949476674）Windows job 的 Test workspace 步骤转绿（chmod
skipIf 修复生效），但 **Package desktop app** 步骤失败；macOS 同链路全绿；
GitHub Release job 因 needs 两路全绿继续跳过，7 个预期资产全部 404。CI 匿名
接口拿不到 job 日志，本地无 Windows 环境，按本地最小复现归因。

## Root Cause（本地 makensis + electron-builder 双重复现实证）

本窗口 c846b52 新增 `desktop/resources/installer.nsh`（VC++ redist 检测 +
卸载清理询问），该文件**只被 Windows nsis 目标编译**——此前从未编译过：

1. `!ifexists "..." ` 不是 NSIS 指令（条件编译正确写法是
   `!if /FileExists "path"`）→ makensis `Invalid command: "!ifexists"`
   （makensis 3.12 本地复现，Error in macro customInstall on macroline 12）。
2. 文件是无 BOM UTF-8 且含中文卸载询问文案；GitHub windows-latest 的
   makensis 按 ANSI 代码页读无 BOM 文件，中文即乱码/编码错误。加 UTF-8 BOM
   保证按 UTF-8 解析。
3. `nsis.include: resources/installer.nsh` 的路径基准本应相对 buildResources
   （会解析成 resources/resources/installer.nsh），实际靠 app-builder-lib
   getResource 的 projectDir 回退（`path.resolve(projectDir, custom)`）命中
   `desktop/resources/installer.nsh`——能用但属侥幸路径，后续可改纯文件名。

## Decision

1. `!ifexists` 改 `!if /FileExists`，文件头加 UTF-8 BOM。
2. 验证闭环：makensis 3.12 对仓库文件双分支编译（redist 在场/缺场）全过；
   `npx electron-builder --win nsis zip --x64 --publish never` 在 macOS 本地
   端到端跑通，产出 dsh-trading-desktop-0.1.2-win-x64.exe/.zip——CI 同款命令
   本地复现成功，同 tag 重推（Release 对象两次都未创建，规则允许）。

## Verification

- makensis 双分支编译通过；本地 electron-builder win 打包产物生成。
- 重推 tag 后 windows job Package desktop app 转绿（见新 run）。
