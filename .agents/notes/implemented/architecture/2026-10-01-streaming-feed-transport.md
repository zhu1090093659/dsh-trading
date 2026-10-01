# 流式行情传输层：策略与传输分离，心跳超时立即退避

日期：2026-10-01 · 阶段：P3 步骤 4（缺口补齐）· 卡片：317a623f · 包：`@dshtrading/tradectl/ws-feed`

## 事实

- **传输是可注入端口**（`FeedTransport`：connect/send/close + 四个回调），订阅/心跳/重连/限频/解码这些**策略**留在本模块。于是交易所适配器只剩"怎么连、怎么订阅"这一层薄适配，而策略层可以离线完整测试（注入传输 + 注入时钟 + 可手工推进的调度器 ⇒ 无网络无 sleep）。
- **每条消息必须带 epoch**，传输层只把世代号**如实下传**给对齐层，不越权判断世代——世代守卫只有一处（alignment.ts）。
- **心跳超时 = 失败**：`heartbeatTimeoutMs` 内没有任何消息就主动断开并**立即进入退避**。这里有个实测抓出来的坑：第一版只调 `transport.close()` 然后等传输回调 `onClose` 触发重连——但那个回调可能永远不来（半开连接、传输实现有 bug），连接就会停在"看起来还活着"的状态，而这是最危险的一种静默。改成主动断开 + 立即安排重连，并用"世代号 + 去重闸门"保证随后的 `onClose` 不会排出第二次重连。
- **重连指数退避 + 封顶**，且每次连接（含重连）都消耗一个**订阅令牌**：预算打空时宁可晚点连，也不去打爆交易所的限频。订阅预算与下单预算互相独立（§13 #14）。
- **坏帧隔离**：解析失败只计数并记事件，不抛、不打断整条流（一条畸形帧不该让行情面整体失效）。

## 测试（8 例新增，tradectl 累计 121 例全绿）

帧解析（合法/坏 JSON/非对象/未知 kind）、连上后逐标的发订阅并喂进对齐层、**心跳超时触发断开与重连并如实计数**、坏帧计数但不影响后续好帧、重连指数退避、**订阅预算打空后不再连接**、stop 后不再重连、epoch 变化由对齐层判定（传输层不越权）。假传输是契约假件（只实现文档化的四个回调），调度器可手工推进——无 mock 框架、无 sleep、无网络。


## 后续细化：解码器区分「事件帧」与「畸形帧」（2026-10-01 同日补完）

原文里记的粗糙处（订阅确认帧被计入 badFrames）已经修掉。解码器的返回值现在是三态：

| 返回 | 含义 | 计数 |
|---|---|---|
| FeedMessage | 数据帧 | 走对齐层 |
| **ignored** | **认识但无需处理的事件帧**（订阅确认、pong） | ignoredFrames |
| undefined | 真的解析不了 | badFrames |

**为什么值得单列一类**：把事件帧混进坏帧会让监控失去意义 —— badFrames 应当表示「要么协议变了、要么有人在乱发」，而不是「交易所回了句 pong」。OKX 的 event 帧、Bybit 的 success/op 帧与两家的 pong，现在都归入 ignoredFrames。

测试补了一例：一帧 ignored + 一帧畸形 + 一帧好数据 ⇒ messages 3 / ignoredFrames 1 / badFrames 1（三类互不混淆）。tradectl 累计 **131 例全绿**。

**仍未验证**：ignoredFrames 在真实 OKX/Bybit 连接上的实际计数未复核（此前实测是 OKX 4 条、Bybit 2 条确认帧，改成 ignored 后应当记在 ignoredFrames 而不是 badFrames）——下次跑冒烟时核对。


## 真实连接复核（2026-10-01 同日，三家实测）

    # OKX    统计: {"messages":203,"badFrames":0,"ignoredFrames":4,"state":"live"}  对齐态: {"alignment":"aligned","droppedTicks":0}
    # Bybit  统计: {"messages":95,"badFrames":0,"ignoredFrames":2,"state":"live"}   对齐态: {"alignment":"aligned","droppedTicks":0}
    # Binance 统计: {"messages":75,"badFrames":0,"ignoredFrames":0,"state":"live"}  对齐态: {"alignment":"aligned","droppedTicks":0}

改前的 4 条（OKX）与 2 条（Bybit）确认帧，现在如实记在 `ignoredFrames` 上，`badFrames` 归零。Binance 是 0/0 —— 它的订阅在 URL 里、没有确认帧，pong 也是协议级的，这与设计一致。三家都 `aligned` 且 `droppedTicks: 0`。

## 复核过程中踩到的一个流程坑（值得记）

