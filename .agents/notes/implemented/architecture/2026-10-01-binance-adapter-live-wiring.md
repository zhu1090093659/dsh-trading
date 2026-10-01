# 真实行情接线：Binance 适配器、Node 内置 WebSocket、以及两个只有真跑才暴露的问题

日期：2026-10-01 · 阶段：P3 步骤 4 · 卡片：317a623f · 包：`@dshtrading/tradectl/{adapters/binance,transport/node-ws}`

## 事实

- **适配器只做三件事**：拼 URL、把交易所帧映射成 `FeedMessage`、声明"订阅在 URL 里"。策略（心跳/重连/限频/坏帧）全在 ws-feed.ts —— 三家交易所共用一套策略，各写一份必然出现三份行为不一致的实现。
- **用公共市场流**（`wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/...`），不需要任何交易凭据、不涉及私有接口 —— 所以它能在没有凭据的环境里真跑。
- **Node 内置 WebSocket**（Node ≥22 的全局 `WebSocket`）做传输绑定，**不引第三方 ws 包**。

## 真实冒烟（`node packages/tradectl/drill/binance-smoke.ts`）

    connecting: wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade
    [feed] open: transport open
    统计: {"connects":1,"reconnects":0,"messages":235,"badFrames":0,"heartbeatTimeouts":0,"state":"live"}
    对齐态: {"epoch":null,"alignment":"unaligned","buffered":235,"bytes":30080,"droppedTicks":0}

## 真跑暴露的两个问题（离线测试发现不了，都已修）

1. **feed 没有解码钩子**：我给适配器写了 `parseBinanceFrame` 却无处可接 —— 第一版冒烟里 **每一帧都被算成坏帧**（Binance 的字段是 `e/s/p/T` 而不是我们的 `kind/epoch/symbol/price/atMs`）。离线测试发现不了，因为测试喂的本来就是自家格式。修法：`FeedOptions.decode(text, epoch)`（缺省仍是内置解析器），适配器必须传自己的解码器。
2. **乱序判定是全局的**：`lastSeq` 只有一个，两个标的交错时互相干扰 —— 真实冒烟里 **26 条 tick 被误判成乱序丢弃**。改成 `lastSeqBySymbol`（按标的各记各的）后 `droppedTicks: 0`、`messages: 235`、`badFrames: 0`。（离线测试没用多标的交错场景，所以没抓到 —— 这条已作为测试盲区的教训记下。）

## 对齐态为什么是 unaligned（正确行为，不是缺陷）

aggTrade 流只有 tick、**没有任何快照**，所以对齐层按"先缓冲后发布"把 235 条 tick 全部缓冲、一条都不发布 —— 这正是设计要的：没有基准就不对外给价格。它也指出了适配器**还缺的东西**：Binance 侧的快照源（kline 收盘 `x:true` 已支持，或 REST ticker），接上之后才会进入 aligned。

## 未验证项（如实标注）

- **仍只有 Binance 一家**：OKX / Bybit / CCXT 适配器未写（端口与策略已就绪，各自只差 URL、订阅形态与字段映射）。
- **快照源未接**：见上，所以真实冒烟里对齐层停在 unaligned 且不发布（刻意的）。
- **epoch 语义**：Binance 公共流不提供世代号，适配器把"连接世代"当作 epoch；这与"交易所侧真实世代"不是一回事，交易所重连后的市场状态连续性未验证。
- **交易所侧限制未实测**：Binance 的 24h 断连、单连接订阅上限、限频权重都未核对。
- **未接真实下单通道**（本阶段不该接）：shadow/paper 边界不变，仍然零 venue 写。

## 被否决的方案

- **引 `ws` 第三方包**：Node ≥22 已内置 WebSocket，多一个依赖换不来什么。
- **在适配器里各写一套心跳重连**：见事实第一条。
- **为了冒烟好看给 aggTrade 流塞一个假快照**：那会让"先缓冲后发布"这条不变量在真实环境里第一次就失效。
