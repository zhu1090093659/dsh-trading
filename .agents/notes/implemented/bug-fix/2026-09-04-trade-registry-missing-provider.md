# Agent Note: 资产抽屉恒报「凭证未配置」——tradingTradeRegistry 契约从未有 provide 方

Status: implemented

## Problem

用户报告 GUI 底部资产抽屉（TradeDrawer，issue #40 交易台的演进形态）四个分区
永远显示「凭证未配置或不可用（fail-closed）——配置后可查看」，且设置 → 交易
里没有任何可配的交易连接器项；按提示去配凭证也无从下手。

## Root Cause（全仓检索 + git 历史实证）

1. 前端链路：`fetchTradePositions/Balances` 失败（HTTP 400 或 `ok:false`）→
   catch → `null` → TradeDrawer 对 `null` 一律渲染 `trade.credentialHint`。
2. 400 的来源：桥 `#requireTradeService` 里 `webCtx.get('tradingTradeRegistry', false)`
   恒 `undefined` → 抛 `no trade service for market <m>`。**注册表服务在本仓
   从未被任何插件 provide**——grep 全仓只有消费方（5 个连接器 dataplane 的
   `resolveTradeRegistry` + 桥 + api 包类型声明），没有任何 `TradeRegistryService`
   构造；对比行情侧 `tradingMarketDataRegistry` 在 router 插件有
   `MarketDataRegistryService` 完整实现。
3. 断点溯源：issue #40（3b4ce02）只交付了契约（api 包接口 + Context 声明）与
   消费方；验收 spike `spikes/impl-trade-desk/run-trade-probe.mjs` 是手工 new
   假注册表注入 `createBridgeHost`——单测/spike 全绿但真实 cordis 装配缺失。
   739d962（旗舰重构）把同一模式复制到 alpaca/bybit/futu/qmt 四个 dataplane，
   缺口随之扩大到全市场。
4. 结论：凭证配置与否都不影响故障——该提示把「服务未注册」误导渲染成了配置问题。

## Decision

1. **router 插件补齐 provide 方**：新增 `TradeRegistryService`（与
   `MarketDataRegistryService` 同构：register/active/list；同 (market, provider)
   重复注册不同实例抛错），`apply()` 内与行情注册表同 fiber 提供
   （`new TradeRegistryService(ctx, service)`），base patch 行零改动。
2. **交易面路由裁决**：`MarketRouterService` 新增 `activeTradeProvider(market)`
   = `tradeProvider ?? provider`（§2.4 数据/交易分离字段预留语义）。
   `active()` 与行情注册表同款：路由选中但未注册 → `undefined`（不静默降级，
   用户设置是权威）；router 无该市场路由且恰好一个注册项 → 返回（新市场零配置）。
3. **前端语义区分**：`BridgeError` 增加 `code`；`getJson` 对非 2xx 也读 body code；
   桥对服务未挂错误附 `code: 'TRADING_NO_TRADE_SERVICE'`（路由分发层透传）。
   四个交易只读 fetcher 改返 `TradeRowsResult`（rows + reason），TradeDrawer
   按 reason 分流：`no-trade-service` → 新词条 `trade.noTradeService`
   （「该市场未挂交易连接器——在设置 → 交易选择带交易面的 provider 后可用」），
   其余 null 仍显 `trade.credentialHint`；`credentials-missing` 保留专语义。
4. **否决的备选**：前端只按 HTTP 400 猜「服务未挂」不改桥 code——老部署/未来
   其它 400 协议错误会混淆；不加服务端 code 的话语义无法稳定演进，故桥+客户端
   同步加 code（旧部署兼容：客户端对无 code 的 400 回退按服务未挂解释）。

## Consequences

- 交易连接器 dataplane 的 `resolveTradeRegistry` 从此拿得到注册表，
  okx/bybit/alpaca/futu/qmt 的 TradeService 真正注册进宿主面；GUI 只读面与
  dry-run 下单在「provider 已路由 + 凭证已配」的部署下端到端可用。
- `cn` 等纯行情 provider 路由下，抽屉显示「未挂交易连接器」而非误导性的凭证提示；
  A 股要走 QMT 需在设置 → 交易把 cn provider 切到 qmt 并运行本地 miniQMT 网关。
- 安全语义不变：注册面不做裁决，服务缝三态闸门与桥层 dry-run 强制照旧
  （见 feature/2026-09-02-issue-40-trade-desk.md）。

## Verification

- `pnpm --filter @dshtrading/router --filter @dshtrading/client-ui-trading build` 绿。
- router 单测新增 4 例（路由解析/tradeProvider 优先/未注册不降级+注销/零配置兜底）；
  bridge 单测新增 1 例（服务未注册 → 400 + `TRADING_NO_TRADE_SERVICE`）。
- 全量 `pnpm -r build` + `pnpm test` + `node scripts/typecheck-gate.mjs` 门禁见
  当次 CI/本地运行记录（交付前必须全绿）。
