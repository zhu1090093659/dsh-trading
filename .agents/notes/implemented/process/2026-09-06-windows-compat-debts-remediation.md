# Windows 兼容遗留项整改——.gitattributes 强制 LF、ci 加 windows 矩阵、nsis.include 去侥幸回退

- **日期**: 2026-09-06
- **状态**: implemented

## Problem

2026-09-06 的 Windows 兼容性盘点（会话调查结论）确认桌面安装包已可独立运行、
CI 实证全绿，但存在四类遗留债：

1. **仓库无 `.gitattributes`**——CRLF 是整类地雷而非已根治：v0.1.4 的
   bundle preset 行定位事故（见同日 bug-fix note）只做了代码级
   `replace(/\r\n/g, '\n')` 归一，今后任何新代码再对检出的 asset 做
   LF 锚定搜索，Windows runner（autocrlf）上必然复发。
2. **Windows 测试只在发版窗口跑**——ci.yml 仅 ubuntu runner，Windows 信号
   只出现在推 tag 时：v0.1.2（chmod 语义、installer.nsh 编码）与
   v0.1.4（CRLF 行定位）两次故障都是发版当天才暴露、靠删 tag 重推救回。
3. **nsis.include 侥幸路径**——`include: resources/installer.nsh` 的主解析
   必失（buildResources 相对拼接成 `resources/resources/installer.nsh`），
   一直靠 app-builder-lib `getResource` 的 projectDir 回退命中
   （2026-09-05 windows-nsis-ifexists-and-encoding note 自标的遗留项）。
4. **未验证项**：Windows 真实文件占用的 updater 锁集成测试未补（同 note
   后续项）。

## Decision

1. **根级 `.gitattributes` 统一 LF**：
   - `* text=auto eol=lf`——所有文本文件在所有平台检出恒为 LF，根除
     autocrlf 检出差异；
   - `spikes/** -text`——spikes 下的原始响应证据（headers/body/html）
     字节保真，绝不做行尾转换（现网 18 个 i/crlf 文件全在此目录，
     归一等于篡改证据）；
   - `*.bat` / `*.cmd` 例外 CRLF（Windows 命令解释器消费）。
   - 实施核验：索引内除 spikes 外全部本就是 `i/lf`，加属性后
     `git status` 零扰动，无需 renormalize 提交。
2. **ci.yml 加 windows-latest 矩阵项**：`include` 矩阵 = ubuntu×(node 22,24)
   + windows×(node 22)，Windows entry 与 desktop-release 管线同源
   （`pnpm install --frozen-lockfile` + `pnpm -r build` + `pnpm -r test`）。
   typecheck-gate 与 i18n 门禁是平台无关的 lint 级闸门，ubuntu 双节点已
   覆盖，Windows 不重复跑以控时长（`if: matrix.os == 'ubuntu-latest'`）。
   node 钉 22 与发版管线 setup-node 一致。
3. **electron-builder.yml `nsis.include` 改纯文件名 `installer.nsh`**：
   app-builder-lib `getResource(custom, "installer.nsh")` 对非空 custom 的
   解析顺序 = buildResources 目录清单命中 → `resolve(resourcesDir, custom)`
   → `resolve(projectDir, custom)` → 抛错。纯文件名走第一主路径确定性命中
   `desktop/resources/installer.nsh`；且今后路径写错会立即抛
   InvalidConfigurationError 而非静默侥幸。

## Verification

- `.gitattributes`：`git ls-files --eol` 确认 spikes 显示 `attr/-text` 且
  内容保持 `i/crlf` 原样；加属性后 `git status` 无任何行尾引起的改动。
- `nsis.include`：本地 macOS 交叉构建
  `npx electron-builder --win nsis --x64 --publish never` 完整通过，产出
  `dsh-trading-desktop-0.1.4-win-x64.exe`（getResource 找不到文件会直接
  抛 InvalidConfigurationError，构建通过即证明主路径解析命中）。
- ci.yml 矩阵：提交 push 后首个 ci run 即含 windows-latest job，以该 run
  全绿为最终验收（见本 note 收尾时的 run 记录）。

## Consequences

- Windows 专属故障的暴露点从「发版窗口」前移到「每个 push/PR」，
  删 tag 重推的发版救火模式不再为 CI 盲区买单。
- 新增代码若再依赖「Windows 检出为 CRLF」的前提会直接失效——这正是目的，
  仓库从契约上锁死 LF。
- `desktop/dist` 本地产物由本次交叉构建刷新为 0.1.4-win-x64（含新
  installer.nsh 解析路径）。

## 遗留（明确不在本轮处理）

- **Windows arm64 构建**：产品级决策（fetch-node TARGETS、builder 矩阵、
  verify-toolchain 均需扩），成本是每版 +一份产物与构建时长，待用户拍板。
- **代码签名**：需付费证书，维持未签名 + 安装引导（release-preamble）现状。
- **Windows 真实锁集成测试**：Node/libuv 打开的句柄自带
  FILE_SHARE_DELETE，纯 JS 无法可靠模拟文件占用锁；windows 矩阵落地后
  具备了真实验证位，待后续窗口补。
