# 移动端（P4 ④）落仓方案

> 本文只写**已验证的事实**与**可执行的下一步**。可行性证据见文末。

## 现状

- **客户端契约面已完成**：设备配对（一次性配对码 → 设备令牌，作用域 `read`/`command`/`control`，**配对永不签发 `control`**）、数据源守卫（跨源不混、切换即只读、双源对账）、推送载荷契约、离线陈旧度、深链开放集、确认策略（控制类要求 `biometric`）。
- **工程本体已落仓并入 main**（`f617b964` 起 HEAD 树里有 apps/mobile；分支 feat/p4-mobile-app 是快进合并，**无 PR、无审查记录** —— 2026-10-02 验收实测）：apps/mobile 是独立 npm 工程，不进 pnpm workspace（与 desktop/ 同一先例）。
- **构建已实测**：仓库内骨架跑通 npm install → npx expo install → npx expo prebuild -p ios → xcodebuild（Xcode 27.0 / iOS SDK 27.0），结果为 BUILD SUCCEEDED。
- **契约面已接线并带测试**：apps/mobile 的用例由 CI 的 mobile job 与本地 `cd apps/mobile && npx vitest run` 跑，例数随开发漂移、不在此写死（落仓基线：9 文件 / 39 例，`f617b964`）—— 覆盖版本与能力协商、设备配对（真 HTTP 服务器，5 例）、凭据安全存储（fail closed）、带令牌的 /v1 客户端（含跨源拒绝）、数据源守卫、离线陈旧度（过期不渲染）、动作确认闸门（未知动作 fail closed）、推送处理（非法载荷与外部深链一律 drop）、客户端流水（配对成功才落库）。
- **CI 已接**：ci.yml 的 mobile job 跑 typecheck 与契约测试；**不跑 iOS 构建**（需 macOS runner，留给本地/发布流程）。
- **未落地**：真机验收、推送服务（APNs/FCM）、生物识别设备验证、弱网。（交付流要求见下文「落仓形态」；本次实际合并未走 PR 与审查 —— 2026-10-02 验收实测。）

## 可行性与工程实测

工具链实测值、构建证据（BUILD SUCCEEDED）与首次引导命令的**家是 [apps/mobile/README.md](../../apps/mobile/README.md)**；本节不再复述，只保留方案决策。

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

## 本地构建命令

见 [apps/mobile/README.md](../../apps/mobile/README.md) 的「首次引导」与「实测证据」节（家在工程目录，不在此复制）。

## 未验证项

与 apps/mobile/README.md 的「尚未做」清单同源，**以该清单为准**（真机、推送服务、生物识别、弱网均未验）；本节不另立副本。
