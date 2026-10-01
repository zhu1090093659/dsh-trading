# 真实行情接线：三家交易所适配器、Node 内置 WebSocket、以及只有真跑才暴露的问题

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


## 真实快照源接上之后（2026-10-01，同日补完）

aggTrade 推流只有 tick、没有快照，所以对齐层永远停在 `unaligned` 并只缓冲。补上**公共 REST 快照**（`api.binance.com/api/v3/ticker/price`，无需凭据）与 `bootstrap` / `deliverSnapshot` 两个口子之后，真实链路第一次跑到 `aligned`：

    [feed] open: bootstrap delivered 2 snapshot(s)
    统计: {"connects":1,"reconnects":0,"messages":82,"badFrames":0,"heartbeatTimeouts":0,"state":"live"}
    对齐态: {"epoch":1,"alignment":"aligned","buffered":0,"bytes":0,"droppedTicks":0}

**这里暴露了一条真实部署必须遵守的约束**：中间那版冒烟只拉**一次**引导快照，15 秒后对齐态转 `stale` 并丢掉 58 条 tick —— 因为年龄预算 10s 而基准再没刷新过。**快照年龄预算必须 ≥ 快照刷新节奏**，两者不匹配时系统会（正确地）拒绝发布价格。真实部署里这一步是 kline 收盘或定时 REST 拉取；冒烟里改成每 5s 刷新（预算 10s）后即 `aligned` 且 `droppedTicks: 0`。

两个新口子的分工：`bootstrap(symbols)` 在连上后拉一批基准（失败只记事件、不打断流）；`deliverSnapshot()` 供外部周期刷新（真实部署可以是 kline 收盘事件）。两者都直接喂对齐层，不经过传输层。


## 第二家适配器：OKX（同日补完）

卡片给的优先级是 Binance → OKX → Bybit → CCXT。做第二家的价值不在"多一家"，而在**它走的是另一条路径**：

| | Binance | OKX |
|---|---|---|
| 订阅形态 | 流名写在 **URL** 里 | 连上后发**订阅帧** |
| 基准（快照） | aggTrade 没有基准 ⇒ 需 REST 轮询 | `tickers` 频道**持续推送最新价** ⇒ 基准自动刷新 |
| 世代号 | 无（用连接世代顶替） | 无（同上） |

第二条差异正好解掉了上一轮实测出来的约束（"快照年龄预算必须 ≥ 快照刷新节奏"）：**把 venue 自己的 ticker 频道当作基准刷新源**，比定时 REST 轮询更省、更及时、也更少被限频。

真实冒烟（`node packages/tradectl/drill/okx-smoke.ts`）：

    connecting: wss://ws.okx.com:8443/ws/v5/public
    [feed] open: transport open
    统计: {"connects":1,"reconnects":0,"messages":227,"badFrames":4,"heartbeatTimeouts":0,"state":"live"}
    对齐态: {"epoch":1,"alignment":"aligned","buffered":0,"bytes":0,"droppedTicks":0}

**注意 `badFrames: 4`**：那四条是订阅确认帧（`{"event":"subscribe",...}`），我的解码器对"事件帧"与"畸形帧"都返回 undefined，于是被计入坏帧。这是个**已知的粗糙处**（后续应让解码器区分 ignored 与 malformed），不是数据丢失——本轮如实记下，不假装它是 0。

订阅帧按**标的**拆（一个标的一帧、含 trades + tickers 两个 arg）：ws-feed 的 `subscribePayload` 本来就是逐标的调的，适配器顺着端口的形状走，比让端口为某一家交易所改形更划算。


## 第三家适配器：Bybit（同日补完）

第三家的价值是**第三种帧形状**：

| | 语义来源 | `data` 形状 | 保活 | 订阅 |
|---|---|---|---|---|
| Binance | `e` 字段 | 对象（combined 包裹） | 协议级 ping | 流名在 URL |
| OKX | `arg.channel` | **数组** | **文本** `ping` | JSON 订阅帧 |
| Bybit | `topic` | tickers 是**对象**、publicTrade 是**数组** | **JSON** `{"op":"ping"}` | JSON 订阅帧 |

三种形状都走通了，"解码钩子 + 逐标的订阅帧"这个端口设计才算真的被验证过——如果只做一家，端口是照着那一家的样子长的，换一家就要动端口。

