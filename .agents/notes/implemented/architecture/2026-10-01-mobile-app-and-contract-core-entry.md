# Agent Note: 移动端 App（本地构建）与契约包的客户端入口

Status: implemented（当前在 feat/p4-mobile-app 分支，未并入 main）

## Problem

P4 要求客户端有网页驾驶舱与移动 App 两种形态。移动端要复用服务端已有的契约面（版本协商、
数据源守卫、推送载荷、离线陈旧度、确认策略、深链开放集），但直接照搬服务端写法会遇到三件事：

1. **契约包不能整体在 React Native 里用**：ids.ts 调 globalThis.crypto.randomUUID()，
   而 Hermes（RN 的 JS 引擎）默认没有 WebCrypto —— 客户端引到 id 工厂会在运行时炸；
2. **工程形态冲突**：RN 在 pnpm 硬链接布局下解析不稳，而本仓是 pnpm workspace；
3. **分发方式需要决定**：上架（开发者账号、审核、商店税）还是本地构建。

## 决策

- **apps/mobile 是独立 npm 工程，不进 pnpm workspace**，与既有 desktop/ 同一先例
  （desktop/ 已是独立 npm 工程并有自己的 test:desktop）。
- **契约包新增客户端入口 ./core**（导出 version/scopes/cards/push/confirm/offline/source-guard，
  **排除 ids.ts**）；构建入口同步加入 src/core.ts，package.json 增 "./core" 导出
  （含 import 与 types 条件）。边界由 packages/contract/test/core-entry.test.ts 守住：
  沿相对导入走图谱，断言该入口可达的源码**没有真正的 node: import**、且不含 ids.ts。
- **分发取本地构建**（owner 2026-10-01 确认）：App 依赖 file:../../packages/contract
  链接契约包；ios/、android/ 由 expo prebuild 生成、不入库。
- **CI 只跑 typecheck 与契约测试**（ci.yml 的 mobile job），**不跑 iOS 构建** —— 不把
  macOS runner 绑进日常 CI；iOS 构建留给本地与发布流程。

## 事实与证据

- 本机 Xcode 27.0 / iOS SDK 27.0 / CocoaPods 1.16.2；仓库内骨架跑通
  npm install → npx expo install → npx expo prebuild -p ios → xcodebuild，
  输出 BUILD SUCCEEDED（xcodebuild 自报）。
- App 侧 **39 例测试**全绿（版本协商、设备配对、凭据安全存储、带令牌的 /v1 客户端、
  数据源守卫、离线陈旧度、动作确认闸门、推送处理、客户端流水）。
- 依赖版本由 Expo SDK 决定（react-native 0.86.3，而非 npm 上的 latest），**不手写版本**。

## 被否决 / 已知边界

- **不把 ids.ts 复制一份给客户端**：那会让"哪些 id 可见"有两个家；客户端本就不该发号。
- **ids.ts 与 node:crypto 无关**（初版注释曾写错）：全 src 零 node: import，真正的客户端
  障碍是 WebCrypto 缺席。
- 未验证：真机、推送服务（APNs/FCM）、生物识别设备验证、弱网。
