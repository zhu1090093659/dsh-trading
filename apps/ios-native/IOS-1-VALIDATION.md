# IOS-1 验证记录

本记录只描述 session-8d8bca7f-b4b7-47ab-ac10-1a74c017c388 本次工具运行观察到的事实，不代表最终验收通过。基线 HEAD：cf8db39ef58315722d548c04423e4f7f6f882707；工作区存在并发修改。

## 工程与写作用域

工程源是 project.yml，XcodeGen 生成 xcodeproj；独立于 pnpm workspace。Sources/Contract 是共享契约唯一消费面，不移植 ids.ts。Transport、Domain、Features、Alerts、Offline 各自 Sources/<Area>/** 与 Tests/<Area>Tests/** 由对应子卡认领；共享契约与 project.yml 的修改需要冻结面负责人协调。

冻结符号包括 ApiContract、VersionVerdict、parseCaps、formatCaps、negotiateVersion；ScopePlane 与 grantableByDefault；CardType/FieldKind/ActionKind、Card/CardVerdict、validateCard/renderableActions；ConfirmLevel/actionConfirm/confirmLevel/scopeForAction；PushPayload/validatePushPayload/acceptedPush；OfflineSnapshot/StalenessBudget/offlineView/parseDeeplink；SourcedDatum/SourceGuard/ReconcileReport。TS packages/contract/src/core.ts 是唯一权威入口。未知动作最高档并不授予执行权；未知卡片禁止操作。

## 复现命令

```bash
cd apps/ios-native
bash scripts/build-simulator.sh
bash scripts/test-contract.sh
```

测试快照由 gen-contract-snapshot.mjs 动态导出 TS 常量、枚举、映射与行为向量；ContractDriftTests/ContractVectorTests/ContractParityTests 对 Swift 同批源文件作断言。不能仅凭编译成功或退出码判断断言通过。

## 本次真实结果

1. 首次契约测试退出 65：ContractSmokeTests 引用旧 ContractVersion.apiMajor。该引用已经修成 ApiContract.major。
2. 修复后 xcodebuild test 退出 65：Pseudo Terminal Setup Error，Underlying Error: Operation not permitted；没有获得 XCTest 运行断言通过证据。日志 build/contract-test-round2.log。
3. 模拟器构建退出 65，BUILD FAILED：Domain/DeskObservation.swift 的 ObservationMacros.ObservableMacro，swift-plugin-server produced malformed response。日志 build/simulator-build-round2.log。不能将此解释为 BUILD SUCCEEDED。
4. git check-ignore 确认 build/、Generated/、DshTradingNative.xcodeproj 内产物被忽略。

## 未完成交接

缺少 BUILD SUCCEEDED、防漂移故意改错后断言失败及恢复全绿的证据；完整验收仍未完成。脚本与测试在执行过程中有并发写入，不在未经协调时重复改写或运行重活。需 Lead 统一验证执行窗口，并把长期工程事实同步到既有移动端 Owning Note；本卡不越范围修改 .agents/notes。
