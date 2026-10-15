# Agent Note: 桥层与连接器层四处重复定义的收敛（校验前奏、失效路由表、缓存协议、provider slug）

Status: implemented

## Problem

四处「同一事实写两遍以上」的实现面，都在热路径上：

- **桥的「市场 + symbol 校验前奏」被复制**：`packages/bot-api/src/bridge.ts` 里
  `!isMarketId(market)`、`market … is not installed`、`<方法>: symbol is required`
  三行一组逐方法重写。同文件早已抽出过同类守卫（`#requireTradeService`、
  `#requireRegisteredService`）。
- **「写成功 → emit(store)」表与桥的路由表平行维护**：失效规则写在
  `packages/bot-api/src/index.ts` 的若干 `(method, sub)` 条件里，而路径真值在
  `bridge.ts` 的 `dispatchBridgeRequest` 里。两边平行维护 ⇒ 将来只改 `bridge.ts`
  新增写端点时，客户端会静默不刷新、不报错。
- **桥层三套 TTL / 去重实现**：`symbolsCache` 是裸 `Map` + 内联新鲜度判断，
  `fundamentalsCache` / `southboundCache` 是两个 `TtlCache`，各自配一份独立 inflight Map
  并把「getFresh → inflight → job → set → finally delete」协议各写一遍。
- **多个连接器双声明 router provider slug**：`ROUTER_PROVIDER` 同时在 `src/index.ts`
  与 `src/dataplane.ts` 各写一份。两值一旦不一致，provider 名与用户设置的路由值对不上，
  该 provider **永不激活且不报错**（`packages/router` 对未知 slug 是 log warn 的 fail-soft）。

## Decision

四处各自收敛到单一真值；工具名、参数与输出形状不变。

1. **行情侧守卫收成三个私有方法**（`TradingBridge`）：
   `#requireMarketId`（`isMarketId` 校验 + 窄化）、`#requireMarketService`（active 解析 +
   未安装 400）、`#requireMarketServiceFor`（走既有 `#requireRegisteredService`）。
   10 个调用点接入：`tickers` / `klines` / `symbols` / `derivatives` / `derivativesHistory` /
   `orderbook` / `trades` / `news` / `fundamentals` / `southboundHoldings`。
   特例是各自语义，逐字保留：`tickers` 的显式 provider 分支（给了 provider 绝不回退 active）、
   `klines` 的跨源候选解析与空候选 400、`symbols` 在缓存前的 `listInstruments` 缺席早返回。
   `#requireTradeService` 与整条下单链路**未动**（受 `live-order:check` 门禁保护；
   `isMarketId` 至今只剩定义处、`#requireMarketId`、`#requireTradeService` 三处）。
2. **失效规则从桥的写路由表派生**：新增声明表 `BRIDGE_WRITE_ROUTES`（`bridge.ts`），
   每条 = `method` + `pathname` + **必填的 `invalidates`** + handler。
   表覆盖全部非 GET 路由 **28 条**（9 DELETE / 7 PUT / 12 POST），指向 6 个 store
   （`indicators` / `chart` / `strategies` / `watchlists` / `selection` / `holdings`）；
   交易台两条写端点（`POST` / `DELETE /trade/order`）显式声明空表 —— 报单撤单不改变任何
   客户端读面缓存。
   `dispatchBridgeRequest` 查表执行并把该声明随结果返回；`BridgeRouteResult` 是
   **联合类型**：写路由必带 `invalidates`，读路由（GET）不带。
   `index.ts` 只留「`status === 200 && payload.ok === true` 才逐 store emit」这道门禁，
   不再持有第二份 `(method, path)` 知识。
   漏声明失效在**编译期**是错误（`invalidates` 非可选），运行时另有 `resolveWriteRoute`
   兜底拒收；`test/bridge-invalidation.test.ts` 用 28 条逐端点用例 + 1 条结构用例钉住，
   结构用例同时断言 `BRIDGE_WRITE_ROUTES` 与期望表逐条一致 ⇒ 新增写端点不在那里登记即判红。
3. **缓存协议收敛**：`symbolsCache` 换用 `TtlCache`（30 分钟 TTL），
   `SYMBOLS_CACHE_MAX = MARKET_IDS.length`（=6）—— 键必过 `#requireMarketId`，键空间即
   `MARKET_IDS`，故驱逐循环永不触发，与旧裸 `Map`「永不驱逐」等价（换类的价值是消灭第三种
   TTL 语义，不是修内存问题：`symbolsCache` 从未无界）。
   两份「getFresh → inflight → job → set → finally delete」协议收成一个 `#cachedFetch` helper：
   TTL 命中直返 / 同键在途 `await` 同一 promise / 成功写缓存 / 失败清在途、不写缓存、原样抛。
   `symbols` 仍然**不带**同键去重（它从来没有，维持既有裁决）。三个读面的时长与上限逐项映射、
   未统一默认：`symbols` 30min、`fundamentals` 5min + 64、`southbound` 5min + 64。
   缓存类的所有权与逐项口径见
   [2026-09-09-fundamentals-cache-bounded-lru.md](../bug-fix/2026-09-09-fundamentals-cache-bounded-lru.md)。
