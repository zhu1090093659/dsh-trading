# 移动端（P4 ④）落仓方案

> 本文只写**已验证的事实**与**可执行的下一步**。可行性证据见文末。

## 现状

- **客户端契约面已完成**：设备配对（一次性配对码 → 设备令牌，作用域 `read`/`command`/`control`，**配对永不签发 `control`**）、数据源守卫（跨源不混、切换即只读、双源对账）、推送载荷契约、离线陈旧度、深链开放集、确认策略（控制类要求 `biometric`）。
- **工程本体未落仓**：App 尚未创建。

## 可行性（已实测，不是推断）

在本机 Xcode 27 上完整跑通：`create-expo-app`（blank 模板）→ `expo prebuild -p ios` → **CocoaPods 安装** → **`xcodebuild` 真编译成功**。

| 项 | 实测值 |
|---|---|
| Xcode | 27.0（Build 27A266a）|
| iOS SDK | 27.0（`iPhoneSimulator27.0.sdk`）|
| 部署目标 | iOS 16.4（模板默认）|
| CocoaPods | 1.16.2 |
| Expo CLI / SDK | `expo@57.0.26`（CLI 自报 57.0.27）|
| Node | v25.8.1 |
| 构建结果 | `** BUILD SUCCEEDED **`，`BUILD_EXIT=0`，arm64 + x86_64 模拟器 |

## 分发方式与代价（需人确认）

| 方式 | 代价 | 说明 |
|---|---|---|
| **本地构建（推荐）** | 0 元；免费凭据 **7 天重签** | 已实测可行；无需任何外部账号 |
| EAS（Expo 云构建） | 需 Expo 账号 | 免本机工具链，但把构建放到第三方 |
| 企业签名 | **299 USD/年** | 对自用过重 |

## 落仓形态

按 AGENTS.md 的交付流分级，**新增 mobile 工程属"跨多包新功能"**，因此：

1. 从最新 main 开 `feat/<issue号>-mobile-app`；
2. 新建 `apps/mobile`（Expo 工程，`app/` + 原生目录由 `expo prebuild` 生成，**原生目录不入库**，改由脚本生成）；
3. 只依赖 `@dshtrading/contract`（契约面），**不得**依赖 bot 平面的任何运行时包（`plane:check` 会拦）；
4. 复用既有能力：配对流程、`source-guard`、推送载荷、离线陈旧度、生物识别确认闸门；
5. CI 只跑 **typecheck + 契约测试**，**不跑 iOS 构建**（避免把 macOS runner 绑进日常 CI）；iOS 构建脚本留给本地/发布流程；
6. PR 关联 Issue，**至少一个审查批准**后合并 —— 这一步需要人。

## 本地构建命令（已实测）

```bash
cd apps/mobile
npx expo prebuild -p ios          # 生成 ios/（含 pod install）
xcodebuild -workspace ios/*.xcworkspace -scheme <scheme> \
  -sdk iphonesimulator -configuration Debug -derivedDataPath /tmp/dd build
```

## 未验证项（如实标注）

- **真机**（本机只有模拟器构建证据；真机签名与部署未验）；
- 推送（APNs/FCM）只有载荷契约与谓词，**未接真实推送服务**；
- 生物识别只有谓词与确认策略测试，**未在设备上验证**；
- 复杂网络/弱网下的驾驶舱与 App 行为未验。
