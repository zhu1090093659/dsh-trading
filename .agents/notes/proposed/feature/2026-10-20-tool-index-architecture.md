# Agent Note: 工具面改为索引式架构（trading_tools_index）

Status: proposed

## Problem

交易 profile 的会话一次注入 97 个工具 schema（6 个市场 × 12 个行情/账户工具 ＋ holdings / watchlist / strategy / screener / indicator / knowledge / tasks / news / flash / econ / fx / routing 等族）。模型每次请求都要把这 97 份 schema 读完才能决定调哪个，代价有三：

1. **上下文成本**：97 份 schema 的描述文本常驻，挤占真正用于分析的预算。
2. **选择成本**：命名同构（`cn_get_ticker` / `hk_get_ticker` / `us_get_ticker` …），模型容易在相似的族之间选错，或在只需一族时被其余族的描述干扰。
3. **维护成本**：新增一族就要再摊一份 schema，成本随族数线性增长，没有收敛机制。

用户的要求是：参照 `~/.agents` 的索引式架构重新组织工具注入。

## Decision

把工具面切成**两级**，第一级先落地、零回归：

**第一级（本次已实现）——索引层 `trading_tools_index`**

- `~/.agents/AGENTS.md`（场景 → 读哪个文件）对应 `trading_tools_index`（场景 → 用哪一族工具）。
- `~/.agents/harness/*.md`（按场景拆的细则）对应各工具族的 `whenToUse` ＋ 族内工具的 description。
- 索引**不是硬编码清单**：每次调用从 `ctx.tools.schemas()` 现读现算，因此永远等于真实注册面。测试把「覆盖全部注册工具且不重复」写成契约断言，堵住漂移。
- 19 个族级场景说明；未登记的新族回落为原前缀，不报错。
- 纯增量：不隐藏、不改名、不动任何既有工具。现有会话、skill 引用、用户肌肉记忆全部不受影响。

**第二级（未实施，待批准）——折叠注入面**

宿主已内置两条可用通路，二者都不需要改 dsh-trading 的 97 个工具：

| 通路 | 机制 | 代价 |
|---|---|---|
| `@deepseek-ai/dsh-agent-tool-presentation` | 每预设一行 `mode: native \| ptc \| both`；`ptc` 只发 `run_code` ＋生成的 TypeScript SDK，其余按 SDK 子调用派发 | 模型改用代码式调用，全部既有 prompt/skill 的调用习惯要改 |
| `ToolRestriction { allow, deny }` | 每作用域过滤全局工具可见性；"allow 里的保留，其余移除" | 需要把族选择变成会话内动作（切换 allowlist），行为更接近 `~/.agents` 的「命中才读」 |

第一级落地后，第二级可以按族灰度：先折叠使用频率最低、族内工具最多的几个市场族，观察是否出现「模型不知道有这族」的漏调，再扩大。

## Alternatives considered

- **直接开 `ptc` 模式**：能一步把 97 份 schema 压成 1 份，但会同时改变四种角色的调用范式，且模型必须学会 SDK 写法；在没有索引层兜底时，漏调风险最高。否决为第一步。
- **把 6 个市场的同构工具合并成带 `market` 参数的单一工具**（如 `market_get_ticker(market, symbol)`）：schema 数量降为 1/6，但会让所有既有 skill 里的 `cn_get_ticker` 等引用全部失效，且用户已形成的工具语义被打破。否决。
- **只写一份静态工具清单文档**：不解决「模型怎么知道该读它」，且清单会漂移。否决，改为现读现算。

## Consequences

- 每次不确定用哪个工具时多一次 `trading_tools_index` 调用；换来的是不必先读 97 份 schema。净收益随族数增长而扩大。
- 索引的 `whenToUse` 变成需要维护的资产：族说明写错了会误导路由，因此族说明必须与该族工具职责同步演进（本次已把「持仓」语义唯一归给 holdings 族，避免 cn/hk 等族的说明互相渗透）。
- 第二级折叠是可选增强，不落地也不影响第一级的正确性。
- 回归风险：零（纯增量新增一个工具 ＋ 每个预设一行）。已在任务分支 `feat/tool-index-architecture` 通过 7/7 单测与运行时模块加载验证。

## 验证证据

- 单测：`packages/base/test/tool-index.test.ts` 7/7 通过（覆盖契约、分族、query 路由、family 单选、未登记族回落、brief 截断）。
- 运行时：`tsx` 直接加载模块，`total/matched = 8/8`、`query 持仓 -> holdings`（首位）、`family holdings -> ["holdings_list","holdings_stage"]`。
- 提交：`df7b78a3` on `feat/tool-index-architecture`（基于 main `423cfd03`）。
