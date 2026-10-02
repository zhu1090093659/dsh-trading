# 行情对齐与录音-回放 harness：epoch 世代、先缓冲后发布、标的级价格状态、按实测标定的上界

日期：2026-10-01 · 阶段：P3 步骤 4 · 卡片：317a623f · 包：`@dshtrading/tractl/{alignment,replay-harness}`

## 事实

- **标的级价格状态**（2026-10-02 修，验收发现 F1/#3）：`snapshotAtMs` / `alignment` / `divergenceStrikes` **按标的分开记**（与既有的 `lastSeqBySymbol` 同构）；缓冲也按标的切片：某只标的的快照只补发**该标的**的缓冲 tick，分歧对账带 symbol、只降肇事标的。读状态只有 `state(atMs, symbol)`——漏传 symbol **直接抛错**，不返回任何"全局对齐态"。
  - 为什么必须这样：设计 §9/§13 #22 里 `alignment` 就是**标的级**词汇，运行期唯一接线按标的喂给 `openRiskAllowedFor`（`signals.alignmentOf(symbol)`）。第一版只有一个全局 `snapshotAtMs`/`alignment`，V3 探针（`/tmp/alignment-symbol-probe.mjs`）实测撞出三条：A) BTC 快照超龄 6s（预算 5s）⇒ 正确丢弃；B) 同一张过期 BTC 快照，但 ETH 在 t=6000 来了一张新快照 ⇒ **BTC tick 被 published**；C) **只有 ETH 快照**（BTC 从未有基准）⇒ BTC tick 也被 published。B/C 是同一类失效：异标的的新快照让本标的的陈旧价格重新变成"可信"。反方向则是单标的 DoS（一只标的的陈旧快照把整个 desk 判 stale，§9 明令只降肇事标的）。同一个"全局 vs 标的级"的坑在 `seq` 上已被真跑撞出并修过，快照年龄这次是探针撞出来的。
  - **通道级**事实仍然是全局（不是"异标的互相影响"）：epoch（一次连接一个世代，由 feed 盖章）、缓冲条数与字节的**全局界**、重对齐与下单令牌桶。
  - 观测与风控分离：`worstAlignment(atMs)` 是显式命名的聚合态（字段就叫 `worstAlignment`，没有 `alignment` 字段可被误用），**只用于观测/告警，不得作为发布或风控输入**。
- **epoch 世代守卫**：快照带来世代号；比当前更旧的快照忽略（世代不回退）；tick 的世代与通道不一致 ⇒ 丢弃 + 强制重快照；**新世代快照到达时旧缓冲整块丢弃**（不把两个世代混着发）。
- **先缓冲后发布**：还没有快照时 tick 只入缓冲、不发布；快照到齐后把同世代缓冲**按 seq 排序补发**（只补发这只标的的）。这条一开始写错了（没有快照就直接丢 tick），是测试抓出来的——丢掉的是真实的行情增量。
- **快照年龄检查**：快照存在但超过年龄预算 ⇒ tick 丢弃并转 `stale`（不能拿旧价当新价用）；**没有快照是"等"，不是"陈旧"**：没有基准的标的按 `unaligned` 兜底，tick 进缓冲等自己的基准，不发布、也不丢。年龄按标的判。
- **缓冲全局界**：条数与字节双界；越界即清空缓冲 + 强制重快照（不静默截断），事件日志留痕。全局界是通道级事实，越界后**所有标的**一起回到 `unaligned` 等新快照。
- **限频预算各自独立**：重对齐/快照一个桶、下单一个桶，互不影响（§13 #14：共享预算 = 打忙下单通道即可让 bot 降级）。
- **静默分歧探测器**：心跳对账相对差 > `divergenceBps`（50）**连续** N 次（2）⇒ DIVERGED + 丢该标的的缓冲 + 强制重快照 + 按 `stale` 对待；中间回到阈值内即清零连击（不是累计计数）。连击按标的记。
- **上界没有缺省值**：`AlignmentParams` 的年龄预算/条数/字节/令牌容量必须由调用方显式传入，`createAlignment` 不提供猜测缺省——否则"没标定"会看起来像"标定过"。

## 录音-回放 harness（卡片把它定为验收前提）

`runScenario(params, scenario)` 确定性回放五种可注入条件：① 快照延迟 `snapshotDelayMs` ② 乱序 `outOfOrderEvery` ③ epoch 变更 `epochChanges` ④ tick 洪泛 `tickFloodPerSec` ⑤ 预算占用 `snapshotBurst`；输出 10 项实测（发布/丢弃/强制重快照/峰值缓冲条数与字节/令牌授予与拒绝/分歧事件/健康间隔）+ 完整事件日志。单标的，标的由 `scenario.symbol` 指定（缺省 `BTC/USDT`）。

