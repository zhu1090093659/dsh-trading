# dsh-trading Skill 架构与接入指南

> **知识与代码分离**（铁律 #2）：市场规则、定性分析框架、风控检查清单与交易策略必须沉淀为 Skill，而不是硬编码在插件/连接器代码中。

本指南为 `dsh-trading` 生态中 **Skill（Agent 领域知识与策略 SOP）** 的唯一权威规范。它规定了 Skill 的存储组织、命名空间、加载优先级、编写模板以及外部社区 Skill（如 OKX Agent Trade Kit 等）的引入标准。

---

## 🌟 核心原则：单一事实来源（SSOT）

在 Agent 协作与生产运行中，Skill 遵循 **“单一源头，自动分发”** 原则：

```
                    ┌────────────────────────────────────────────────────────┐
                    │          .agents/skills/<name>/SKILL.md (唯一标准源)    │
                    │   所有 Agent (Claude/Cursor/DSH/Antigravity) 自动加载   │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
                                 scripts/sync-skills.mjs (构建同步)
                                               │
                                               ▼
                    ┌────────────────────────────────────────────────────────┐
                    │            packages/kit-*/assets/skills/               │
                    │   (作为 npm 静态资源打包，供独立安装包无源码运行)        │
                    └────────────────────────────────────────────────────────┘
```

1. **`.agents/skills/` 为唯一标准源**：所有官方内置、社区引入与本地开发的 Skill，均在此目录下以独立文件夹形式存在。任何标准 Coding Agent 或 IDE 插件开箱即可自动发现与调用。
2. **连接器（Connector）与工具箱（Kit）各司其职**：
   - **连接器 (`packages/connector-*`)**：只提供**原子 API 与工具**（如 `crypto_get_klines`, `crypto_place_order`, `okx_get_smartmoney`），**绝不内嵌长文本 Prompt 或策略分析流程**。
   - **工具箱 (`packages/kit-*`)**：提供市场级公共辅助工具，并通过 `@deepseek-ai/dsh-skill` 的 `SkillProvider` 随包分发内置 Skill。
3. **包分发资产自动同步**：开发者只在 `.agents/skills/` 下维护 Skill，构建时运行 `node scripts/sync-skills.mjs` 自动同步至各 `packages/kit-*/assets/skills/`。

---

## 🏛️ 三层体系与加载优先级（Rank Hierarchy）

基于 `@deepseek-ai/dsh-skill` 机制，Skill 按优先级分层，支持用户无侵入覆盖：

| 层级 (Level) | 适用场景 | 存放物理路径 | 优先级 (Rank) | 覆盖规则 |
|---|---|---|---|---|
| **Level 1: 用户自定义 (User Custom)** | 用户私有交易策略、个人风控偏好、自定义参数 | `~/.dsh/skills/`<br>或当前工作区 `.agents/skills/` | **Rank 100-300** | **最高优先级**：同名配置自动覆盖社区与内置版本 |
| **Level 2: 社区精选 (Community)** | 来自 OKX Tradekit、开源社区的策略或指标分析 | `~/.dsh/profiles/<name>/skills/`<br>或 `.agents/skills/<market>-*` | **Rank 400-500** | 中等优先级：覆盖官方内置版本 |
| **Level 3: 官方内置 (Bundled in Kit)** | 随包发布的风控清单、多周期定性分析等基准 SOP | `packages/kit-<market>/assets/skills/` | **Rank 600** (`BUNDLED_SKILL_RANK`) | 兜底基线：提供基础交易能力保证 |

---

## 📁 目录与文件组织规范

`.agents/skills/` 下统一遵循 **“一 Skill 一目录，入口固定为 `SKILL.md`”**：

```
.agents/skills/
├── crypto-risk-checklist/             ← 加密合约风控清单
│   └── SKILL.md
├── crypto-instrument-analysis/        ← 标的五步定性分析框架
│   └── SKILL.md
├── us-risk-checklist/                 ← 美股风控清单
│   └── SKILL.md
├── cn-risk-checklist/                 ← A 股风控清单
│   └── SKILL.md
├── hk-risk-checklist/                 ← 港股风控清单
│   └── SKILL.md
│
├── crypto-trading-plan/               ← 社区/引入：交易计划生成器
│   └── SKILL.md
├── crypto-okx-smartmoney/             ← 社区/引入：OKX 聪明钱与牛人榜分析
│   └── SKILL.md
│
└── my-custom-alpha/                   ← 用户私有策略
    └── SKILL.md
```

---

## 🏷️ 命名空间与前缀规则

为防止不同市场、不同来源的 Skill 发生冲突，目录名必须采用严格的前缀命名：

```
<前缀>-<业务主题>
```