第一次复核时统计里**根本没有 `ignoredFrames` 字段** —— 因为 drill 脚本 import 的是构建产物 `lib/`：上一轮我只跑了测试与 typecheck，**没有 rebuild**，于是冒烟跑的是旧代码。**规矩：改完 `src/` 再跑 drill 之前必须先 build**，否则 drill 验证的是上一版行为（这类"验证了旧代码"的错误比不验证更危险，因为它给出的是假证据）。


## epoch 语义：快照世代号由 feed 盖章（2026-10-01 修掉一个静默停摆）

**发现的缺陷**：`ws-feed` 把快照的 `epoch` **原样透传**，而快照源（冒烟脚本、以及任何适配器）会自己填 —— 实际写法是**硬编码 `epoch: 1`**。

后果：**重连之后**，新连接世代（`generation = 2`）的 tick 带着 epoch 2，而引导快照仍带着 epoch 1 ⇒ 对齐层判定世代不符 ⇒ **永远停在 unaligned、一条都不发布**。这正是本系统最不能接受的那类故障：不报错、界面照常、数据静默不再流动。

**修法**：**由 feed 给快照盖章**（`epoch = generation`），覆盖快照源自带的任何值。理由：**"这条快照属于哪次连接"是 feed 独有的事实** —— 让每个适配器/脚本自己记，就必然出现硬编码（已经出现了）。`deliverSnapshot` 同样盖章：外部只负责"拿到一个价"，不需要知道当前是第几次连接。

**测试 2 例**：① 引导快照自带 `epoch: 999` 被覆盖为当前世代，随后同世代的 tick 能进入 aligned（若仍透传 999 则会 unaligned）；② `deliverSnapshot` 传 `epoch: 42` 同样被盖章。

**第一版测试自己写错了两处**（都已修，值得记）：给 fixture 传了多余的 `scheduler: undefined`（把手工调度器覆盖掉了）；以及**没有等待异步引导落地**就发 tick（`void bootstrap().then(...)` 是异步的，测试里必须显式等一个 `setImmediate`）。

## 未验证项（如实标注）

- **真实交易所适配器仍未写**：Binance / OKX / Bybit / CCXT 的 URL、订阅载荷、消息字段映射（→ `FeedMessage`）都还没有；本模块提供的是它们要实现的端口与策略。
- **真实 WebSocket 绑定未接**：没有引入 `ws` 或 `undici` 的 WebSocket；本轮只定义端口，真实实现是薄薄一层。
- ~~未在真实行情上跑过~~ **已在真实行情上跑过**：三家交易所冒烟到 aligned（见上），shadow 也有真实行情报告；但真实样本只有几十秒，不构成策略证据。
- 交易所侧的心跳/重连限制（例如 Binance 的 24h 断连、订阅上限）未实测核对，属适配器落地时的必做项。

## 被否决的方案

- **把策略写进适配器**：三家交易所各写一遍心跳重连，必然出现三份行为不一致的实现。
- **心跳超时只 close 等回调**：见上，会停在"看起来还活着"的状态（实测踩中并修掉）。
- **坏帧直接抛错**：一条畸形帧打断整条流，代价与收益不成比例。

### 空订阅载荷不再发送（2026-10-01 修掉一个库层隐患）

**发现过程**：写"环路 + 真实行情"演练时，真实流只收到 2 条消息且**全被判坏帧**、进入 backoff。直接打印原始帧看到 Binance 的回复：

    {"error":{"code":3,"msg":"Invalid JSON: EOF while parsing a value at line 1 column 0"}}

**根因**：`ws-feed` 在连接打开时**无条件**对每只标的发送 `subscribePayload(symbol)` —— 而 URL 式订阅（Binance）的适配器约定返回**空串**，于是发出一个空帧，被交易所当成畸形 JSON。**那个 error 帧会被算进"坏帧"，把真正的解码问题淹没。**

**修法**：空载荷不发（`if (payload !== '') send(payload)`）。测试 2 例：空载荷 ⇒ 一条都不发；非空载荷 ⇒ 按 symbols 顺序逐条发。

**顺带**：Binance 冒烟之所以一直是 `badFrames: 0`，是因为它 `symbols: []`（标的由 `bootstrapSymbols` 承担）—— 空循环自然什么都没发，**把这个隐患藏住了**。

### 未打通：环路 + 真实行情的装配演练

本轮尝试把**真实行情的对齐态**喂进环路（不涉真钱），**没打通**：对齐层在"直接构造 + feed 盖章 epoch"的组合下始终判 `stale`（`droppedTicks` 全量），即使快照只有 300ms 新鲜度；而 `binance-smoke` 用几乎相同的构造能到 `aligned` —— **差异未定位**。

**我没有把跑不通的演练提交进仓库**（已删除该文件）：留一个红着的 drill 比没有更坏。此事的准确状态是：**环路已由脚本化信号 + 真 DB 验证（desk-loop-drill），真实行情驱动尚未接通**。
