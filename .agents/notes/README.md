# Agent Notes 规则（dsh-trading）

本目录只放**决策记录**：每个非平凡变更在同一变更中写下 why 与放弃了什么。行为描述归 README/docs，一个事实只有一个家。本仓为单语（中文）仓库，无双语契约与文档门禁脚本——规则靠纪律执行。

## 布局与路径编码

```
{lifecycle}/{class}/yyyy-mm-dd-topic-title.md
```

- 日期 = 首次提案日期（以 git 历史为准）；交叉引用用相对链接；**禁止集中式 INDEX 文件**——活跃树即清单。
- 生命周期目录：`proposed/`（未实现提案）→ `implemented/`（已交付）或 `rejected/`（否决）；`archived/` 只收 implemented 中未来价值低的记录，封存后永久冻结。

## 封闭类别集

| class | 含义 |
|---|---|
| `feature` | 新能力 |
| `bug-fix` | 修缺陷 |
| `simplification` | 移除代码/行为而不加能力 |
| `architecture` | 交付源码的结构决策 |
| `process` | 围绕代码的工具/策略/工作流 |
| `testing` | 测试基础设施与策略 |

刻意不设 `refactor`（被 simplification 覆盖）。加类别须同时改本表。类别子目录在第一条对应记录出现时才创建。

## 何时写

每个非平凡变更（行为、架构、跨包契约、流程工具、测试策略、持久化/传输/配置格式）**必须在同一变更中**新增或更新至少一条记录。更新已拥有该决策的旧记录即满足要求，不建重复。纯机械局部修改（改名、格式化）豁免。每条新记录先做**取代检查**：搜活跃树是否已有同主题记录。

## 文件格式

前三行严格为：

```
# Agent Note: <title>

Status: <status>
```

Status 取 `proposed` / `implemented` / `rejected — <一句话理由>`，不带日期与括号，且与所在目录一致。

正文以 `## Problem` 开篇（动机须独立成立）。骨架：

- **proposed**：Problem / Proposal（可将来时）/ 定制章节 / Alternatives considered / Acceptance criteria / Risks
- **implemented**：Problem / Decision（现在时）/ 定制章节 / Alternatives considered / Consequences；规格腔标题（Proposal / Plan / Acceptance criteria）禁入——已交付的决策写事实
- **rejected**：冻结提案原样，仅头部块、Problem 开篇与备选方案强制要求适用

**备选方案强制**：每条必有 `## Alternatives considered`，每个真实备选一段落败原因；备选是记录下来的，不是编造的。前格式遗留记录在该章节位置放精确注释 `<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->`。

## 生命周期迁移

移动文件时同一变更内更新 Status 行并重满足目标目录骨架：proposed→implemented 把 Proposal 改写为现在时 Decision、验收/风险并入 Consequences；proposed→rejected 只加理由后冻结。

## 归档与删除

implemented 中未来价值低的移入 `archived/{class}/` 并永久冻结——归档变更只允许：移动文件、在 `Status: implemented` 之下插入 `Archived: YYYY-MM-DD` 行、修复入链。绝不归档 proposed（过时提案走 rejected）；rejected 只在还能阻止可能犯的错误时保留，否则整组删除。