`runMultiSymbolScenario(params, scenario)`（2026-10-02 加）补上**多标的**这一维：每个标的有各自的 `snapshotDelayMs`（**null = 快照断供**）、`snapshotRefreshMs`、`tickEveryMs`，逐标的出实测（发布/只进缓冲/超龄丢弃/末态对齐/快照年龄）+ 断供标的清单 + 聚合态。为什么必须有：对齐态是标的级的，"一只标的断供或超龄、另一只健康"这一整类失效**在单标的场景里结构上跑不出来**——F3 就是这样漏掉一轮的。

标定口径的三次扩展（2026-10-02，§13 #23）：① `snapshotAgeSamplesMs` 逐条 tick 记快照年龄（只有一个 max 说不出"p99 余量多少"）；② `maxGlobalBufferTicks`/`maxGlobalBufferBytes` 报**全局**（所有标的合计）峰值——参数 `bufferMaxTicks`/`bufferMaxBytes` 比的本来就是 `buffer.length`，只报单标的切片会系统性偏小；③ `realignRequestedAtMs` + `peakDemandInWindow` 记重对齐**需求曲线**（桶容量要覆盖一个回填窗口内的峰值，不是总次数）。同时修了一处**少算**：`publishedTicks` 此前只数 `onTick` 直接发布的部分，快照到达后补发的缓冲 tick 一条都不计——断供窗口场景里"缓冲了多少、补发了多少"正是缓冲界的判据，少算会把界造成的丢失测成 0。注入侧另加 `epochChangeAtMs`（按真实退避梯子注入 N 次重连；旧实现只换一次世代）、`realignOnEpochChange`/`realignAtMs`、`MultiSymbolFeed.tickFloodPerSec`/`snapshotDelaysMs`（逐标的洪泛与到达抖动），全部是可选的，缺省行为与扩展前一致。

`calibrate(base, scenarios, headroom)` 把实测换算成建议常量，并逐条给出证据行，单标的与多标的场景可以混着传（`feeds` 字段判别），例如：

    bufferMaxTicks = ceil(maxBufferedTicks <实测> x 1.5) = <建议值>

**这就是"三个上界参数必须在 harness 上标定后才能写成常量"的落点**：常量不是手写的，而是可从实测追出来的；测试里断言建议值不小于实测最大值。

## 三个上界参数：已标定（§13 #23）

标定入口 `drill/calibrate-alignment.ts`（离线、确定性、无网络、无 sleep，约 7s）在录音-回放 harness 上注入五种故障并出三组实测与**上下档失效边界**：

