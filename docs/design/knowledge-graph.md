# 知识库与知识图谱设计（Knowledge Base Tab）

> 状态：设计定稿（待实现） · 2026-08-31
> 决策：项目所有者（Mode 2） · 起草：agent 评审
> 关联：[docs/design/strategy-tab.md](strategy-tab.md)（第二 Tab）、[`.agents/skills/content-insight/`](../../.agents/skills/content-insight/SKILL.md)（内容摄取管线 SSOT）、[docs/skills-guide.md](../skills-guide.md)

## 1. 背景与决策

项目所有者 2026-08-31 定稿：中栏第三 Tab = **知识库**。把我们认同的财经博主、研究机构的观点，经内置 **Content Insight** 技能（B 站视频 / 微信公众号文章 → 底稿 → 事实核查三档标注 → 知识卡片）沉淀为结构化卡片，作为交易研究的个人知识库；呈现方式 = **Obsidian 式图谱可视化**（力导网络）。

设计原则（与 #19 指标创作链路同构）：

- **agent-native 摄取**：卡片由 agent 经工具入库，UI 只读浏览（v1 不做 UI 编辑）；
- **数据模型对齐既有产出**：字段直接映射 content-insight S3 知识卡片模板，不让用户重复劳动；
- **本地私有**：数据只存本机，不上传、不自动抓取订阅源。

## 2. 数据模型（`packages/knowledge`）

```ts
export type KnowledgeSourceType = 'bilibili' | 'wechat' | 'manual'

export interface KnowledgeCard {
  readonly id: string                 // 'kc_' + ULID（入库时生成，稳定不变）
  readonly title: string              // 卡片主题（模板「知识卡片：<主题>」的主题段）
  readonly summary: string            // 2-4 条核心论点合并的一句话概述（图谱 hover 文案）
  readonly source: {
    readonly type: KnowledgeSourceType
    readonly url: string              // 去重键：BV 页链接 / 微信文章链接 / manual
    readonly author: string           // UP主 / 公众号名 / 手工
    readonly publishedAt?: string     // 素材发布日期（ISO 日期）
  }
  readonly credibility: 'high' | 'medium' | 'low'   // 依据核查结论整体定级
  readonly coreClaims: readonly string[]            // 核心论点（保留原作者推理链）
  readonly factCheck: {
    readonly verified: readonly string[]       // ✅ 证实
    readonly discrepancies: readonly string[]  // ⚠️ 有出入
    readonly unverifiable: readonly string[]   // ❓ 无法核实
  }
  readonly takeaways: readonly string[]             // 可复用的分析经验
  readonly boundaries: readonly string[]            // 适用边界与避坑
  readonly tags: readonly string[]                  // 受控主题词（见 §4 字段标准）
  readonly tickers?: readonly string[]              // 可选关联标的（市场规范词汇：BTCUSDT / 600519.SH）
  readonly related?: readonly string[]              // 显式关联卡片 id
  readonly createdAt: string
  readonly updatedAt: string
}
```

与 content-insight 卡片模板的字段映射：来源→`source`；内容可信度→`credibility`；核心论点→`coreClaims`+`summary`；事实核查结论→`factCheck`（✅/⚠️/❓ 三桶）；可复用的分析经验→`takeaways`；适用边界与避坑→`boundaries`；主题关键词→`title`+`tags`。

## 3. 存储与包布局

```
packages/knowledge/src/
├── index.ts          # 类型 + buildGraph + 内存 store（纯库，浏览器可打包）
├── types.ts          # KnowledgeCard / GraphNode / GraphLink
├── validate.ts       # ingest 结构校验（纯函数）
├── graph.ts          # buildGraph(cards, opts) → { nodes, links }
└── tool.ts           # createKnowledgeIngestTool / createKnowledgeSearchTool（node 子路径导出）
└── knowledge-fs.ts   # createFileKnowledgeCardStore（node 专用）
```

