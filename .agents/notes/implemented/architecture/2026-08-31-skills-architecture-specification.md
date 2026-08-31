# Agent Note: Skill 架构与管理规范定稿

Status: implemented

## Problem

随着项目推进与外部生态（如 OKX Agent Trade Kit Skills 广场）对接，Skill（领域知识、策略 SOP、风控清单）的种类与数量逐渐增加。此前存在职责边界与组织方式的模糊点：
1. 外部策略与 Prompt 容易被误塞进连接器（`connector-*`）代码中，违反代码与知识解耦原则（铁律 #2）；
2. 缺少统一的单一事实来源（SSOT）与目录规范，导致常规 Coding Agent（如 Claude Code、Cursor、DSH 等）无法按标准路径自动扫描加载。

## Decision

确立并落地全仓 **Skill 架构与管理规范**（详见 `docs/skills-guide.md`）：

1. **单一事实来源（SSOT）**：
   - 统一以根目录 `.agents/skills/<skill-name>/SKILL.md` 为唯一标准源，确保所有主流 Agent 工具开箱即用自动加载。
   - `packages/kit-*/assets/skills/` 保持为分发打包副本，通过 `scripts/sync-skills.mjs` 自动化同步。
2. **三层体系与加载优先级（Rank Hierarchy）**：
   - 用户自定义（Level 1: Rank 100-300）> 社区精选（Level 2: Rank 400-500） > 官方内置（Level 3: Rank 600 `BUNDLED_SKILL_RANK`）。
   - 允许用户在不修改包代码的情况下，无侵入覆盖或定制同名策略与风控规则。
3. **命名空间前缀**：
   - 通用市场策略：`crypto-*`, `us-*`, `cn-*`, `hk-*`；
   - 平台专有特化：`crypto-okx-*`, `crypto-binance-*` 等；
   - 跨市场通用：`trading-*`, `risk-*`。
4. **外部社区 Skill 拆解标准**：
   - 底层 API 与端点工具下沉到连接器（`packages/connector-*`）；
   - 策略分析、交易计划与 SOP 上浮到 `.agents/skills/`（遵循五段论模板），并随 `kit-*` 注册分发。

## Alternatives considered

- **只保留 `packages/kit-*/assets/skills/`**：落选——外部通用 Agent 与 IDE 插件无法识别包内深层路径，无法自动触发。
- **手动维护两处文件**：落选——容易出现版本漂移，引入 `scripts/sync-skills.mjs` 并在 `pnpm build` 中串联自动化同步。

## Consequences

- 产出权威文档：[docs/skills-guide.md](../../../../docs/skills-guide.md) 与索引；
- 提供同步工具：`scripts/sync-skills.mjs` 并集成入 root `package.json` 的 `pnpm sync:skills` 和 `pnpm build`；
- 后续接入 OKX Tradekit 或社区策略时均有据可依，直接在 `.agents/skills/` 下快速扩展。
