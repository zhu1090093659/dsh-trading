# IOS-1 冻结面复核与交接

Status: implemented

## Problem

工程脚本等待重活锁超时后仍继续构建，且按 15 分钟年龄删除锁，不能保证共享工作区重活串行。现场发现其它调用者持有同一锁再调用测试脚本，造成嵌套等待。

## Decision

构建与契约测试脚本使用原子 mkdir 取锁。竞争时立即退出 75，并打印 HEAVY_LOCK_BUSY；不等待、不按年龄删除锁、不无锁继续。只有成功取得锁的脚本安装退出清理。调用者不得再包同一把锁。

冻结面及各目录写作用域见 [README](README.md) 与 [接口冻结件](INTERFACE-FREEZE.md)。本轮不变更共享 Swift API，不修改 TS 权威契约，不覆盖其它会话的 Alerts/Domain/Features/Offline 实现。

## Alternatives considered

保留等待并按年龄破锁被否决：长构建仍可能活跃，年龄不能证明锁失效。允许外部锁持有者以环境变量跳过取锁被否决：客户端无法可靠验证调用者确实拥有锁。

## Consequences

验收基线 HEAD e22d2704bb815defd79bc6e85b2c8ce3ff48bde9，共享工作区另有并发改动。本轮现场确认 Xcode 27.0 (27A266a)、iOS SDK 27.0、XcodeGen 2.45.3。测试入口返回 75 / HEAVY_LOCK_BUSY；未取得新的构建成功或突变红绿证据。原测试等待作业 bash-254 已取消并收集。

Lead 需要协调所有外部锁持有者与等待者，释放锁后直接（不加外层同名锁）串行运行 scripts/test-contract.sh 与 scripts/build-simulator.sh，并重新做故意改错、红、恢复、绿验证。不可把 README 中历史证据当作本轮通过。

静态发现待裁决的等价边界：Swift PushPayload 的 revision/expiresInMs 使用 Int，而 TS 允许有限的小数；推送字符串上限现使用 utf16.count 与 TS length 一致，并新增 15 条 TS 推送校验向量（含 emoji 边界），断言合法性及完整诊断。卡片其它字符串计量与数值小数差异仍待裁决。新增断言尚待串行执行。不自行放宽契约；需要 Lead 明确冻结处理并补向量。
