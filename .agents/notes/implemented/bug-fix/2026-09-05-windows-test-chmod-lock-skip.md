# Agent Note: Windows 管线 Test workspace 失败——chmod 只读模拟仅 POSIX 生效

Status: implemented

## Problem

v0.1.2 桌面发版管线首推（tag v0.1.2，run 33948982244）windows-latest 在
`pnpm -r test`（Test workspace 步骤）失败退出 1；同 run macOS 同步骤全绿；
GitHub Release job 因 needs 两路全绿被跳过，无产物无 Release。ci.yml 只有
ubuntu runner，Windows 测试仅 desktop-release 管线执行，故 main 一直无信号。

## Root Cause

本窗口新增的 client-ui-updater（1513b20）用例
"fails and leaves the profile untouched when the packages root is locked"
以 `chmodSync(packagesDir, 0o500)` 模拟锁目录。Windows（NTFS/ACL）不实施
POSIX mode bits 的写位语义，写操作照常成功 → `apply.phase` 永不进入
`error` → `vi.waitFor` 15s 超时 → 用例失败。被测产品路径本身 Windows-aware
（`updater-service.ts` `renameWithRetry` 对 EPERM/EBUSY 有界重试），属
测试模拟手段的平台局限，非产品缺陷。

## Decision

1. 该用例改 `it.skipIf(process.platform === 'win32')` 并注释缘由：chmod
   锁定模拟在 Windows 无 OS 语义对应；Windows 真实锁定路径（文件占用 →
   重试耗尽 → UPDATER error）由 `renameWithRetry` 承载。
2. 遗留缺口（后续项）：补 Windows 真实锁集成用例（open handle 卡 rename），
   需在 Windows runner/真机验证后落地，不在发版窗口内赌无法本地验证的模拟。
3. 同 tag 重推规则适用：GitHub Release 尚未创建 → 修复提交后删远端 tag
   重推 v0.1.2；npm publish 对已存在精确版本幂等跳过，无重发风险。

## Verification

- macOS 本地 updater 包测试全绿（skipIf 在 darwin 不触发，用例真实执行）。
- 全仓 `pnpm test` 复跑全绿；重推 tag 后 Windows job Test workspace 转绿。
