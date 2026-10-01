# 驾驶舱 SPA：独立构建产物 + 由 edge 托管（骨架）

日期：2026-10-01 · 阶段：P4 步骤 3（前端一半·骨架）· 卡片：bf92b5d2 · 包：`@dshtrading/cockpit`

## 事实

- **本仓第一个真正的前端工具链**：动工前实测，仓库里没有独立前端应用 —— 没有 `apps/`、根 package.json 里前端相关只有 vitest；出现 react 的地方全是 `packages/client-ui-*/package.json`，而那里 **react 18.2 是 peerDependency**（宿主提供），构建走 tsdown + `tsdown.client.config.mjs`。也就是说既有 `client-ui-*` 是"渲染在宿主 web 壳里的插件"，不是独立 SPA。卡片要求的独立 SPA 因此是新增形态，不是复用。
- **两个与三平面闭包有关的约束（本包的设计立场）**：① SPA **只进 GUI 平面的构建机**，运行时不带 React（bundle 自带）；② **bot 侧只通过 staticDir 指过来、不 import 本包** —— `plane:check` 要求 bot 闭包零 UI-heavy 依赖，P1 实测 bot 54 包 / GUI 195 包（差 141 包 47.2 MB）不能因为驾驶舱吃回去。
- **`base: '/v1/assets/'`**：构建产物里的资源路径直接指向 edge 的静态前缀，而不是站点根；带哈希资源可以被 edge 长缓存，`index.html` 不缓存（`serveStatic` 已按此实现并有测试）。
- **`chunkSizeWarningLimit: 300`** 作为首屏体积预算的第一道闸：超标即构建失败（不是"警告一下继续"）。
- **观测面不依赖 tick 流**（卡片硬要求）：骨架页只有一次卡片拉取 + 手动刷新，没有任何行情订阅；新鲜度用"数据取于 N 秒前"表达。
- **未知枚举的卡片渲染成不可操作态**：协议层已清空 actions，界面如实显示"此卡片需要升级客户端后才能操作"，不猜一个样子。

## 证据（真实输出）

    vite v7.3.6 building client environment for production...
    ✓ 26 modules transformed.
    dist/index.html                  0.34 kB │ gzip:  0.26 kB
    dist/assets/index-DQb-KEuK.js  144.38 kB │ gzip: 46.95 kB
    ✓ built in 239ms

首屏 gzip 46.95 kB（预算 300 kB 未触发）；产物经 `serveStatic` 验证：`index.html` 200 + `text/html` + `no-store`，引用资源 200 + `text/javascript` + `immutable`，`base` 前缀指向 `/v1/assets/` ✓。

## 未验证项（如实标注）

- **尚无业务内容**：本轮只证明"能构建出静态产物 + 产物能被 edge 托管 + 资源路径正确"；卡片要求的五块信息架构（desk 卡首页 / 决策动态流 / 持仓与挂单 / 升级收件箱 / 指令输入 + 控制按钮）与 ui-screenshot-verify 截图**都还没做**。
- **headless Chrome 渲染验证未做**（下一轮：起 edge 托管 dist + 截图）。
- **A0 在行情与 agent 全挂时仍可用**这条卡片证据未在驾驶舱上复验（P2 有 A0 实现）。
- 首屏预算只有构建期闸门，**没有真实的"慢网首屏时间"测量**。
