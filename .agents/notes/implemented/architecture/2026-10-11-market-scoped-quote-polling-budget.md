# Agent Note: 行情轮询的按市场预算执行（global 0 常驻）

Status: implemented

## Problem

金十（`global` 市场）的上游配额**按工具分池**，而 GUI 侧此前对每个市场用同一套固定间隔轮询：
聚焦一个全球品种即每 5s 一拍 `global_quote`，另有底部三条指数 5s、K 线 30s resync、自选面板
最新价 8s 与参考序列 60s——折算下来单品种一天上万次调用，远超该工具每日配额。owner 口径是
「金十不做价格源」：`global_quote` / `global_klines` 的 UI/价格路径预算为 **0 常驻**（数值与
分配口径的家在 dsh-trading-bot：`packages/tradectl/bin/feeds-budget.mjs` 与
`docs/guides/connectors-guide.md` 的「金十额度预算分配」节）。

缺两个东西：GUI 侧没有「哪个市场允许常驻轮询」的执行点（节奏散在五处调用点各写死一个常量），
连接器里那个 5s 常驻 `subscribeTicker` 也还留着——后来者接上去就能静默跑，超预算不响亮。

## Decision

1. **策略唯一家** `packages/client-ui-trading/src/client/quote-budget.ts`：
   `NO_RESIDENT_POLL_MARKETS = ['global']` + `residentPollMs(market, intervalMs)` +
   `residentTargetKeys(keyCsv)`。本仓只落**规则**，不复写数值——两仓各存一份字面量则漂移无从判定。
2. **`usePoll` 支持空档**：`intervalMs` 传 `null` 即不挂定时器，只在依赖变化与文档重新可见时
   各取一次（依赖变化＝挂载/切标的/切周期/切页签，回到前台＝用户手势）。按需取数由这一条语义承载。
3. **五处消费点全部接策略**：QuoteStage 报价头与底部指数（原 5s）、QuoteStage K 线 resync（原 30s）、
   MarketSidebar 最新价（原 8s）与参考序列（原 60s）、HoldingsPanel 盯市（原 30s）。无常驻预算的
   市场只在「视图行集/标的/盯市目标键变化」时按需取一次；其余市场节奏一个字没动。自选面板的
   行过滤用 `isResidentPollMarket`，盯市键过滤用 `residentTargetKeys`。
4. **连接器 fail-closed**：`createJin10GlobalMarketDataService` 的 `subscribeTicker` 显式抛
   `Jin10Error('TRADING_NOT_IMPLEMENTED')`，与「可选能力缺席 = 显式报错」的既有语义同款；
   `TICKER_POLL_MS` 与工厂的 `pollMs` 选项随之删除（本市场不存在「常驻 ticker 订阅」这件事）。
5. **交易台只读轮询按面板开关收紧**：`QuoteStage` 的 `refreshTradeDesk`（一次 Promise.all 打
   `/trade/positions`、`/trade/balances`、`/trade/orders`、`/trade/fills` 四个签名端点）只在
   **图表页签 且（交易台打开 或 实盘模式）** 时取数——面板关着时这四个响应没有渲染消费者
   （消费方只有 `OrderPanel` 与面板比例填单的 `currentPositionSize`/`availableCash`）；实盘例外是
   风险可见性优先于省请求。`tradeDeskOpen`/`tradeMode` 都在 `usePoll` 的 deps 里，打开面板那一刻
   即 tick（不等 15s 定时器），关掉即停。

## Alternatives considered

- **只把连接器 `subscribeTicker` 拒掉**：GUI 根本不走 `subscribeTicker`——它走 HTTP
  `/dshtrading/api/tickers` → 服务端 `getTicker`；只拒连接器拦不住真实泄漏（预算文档原先记的
  「经 `tradingGlobalMarketData.subscribeTicker` 被 QuoteStage 消费」这条因果链实测不成立，
  已在 dsh-trading-bot 的同一变更里纠正）。
- **给 global 降到「预算内频率」**：预算是 0 常驻，任何固定间隔都不合规；而降频到分钟级对盯盘
  也没有使用价值。按需取数才是这条预算的语义。
- **在 `api.ts` 传输层按「是否定时器发起」打标拒绝**：要给所有调用点穿参，且客户端无法自证
  「这一拍来自用户手势」，把判据建在调用方自我声明上是假门禁。
- **加手动刷新按钮**：要新增 i18n 键与按钮面，而 `usePoll` 的 visibilitychange 分支已经给出
  「回到前台各取一次」的按需语义。不引入新 UI 面。

## Consequences

- global 行情只在用户手势下取数；长时间盯着同一个全球品种不再自动刷新（预算=0 的预期语义，
  顶部价格与图表停在最近一次按需取数上）。
- 其它市场节奏不变；`NO_RESIDENT_POLL_MARKETS` 是黑名单形态，新市场默认常驻——要设零预算需显式登记。
- `subscribeTicker` 由「5s 轮询」变「抛错」：本仓无生产调用方（GUI 走 `getTicker`，kit / 策略 /
  工具面同理），破坏面只剩未来接线者——那正是要拦的对象。
- 判据：`packages/client-ui-trading/test/quote-budget.test.ts`（策略单测）、
  `quote-stage.smoke.test.tsx` 的「global 按需 / us 常驻」对照、
  `market-sidebar-idle-quiescence.test.tsx` 的按需取价断言、
  `connector-jin10/test/market-data.test.ts` 的显式拒绝断言。把策略名单清空做反向验证时，
  global 两条断言转红而 us 对照仍绿——断言绑的是行为，不是实现。
