# Agent Note: Agent Notes 与软件工厂治理体系落地

Status: implemented

## Problem

在 `dsh-trading` 多市场、多连接器以及多插件的复杂 monorepo 演进中，若缺乏统一的架构与效能治理规范，容易产生以下工程痛点：
1. **决策上下文碎片化**：历史架构权衡散落在代码注释或 PR 描述中，后续 Agent 与开发者接手时难以追溯为什么做此设计、放弃了哪些备选方案。
2. **Context Bloat 与 Prompt Cache 失效**：随开发深入，若静态规则与动态上下文混杂，会导致服务端 KV Cache 命中率骤降，增加延迟与 Token 消耗。
3. **CI 试错震荡**：当测试或门禁报错时，缺乏确定性的自愈流程容易导致盲目全量重试或往复撤销修改（thrashing）。
4. **模型资源配比失衡**：机械性代码搜索、文档维护与高难度系统 Planning 混用同一模型层级，不符合成本效能 Pareto 最优原则。

## Decision

依据 `agent-notes-setup` 规范，确立并在仓库根 `AGENTS.md` 与 `.agents/notes/README.md` 中落地完整的 Agent Notes 决策记录树与 Agent 软件工厂治理基线：

1. **统一决策记录树规范**：
   - 严格实行封闭类别集（`feature`, `bug-fix`, `simplification`, `architecture`, `process`, `testing`）与生命周期管理（`proposed/`, `implemented/`, `rejected/`, `archived/`）。
   - 规定每个非平凡变更必须在同一变更中新增或更新 Agent Note，且强制记录 `## Alternatives considered`。
2. **Prompt 分层与缓存优化（Prompt Layering & Caching）**：
   - 确立 Layer 1（全局静态前缀）、Layer 2（仓库与领域静态前缀）、Layer 3（动态上下文末尾）分层，确保静态前缀高度稳定，最大化服务端 KV Cache 命中率。
3. **CI 确定性自愈闭环（CI Self-Healing Protocol）**：
   - 确立「日志精准归因 $\rightarrow$ 本地最小复现 $\rightarrow$ 针对性最小补丁 $\rightarrow$ 全量门禁前置验证」四步自愈流程，杜绝盲目线上试错。
4. **效能治理与模型分级契约（Pareto Model Tiering & Anti-Thrashing）**：
   - 确立子 Agent 模型分级策略（优先 `flash`/`flash_lite` 承担检索与机械子任务，`pro` 承担复杂推理与 Planning）。
   - 设定连续 3 次单点排错未果强制触发 Anti-thrashing 熔断，主动向用户请求澄清。
5. **演进闭环机制（The Evolution Loop）**：
   - 确立「发现模式（Note） $\rightarrow$ 固化为 Skill（`.agents/skills/`） $\rightarrow$ 固化为脚本 Gate（`scripts/`）」的资产演进链路。

## Alternatives considered

1. **仅保留简版 notes 规则，不引入软件工厂治理规范**：
   - *落败原因*：仅有笔记格式无法规范 Agent 在多轮对话和子任务派发时的行为，易出现 KV Cache 命中率低、CI 循环震荡重试与模型算力浪费等问题。
2. **使用集中式 `INDEX.md` 维护所有决策清单**：
   - *落败原因*：多 agent 并行开发时集中式索引文件极易产生频繁的 Git merge conflict，去中心化的活跃文件树（`implemented/` 等）能够天然避免冲突。
3. **允许自由扩展类别集（如引入 `refactor`）**：
   - *落败原因*：`refactor` 往往模糊了「行为不变的代码精简/结构调整（simplification/architecture）」与「加功能（feature）」，封闭类别集有助于强迫思考变更的真实本质。

## Consequences

- 仓库的 Agent 决策记录与工程治理规则完整对齐了 deepseek-harness 上游生态最佳实践。
- 多 Agent 协作与 CI 自动化维护具备了确定性契约，显著降低了 Context Bloat、模型成本与震荡调试风险。
- 本地单测 `pnpm test` 与构建 `pnpm build` 全流程验证通过，单语（中文）仓库纪律保持一致。
