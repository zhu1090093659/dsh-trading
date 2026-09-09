# Agent Note: knowledge_graph 工具改只计数通道（不再物化 O(n²) 边对象）

Status: implemented

## Problem

`knowledge_graph` 工具（`packages/knowledge/src/plugin.ts:71`）每次调用执行默认模式 `buildGraph(cards)`——co-tag + co-author 全配对、物化全部节点与边对象——却只取 `nodes.length` 与 `links.length` 两个数字，其余全部丢弃。graph.ts 头注自证规模：215 卡 ≈ 2 万+边。且 AGENTS.md 交易会话守则把它定为每次正式分析的第一个工具调用，频率真实、随库增长。

## Decision

`graph.ts` 新增 `countGraphSummary(cards)`：related 边键去重 O(E)、co-author 边按作者分组 Σk(k-1)/2（同作者对唯一，空/manual/手工 不参与，与 buildGraph 同口径）、co-tag 边按标签索引逐标签枚举对并全局去重 O(Σ k_t²)；`nodeCount = cards.length`（默认模式节点与卡一一对应）。工具输出字段与数值与改前**严格一致**（等价性由测试锁定）。

## Alternatives considered

- **输出砍掉 edgeCount/nodeCount**：改 agent 面工具输出契约，且丢掉库密度信号；`cards` 字段确实与 nodeCount 恒等（冗余），但契约冻结优先，否决。
- **tagHubs 模式取数**：hub 节点改变 nodeCount 语义，输出数值口径突变，否决。
- **按卡数缓存结果**：store 无 revision 面，用卡数+updatedAt 拼键有陈旧风险；计数通道已足够快，不引入缓存，否决。

## Consequences

- 实测（`spikes/bench-knowledge-graph-count.mts`，7 轮取中位数，含等价校验）：215 卡 1.98ms → 0.39ms（5.1×）；1000 卡 39.3ms → 10.2ms（3.9×）；3000 卡 428.6ms → 172ms（2.5×），且不再逐次物化 ~96 万边对象（GC 压力消除）。worst-case 复杂度同为配对级，收益在常数因子与零分配。
- 测试：`graph.test.ts` 新增 countGraphSummary 等价套件——5 组确定性伪随机卡集（0/1/17/64/215 卡，含多标签重叠/同作者/related 互指/悬空 related/manual 排除）与 buildGraph 逐值相等断言 + 空库/自指/重复标签边角例；包级 30 用例全绿。
- 剩余风险：buildGraph 默认模式边语义若日后变更，countGraphSummary 须同步——等价测试会当场捉住漂移。
