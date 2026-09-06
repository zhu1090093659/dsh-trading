# Agent Note: 内置技能按角色预设分配（#70）

Status: implemented

## Problem

统一角色预设（见 2026-09-06-unified-trading-role-presets）落地后技能面实际「全员全量」：四个角色都挂 kit 行，而各 kit provider 无条件注册全部捆绑技能（risk-checklist、indicator-authoring、trading-strategy-paradigms、knowledge-curation、trading-notes-setup，kit-crypto 另有 crypto-instrument-analysis）；base role-skills 又给所有角色注册 company-analysis + dynamic-capabilities。结果研究员能看到下单风控清单与指标创作指南，风控审查员能看到策略范式，角色纪律没有体现在技能目录上，且每会话静态技能目录被无关条目放大。

## Decision

让挂载面与 persona 既有分工对齐（master 保持全量不动）：

| 技能 | 大师 | 交易员 | 标的研究员 | 风险审查员 |
|---|---|---|---|---|
| company-analysis (base) | ✓ | | ✓ | |
| dynamic-capabilities (base) | ✓ | | | |
| crypto-instrument-analysis (kit-crypto) | ✓ | | ✓ | |
| \<market\>-risk-checklist | ✓ | ✓ | | ✓ |
| trading-strategy-paradigms | ✓ | ✓ | | |
| indicator-authoring | ✓ | ✓ | | |
| knowledge-curation | ✓ | | ✓ | |
| trading-notes-setup（全员 persona 的 JOURNAL 块引用） | ✓ | ✓ | ✓ | ✓ |

机制：
- kit provider（kit-crypto/us/cn/hk）增加可选 `config.skills` 白名单：缺省（未配置）保持全量目录向后兼容；白名单含未知名 fail-fast 抛错，不静默缩面；白名单外的 `get` 拒绝分发（`providerForSkills` 导出供测试）。
- base role-skills 同样配置化：master 全量对、instrument-researcher 仅 company-analysis、trader 与 risk-reviewer 不再挂该行。
- trader 与 master 共用 market contribution 的 traderRows（连接器行 + kit 行整块），而两者技能面不同：`presets.ts` 用 `connectorRowsOf` 把 kit 行从块尾拆出（找不到 kit 行即抛错，fail-conservative），trader 重写 kit 行注入白名单；master 保留整块原文（kit 行无 skills = 全量）。market 包契约与资产不动。
- 研究员保留 knowledge-curation：交易会话守则要求分析者沉淀知识卡片（knowledge-curation 流程），研究员是主要知识生产角色。

## Alternatives considered

- persona-only 区分（技能目录保持全员全量，靠人设约束加载）：目录描述进每会话静态前缀，无关条目放大上下文且把越权纪律文档暴露给不该见的角色——拒绝。
- 把 kit 行从 market 资产移除、由 base 统一生成：需改 getPresetContribution 契约与四个 market 包资产，跨包联动面大——本轮拒绝，traderRows 尾部拆分即可达成，契约零变更。
- trader 也保持全量、只滤 base 技能：交易员仍见 knowledge-curation / crypto-instrument-analysis，与「执行与编排层看全量、专家层最小面」的分层不一致——拒绝。
- 白名单未知技能名静默忽略：会掩盖预设与 kit 技能清单漂移（如技能改名后白名单悄悄失效）——拒绝，fail-fast。

## Consequences

- 16 市场子集组合测试断言各角色 kit 白名单与 role-skills 行形态（trader 无 base 行、researcher 无 risk-checklist 字样、risk-reviewer 无策略/指标条目、master 全量无白名单）；kit-crypto skills 测试新增白名单用例；base role-skills 新增 providerForSkills 用例。
- 门禁全绿：`pnpm -r build`、`typecheck-gate`（498 < 基线 504，顺带清 6 个存量错误）、`i18n:check`、`pnpm -r test`（43 包 exit 0）与根 vitest（1112 passed）。
- `SkillProvider.get` 契约实为 `(candidate, options: SkillLookupOptions)` 双参：本次把 5 个 provider.get 放宽签名并转发 options，消除新增转发调用的 TS2554，也清掉潜在存量隐患。
- 已安装托管预设带管理戳 hash，宿主重启后安装器幂等重写自动生效；运行中实例不受影响（禁止运行中 `dsh plugin install`）。
- 真机验收待办：宿主重启后按 unified-trading-role-presets note 的真机方法抽查——研究员会话技能目录应只有 company-analysis（crypto 安装时另有 crypto-instrument-analysis/knowledge-curation/trading-notes-setup），交易员/风控员不应出现 base 技能。
- 遗留观察：indicator-authoring 的 `.agents/skills/` SSOT 目录已不存在，但 4 个 kit 资产仍随包分发并注册（sync-skills 只写不删）；后续若下线该技能需显式清理 kit 资产与注册。
