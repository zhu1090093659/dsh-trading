# 移动端（P4 ④）落仓方案

> 本文只写**已验证的事实**与**可执行的下一步**。可行性证据见文末。

## 现状（两条工程并存，2026-10-02）

**A. iOS 原生观测端 —— `apps/ios-native`（本轮落仓）**

- **定位**：交易机器人的**观测端** —— 只读机器人运行状态、持仓/订单/资产、告警与升级；**不做**手动下单面板、
  不做行情终端；权威态在执行核，手机崩溃/断线/锁屏**不得**影响执行。
- **形态**：由 XcodeGen 从 `project.yml` 生成工程，**独立工程、不进 pnpm workspace**（与 desktop/ 同一先例）；
  **一个子目录 = 一个 framework target**（Contract / Transport / Domain / Features / Alerts / Offline / App），
  层间依赖由**编译器**强制；`*.xcodeproj` / `build` / `Generated` 等生成物不入库。
- **契约**：Swift 侧是 `packages/contract/src` 的等价实现，由**机检**绑定 —— 生成器从 TS 契约导出行为向量
  （条数随契约扩展，不写死），`DshTradingContractTests` 逐字段/逐向量断言；CI 侧另有两条**纯 Node** 门禁
  （`scripts/ios-native/check-contract-drift.mjs`、`check-swift-layering.mjs`），不需要 Xcode。
- **已实测**：冷构建 `BUILD SUCCEEDED`（0 error），六个分层 scheme 全绿，契约机检 0 失败，
  故意改错必红、改回必绿。
- **工程细节之家**：[apps/ios-native/README.md](../../apps/ios-native/README.md)（构建命令、冻结符号表、finding、未验证项）。
- **未验证**：真机、APNs/FCM 推送、生物识别设备验证、弱网、沙箱外的 `xcodebuild test`。

**B. Expo/RN 工程 —— `apps/mobile`（2026-10-01 并入 main）**

- **客户端契约面已完成**：设备配对（一次性配对码 → 设备令牌，作用域 `read`/`command`/`control`，**配对永不签发 `control`**）、
  数据源守卫（跨源不混、切换即只读、双源对账）、推送载荷契约、离线陈旧度、深链开放集、确认策略（控制类要求 `biometric`）。
- **工程本体已落仓并入 main**（`f617b964` 起 HEAD 树里有 apps/mobile；分支 feat/p4-mobile-app 是快进合并，
  **无 PR、无审查记录** —— 2026-10-02 验收实测）：apps/mobile 是独立 npm 工程，不进 pnpm workspace。
- **构建已实测**：仓库内骨架跑通 npm install → npx expo install → npx expo prebuild -p ios → xcodebuild
  （Xcode 27.0 / iOS SDK 27.0），结果为 BUILD SUCCEEDED。
- **契约面已接线并带测试**：用例由 CI 的 mobile job 与本地 `cd apps/mobile && npx vitest run` 跑，例数随开发漂移、
  不在此写死（落仓基线：9 文件 / 39 例，`f617b964`）。
- **CI 已接**：ci.yml 的 mobile job 跑 typecheck 与契约测试；**不跑 iOS 构建**。

## 迁移缺口（A 相对 B 还缺什么）

- **设备配对与安全存储**：A 的 Transport 层已有配对/令牌/origin 绑定与 `SecureStore` 协议，
  但 Expo 侧用的 `expo-secure-store` 在原生侧要换 Keychain 实现（协议已在，实现未验）。
- **推送**：A 只有载荷契约与校验闸门（`acceptedPush`），未接 APNs；B 同样未接（只有载荷契约）。
- **真机签名与部署**：两者都只有模拟器/本机证据，真机未验。
- **UI 能力对照**：B 的首屏流程是 RN 组件；A 的观测面是 SwiftUI（五入口 Tab）。两者尚未做同屏对照验收。

## 去留：三种处置的代价（**决定权在人**，本文不代为决定）

| 处置 | 代价 | 收益 | 需要谁决定 |
|---|---|---|---|
| **保留两者并行** | 两份客户端壳长期维护；契约面每次变更要过两套机检；CI 两条 job | 风险最低、不丢已有工作；可先让原生侧跑通真机再收口 | owner（产品定位） |
| **以 A 为准，B 退役** | 需确认 B 没有 A 还不具备的能力（真机签名/推送/生物识别设备验证都未做，所以不是"B 独有"）；退役动作本身需一次性 PR | 单一客户端形态，维护面减半 | owner + 一次退役 PR |
| **以 B 为准，A 退役** | 放弃本轮原生的分层/编译期强制与契约机检；与"观测端只读、不得影响执行"的定位需要重新对齐 | 保留 Expo 的多端能力 | owner（产品定位） |

**本轮不做任何删除**：`apps/mobile/**` 保持原样，A 与 B 并存，去留由人裁决。

## 可行性与工程实测

工具链实测值、构建证据（BUILD SUCCEEDED）与首次引导命令的**家**：
- 原生（A）：[apps/ios-native/README.md](../../apps/ios-native/README.md)
- Expo（B）：[apps/mobile/README.md](../../apps/mobile/README.md)

本节不复述，只保留方案决策。

## 分发方式与代价（需人确认）

| 方式 | 代价 | 说明 |
|---|---|---|
| **本地构建（推荐）** | 0 元；免费凭据 **7 天重签** | 已实测可行；无需任何外部账号 |
| EAS（Expo 云构建） | 需 Expo 账号 | 免本机工具链，但把构建放到第三方 |
| 企业签名 | **299 USD/年** | 对自用过重 |

## 落仓形态（对新建客户端工程仍然有效）

按 AGENTS.md 的交付流分级，**新增客户端工程属"跨多包新功能"**，因此：

1. 从最新 main 开 `feat/<issue号>-<短名>`；
2. 独立工程、**不进 pnpm workspace**；原生目录/工程文件由脚本生成，**生成物不入库**；
3. 只依赖 `@dshtrading/contract` 的契约语义，**不得**依赖 bot 平面的任何运行时包（`plane:check` 会拦）；
4. 复用既有能力：配对流程、`source-guard`、推送载荷、离线陈旧度、生物识别确认闸门；
5. CI 只跑**静态门禁 + 契约测试**，**不跑 iOS 构建**（避免把 macOS runner 绑进日常 CI）；
6. PR 关联 Issue，**至少一个审查批准**后合并 —— 这一步需要人。

## 本地构建命令

- 原生（A）：`cd apps/ios-native && ./scripts/build-simulator.sh`、`./scripts/test-contract.sh`
  （详见 [apps/ios-native/README.md](../../apps/ios-native/README.md)）
- Expo（B）：见 [apps/mobile/README.md](../../apps/mobile/README.md) 的「首次引导」与「实测证据」节

## 未验证项

- 原生（A）：真机、APNs 推送、生物识别设备验证、弱网、沙箱外的 `xcodebuild test` —— 以
  [apps/ios-native/README.md](../../apps/ios-native/README.md) 的清单为准。
- Expo（B）：与 [apps/mobile/README.md](../../apps/mobile/README.md) 的「尚未做」清单同源，以该清单为准。
