# Agent Note: 知识库数据层与 Agent 摄取链路（knowledge_ingest/search + knowledge-curation）

Status: implemented

## Problem

用户在日常研究中通过 Content Insight 技能完成了对财经视频（B站）或深度研报/公众号文章的事实核查与多维分析，但这些高价值观点缺乏结构化的个人知识库沉淀机制。为了支持中栏第三 Tab 知识库的 Obsidian 式图谱可视化，亟需建立纯库数据模型、结构校验、力导图网络构建、原子文件持久化、Agent 工具链路（`knowledge_ingest` 与 `knowledge_search`）以及标准化策展技能（`knowledge-curation`）。

## Decision

1. **新建纯库核心包 `@dsh-trading/knowledge`**：
   - 契约对齐设计定稿（`docs/design/knowledge-graph.md` §2）：`KnowledgeCard` 包含 `id`, `title`, `summary`, `source`, `credibility`, `coreClaims`, `factCheck`（三桶），`takeaways`, `boundaries`, `tags`, `tickers`, `related`；
   - 纯函数结构校验器 `validateKnowledgeCard`：严格校验必填项、`source.url` 白名单与格式、`credibility` 枚举（high/medium/low），并强制校验 `related` 关联 ID 必须在现有知识库中存在（拒绝悬空关联）；
   - 纯函数图构建器 `buildGraph`：生成解耦的 `{ nodes, links }` 图数据，支持显式 `related` 关联、`co-tag` 共享标签（合并去重并累加 weight）、`co-author` 同作者关联，并保留孤立节点（度数为 0）；
   - Node 端原子持久化存储 `createFileKnowledgeCardStore`（`~/.dsh/knowledge/cards.json`）：严格采用 `tmp + rename` 原子写盘与异常捕获，逐行对齐 `custom-fs.ts` 既有先例。

2. **Agent-native 摄取与检索工具链路**：
   - `knowledge_ingest`：入参接收完整卡片字段，以 `source.url` 为唯一定重键；当 URL 已存在时执行更新（保持原有 `id` 与 `createdAt` 不变，更新 `updatedAt` 与其余内容）；返回结构化入库状态；
   - `knowledge_search`：跨字段（title, summary, coreClaims, tags, author）不区分大小写模糊匹配，支持 `author`, `sourceType`, `credibility`, `tags` 多维过滤与 `limit` 截断，按 `updatedAt` 倒序返回；
   - 在 `packages/client-ui-trading/src/index.ts` 中实例化单例 store 并向 Cordis 全局 tools 注册；在 4 大 market kit（`crypto/us/cn/hk`）中注册工具并随包分发。

3. **Bridge HTTP 桥只读端点**：
   - 在 `packages/client-ui-trading/src/bridge.ts` 中提供 `GET /dshtrading/api/knowledge/cards`，返回全量卡片列表；
   - 在 `packages/client-ui-trading/src/client/api.ts` 导出 `fetchKnowledgeCards()`，供中栏知识库 UI 消费（v1 UI 只读浏览，写入一律走 Agent 工具）。

4. **策展技能与单源分发**：
   - 编写 `.agents/skills/knowledge-curation/SKILL.md`（五段论 SOP：目标范围、核查前置、提取与受控词表对齐、查重入库、回报契约与立场红线）；
   - 更新 `scripts/sync-skills.mjs`，将 `knowledge-*` 前缀技能统一分发至 4 大 market kit 静态资产目录，并在各 kit 的 `SkillProvider` 中注册。

## Alternatives considered

- **UI 端直接提供表单编辑与卡片增删改查**：
  - *落败原因*：违背 agent-native 设计原则；知识卡片的核心价值在于经过 Content Insight 事实核查与推理链提炼，由 Agent 结构化输出远比用户手工复制粘贴高效且规范。
- **引入 SQLite / 向量数据库**：
  - *落败原因*：v1 阶段定位于个人知识库，节点规模在数百~数千量级，单文件 JSON + 内存索引毫秒级响应，零外部依赖，极简可控；未来如做十万级跨源检索再平滑演进。

## Consequences

- 知识库核心包经过 16 个确定性单元测试验证，全仓 21 包构建与 438 个单测 100% 绿灯；
- 形成完整的「用户链接 → Content Insight 核查分析 → Agent 调 knowledge_ingest 入库 → Bridge 端点供数」端到端闭环，为 Issue #25（知识库图谱 UI）提供了坚实的数据层支撑。