真实冒烟（`node packages/tradectl/drill/bybit-smoke.ts`）：

    connecting: wss://stream.bybit.com/v5/public/spot
    [feed] open: transport open
    统计: {"connects":1,"reconnects":0,"messages":97,"badFrames":2,"heartbeatTimeouts":0,"state":"live"}
    对齐态: {"epoch":1,"alignment":"aligned","buffered":0,"bytes":0,"droppedTicks":0}

`badFrames: 2` 同样是订阅确认帧（与 OKX 那 4 条同源，属已知粗糙处）。

**三家真跑汇总**：Binance（URL 订阅 + REST 基准）、OKX（订阅帧 + tickers 基准）、Bybit（订阅帧 + tickers 基准对象形状）——三家的 `alignment` 都到过 `aligned` 且 `droppedTicks: 0`。


## 第四家：CCXT 快照适配器（同日补完，卡片清单齐）

卡片列的四家是 **Binance → OKX → Bybit → CCXT**。前三家是原生 WS 适配器；CCXT 的角色是**聚合兜底**（一次 REST 拿一个可信的最新价），所以它只产快照、不产 tick。

### 关键设计：**本模块不 import ccxt**

理由有三条，都写进了模块头注：

1. 依赖已在仓里（`packages/connector-ccxt`），但那是 **host 平面**的连接器包；
2. 把 ccxt 装进 `@dshtrading/tradectl` 会把它拖进 **bot 平面的安装闭包** —— P1 实测的那条边界（bot 54 包 / GUI 195 包，差 141 包 47.2MB）会被吃掉一大块；
3. 于是走与 `FeedTransport` / `PumpScheduler` 同一套做法：**端口注入**。谁装 ccxt 谁构造 exchange 传进来，核心只认一份**契约子集**（`fetchTicker` 返回的 `last` 与 `timestamp` 两个字段 —— 依赖面越小，ccxt 升级时越不容易碎）。

**当场验证**：加了适配器之后 `pnpm plane:check` 仍报"bot 平面闭包 18 包（零 client-ui-*、零 UI 重依赖）" —— 设计目标不是嘴上说的。

### 容错语义（与"先缓冲后发布"配套）

`createCcxtSnapshotSource` 的形状与 `FeedOptions.bootstrap` 一致，可以直接接进 ws-feed；三类情况**都不抛**：某只标的 fetchTicker 抛错 ⇒ 跳过它；返回里没有可用 last（空值/NaN/≤0）⇒ 跳过它；没有 timestamp ⇒ 用注入时钟（时间来自交易所时以交易所为准）。**聚合兜底的价值就在于"能拿到几只算几只"，而不是整批失败。**

测试 4 例（契约假件，无网络无 mock 框架）：映射正确且 epoch 如实传递；单只失败/价格不可用 ⇒ 跳过其余照常；无 timestamp 用注入时钟且字符串价格能解析；只产快照不产 tick。

## 未验证项（如实标注）

- **四家齐**：Binance / OKX / Bybit 均真跑验证到 aligned；**CCXT 为注入式快照兜底**（不引依赖，见下节）。
- ~~快照源未接~~ **已接**（公共 REST + bootstrap/deliverSnapshot），真实链路已到 aligned；剩下的约束是**刷新节奏必须 ≤ 年龄预算**（见上）。
- **epoch 语义**：Binance 公共流不提供世代号，适配器把"连接世代"当作 epoch；这与"交易所侧真实世代"不是一回事，交易所重连后的市场状态连续性未验证。
- **交易所侧限制未实测**：Binance 的 24h 断连、单连接订阅上限、限频权重；OKX 的 30s 无互动断连（需文本 ping）都未核对。
- **解码器无法区分"事件帧"与"畸形帧"**：订阅确认等事件帧被计入 badFrames（OKX 冒烟里 4 条），后续应把返回值扩展成 ignored/malformed 两类。
- **未接真实下单通道**（本阶段不该接）：shadow/paper 边界不变，仍然零 venue 写。

## 被否决的方案

- **引 `ws` 第三方包**：Node ≥22 已内置 WebSocket，多一个依赖换不来什么。
- **在适配器里各写一套心跳重连**：见事实第一条。
- **为了冒烟好看给 aggTrade 流塞一个假快照**：那会让"先缓冲后发布"这条不变量在真实环境里第一次就失效。
