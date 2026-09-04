# Agent Note: 中栏板块重规划——「策略」板块与「知识库」板块设计定稿

Status: implemented

## Problem

中栏第二视图原为「量化」占位（`WorkflowView`，机制验证性质），无实质内容；`docs/archive/crypto-slice-plan.md`（2026-08-29，已归档）曾将回测引擎列为 non-goal。项目所有者 2026-08-31 对中栏板块做出方向性重规划：第二 Tab 更名「策略」并承载三类交易策略参考范式；新增第三 Tab「知识库」，经 content-insight 沉淀财经内容并以 Obsidian 式图谱呈现。

## Decision

1. **方向性反转（取代旧范围控制）**：回测能力以「纯函数、浏览器端、单标的本地回测」形态进入路线图，服务参考范式教学与验证；实盘自动化仍然 non-goal（铁律 #3 不变）。旧 non-goal 在 `docs/archive/crypto-slice-plan.md` 补指向注，不删改原句。
2. **两份设计文档定稿**（含契约、六个范式详表、交互规格、验收清单）：
   - [docs/design/strategy-tab.md](../../../../docs/design/strategy-tab.md)——策略板块：`packages/strategies` 纯库 + 引擎成交假设 + `StrategyView` + `trading-strategy-paradigms` skill；
   - [docs/design/knowledge-graph.md](../../../../docs/design/knowledge-graph.md)——知识库：`packages/knowledge`（卡片模型对齐 content-insight S3 模板）+ `knowledge_ingest`/`knowledge_search` 工具 + `knowledge-curation` skill + force-graph 图谱视图。
3. **实现路线**：拆三个 issue 交协作者执行（策略板块 / 知识库数据层与摄取 / 知识库图谱 UI），本 agent 只做评审。
4. **图库选型**：`force-graph`（vanilla + React 外壳，对齐 `TvChart` 先例）；`buildGraph` 输出与渲染库解耦，预留 sigma.js 升级路径。

## Alternatives considered

- **策略板块继续占位**：落选——所有者明确要求承载参考范式，这是产品主线不是实验。
- **定投/再平衡纳入 v1 范式**：落选——现金流语义会迫使回测引擎支持多笔现金注入，复杂度不成比例；v1 以 entry/exit 两态语义覆盖 6 个范式，现金流留给 v2 组合回测。
- **知识卡片自定义 markdown 存储（Obsidian vault 式）**：落选——结构化 JSON store（对齐 #19 custom indicators）才能支撑校验、去重与图谱构建；md 渲染仅用于展示层。
- **react-force-graph 包装库**：落选——vanilla `force-graph` + `useRef` 外壳已足够且少一层 peer 依赖面。

## Consequences

- 中栏扩展点（`MIDDLE_VIEWS` 视图注册表）即将从 2 视图扩为 3 视图；`workflow` 占位视图与相关 locale 键将被移除；
- 新增两个纯库包（`strategies` / `knowledge`），均零运行时依赖、浏览器可打包、node 能力走子路径；
- 两个新 skill（`trading-strategy-paradigms` / `knowledge-curation`）走 SSOT + sync 分发；
- 协作纪律照旧：本 agent 只评审 PR，实现由协作者（@Aa728848）承担。
