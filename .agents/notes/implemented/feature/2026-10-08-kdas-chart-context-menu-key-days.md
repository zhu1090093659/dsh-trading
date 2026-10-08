# Agent Note: KDAS 关键日图表右键菜单（右键设 Key Day / 删除 Key Day / 未挂载时挂载）

- 日期：2026-10-08
- 状态：已实现（feature）
- 归属：本 note 拥有「KDAS 右键菜单交互与 Key Day 写入契约」；Key Day 数据面本身归属 [weekly-trading-plan 技能资产](../feature/2026-09-13-weekly-trading-plan-skill-and-portable-skill-assets.md) 与 kdas 自定义指标定义（custom.json），本 note 只记录 GUI 操作面的新增约束。

## 背景

KDAS（关键日 Anchored VWAP）的 Key Day 存储就是激活实例参数 kd1..kd8（YYYYMMDD，0=未用，最多 8 条），实际生效值住 symbolParams["<market>:<symbol>"] 覆盖（issue #72 机制，chart.json）。此前增删 Key Day 只能靠 agent 走 indicator_activate 工具或手改参数弹窗逐槽填数字；owner 要求在已启用 KDAS 的标的上，图表右键即可设/删关键日。

## 交互契约（owner 三项裁决，2026-10-08）

1. 满槽（8/8）：菜单项禁用 + title 提示，不静默替换。
2. 菜单形态：右键项（点击锚点柱 → 移除该锚；自由柱 → 设为关键日）+ 底部列出全部 Key Day（带线色圆点）供删（覆盖不在视野内的锚点）。
3. KDAS 未启用：菜单退化为单项「挂载 KDAS」；点击后进入正常增删流程。

## 实现约束（后续改动必须遵守）

- **存储口径 = UTC 日**：写入值取命中 K 线 openTime 的 UTC 日（kdas-menu.ts utcDayNum，与 custom 指标 computeSource 的 dayNum 同源）。港股日 K openTime 落 HKT 零点（= 前一日 16:00Z），轴/菜单标题的**显示**标签走本地日（fmtDay）——两套口径不可混用，否则港股锚点整体偏一天（kdas.py 已记录过同类问题）。锚定命中判定（kdasAnchorSourceDay）也用同源 UTC 口径：点击锚点柱 → 删其存储 kd（kd 可为非交易日，锚定=第一根交易日 >= kd）。
- **始终写 symbolParams 覆盖**：菜单动作经 setIndicatorParams(kdas, params, scopeKey) → host-chart-sync → PUT /chart/indicators（market+symbol），不写全局 params。未挂载时 setParams(scopeKey) 的桥/本地语义即「建实例（全局 schema 默认）+ 写该标的覆盖」，挂载与追加天然合一，不产稀疏参数表（addKdasDay 补齐 kd1..kd8 全 8 键）。
- **守卫**：仅日 K 周期 + 聚焦标的存在 + KDAS 对当前标的可见（visibleInstances 命中）时接管右键；否则浏览器默认菜单。多标签并发 = host-first + SSE 重拉 last-write-wins，与参数弹窗同语义。
- **TvChart 零业务**：TvChart 只加 onBarContextMenu（坐标→逻辑下标，与区间框选同源换算），守卫与动作全在 QuoteStage；满槽判定、锚点幂等（同锚去重 → 点击锚点柱只提供删除）都在 kdas-menu.ts 纯函数（18 例单测，含 clampRectInto）。
- **菜单钳位（2026-10-08 owner 报告右缘残缺后补）**：菜单在 chartBox 内绝对定位，style 的 left/top 是容器坐标；钳位（clampRectInto）必须全程容器系——inner 用 kdasMenu.x/y、outer 用 chartBox 的 clientWidth/Height（原点归零），量测帧 visibility:hidden 渲染（useLayoutEffect 量真实尺寸后 placed 落位）。视口系与容器系混算会让"看似已钳位"的值再叠一次 chartBox 偏移（本 note 验证环节实测踩中：left 954 → 视口 1241 溢出）。

## 文件

- packages/client-ui-trading/src/client/kdas-menu.ts（纯函数：槽位推导/add/remove/锚定命中/UTC 取日）
- packages/client-ui-trading/test/kdas-menu.test.ts
- packages/client-ui-trading/src/client/TvChart.tsx（onBarContextMenu prop）
- packages/client-ui-trading/src/client/QuoteStage.tsx（菜单状态/守卫/动作/渲染）
- packages/client-ui-trading/src/client/contract.ts + locales.ts（kdas.menu.* 词条 zh/en）
- packages/client-ui-trading/src/client/quote-stage.module.css（kdasMenu* 类）

## 验证（commit 89a9c7c0）

- pnpm test（client-ui-trading）：34 文件 275 例全绿（含新增 13 例）。
- tsc tsconfig.client.json：错误计数与基线一致（24，全为存量债），本次改动零新增。
- 后端（indicators/bot-api 桥）零改动：写通道复用 issue #72/#63 既有 PUT /chart/indicators 语义。
- 影子 profile 实机（trading-web-shadow-kdas @3421，独立 headless Chrome + CDP，用后即毁；不触碰运行中的桌面实例）：cn:002714.SZ 日 K 右键弹菜单（标题/设为关键日/底列 4 条带线色 Key Day/4·8 提示）；点「设为关键日 2026-08-17」→ host chart.json 该标的 kd3=20260817 落盘、读数行与图出现第 5 条线；右键锚点柱 → 菜单项变「移除关键日 2026-08-17」→ 点击后 host 归 0、线消失；底列点「2026-10-08 移除」（锚点在视野外）→ host kd7 归 0、线消失。验证产生的数据改动已现场还原原值并核对。
- 右缘钳位复验（修复后同法重建影子环境）：右缘点击（容器系 x=773）菜单 right=1162=chart.right 零溢出；下缘点击（y=662）menuBottom=841 < chartBottom=845；容器中部回归点击落位与原坐标一致（left:413,top:300）。
- 「挂载 KDAS」单项（实例缺席态）未单独实机走查：与已验证的添加路径同代码（kdasAddDay 空参 → setParams(scopeKey) 建实例），由单测覆盖。
