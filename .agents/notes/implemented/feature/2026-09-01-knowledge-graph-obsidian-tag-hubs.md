# 2026-09-01 知识库图谱 Obsidian 化：tag-hub 拓扑 + 力学/标签策略重调

Status: implemented

## 问题

215 卡真实数据下图谱不可读：全画布挤成一团、标签互相覆盖、力导模拟高速发散（"非常快"）。

## 根因

`buildGraph` 对 co-tag / co-author 做 **全配对** 边生成（O(n²)）。本次批量沉淀 212 张
同作者卡片后：所有卡共享作者 "艾丽的无废话财经" 与公共标签，实测产生约 2 万+ 条边。
力导模拟被海量边驱动发散（视觉上"非常快"），节点全被拉向质心（"糊成一团"）。

## 方案（参考 Obsidian graph view）

1. **数据层**（packages/knowledge）：`buildGraph` 新增 `tagHubs` 模式——标签聚合为
   独立 hub 节点（id `tag:<名>`、`type:'tag'`），卡片仅与自己的标签建边（新边类型
   `tag-hub`）+ 显式 related 边；hub 模式下不做全配对。边数从 O(n²) 降为
   O(卡数×平均标签数)（212 卡：~2 万边 → ~500 边）。`coTag/coAuthor` 旧模式保留
   （`tagHubs` 缺省 false，旧测试/调用方行为不变）。
2. **渲染层**（client-ui-knowledge）：
   - 力学：`d3VelocityDecay 0.45`（高阻尼）+ `d3AlphaDecay 0.028`（快收敛）+
     自定义 collide 斥力（手工 O(n²) 实现，force-graph 未内建）+ 斥力/连距按 hub
     拓扑调优；`onEngineStop` 后自动 `zoomToFit`——打开即稳定全览。
   - 标签策略：hub 标签常显（#名）；卡片标签仅 zoom>1.6 或 hover/选中显示——
     215 个标题常显必然互叠（Obsidian 同款渐进显示）。
   - 节点视觉：卡片=实心圆（主题簇色），hub=空心环（灰蓝），视觉分层一眼可分。
   - 交互：点 hub 节点 = 切换标签过滤（新 prop `onTagClick`，Obsidian 点标签即聚焦）。
3. **回调 ref 化**：`onSelectCard/onTagClick/selectedCardId` 改经 ref 读取，effect 依赖
   收敛为 `[data]`——修复"点选卡片导致图谱实例重建、布局重置"的隐性问题。

## 取舍

- hub 模式丢掉了 co-author 全配对信息（同作者关系不再有边）——作者已有独立过滤
  下拉，边化收益远低于可读性成本；后续若需要，可对小组作者（≤10 卡）恢复全配对。
- collide 力为手写 O(n²)，数百节点量级无压力；十万级需换 quadtree。

## 验证

- packages/knowledge 19/19（新增 3 个 hub 模式测试：hub 结构、related 保留、
  单作者大库线性边数 200 vs 全配对 4950）。
- 全仓 643/643 通过；`pnpm build` 后 profile 副本硬链接 inode 一致，重启实例生效。
