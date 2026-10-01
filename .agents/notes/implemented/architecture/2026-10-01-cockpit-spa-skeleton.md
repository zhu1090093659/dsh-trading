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


## 五块信息架构（同日补，用 SSR 字符串断言验证）

`src/blocks.tsx` 把卡片渲染成四块：**Desk 首页 / 决策动态流 / 持仓与挂单 / 升级收件箱**（加上 `App.tsx` 的控制区共五块）。全部是**纯展示**（输入 `Card[]`、输出 DOM，无取数无副作用）—— 这样"渲染对不对"可以用 `react-dom/server` 的字符串断言直接钉住，**不需要 jsdom**。

落到可执行断言上的四条：

1. **不可操作卡片禁用全部动作**：`operable === false` ⇒ 不渲染任何 `<button>`、`data-operable="false"`、并给出"需要升级客户端"的说明；**但内容与 fallbackText 仍然显示**（用户能看到事实，只是不能操作）。
2. **持仓与挂单块里没有下单入口**（卡片硬要求"不做手动下单面板"）：断言不含买/卖/下单/submit/place 字样、不含 `<form>`。
3. **决策动态流按 revision 倒序**（新的在上），且只收 decision/trigger-trace/escalation —— 断言三段 indexOf 的先后关系，而不是"包含"。
4. **空态明说**（"没有待处理升级"之类）而不是渲染空白 —— 空白会让人以为界面坏了。

控制按钮（pause/resume/kill/flatten）在界面层**再拦一道二次确认**（协议层已要求控制类动作 confirm: true）：确认之后才发 POST /v1/commands，并带 clientRequestId（幂等键）。

测试 7 例（cockpit 包首个测试套件）：新鲜度三档 + 未取数；可操作/不可操作两种渲染；不可操作仍显示内容；首页不混入决策与持仓；动态流倒序且过滤；**持仓块无任何下单入口**；空态文案。


## 截图验证（ui-screenshot-verify）与它抓出的两个真问题

流程按 skill：临时服务（仅回环、跑完即杀）托管 dist + 夹具卡片 → curl 可达性 → headless Chrome 截图（--headless=new --timeout）→ **读图断言**（不是"跑完没报错"）。

    GET /            -> 200 text/html
    GET /v1/cards     -> 200 application/json（8 张夹具卡）
    GET asset        -> 200 text/javascript
    截图 1600x1200 / 112027 字节；读图确认：控制区四个按钮、Desk 两张卡（含"可用动作：知道了"）、
    决策动态 rev 12 → rev 11 倒序、升级卡、**未识别卡片块**（future-card + 兜底文本 + "需要升级客户端"、无按钮）

### 抓出的问题一：界面把"不认识的卡片"丢掉了

协议层做到了"未知枚举的卡片不可操作而**不是丢弃**"，但信息架构按 cardType 分块过滤时把它**在 UI 层丢了** —— 第一版截图里那张 future-card 完全不出现。于是"服务端说了有新东西、客户端装作没有"变成了事实上的静默丢弃：**协议的不丢弃保证必须在渲染层也成立才算数**。修法是新增"未识别卡片"块（任何不在契约 12 个已知类型里的卡片都露出来、强制 operable: false），放在页面**最前面**（需要升级客户端的提示不该埋在底部），并补两条测试（未知卡必须出现且无按钮；没有未知卡时整块不渲染）。

### 抓出的问题二：契约包引了 node:crypto

加上未知卡片块后 vite build 直接失败：

    error during build: ../contract/lib/ids.js (1:9): "randomUUID" is not exported by "__vite-browser-external"

根因：ids.ts 用 node:crypto 的 randomUUID 生成 id，而契约包要**同时被服务端、网页 SPA 与移动 App 引用**（卡片原文）—— 浏览器 bundle 里没有 node:crypto 这个模块。修法是改用 **Web Crypto**（globalThis.crypto.randomUUID）：Node >=19 与所有现代浏览器都有，这条依赖整个消失。**这个错误只有真构建浏览器产物时才会暴露** —— 契约包的 30 条单测（跑在 Node 里）全绿也发现不了。

修后：contract 30 例 ✓、cockpit 9 例 ✓、cockpit 构建 147.75 kB / gzip 48.22 kB ✓。

## 未验证项（如实标注）

- ~~尚无业务内容~~ **五块信息架构已实现**（见下节）；**ui-screenshot-verify 截图仍未做**。
- ~~headless Chrome 渲染验证未做~~ **已做**（见下节），并抓出两个真问题、都已修。
- **A0 在行情与 agent 全挂时仍可用**这条卡片证据未在驾驶舱上复验（P2 有 A0 实现）。
- 首屏预算只有构建期闸门，**没有真实的"慢网首屏时间"测量**。