- **年龄预算**：健康路径（刷新 5s + 到达抖动 0/300ms）下每条 tick 的快照年龄 p50/p99/max = 2400/5100/**5200**ms；需求 = max × 1.5 = 7800 ⇒ 取 **10s 档**。下侧边界实测：5s 档健康路径 40 条 tick 被判 `snapshot-stale`（正常行情被误丢）；上侧代价实测：7.5s/10s/15s/30s/60s 档在"快照已死"场景下分别多发布 92/192/392/992/2192 条（该丢的没丢）。
- **缓冲全局界**：断供窗口 30s（真实心跳超时）× 4 标的 × 100 条/秒/标的 ⇒ 每标的峰值 3000 条、**全局峰值 12000 条 / 1536000 字节**；需求 × 1.5 ⇒ 取 **20000 条 / 2560000 字节**。下侧边界实测：10k 档越界清空 1 次、丢 10001 条真实 tick（界造成的丢失按"无界回放共补发 12800 条"为基准度量）。
- **重对齐令牌桶**：重连风暴（退避梯子 9 次重连 + 4 次快照刷新失败，其中 t=15s 是相关双故障）在**任意 1s 回填窗口内的峰值需求 = 2 次**；需求 × 1.5 ⇒ 取 **容量 4**。下侧边界实测：容量 1 误拒 1 次合法请求；上侧实测：容量 4 把 50 次/秒的失控重试环压到 4 次，容量 64 则整串放行。

取值落点 `drill/alignment-params.ts`（单一来源，加载时断言 `snapshotAgeBudgetMs > SNAPSHOT_REFRESH_MS`），测量方法、命令、原始输出、逐条对应与**未验证项**见 `docs/design/alignment-calibration.md`（标定日期 2026-10-02，HEAD 522d79c0）。`test/alignment-params.test.ts` 直接跑标定入口逐条对账，手改常量即红。**这份标定是合成场景的**：真实行情录音尚未接入，生产常量仍需一次带真实录音的标定，换行情源/换交易所必须重标。

## 测试（2026-10-02 实测：tradectl 包内 33 文件 / 285 例全绿）

epoch 不一致丢 tick 并强制重快照、新世代清旧缓冲、更旧快照被忽略、无快照时只缓冲不发布、快照到达后补发、乱序 tick 丢弃、超龄转 stale、缓冲越界清空并强制重快照、重对齐与下单预算互不影响、令牌桶按时间回填、分歧探测连击判定、回到阈值内清零、harness 五种条件可注入并出实测、calibrate 的常量不小于实测且证据成行、参数拼错即抛错。纯函数 + 注入时钟，无 mock 无 sleep。

**标定回归**（2026-10-02 加）：`test/replay-harness-calibration.test.ts` 钉住新的测量口径（年龄分位落在"刷新 + 抖动"带内、全局峰值 = 各标的峰值之和而 `maxBufferTicks` 仍是单标的切片、`epochChangeAtMs` 按给定时刻注入 N 次换世代、重对齐需求按时刻记全、断供缓冲的补发计入发布、`calibrate` 按全局峰值取建议值）；`test/alignment-params.test.ts` 直接跑标定入口逐条对账 `drill/alignment-params.ts`，并断言"取值 = 实测 × 1.5 的最小档""下侧失效边界确实存在""参数文件与标定记录互相指向"。这三个文件在包内 scoped 跑（`npx vitest run test/alignment*.test.ts test/replay-harness*.test.ts`）：3 文件 / 39 例全绿，标定对账用例显式给 120s 超时。

**标的级回归**（2026-10-02 加，对应上面 A/B/C 三条探针）：A) 本标的快照超龄 ⇒ `snapshot-stale`；B) 异标的拿到新快照也不让本标的的旧价重新发布；C) 只有异标的快照时本标的 tick 不发布、态为 `unaligned`；ETH 新鲜 + BTC 陈旧各自独立判定；ETH 的快照只补发 ETH 的缓冲；分歧连击按标的隔离；`worstAlignment` 是聚合态且没有 `alignment` 字段；漏传 symbol 抛错。传输层同款回归在 `test/ws-feed.test.ts`（ETH 快照经 WS 到达也不会让 BTC 超龄的 tick 进入发布流）。离线多标的回放演练：`drill/multi-symbol-replay.ts`（断供 + 超龄两条场景，退出码即断言）。

## 未验证项（如实标注）

- **真实 WS 连接器已接**（Binance/OKX/Bybit 原生 + CCXT 兜底），但**长窗口稳定性未测**：只有 15 秒冒烟（三家 `badFrames: 0`）；交易所侧限额（Binance 24h 断连、单连接订阅上限、OKX 30s 无互动断连）没有实测记录。
- **股票市场"伪 WS"未涉及**（卡片禁止做）。
- **标定用的是合成场景，不是真实录音**：三组实测与全部档位失效计数都来自确定性回放，可复现但样本是合成的；单标的 tick 速率（100 条/秒）是量级判断而非本仓实测，快照到达抖动沿用设计 §3 的"交易所往返 p99 100–300ms"。**真实录制（交易所原始帧 → 回放）尚未接入**，所以 `drill/alignment-params.ts` 是演练标定值，生产常量仍需带真实录音的标定。
- **缓冲界的上侧没有实测边界**：界只影响内存，harness 里没有"界太大导致错误行为"的形态；年龄与重对齐的上侧都有实测，缓冲的上侧是内存策略选择（20k 条 × 128B ≈ 2.5MB）。
- **`realignRefillPerSec` 与下单侧预算未标定**：真实重连率的统计没有数据源；下单预算与本次三个上界无关。
- **`onHeartbeat` 的真实数据通路不存在**：与 venue 心跳对账的价格源（"venue 侧价格"从哪来）还没有接线，探测器的输入目前只有测试与 harness；分歧是标的级判定这件事在库层已钉住（带 symbol、按标的记连击）。

## 被否决的方案

- **没有快照就丢 tick**：丢掉的是真实增量（本轮实测踩中并修掉）。无基准 = 等，不是陈旧。
- **共享限频预算**：打忙下单通道即可让 bot 降级（§13 #14 明令）。
- **分歧用累计计数**：累计计数会让长时间的小偏离最终触发；改成连续计数。
- **给上界参数写缺省值**：会让"没标定"看起来像"标定过"，正是卡片禁止的猜测值。
- **全局 `snapshotAtMs`/`alignment`（"一个 desk 一个对齐态"）**：异标的的新快照会让本标的的陈旧价格重新发布，反方向是单标的 DoS；`alignment` 从设计起就是标的级词汇，全局态只是"只有一只标的时恰好对"。
- **保留一个没有 symbol 的 `state(atMs)` 让旧调用点继续跑**：那就是把缺陷留成默认路径——现在漏传 symbol 直接抛错，聚合观测只能显式走 `worstAlignment`。
