# 移动端（P4 ④）落仓方案

> 本文只写**已验证的事实**与**可执行的下一步**。可行性证据见文末。

## 现状（单一客户端：iOS 原生，2026-10-02）

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

**B. Expo/RN 工程 —— `apps/mobile`（已退役，owner 2026-10-02 决定）**

- **处置**：以 iOS 原生（A）为准，Expo/RN 工程退役；`apps/mobile/**` 已于 2026-10-02 用 `git rm -r` 删除
  （历史保留在删除前的提交里），ci.yml 的 mobile job 一并移除。
- **退役理由**：A 已具备 B 的契约面能力，且多出编译期分层强制与契约防漂移机检；B 没有 A 还不具备的能力
  （真机签名/推送/生物识别设备验证两侧都未做，不是 B 独有）。裁决见
  [Owning Note](../../.agents/notes/implemented/architecture/2026-10-01-mobile-app-and-contract-core-entry.md)。
- **工程操作与实测证据**：退役后不再有 `apps/mobile/README.md`；历史工程实测（工具链表、首次引导命令）
  只留在这批删除前的提交历史里，不再维护。

## 迁移缺口（客户端整体还缺什么）

Expo/RN 旧工程（B）已退役，不再构成“迁移”对象；下列是**客户端整体**的未交付项：

- **设备配对与安全存储**：Transport 层已有配对/令牌/origin 绑定与 `SecureStore` 协议，
  Keychain 实现尚未在设备上验证。
- **推送**：只有载荷契约与校验闸门（`acceptedPush`），未接 APNs。
- **真机签名与部署**：只有模拟器/本机证据，真机未验。
- **UI 能力对照**：观测面是 SwiftUI（五入口 Tab）；旧 RN 首屏流程已随工程退役，不再作为对照对象。

## 去留裁决（owner 2026-10-02）

以 **A（iOS 原生）为准，B（Expo/RN）退役**，已执行：`apps/mobile/**` 用 `git rm -r` 删除，ci.yml 不再有 mobile job。

裁决要点（曾评估三种处置）：

| 处置 | 代价 | 收益 |
|---|---|---|
| 保留两者并行 | 两份客户端壳长期维护；契约面每次变更要过两套机检；CI 两条 job | 风险最低、不丢已有工作 |
| **以 A 为准，B 退役（已选）** | 需确认 B 没有 A 还不具备的能力 —— 真机签名/推送/生物识别设备验证两侧都未做，不是 B 独有 | 单一客户端形态，维护面减半 |
| 以 B 为准，A 退役 | 放弃原生分层/编译期强制与契约机检；与“观测端只读、不得影响执行”的定位需重新对齐 | 保留 Expo 的多端能力 |

**删除不可逆**：执行前已在当前 HEAD 现场验过 A 可构建（`BUILD SUCCEEDED`），确认存在可用替代客户端后才删。

## 可行性与工程实测

工具链实测值、构建证据（BUILD SUCCEEDED）与构建/测试命令的**家**：
[apps/ios-native/README.md](../../apps/ios-native/README.md)（退役的 Expo 工程不再有家，其历史实测只留提交历史）。

本节不复述，只保留方案决策。

## 分发方式与代价（已定：本地构建）

| 方式 | 代价 | 说明 |
|---|---|---|
| **本地构建（推荐）** | 0 元；免费凭据 **7 天重签** | 已实测可行；无需任何外部账号 |
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

## 未验证项

- 真机、APNs 推送、生物识别设备验证、弱网、沙箱外的 `xcodebuild test` —— 以
  [apps/ios-native/README.md](../../apps/ios-native/README.md) 的清单为准。
