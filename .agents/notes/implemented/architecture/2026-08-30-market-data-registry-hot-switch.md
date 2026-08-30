# Agent Note: 行情服务注册表模式 —— 修复 GUI/会话数据面生效时机裂口

Status: implemented

## Problem

设置驱动路由（[2026-08-29-settings-driven-market-routing.md](2026-08-29-settings-driven-market-routing.md)）
承诺「切交易所后新建会话生效，无需重启进程」，但该语义只对 preset 平面成立
（preset 挂载是会话级的）。host 面数据行（各市场 bundle patch 的 dataplane 行）
只在进程启动时 apply 一次，`routeAllows()` 也只在那一刻 consult 路由：用户改完
`dshtrading.markets.crypto.provider` 后，新建会话的 Agent 拿到新交易所工具面，
而 GUI 中栏行情仍是旧交易所数据，直到重启 dsh 进程——Agent 看到的和 GUI 显示的
不是同一家，且文档口径与实现分叉。架构评审（2026-08-30）判为语义裂口。

## Decision

引入 **行情服务注册表**（指标系统 tradingIndicators 已验证的同一模式推广到行情面）：

1. **`@dsh-trading/api`**：新增 `MarketDataRegistry` / `MarketDataRegistration` 纯类型
   契约 + Context 模块增强键 `tradingMarketDataRegistry`（零运行时不变）。
2. **`@dsh-trading/router`**：同插件同 fiber 追加 provide `MarketDataRegistryService`
   ——base patch 行零改动。`register(market, provider, service)` 返回注销函数；
   同 (market, provider) 重复注册不同实例**抛错**（配置错误必须响亮）。
   `active(market)` 裁决：路由选中的 provider 已注册 → 返回；选中了未注册 →
   undefined（用户设置是权威，**不静默降级到别家**）；router 无该市场路由且恰好
   一个注册项 → 零配置可用；多注册项无路由 → undefined。
3. **连接器 dataplane**（binance/okx/yahoo/tencent + connector-template 同步）：
   `enabled=false` 硬关不变；有注册表时在 `ctx.isolate(市场键)` realm 内构造服务
   （不占 host 根市场键——binance/okx 并存注册，互斥冲突在机制上消失）并
   `ctx.effect` 包注册（随 fiber 注销）；无注册表的老部署回退 2026-08-30 前形态
   （router consult 互斥 + 直接 provide 市场键）。连接器对 router 包保持**零依赖**
   （鸭式接口 + ctx.get，与既有 router consult 同纪律）。
4. **行情桥**（client-ui-trading）：`createBridgeHost` 为 registry-first 解析唯一实现
   ——每请求经注册表按路由当前值解析（热切换无需 watch/重启），注册表缺席或无
   注册项时回退旧市场键直读；`activeProvider` 优先报告实际供数的注册项。
5. **preset 平面不动**：会话内数据源一致性是有意语义——切交易所对会话 = 新建会话
   生效（restart 语义保留）；GUI 面 = 即时生效。两面语义差异在 docs 写明。

与 tradeProvider 预留的衔接：注册表只承载 MarketDataService；数据/交易分离落地时
TradeService 走独立注册面，铁律 #4 到时再抽象。

## Alternatives considered

- **dataplane 订阅 `router.watch()` 自行重挂载**：router 服务本有 watch 面。落选——
  重挂载 = dispose/re-provide 生命周期复杂化（订阅清理、服务重建时序），而桥本来就
  是每请求惰性解析，注册表把「谁激活」推迟到消费点天然零 watcher。
- **注册表做成独立新包/新 base 行**：落选——注册表是路由的解析面，与 router 同插件
  内聚最强且 base patch 零改动；铁律 #4 不允许为单一消费方过早抽象新包。
- **preset 平面一并改注册表**（会话内热切换）：落选——会话中途换交易所会让同一
  对话的工具语义漂移（上下文里既有 Binance 数据又有 OKX 数据），会话一致性优于
  热切换便利；新建会话生效的代价可接受。
- **保留 dataplane 直接 provide + 桥读取时按路由选键**（服务键加 provider 维度）：
  落选——键维度发散（每市场 × 每 provider 一键）污染 api 模块增强面，注册表把
  二维解析收敛在一个服务里。

## Consequences

- GUI 热切换成立：改 `~/.dsh/settings.yaml` 的 provider 后，下一次行情轮询即用新
  交易所数据（桥每请求解析），会话面仍新建会话生效——文档口径与实现不再分叉。
- 第三方/新交易所连接器的 host 面接入不再需要改 router/桥的任何代码：注册
  (market, slug) + 用户设置同名 slug 即上榜（配合 provider 词汇开放化，见
  2026-08-30-provider-vocabulary-open.md）。
- 老部署兼容：注册表缺席时连接器 dataplane 回退旧互斥路径，桥回退旧市场键直读；
  新旧任意组合不炸（单向退化，不报错）。
- 验证：router 10 例（注册表 4 例：注册/热切换/选中未注册/零配置与多注册裁决）、
  四连接器 dataplane 各增注册表模式用例、client-ui-trading 31 例（createBridgeHost
  3 例：热切换/选中未注册不降级/老部署回退）、模板 8 例（dataplane 三态）。
  `pnpm -r build` / `pnpm -r test` 全绿。
