# Agent Note: 交易工作台（issue #40）——宿主面交易注册表 + 桥强制 dry-run + 只读账户面

Status: implemented

## Problem

issue #40 要求 GUI 交易执行控制台（下单 + 持仓/挂单/流水）。当时交易服务
（TradeService）**只在 preset 平面**（凭证 + 审批闸门的会话面，dataplane 头注明确
「交易面不进 host 数据面」），GUI 所在的宿主平面没有任何交易通道；桥也不感知
TradeService。直接把 GUI 接到实盘下单会击穿铁律 #3 的审批闸门。

## Decision

- **契约**（api 包）：
  - `TradeService` 新增三个可选成员：`getBalances?`、`listOpenOrders?`、
    `listTradeFills?`（新增 `TradeFill` 类型；流水时间升序，与 getRecentTrades 同向）；
  - 新增 `TradeRegistry` 注册面 + `Context.tradingTradeRegistry` 声明——与
    MarketDataRegistry 同构，**显式修订**「交易面永不进 host 数据面」的旧决策：
    host 面注册的是同一 TradeService 实例，服务缝三态闸门随实例生效，
    注册面本身不做安全裁决（闸门在服务缝 + 桥层）。
- **okx**：dataplane 注册行情后，trade registry 在场时一并注册 OkxTradeService
  （共享 OkxRestClient；凭证缺失不阻断注册，只读方法调用时 fail-closed 报
  TRADING_CREDENTIALS_MISSING）；rest 层补 `orders-pending` / `fills-history`
  两个签名端点；TradeService 实现挂单/流水映射（SWAP 张→币经 ctVal 缓存换算）。
- **桥**（client-ui-trading node 半）：host 增加 `getTradeService(market)`
  （tradeRegistry 惰性解析）；路由 `GET /trade/{positions,orders,fills,balances}` +
  `POST /trade/order`。**`placeOrderFromGui` 强制 `dryRun: true`**——body 无
  dryRun 字段可言，GUI 实盘下单在结构上不可能；实盘唯一通道保持 Agent 工具
  （服务缝 liveTrading 闸门 → base 统一审批闸门）。
- **client**：QuoteStage 底部可折叠 `TradeDesk`（默认关，开关跨会话记忆）：
  左侧下单表单（买/卖 × 市/限 × 数量，提交即模拟回执）+ 右侧只读四分区
  （持仓/活动委托/成交历史/余额）；凭证缺失分区显示提示而非空数据；15s 轮询
  仅面板打开时拉取；开关仅 crypto 市场渲染（当前唯一交易注册方）。

## Alternatives considered

- **GUI 直接放行实盘下单（liveTrading=true 时）**：落选——base 审批闸门是
  pre-execute 工具面机制，GUI 请求不经工具面，等于绕过审批；实盘保持唯一通道。
- **GUI 撤单按钮**：落选——服务缝撤单同样要求 liveTrading=true，且撤单是真实
  交易动作；本轮挂单列表只读，撤单留待有明确需求时单独设计。
- **preset 平面拉取数据、经会话工具卡呈现**：落选——那是 Agent 会话面（已有
  crypto_get_positions 工具），不是用户要的 GUI 常驻交易台；且会话面无 HTTP 通道。

## Consequences

- crypto 行情页出现「交易」开关：默认关；打开后可模拟下单并实时看回执与
  持仓（凭证配置后）；面板明示「Dry-Run 模拟（GUI 不提供实盘通道）」。
- **宿主平面首次出现 TradeService 注册**：未来任何 host 面消费方都能拿到交易
  服务——闸门在服务缝与调用方自律（桥的 dry-run 强制是本仓消费方的实现），
  第三方 host 面插件直接调用该服务时 liveTrading 闸门仍生效，但审批闸门不
  在工具面以外——已知边界，写入本记录供后续评审。
- 凭证（OKX_DEMO_*）未配置的部署：交易台可开、可模拟下单、只读分区显示
  凭证提示；配置后即真实数据（带凭证实测待用户 key，见
  spikes/impl-trade-desk/EVIDENCE.md）。
- **2026-09-04 修复**：本决策的 `TradeRegistry` 当时只交付了契约与消费方，
  `tradingTradeRegistry` 服务从未被 provide（spike 以假注册表注入验证，真实
  装配缺失），GUI 交易面全市场不可用且被误渲染为凭证提示——provide 方已在
  router 插件补齐，见 [bug-fix 记录](../bug-fix/2026-09-04-trade-registry-missing-provider.md)。