- 文件存储：`~/.dsh/knowledge/cards.json`，**tmp+rename 原子写**、错误日志 + rethrow——实现模式逐行对齐 `packages/indicators/src/custom-fs.ts`（#19 先例）；
- node 子路径 `@dshtrading/knowledge/tool` 承载工具与 file store（对齐 `@dshtrading/indicators/tool`）。

### 图构建（`graph.ts`）

`buildGraph(cards, { coTag = true, coAuthor = true })`：

- 节点 = 卡片：`{ id, label: title, degree, cluster: tags[0] ?? '未分类', credibility }`；
- 边三类，带 `kind` 字段：`related`（显式）、`co-tag`（共享任一 tag）、`co-author`（同作者）；共享多条 tag 只出一条边，`weight` 记共享数；
- 孤立卡片保留（度 0），图谱不为连通性造假边。

## 4. 摄取链路（agent-native）

```
用户丢链接（聊天）→ agent 走 content-insight 技能（已随 base 分发）
  → S1/S3 产出知识卡片 → agent 调 knowledge_ingest 工具入库 → UI 图谱即刻可见
```

两个工具（注册模式对齐 #19 `indicator_author`：`ctx.inject(['tools'])`，宿主全局唯一）：

- `knowledge_ingest`：入参 = 卡片内容（id/时间戳由工具生成）。校验：必填字段、`source.url` 白名单（bilibili.com / b23.tv / mp.weixin.qq.com / manual）、`credibility` 枚举、`related` 必须指向已存在卡片。**去重键 = source.url**：已存在则 update（保留 id/createdAt），返回 `{ status: 'created' | 'updated', id }`；
- `knowledge_search`：`{ query?, tags?, cluster?, author?, sourceType?, credibility?, limit?=20, detail?='summary' }`，大小写不敏感子串匹配（title/summary/coreClaims/tags）+ 过滤；有关键词时按字段命中相关度排序（tags > title > coreClaims > summary/author，同分按 updatedAt 倒序），无关键词按 updatedAt 倒序；`detail="full"` 附核心论点/事实核查/经验/边界全文（上限 20 张）（2026-09-02 演进，见 Agent Note 2026-09-02-journal-agents-knowledge-recall）；
- `knowledge_get`（2026-09-02 新增）：按 id 读单卡全文，id 来自 search 结果或分析引用标注；
- `knowledge_delete`（2026-09-02 新增）：证伪下架——删除卡片并自动清理其他卡片指向它的 `related` 引用，输出回显被删卡片论点留痕；配套 knowledge-curation skill 的 Retraction SOP；
- **两级检索**（2026-09-02 同日定稿）：`knowledge_graph` 作第一级返回主体（聚类键 = 卡片首个标签）全量分布，`knowledge_search { cluster }` 作第二级按主体钻取，`knowledge_get` 读全文——先主体后知识点，避免百卡级全库扫描。

### 新 Skill：`.agents/skills/knowledge-curation/SKILL.md`（五段论）

1. **目标与范围**：何时入库（用户说"沉淀/入库/收藏/记到知识库"，或完成一次 content-insight 分析后主动建议）；何时不动手（用户只要口头总结）。
2. **前置依赖**：content-insight 已产出底稿与核查结论；无核查不入库（credibility 无依据）。
3. **SOP**：提炼卡片字段 → tags 用受控词汇（在 skill 中维护初始词表：宏观/货币/行业/个股/加密/风控/估值/情绪…，允许扩充但需向用户说明）→ `knowledge_search` 查重 → `knowledge_ingest` → 回报 id 与建议建立的 related 连接。
4. **输出契约**：入库回报 = 卡片标题 + id + tags + 与哪些既有卡片建立了关联。
5. **风控与红线**：继承 content-insight 第四节立场红线（转述≠背书、数字溯源、不做动机审判）；卡片明示「不构成投资建议」；不自动批量抓取任何订阅源。

## 5. 图谱可视化选型（调研结论）

**推荐：`force-graph`（vasturiano，当前 1.51.x）**——canvas 渲染 + 内置 d3 力导，hover/click/节点拖拽/缩放平移全家桶开箱即用，零 React peer 负担；与本仓「vanilla 库 + React useRef 外壳」的既有先例（lightweight-charts → `TvChart.tsx`）完全一致。规模域：数百~数千节点（本项目多年积累量级）绰绰有余。

