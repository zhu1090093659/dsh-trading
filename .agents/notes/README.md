# Agent Notes 与软件工厂治理规则（dsh-trading）

本目录是仓库的**决策记录树与 Agent 软件工厂治理基线**：每个非平凡变更在同一变更中写下 why 与放弃了什么，同时确立 Prompt 分层缓存、CI 确定性自愈、模型 Pareto 分级与反震荡治理契约。行为描述归 README/docs，一个事实只有一个家。本仓为单语（中文）仓库，无双语契约与文档门禁脚本——规则靠纪律执行。

---

## 第一部分：决策记录（Agent Notes）规范

### 1. 布局与路径编码

```
{lifecycle}/{class}/yyyy-mm-dd-topic-title.md
```

- 日期 = 首次提案日期（以 git 历史为准）；交叉引用用相对链接；**禁止集中式 INDEX 文件**——活跃树即清单。
- 生命周期目录：`proposed/`（未实现提案）→ `implemented/`（已交付）或 `rejected/`（否决）；`archived/` 只收 implemented 中未来价值低的记录，封存后永久冻结。

### 2. 封闭类别集

| class | 含义 |
|---|---|
| `feature` | 新能力 |
| `bug-fix` | 修缺陷 |
| `simplification` | 移除代码/行为而不加能力 |
| `architecture` | 交付源码的结构决策 |
| `process` | 围绕代码的工具/策略/工作流 |
| `testing` | 测试基础设施与策略 |

刻意不设 `refactor`（被 simplification 覆盖）。加类别须同时改本表。类别子目录在第一条对应记录出现时才创建。

### 3. 何时写

每个非平凡变更（行为、架构、跨包契约、流程工具、测试策略、持久化/传输/配置格式）**必须在同一变更中**新增或更新至少一条记录。更新已拥有该决策的旧记录即满足要求，不建重复。纯机械局部修改（改名、格式化）豁免。每条新记录先做**取代检查**：搜活跃树是否已有同主题记录。

### 4. 文件格式与骨架

前三行严格为：

```
# Agent Note: <title>

Status: <status>
```

Status 取 `proposed` / `implemented` / `rejected — <一句话理由>`，不带日期与括号，且与所在目录一致。

正文以 `## Problem` 开篇（动机须独立成立）。骨架：

- **proposed**：`## Problem` / `## Proposal`（可将来时）/ `## Context & Efficiency Impact`（评估 Token、Schema、上下文开销）/ 定制章节 / `## Alternatives considered` / `## Verification & Gates` / `## Risks`
- **implemented**：`## Problem` / `## Decision`（现在时）/ 定制章节 / `## Alternatives considered` / `## Consequences`；规格腔标题（Proposal / Plan / Acceptance criteria）禁入——已交付的决策写事实
- **rejected**：冻结提案原样，仅头部块、Problem 开篇与备选方案强制要求适用

**备选方案强制**：每条必有 `## Alternatives considered`，每个真实备选一段落败原因；备选是记录下来的，不是编造的。前格式遗留记录在该章节位置放精确注释 `<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->`。

### 5. 生命周期迁移

移动文件时同一变更内更新 Status 行并重满足目标目录骨架：proposed→implemented 把 Proposal 改写为现在时 Decision、验收/风险并入 Consequences；proposed→rejected 只加理由后冻结。

### 6. 归档与删除

implemented 中未来价值低的移入 `archived/{class}/` 并永久冻结——归档变更只允许：移动文件、在 `Status: implemented` 之下插入 `Archived: YYYY-MM-DD` 行、修复入链。绝不归档 proposed（过时提案走 rejected）；rejected 只在还能阻止可能犯的错误时保留，否则整组删除。

---

## 第二部分：Prompt 分层与缓存优化规范（Prompt Layering & Caching）

为最大化大模型 KV Cache 命中率并防止 Context Bloat，在开发与治理中确立 Prompt 前缀稳定性要求：

1. **Layer 1（全局静态前缀）**：系统身份、全局不变纪律（如 Mode 2 设计驱动约束、无 emoji 纪律）、全局核心工具元数据。置于 Prompt 绝对头部，严禁注入动态时间戳或会话随机数。
2. **Layer 2（仓库与领域静态前缀）**：仓库根 `AGENTS.md`、加载的 Skill 定义、目录架构边界。在同一代码库会话中保持高度稳定，最大化复用服务端 Prompt Cache。
3. **Layer 3（动态上下文末尾）**：Mem0 记忆片段、CodeGraph 符号查询结果、当前文件的最小必要 Diff、用户实时请求。置于 Prompt 最末尾，避免动态内容破坏前缀缓存。

---

## 第三部分：CI 自愈规范（CI Self-Healing Protocol）

当流水线、本地门禁或测试报错时，Agent 必须遵循确定性自愈闭环，严禁盲目在线重试或震荡提交：

1. **精准归因（Log Isolation）**：提取具体失败步骤的真实日志与报错堆栈，禁止凭猜想修改。
2. **本地最小复现（Local Minimal Repro）**：使用单条最小命令（如单测文件或单一类型检查指令）在本地复现失败，而非盲目运行全量长耗时流水线。
3. **最小补丁修复（Targeted Minimal Diff）**：针对失败根因编写针对性补丁，不得夹带无关格式化或重构改动。
4. **全量门禁前置验证（Pre-Push Gate Check）**：在提交或推送前，必须在本地完整运行仓库全部前置门禁（`pnpm -r test` 与 `pnpm -r build`）并验证通过。

---

## 第四部分：效能治理与模型分级契约（Pareto Model Tiering & Anti-Thrashing）

1. **子 Agent 模型分级策略（Pareto Model Tiering）**：
   - 默认优先采用轻量/高性价比模型（如 `flash` / `flash_lite`）派发只读调研（`research`）、代码搜索、静态检查、文档多语言同步等机械子任务。
   - 仅在主架构设计（Planning）、跨模块深度重构与疑难 Bug 根因分析时使用高规格推理模型（`pro` / `high reasoning`）。
2. **按需工具挂载（Tool Scoping）**：避免无脑全量注入 MCP / Tool Schema；根据当前 Skill 和 Subagent 角色最小化暴露工具集。
3. **循环震荡熔断（Anti-Thrashing Circuit Breaker）**：Agent 若在同一文件或报错上连续尝试 3 次未果，或发生代码往复撤销，必须强制中断循环，向用户说明卡点并主动请求人工澄清（Clarification），坚决杜绝无效 Token 燃烧。

---

## 第五部分：演进闭环（The Evolution Loop）

建立从单次经验到仓库资产的演进通路：

1. **发现模式**：在日常开发与重构中形成的非平凡决策 $\rightarrow$ 提炼为 Agent Note（`proposed` $\rightarrow$ `implemented`）。
2. **固化为 Skill**：当同类任务反复出现（例如特定包模板、特定交易所接入、行情定性分析框架） $\rightarrow$ 将 Note 中的最佳实践沉淀为 `.agents/skills/<skill-name>/SKILL.md`。
3. **固化为 Gate**：当规则可以通过脚本确定性校验 $\rightarrow$ 转化为 `scripts/` 下的校验命令或 pre-push 门禁，实现由 Agent 驱动的软件工厂持续演进。
