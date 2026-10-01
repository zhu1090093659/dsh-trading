# 行情源并存契约：缺席 capabilities() 即 snapshot-only

日期：2026-10-01 · 阶段：P3 步骤 4 后半 · 卡片：317a623f · 包：`@dshtrading/tradectl/market-source`

## 事实

- **能力探测默认安全**：对象上有 `capabilities()` 且**字面量** `streaming === true` 才判为流式；其余全部 snapshot-only —— 包括：没有这个方法、方法抛错、返回非对象、`streaming` 不是字面 true、服务本身不存在。每条路径都给出 reason（审计要能看到"为什么这么判"）。
- **缺席按 snapshot-only 的立意**：反过来默认（"没声明就当它能推流"）会让任何还没跟上新契约的既有连接器被当成推流源，然后在没人注意的路径上给出不完整的数据。默认必须是安全的那一侧。
- **零改动接线**：`attachMarketSources` 只对**流式**源调用 registry 的 `register`；snapshot-only 的源原样留在原路径，适配器不包装、不修改传入对象（测试断言连接器的键集不变、`capabilities` 仍为 undefined）。
- **结构面而非类型依赖**：只依赖 `register/list` 这类最小形状（`MarketSourceRegistryLike`），不 import 既有 registry/router 的类型——于是它们的实现可以独立演进；单机形态用 `createMemorySourceRegistry`（同形）。
- **dispose 撤回全部注册**：不留下悬挂的流式源。

## 测试（8 例新增，tradectl 累计 104 例全绿）

没有 capabilities() ⇒ snapshot-only（理由文本断言）、显式 streaming=true 才流式、capabilities() 抛错 ⇒ snapshot-only、四种畸形声明（字符串/非字面 true/显式 false/null/undefined）全部 snapshot-only、五个源里只有一个进注册表且其余进 snapshotOnly 名单、dispose 清空、接线不修改传入对象、没有流式源时注册表为空且不报错。纯函数 + 内存 registry，无 mock 无 sleep。

## 未验证项（如实标注，本步只做了并存契约这一半）

- **真实 WS 传输仍未实现**：Binance → OKX → Bybit → CCXT 的订阅、重连、心跳、限频都还没写；本轮落地的是"谁算流式源、怎么接进既有 registry"的契约层。
- **与真实 tradingMarketDataRegistry / tradingMarketRouter 的接线未做**：本轮用同形结构面 + 内存 registry 验证契约；真实接线要在 bot/核心进程里落地。
- 卡片禁止的"股票市场伪 WS"未涉及。

## 被否决的方案

- **默认按流式**：任何未跟上契约的连接器都会被当成推流源（默认必须安全）。
- **capabilities() 抛错就认为它有能力**：把故障当能力，是最糟的一种"宽容"。
- **适配器包装 snapshot 连接器以统一接口**：那正是"既有连接器零改动"要避免的——包装会让它们的身份与生命周期变得含糊。