| 备选 | 结论 |
|---|---|
| sigma.js v3 + graphology | WebGL，1 万+ 节点才需要；集成成本更高，落选（预留为 v2 升级路径，`buildGraph` 输出与渲染库解耦，切换不伤数据层） |
| cytoscape.js | 偏生物信息/DAG，体积大，落选 |
| d3-force 裸用 | 交互全要自研，落选 |

依赖进 `packages/client-ui-trading`（唯一消费方）；`buildGraph` 的输出形状刻意对齐 force-graph 的 `GraphData`（`{ nodes, links }`），但不强绑其类型。

## 6. KnowledgeView 交互规格

- `MiddleStage.tsx`：`MIDDLE_VIEWS` 追加 `{ id: 'knowledge', titleKey: 'stage.knowledge' }`（'知识库'），`MiddleViewId` 扩为三值；
- 新 bridge 只读端点：`GET /dshtrading/api/knowledge/cards`（node half 读 file store 全量返回；写入一律走工具，UI 不提供编辑）；client 侧 `fetchKnowledgeCards()` 进 `api.ts`；
- 组件：`KnowledgeView.tsx` + `KnowledgeGraph.tsx`（force-graph 包装）+ 详情抽屉；
- 交互验收表：

| 能力 | 规格 |
|---|---|
| hover | 高亮该节点及其邻域，其余淡化 |
| click | 右侧抽屉渲染卡片全文（markdown：核心论点/核查三桶/经验/边界 + 来源链接） |
| 拖拽 / 缩放平移 | 库默认行为，不吞容器滚轮 |
| 过滤 | 按 tag、作者、可信度、来源类型（过滤后重算布局或保留坐标均可） |
| 搜索 | 输入关键词定位并居中节点 |
| 视觉 | 节点颜色 = 主题簇（tags[0]），大小 = 连接度；红涨绿跌 token 不适用于本视图，配色走中性色板 |
| 空态 | 引导文案："把 B 站视频或公众号文章链接发给助手，说「沉淀到知识库」即可入库" |

- 持久化：`dshtrading.knowledge.view.v1`（过滤器状态），对齐既有 store 模式。

## 7. 隐私与边界

- 卡片只落 `~/.dsh/knowledge/` 本地文件；不上传、不同步；
- v1 不做：UI 编辑卡片、自动抓取订阅源、向量检索、跨设备同步；
- 卡片内容是"别人观点的结构化转述"，图谱上不展示任何交易信号；与策略板块严格解耦（未来如做"观点→标的"联动，另立设计）。

## 8. 验收清单

- [ ] `pnpm -r build` / `pnpm -r test` 全绿；validate 与 buildGraph 有确定性单测（含孤立节点、多 tag 去重边、related 悬空拒绝）
- [ ] `knowledge_ingest`：合法入库 / 重复 URL 走 update 且 id 不变 / related 悬空被拒——三个用例齐
- [ ] `knowledge-curation` skill 经 sync 出现在 4 个 kit assets；`pnpm sync:skills` 幂等
- [ ] 中栏三 Tab「行情 | 策略 | 知识库」齐全；真实入库 ≥3 张卡片（含一条 related 链与共享 tag）后图谱 hover/click/过滤/搜索全部可用
- [ ] headless 场景（无 webServer）行为对齐 #19 先例（工具注册不受影响，bridge 静默挂起）
- [ ] Agent Note（feature）随 PR；Conventional Commits；**不得在 CHANGES_REQUESTED 状态下自行合并**

## 9. 参考

- `.agents/skills/content-insight/`（管线与卡片模板 SSOT）、`references/analysis-framework.md`（五维框架与立场红线）
- `packages/indicators/src/{custom-fs,tool}.ts` 与 `client-ui-trading/src/index.ts` 的工具注册段（#22 定稿形态）——本设计的实现母版
- `docs/skills-guide.md`（SSOT 与 sync 机制）