| 命名模式 | 适用范围 | 示例 | 说明 |
|---|---|---|---|
| `crypto-*` | 加密市场通用策略/分析 | `crypto-risk-checklist`<br>`crypto-trading-plan`<br>`crypto-position-sizer` | 跨交易所通用（Binance / OKX / Bybit 皆可触发） |
| `us-*` | 美股市场通用策略/分析 | `us-risk-checklist`<br>`us-earnings-gap-playbook` | 适用于美股标的与交易环境 |
| `cn-*` | A 股市场通用策略/分析 | `cn-risk-checklist`<br>`cn-limit-up-break` | 涵盖 T+1、涨跌停、两融等制度特性 |
| `hk-*` | 港股市场通用策略/分析 | `hk-risk-checklist`<br>`hk-warrant-cbbc-flow` | 涵盖涡轮牛熊证、碎股、汇率等特性 |
| `trading-*` / `risk-*` | 全市场通用方法论 | `trading-journal-review`<br>`risk-kelly-criterion` | 跨所有市场与资产类别的通用分析工具 |
| `<market>-<exchange>-*` | 平台专有特化功能 | `crypto-okx-smartmoney`<br>`crypto-okx-bot-grid`<br>`hk-futu-lv2-flow` | 依赖特定交易所 API/工具的分析 SOP |

---

## 📝 标准 SKILL.md 编写模板（SOP 五段论）

每个 Skill 必须包含完整的 YAML Frontmatter 元数据与清晰的五段式正文：

````markdown
---
name: crypto-trading-plan
description: 加密资产交易计划生成器：当用户询问交易计划、入场/止损/止盈点位规划、风险收益比计算时使用。输出保守/稳健/激进三档方案。
---

# 加密资产交易计划生成指南 (crypto-trading-plan)

## 1. 目标与适用范围 (Goal & Scope)
- **适用场景**：开仓前的完整交易计划制定（现货 / 永续合约）。
- **非适用场景**：单纯查询实时价格（使用 `crypto_get_ticker`）或直接执行下单（使用 `crypto_place_order`）。

## 2. 前置数据收集与依赖工具 (Prerequisites & Tools)
在输出计划前，必须依次调用以下工具收集客观盘面事实（禁止无数据凭空推测）：
1. `crypto_get_klines`：提取日线（1d）与 4 小时（4h）关键支撑位/阻力位；
2. `crypto_funding_rate` / `crypto_get_derivatives`：核查多空持仓比与资金费率；
3. `crypto_get_news`：确认 24h 内无重大利空/利好突发事件。

## 3. 分析与决策流程 (Step-by-Step SOP)
1. **趋势与结构判定**：定位当前价格区间与最近的流动性密集区。
2. **多空关键位测算**：寻找前高/前低、EMA 均线支撑或布林带上下轨。
3. **三档方案生成**：
   - 保守方案：等待二次回踩确认，盈亏比 $\ge 3:1$；
   - 稳健方案：关键突破/假跌破收回入场，盈亏比 $\ge 2:1$；
   - 激进方案：左侧挂单，小仓位紧密止损。

## 4. 输出格式契约 (Output Format Contract)
以结构化 Markdown 表格输出，必须包含具体数值（严禁模糊代词）：
- 【方向】Long / Short
- 【入场区间】明确价格数值区间（如 64,200 - 64,500）
- 【止损点位】具体止损触发价及失效依据
- 【目标止盈】TP1（减半仓锁利润）、TP2（全平目标）
- 【盈亏比】Risk/Reward Ratio
- 【仓位建议】结合账户资金测算建议杠杆与仓位占比

## 5. 风控与反方情景 (Risk & Invalidation)
- 明确指出何种走势代表当前逻辑失效（如 4H 收盘跌破关键支撑）。
- 提醒用户严格遵守交易安全闸门：默认处于 dry-run 模拟模式，实盘执行必须经二次人工审批确认。
````

---

## 🔄 外部/社区 Skill（如 OKX Tradekit）引入流程

当从 OKX Agent Trade Kit 广场（`okx/agent-skills`）或其他开源社区引入 Skill 时，遵循以下 4 步标准流：

```
[1. 识别拆解] 区分原子工具 (API Tool) 与策略知识 (Skill SOP)
       ↓
[2. 规范落盘] 在 .agents/skills/<name>/SKILL.md 编写标准五段论
       ↓
[3. 工具补齐] 若需专有接口，在 connector-*/src/ 提供 DSH Tool，在 kit-*/ 注册 Skill
       ↓
[4. 验证同步] 运行 pnpm -r test 与 node scripts/sync-skills.mjs
```

### 拆解对照示例：
- **场景 A（纯策略/分析）**：OKX 广场的 `trading-plan-generator`、`rsi-bottom-hunter`。
  - 直接改写为 `crypto-trading-plan`、`crypto-rsi-strategy` 放入 `.agents/skills/`，通用调用 `crypto_get_klines` 等基础工具，跨平台通用。
- **场景 B（专有功能）**：OKX 广场的 `okx-cex-smartmoney`（聪明钱/牛人榜）。
  - 工具层：在 `packages/connector-okx/src/rest.ts` 实现牛人榜 API，在 `index.ts` 注册 `okx_get_smart_money` 工具；
  - 知识层：在 `.agents/skills/crypto-okx-smartmoney/SKILL.md` 编写聪明钱判读与跟单分析 SOP。

---

## 🛠️ 同步与发布命令

开发期修改或新增 Skill 后：

```sh
# 1. 自动同步 .agents/skills/ 到 packages/kit-*/assets/skills/
node scripts/sync-skills.mjs

# 2. 运行全量测试验证 SkillProvider 与工具集成
pnpm -r test

# 3. 重新构建所有包
pnpm -r build
```
