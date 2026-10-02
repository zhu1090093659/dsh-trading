# Agent Note: 移动端客户端（iOS 原生观测端）与契约包的客户端入口

Status: implemented

## Problem

交易机器人的客户端有网页驾驶舱与移动端两种形态。移动端要复用服务端的契约面（版本协商、数据源守卫、
推送载荷、离线陈旧度、确认策略、深链开放集），但直接照搬会遇到四件事：

1. **契约包不能整体在客户端用**：`ids.ts` 调 `globalThis.crypto.randomUUID()`，而当时计划采用的
   Hermes（React Native 的 JS 引擎）默认没有 WebCrypto —— 客户端引到 id 工厂会在运行时炸；
2. **工程形态冲突**：RN 在 pnpm 硬链接布局下解析不稳，而本仓是 pnpm workspace；
3. **分发方式需要决定**：上架还是本地构建；
4. **产品定位需要决定**：移动端是「辅助交易的手机版」还是「交易机器人的观测端」。前者要下单面板，
   后者只读机器人状态并**不得**影响执行；两种定位对失败面、权限面与 UI 的要求完全不同。

## 决策

- **移动端 = 交易机器人的 iOS 原生（SwiftUI）观测端**，落在 `apps/ios-native/`：
  XcodeGen 从 `project.yml` 生成工程，**独立工程、不进 pnpm workspace**（与 `desktop/`、`apps/mobile` 同一先例），
  生成物（`.xcodeproj` / `build` / `Generated`）不入库。**一个子目录 = 一个 framework target**
  （Contract / Transport / Domain / Features / Alerts / Offline / App），层间依赖由**编译器**强制。
  工程细节、构建命令与冻结符号表之家是 [apps/ios-native/README.md](../../../../apps/ios-native/README.md)。
- **契约实现方式**：`packages/contract/src` 的 TS 是**唯一权威**，Swift 侧是等价实现，
  两边由**机检**绑定：`apps/ios-native/scripts/gen-contract-snapshot.mjs` 从 TS 运行期真值导出
  常量、封闭枚举与**行为向量**（条数由生成器从 TS 契约导出，随契约扩展，不写死）；
  `DshTradingContractTests`（macOS 逻辑测试）逐字段比对并逐条重放，重放入口见 [apps/ios-native/README.md](../../../../apps/ios-native/README.md)。
  纯 Node 的 `scripts/ios-native/check-contract-drift.mjs` 把同一批判据带进 CI（不需要 Xcode）。
- **契约包的客户端入口仍然保留**：`@dshtrading/contract/core` 导出
  version/scopes/cards/push/confirm/offline/source-guard 且**排除 `ids.ts`**（RN 与任何 JS 客户端可用）；
  边界由 `packages/contract/test/core-entry.test.ts` 沿相对导入走图谱守住。
- **分发取本地构建**（owner 2026-10-01 确认）：不依赖任何外部账号。
- **CI 只跑静态门禁与契约测试，不跑 iOS 构建**（不把 macOS runner 绑进日常 CI）；
  iOS 构建与 Swift 断言留在本机/发布流程。

## 事实与证据

- 本机工具链：Xcode 27.0（27A266a）/ iOS SDK 27.0 / Swift 6.4 / XcodeGen 2.45.3（2026-10-02 实测）。
- `apps/ios-native` 冷构建 `xcodebuild -scheme DshTradingNative -sdk iphonesimulator build` ⇒
  **BUILD SUCCEEDED**（0 error）；六个分层 scheme 全部 BUILD SUCCEEDED（2026-10-02 实测）。
- 契约机检全绿；**故意改错必红**：让 `grantableByDefault` 放行 control、把 `cardLimits.maxFields` 从 24 改成 25，
  断言都会变红；改回后全绿且源文件逐字节还原（2026-10-02 实测）。红/绿证据与重放命令见
  apps/ios-native/README.md 的"契约防漂移机检"一节。
- `scripts/ios-native/check-contract-drift.mjs` 与 `check-swift-layering.mjs` 同样验证过「改错必红」（同上日期）。
- `apps/mobile`（Expo/RN）的落仓事实与工程实测之家是 [docs/client/mobile-app-plan.md](../../../../docs/client/mobile-app-plan.md)。

## 被否决 / 已知边界

- **不把 `ids.ts` 复制一份给客户端**：那会让「哪些 id 可见」有两个家；客户端本就不该发号。
- **不在客户端放默认值吞掉未知封闭枚举**：未知 cardType / fieldKind / actionKind 一律渲染为**不可操作**
  （禁用全部 Action、只显示 fallbackText）；未知动作按**最高档**（control + biometric）处理。
- **`ids.ts` 与 `node:crypto` 无关**（初版注释曾写错）：全 src 零 `node:` import，真正的客户端障碍是 WebCrypto 缺席。
- **契约缺口（只报告，不改服务端）**：
  - `cards.ts` 注释说未知 cardType 仍 `valid=true`，代码实际 `valid=false`（注释与代码不一致）；
  - `field.key` 未冻结（仓内只有夹具用过 `level`），服务端应冻结每张卡的 key；
  - 资产没有独立卡片类型；成交/资金变动/事件/订单 `stateSince`/等待原因在卡片面与 A0 面都拿不到；
  - **`ids.ts` 的 `isOrderId` 把 UUID 版本位钉成 v4**（`4[0-9a-f]{3}` + 变体位 `[89ab]`），
    与设计文档明文冻结的「不钉版本位（`[0-9a-f]{4}`）」冲突。
- **未验证**：真机、APNs/FCM 推送、生物识别设备验证、弱网、沙箱外的 `xcodebuild test`
  （本机沙箱会挡 xctest 的伪终端，用 `build-for-testing` + `xcrun xctest` 绕过）。