4. **provider slug 单家**：16 个连接器的 `src/dataplane.ts` 改为从包主入口 import
   `ROUTER_PROVIDER`，删掉本地副本 —— `akshare` / `alpaca` / `bybit` / `ccxt` /
   `eastmoney` / `finnhub` / `fmp` / `futu` / `ibkr` / `longbridge` / `polygon` / `qmt` /
   `tencent` / `tiger` / `tushare` / `yahoo`。`connector-xysz` 是先例。
   逐包核对 `index.ts` 的值与 dataplane 原值一致，且各包加载图零变化
   （dataplane 原本就 import 同一 specifier，只是多取一个标识符；`tencent` / `yahoo`
   保留其既有的 `'./index.ts'` 写法）。
   本轮**不收敛**的四个包及各自动机：`connector-hithink`（3 文件，且 slug 另有 4 处内联
   凭证查找字面量，只收敛其中 2 处不彻底）、`connector-jin10`（slug 早已单家于
   `market-data.ts` 的 `JIN10_PROVIDER`）、`connector-polymarket`（无数据面入口）、
   `connector-template`（脚手架，slug 在 `src/` 内有 3 处；生成器 `scripts/new-connector.mjs`
   是纯文本 token 替换，模板有几处就产出几处）。

## 与提案的偏差（实测修正）

- 提案的「9 组写端点」不是真值：真值是 **28 条写路由**；旧 `index.ts` 那段是 11 组
  `(method, sub)` 条件（+1 条 `ok === true` 门禁）覆盖其中 26 条，另 2 条属交易台、本就不 emit。
- 提案的计数偏大：`is not installed` 实际 8 处（提案写 9）、`symbol is required` 实际
  9 处协议错误 + 1 处 `holdingsRejected`（提案写 11）。
- 第 2 项**不是省行数**而是净增：`bridge.ts` 2744 → 2938（+194），`index.ts` 463 → 446（−17）。
  声明表把 28 条路由逐条展开（约 185 行）换掉 133 行 if-chain，换来的是编译期必填与
  可枚举的负向用例。第 1、3 项各自是净减。若按行数取舍，可压成
  `write(method, path, invalidates, handle)` 位置参数形态（约省 84 行）。
- 多抽了第三个 helper `#requireMarketId`：它正好收掉 `news()` 那处，并被另两个内部复用。
- 第 4 项落在 16 个包而非提案的 15 个：多出的 `connector-yahoo` 与那 15 个同病
  （dataplane 持本地副本、`index.ts` 无该 export），且它的 dataplane 早已 import
  `'./index.ts'`，因此只是「加一行 export + 删本地副本」，加载面零变化。

## Alternatives considered

- **只给未覆盖的 emit 分支各补一条守卫测试、不动结构**：只治症状。测试能钉住当前一致，
  钉不住「新增写端点时忘了同步」——那正是这个结构制造的风险。
- **失效规则只导出查表函数（保留 if-chain，另加 `invalidateStoresFor(method, pathname)`）**：
  行数最省，且完全不改返回体（零测试改写）。落败：路由清单不可枚举，负向用例无法钉住
  「新增写端点必须登记」；且 handler 与声明分居两处，声明可能指向一条已不存在的路径。
- **第 4 项改由 `dataplane.ts` 反向导出、让 `index.ts` 去 import**：否决。`index.ts` 是包主
  入口（被 profile 行与工具注册消费），`dataplane.ts` 是数据面入口，反向依赖会把数据面拉进
  主入口的加载面。
- **把 `symbolsCache` 当内存泄漏、给它加驱逐策略**：不单列为目标。它的键空间有界，
  换 `TtlCache` 的价值只在消灭第三种 TTL 语义。
- **在 `@dshtrading/api` 或 `base` 放共享守卫（含连接器侧的 `routeAllows` 一族）**：否决，
  与既有裁决冲突 —— `2026-09-01-service-seam-order-gate.md` 已把「闸门逻辑 13 份」记为
  接受的代价，收益是连接器零跨包耦合。
- **本轮把 `connector-hithink` 与 `connector-template` 一并收敛**：留作后续。
  `hithink` 的 slug 另有 4 处内联凭证字面量，只收敛 2 处不算收敛干净，且其 `index.ts`
  当时正被另一并发会话改写；`template` 的正确形态是先让它复用已有的 `EXCHANGE_SLUG`
  常量（`export const ROUTER_PROVIDER = EXCHANGE_SLUG`，生成器无需改动），属脚手架词汇决定。

## Consequences

- 行为面零变化：工具名、参数与输出形状都不动；400 状态码与各专用 code
  （`TRADING_NO_TRADE_SERVICE` / `TRADING_NOT_IMPLEMENTED` / `TRADING_UNSUPPORTED_INTERVAL` 等）
  逐个保持 —— `BridgeProtocolError` 的（状态, 文案）键集合改动前后 51 = 51 相等，
  只有「同一文案被复制多份」的地方合并，文案本身逐字保留；`no such endpoint`（404）与
  `only GET/PUT/POST/DELETE`（405）兜底语义不变。
- `cordis.patch.yml` 未动，`patch-id` 契约行不受影响（第 4 项只改 `src/`）。
- 测试：`packages/bot-api` 28 个测试文件 / 318 用例全绿；新增
  `test/bridge-invalidation.test.ts`（28 逐端点 + 1 结构用例）与 `test/bridge-cache.test.ts`
  （三个读面各一条「TTL 内不打上游 / 同键并发只打一轮」，假时钟）；`test:audit` 无新增债。
- 16 个连接器包各自 `build` + `test` 全绿；`connector-dataplane:check` 仍是
  「23 个数据面入口都导出 Config schema；patch 引用的 24 条数据面行都可达」。
- 结构上不再可能「新增写端点却静默不失效」：漏声明在编译期红，运行时 `resolveWriteRoute`
  拒收，测试层结构用例也会红（实测：加一条不带 `invalidates` 的写路由 ⇒ `tsc` 报 TS2741
  且结构用例失败；拆掉守卫校验 ⇒ 该用例以 `expected [Function] to throw` 失败）。
- 遗留：`connector-template` 仍会把这处债带进新生成的连接器；`connector-hithink` 的 slug
  仍有 4 处内联凭证字面量。两者见 Decision 第 4 节。
