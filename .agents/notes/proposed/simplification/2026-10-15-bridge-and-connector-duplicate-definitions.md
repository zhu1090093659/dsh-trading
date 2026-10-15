# Agent Note: 桥层与连接器层的重复定义：校验前奏、失效路由表、三套缓存与双声明 provider

Status: proposed

## Problem

四处「同一事实写两遍以上」的实现面，都在热路径上，且都有同仓已成立的先例说明收敛可行：

- **桥的「市场 + symbol 校验前奏」被复制**：`packages/bot-api/src/bridge.ts` 里
  `!isMarketId(market)` 出现 **11 次**、`is not installed` **9 次**、`symbol is required`
  **11 次**，三行一组逐方法重写（`tickers` 860、`klines` 937、`symbols` 1005、`derivatives`
  1050、`derivativesHistory` 1070、`orderbook` 1090、`trades` 1109、`fundamentals` 1743 …）。
  同一文件早已抽出过同类守卫：`#requireTradeService`（1132-1138，内含 `isMarketId`）与
  `#requireRegisteredService`（872-879）——抽取路径存在且被用过，只有行情侧这一族没走。
- **「写成功 → emit(store)」表与桥的 45 分支路由表平行维护**：失效规则写在
  `packages/bot-api/src/index.ts:347-369`（9 组 `(method, sub)` 条件），而路径真值在
  `bridge.ts:2488-2741`。全仓只有 holdings 分支有守卫测试
  （`test/holdings-bridge.test.ts`），其余 8 组没有。当前两边一致（已逐分支核对，无漏发），
  所以这是「平行知识 + 漂移风险」而不是现存 bug——但将来只改 `bridge.ts` 新增写端点时，
  客户端会静默不刷新、不报错。
- **桥层三套 TTL / 去重实现**：`bridge.ts:807` 的 `symbolsCache` 是裸
  `Map` + `:1030-1037` 的内联新鲜度判断；`:808` 与 `:811` 是两个 `TtlCache`（fundamentals /
  southbound），各自配一份独立 inflight Map（`:1754`、`:1824`）并把
  「getFresh → inflight → job → set → finally delete」协议各写一遍。`src/ttl-cache.ts`
  的自述目标正是把这些收敛到一处（「写前清过期 + 命中提尾 + 超上限逐出」），只覆盖了两处。
- **15 个连接器双声明 router provider slug**：`ROUTER_PROVIDER` 同时在
  `src/index.ts`（供 `routeAllows` 用）与 `src/dataplane.ts`（供 `registry.register` 用）
  各写一份，实测 15 个包（akshare / alpaca / bybit / ccxt / eastmoney / finnhub / fmp /
  futu / ibkr / longbridge / polygon / qmt / tencent / tiger / tushare）。两值一旦不一致，
  provider 名与用户设置的路由值对不上，该 provider **永不激活且不报错**
  （`packages/router/src/index.ts` 对未知 slug 是 log warn 的 fail-soft）。
  `connector-xysz` 的 `dataplane.ts` 已经从 `./index.js` import 同一常量，证明该路径可行。

## Proposal

1. **桥的行情侧守卫抽成两个私有方法**：`#requireMarketService(market)`（`isMarketId` +
   `getMarketService` + 未安装 400）与 `#requireMarketServiceFor(market, provider)`（走
   `#requireRegisteredService`）。保留特例：`tickers` 的显式 provider 分支与 `klines` 的跨源候选
   是各自的语义，只替换它们共用的那三行。
2. **失效规则从路由表派生**：把 invalidate 作为 `dispatchBridgeRequest` 的返回值（或让 handler
   声明自己的失效 store），使 `index.ts` 不再持有第二份 `(method, path)` 知识。
   **必须保留**「写成功（`status===200 && payload.ok===true`）才 emit」与「业务拒绝不 emit」。
3. **`symbolsCache` 换用 `TtlCache`**，两份 inflight 协议抽成一个 helper。三个时长/上限
   （30min vs 5min、64 vs 64）是行为，必须逐项映射，不得统一默认。
   注意 `symbolsCache` 的键是 market（最多 6 条），**它不是泄漏**，别按泄漏论证。
4. **15 个 dataplane 改为从 `./index.js` import `ROUTER_PROVIDER`**，与 `connector-xysz` 对齐，
   删掉那 15 行副本。

## Context & Efficiency Impact

- 可省代码：守卫前奏约 40 行与 11 处同步点、失效表 24 行与 9 条同步条件、
  缓存协议约 45 行与 3 种 TTL 语义、provider 副本 15 行与 15 个静默漂移点。
- 无模型可见面变化：工具名、参数与输出形状都不动；`patch-id` 契约行不受影响
  （第 4 项只改 `src/`，不改 `cordis.patch.yml`）。

## Alternatives considered

- **只给 8 个未覆盖的 emit 分支各补一条守卫测试，不动结构**：可行但只治症状。
  测试能钉住当前一致，钉不住「新增写端点时忘了同步」——那正是这个结构制造的风险。
- **第 4 项改由 `dataplane.ts` 反向导出、让 `index.ts` 去 import**：否决。
  `index.ts` 是包主入口（被 profile 行与工具注册消费），`dataplane.ts` 是数据面入口，
  反向依赖会把数据面拉进主入口的加载面。
- **第 3 项把 `symbolsCache` 换成带驱逐的缓存**：不单列为目标。它的键空间有界（≤ 市场数），
  换 `TtlCache` 的价值在于**消灭第三种 TTL 语义**，不是修内存问题。
- **在 `@dshtrading/api` 或 `base` 放共享守卫（含连接器侧的 `routeAllows` 一族）**：否决，
  与既有裁决冲突——`2026-09-01-service-seam-order-gate.md` 已把「闸门逻辑 13 份」记为接受的代价，
  收益是连接器零跨包耦合；本提案只做 `bot-api` 包内的收敛与单个连接器包内的常量化，
  不引入跨包依赖。

## Verification & Gates

- 第 1 项：`pnpm --filter @dshtrading/bot-api test`；400 状态码与各专用 code
  （`TRADING_NO_TRADE_SERVICE` 等）必须逐个保持，只有文案允许合并。
- 第 2 项：为 9 组写端点各补一条「写成功 emit 一次、业务拒绝不 emit、GET 不 emit」的用例，
  照 `test/holdings-bridge.test.ts` 的 `emitted()` 写法；再加一条「新增写端点却未声明失效」的
  负向用例，确保结构上不可能忘。
- 第 3 项：`pnpm --filter @dshtrading/bot-api test` + 三个读面各一条「TTL 内不打上游 /
  同键并发只打一轮」的用例。
- 第 4 项：`pnpm --filter @dshtrading/connector-<pkg> build test` 逐个包跑；
  `pnpm build` 与 `pnpm test` 全量收口。
- 全项收口：`pnpm gates:all`。

## Risks

- 第 1 项动的是实盘相邻的读路径：`#requireTradeService` 处在下单链路上，受
  live-order-invariant 门禁保护，**本轮不得改动它**，只抽行情侧读路径。
- 第 2 项是接口改动（`dispatchBridgeRequest` 的返回值形状），会牵动 `index.ts` 的路由 handler；
  漏改会表现为「写成功但客户端不刷新」——比现在更难察觉，因此守卫用例必须与前两项同批落地。
- 第 4 项改 import 会把包主入口拉进数据面模块的加载图。仓内已有一个包这样做，
  但 `connector-hithink` / `jin10` / `polymarket` 的 `index.ts` 更重，逐个确认加载面后再改。
