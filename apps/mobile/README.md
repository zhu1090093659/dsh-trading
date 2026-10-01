# dsh-trading 移动端（P4 ④）

**分发方式：本地构建**（2026-10-01 由人确认）。本目录是**独立 npm 工程**，与 `desktop/` 同一先例 —— **不进 pnpm workspace**，避免 React Native 在 pnpm 硬链接布局下的解析问题。

## 本机工具链（2026-10-01 实测，非推断）

| 项 | 值 |
|---|---|
| Xcode | 27.0（Build 27A266a）|
| iOS SDK | 27.0 |
| CocoaPods | 1.16.2 |
| Node | v25.8.1 |
| Expo CLI / SDK | expo@57.0.26（CLI 自报 57.0.27）|
| 已验证 | create-expo-app → expo prebuild -p ios → CocoaPods 安装 → **xcodebuild 真编译 `BUILD SUCCEEDED`**（arm64 + x86_64 模拟器）|

## 首次引导（按序执行）

```bash
cd apps/mobile
npm install
npx expo install react react-native expo-status-bar   # 版本由 Expo SDK 钉定，别手写
npx expo prebuild -p ios                                 # 生成 ios/（含 pod install）
npm run build:ios:sim                                    # 模拟器真编译
```

`ios/` 与 `android/` **不入库**（.gitignore 已排除）：原生目录由 `prebuild` 生成，避免把生成物当作源码维护。

## 尚未做（如实标注，不假装）

- **契约面接线**：设备配对流程、数据源守卫（跨源不混 / 切换即只读）、推送载荷、离线陈旧度、生物识别确认闸门 —— 这些能力在 `@dshtrading/contract` 已就绪，但本 App 还没接；
- **真机**：只有模拟器构建证据；真机签名与部署未验；
- **推送服务**：APNs/FCM 未接（只有载荷契约）；
- **生物识别**：未在设备上验证；
- **弱网**：未验。

## 与主仓的关系

- 只依赖契约包（**不得**依赖 bot 平面运行时包；`pnpm plane:check` 会拦 bot 闭包，本包不在其闭包内）；
- CI 只跑 typecheck 与契约测试，**不跑 iOS 构建**（避免把 macOS runner 绑进日常 CI）；iOS 构建留给本地/发布流程。

## 实测证据：仓库内骨架真编译通过（2026-10-01）

不是 blank 模板 —— 编译的是**本目录里这份骨架**（App.tsx / app.json / package.json 均为本仓所有）：

    NPM_INSTALL_EXIT=0
    EXPO_INSTALL_EXIT=0
    PREBUILD_EXIT=0
    ** BUILD SUCCEEDED **
    BUILD_EXIT=0

命令序列：npm install → npx expo install react react-native expo-status-bar → npx expo prebuild -p ios → npm run build:ios:sim（xcodebuild，模拟器，Xcode 27.0 / iOS SDK 27.0）。完整日志：/tmp/mobile-build.log（临时文件，重建方式即上面四条命令）。

提醒：ios/ 与 android/ 是 prebuild 生成物、不入库；换机器重建只需按「首次引导」四步。
