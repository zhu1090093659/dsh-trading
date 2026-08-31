# Agent Note: 中栏第三 Tab「知识库」——Obsidian 式知识图谱可视化（force-graph）

Status: implemented

## Problem

随着 Issue #24 知识库数据层与 Agent 摄取链路交付，用户经过事实核查后的财经卡片已安全沉淀至本地。然而在中栏用户界面上，用户亟需一种直观、立体、具探索性的方式来查看和关联这些知识卡片。传统列表视图无法呈现观点之间的引用关系、主题聚集和共同作者网络；需要引入 Obsidian 式的力导网络图谱可视化。

## Decision

1. **图谱渲染选型与原生包装（`KnowledgeGraph.tsx`）**：
   - 采用 `force-graph`（^1.51.0）Canvas 渲染引擎，以 `useRef` + `useEffect` 模式原生包装（对齐 `TvChart.tsx` 包装 `lightweight-charts` 的架构惯例，零 React peer 负担）；
   - **节点视觉**：节点颜色基于主题簇（`tags[0]`）采用中性柔和色板（不用涨跌红绿色），节点半径根据连接度 `degree` 自适应缩放；
   - **交互规格**：
     - Hover：高亮当前节点及其一阶邻域（相连节点与边），其余节点与边半透明淡化（alpha 0.18 / 0.08），并浮现定制 tooltip 提示卡片核心论点；
     - Click：选中节点并通知父级滑出详情抽屉；
     - 居中定位：暴露 `focusNode(nodeId)` imperative handle，支持平滑平移与放大居中动画。

2. **知识库主视图（`KnowledgeView.tsx`）**：
   - **顶部工具栏**：提供关键词实时搜索框 + 标签 / 作者 / 可信度 / 平台下拉单选过滤 + 统计徽章（卡片数 · 主题簇数）+ 重置按钮；
   - **详情抽屉（Drawer）**：右侧滑出卡片全文面板，格式化呈现核心论点列表、事实核查三桶（✅ 证实 / ⚠️ 有出入 / ❓ 无法核实）、可复用经验、适用边界避坑、关联标的、显式关联卡片快捷跳转以及外部原始链接直达按钮；
   - **空态引导**：使用 `IconKnowledge` 矢量图标，提供「把 B 站视频或公众号文章链接发给助手，说"沉淀到知识库"即可入库」引导文案；
   - **状态持久化**：过滤器状态实时持久化于 `dshtrading.knowledge.view.v1`。

3. **中栏舞台扩展（`MiddleStage.tsx`）**：
   - `MiddleViewId` 扩充支持 `'knowledge'`，`MIDDLE_VIEWS` 注册表中并列展示；
   - 保持视图互斥挂载语义（切走即销毁 Canvas 实例，后台零重绘与内存开销）。

4. **视觉与国际化规范**：
   - 全面采用 `--dsw-futu-*` Futu 牛牛 Design Tokens，零内联硬编码样式与臆造变量；
   - 完备的 `knowledge.*` 与 `stage.knowledge` 双语字典支持（zh 与 en）。

## Alternatives considered

- **引入 react-force-graph**：
  - *落败原因*：多一层 React 包装，更新生命周期与 React 状态易产生不必要的 Canvas 重绘与性能损耗；原生包装更加灵活且与 TvChart 一致。
- **UI 端支持卡片增删改查编辑**：
  - *落败原因*：根据设计定稿，v1 保持 Agent-native 创作链路，卡片由 Agent 经工具严格校验入库，UI 端定位于只读浏览与探索。

## Consequences

- 中栏完整具备「行情 | 策略 | 知识库」三大核心交易研究视角；
- 打包构建产物 `lib/client.js` 包含完整的 `force-graph` 支持，全仓 21 个包构建与 438 个单测 100% 绿灯。
