# Headline Arena 宏观研判外审与预测基准插件接入

- **日期**：2026-09-06
- **作者**：Antigravity Agent
- **类型**：Feature / Ecosystem Plugin
- **关联 Issue / 分支**：Issue #66 / 分支 `feat/66-headlinearena-audit`

---

## 1. 架构定位与业务诉求

在 GitHub Issue [#66](https://github.com/zhu1090093659/dsh-trading/issues/66) 中，Headline Arena 创始人 Kopei 提出了一个关键视角：
- `dsh-trading` 坚守**“下单前必须由人类审批（Discipline before the order）”**的铁律；
- 在审批闸门之前，Agent 本身已经形成了对市场行情的研判、多空方向与观点；
- 用户的核心关切是：**“我凭什么信任 Agent 在闸门前做出的宏观分析与判断？”**

Headline Arena 通过真实市价机械结算（T+24h 结算、3,700+ 笔已结算历史预测），提供客观的 Brier 评分与校准曲线。
我们将其接纳为**“闸门前研判独立审计（Pre-gate Judgment Audit）”**与预测基准插件 `@dshtrading/headlinearena`。

---

## 2. 为什么不作为交易连接器（TradeService Connector）？

依据 [docs/connector-playbook.md](file:///c:/Users/A/Documents/dsh-trading/docs/connector-playbook.md)：
1. 交易所连接器（OKX, Binance, Futu, Alpaca 等）实现 `MarketDataService` 与 `TradeService`，直接面向资金买卖与实时撮合；
2. Headline Arena **不提供真钱资金托管与撮合买卖**，其核心是“观点存证与机械结算评级”；
3. 将其强行放入交易连接器会破坏审批闸门语义与 `TradeService` 契约；
4. 因此，将其定案为独立的**生态审计与宏观预测插件**（`packages/headlinearena`），由用户按需启用（默认 `enabled: false`，自带 `dryRun: true` 防线）。

---

## 3. 实现矩阵

### 3.1 核心包 `@dshtrading/headlinearena`
- **`src/types.ts`**：完整的挑战格式、预测契约、成绩单类型与配置 Schema；
- **`src/store.ts`**：本地凭证存取（对齐官方规范 `~/.headlinearena/credentials.json`，支持多 Agent 字典与旧版扁平结构兼容，支持 `HA_AGENT_ID` / `HA_CLIENT_SECRET` 环境变量覆盖；遵循铁律 #5 不内置密钥）；
- **`src/client.ts`**：纯 TypeScript 原生 fetch 客户端，涵盖 OAuth2 Token 缓存/刷新、超时控制、网络降级容错；
- **`src/tools.ts`**：4 项核心 Agent 工具：
  - `ha_status`：查询凭证配置、Agent ID、激活状态与可用 credits；
  - `ha_list_challenges`：发现开放中的宏观期货题目（黄金 GC、原油 CL、标普 ES、美债 ZN、比特币 BTC 等）；
  - `ha_submit_prediction`：将 Agent 研报观点存证提交至机械结算序列，内置 `dryRun` 保护；
  - `ha_get_scorecard`：查询 Agent 历史预测的客观结算胜率、Brier 分数与校准曲线主页。
- **`src/plugin.ts`**：Cordis 插件形态，提供 `tradingHeadlineArena` 服务与 tools 自动注入。

### 3.2 配套技能 `.agents/skills/headlinearena-audit/SKILL.md`
- 规范 Agent 在涉及大宗商品与宏观期货研判时的工作流；
- 明确纪律红线：严禁自行捏造胜率，胜率一律实时调用 `ha_get_scorecard` 获取；
- 规范外审预测提交流程与 dryRun 确认环节。

---

## 4. 铁律遵循清单

| 铁律 | 落地证明 |
|---|---|
| 铁律 #1（bundle patch insert-only） | 新包独立存在，不修改任何既有市场的 bundle patch |
| 铁律 #2（知识进 skill 随包分发） | 新建 `headlinearena-audit` 技能并随仓落地 |
| 铁律 #3（下单默认 dry-run + 统一闸门） | 预测提交工具内置 `dryRun: true` 默认保护，非交易接口不触碰真实资金 |
| 铁律 #4（base 拥有全部市场无关行） | 跨宏观资产（GC/CL/ES/ZN/BTC），与具体单一市场解耦 |
| 铁律 #5（不内置密钥、不再分发数据） | 密钥由用户本地持存于 `~/.headlinearena/credentials.json`，无任何硬编码密钥 |
