# crypto 垂直切片计划（草案 v0，待 spike 复核后定稿）

> 状态：2026-08-29 由主 agent 起草，作为第 1 阶段施工蓝本。标注 [Sx] 的条目依赖对应 spike 的结论，报告落地后复核修订。

## 切片目标

打通「一条命令安装 crypto 市场包 → 会话级 preset 隔离 → 行情工具可用 → 下单 dry-run+审批」全链路。
**非目标**：UI 面板（后置）、实盘交易、回测引擎、多交易所（先 Binance 一家）。

> **2026-08-31 更新**：本切片的范围控制已完成使命。「回测引擎」non-goal 由 [docs/design/strategy-tab.md](../design/strategy-tab.md) 方向性取代——回测以纯函数浏览器端本地形态进入路线图；「实盘交易」non-goal 不变（铁律 #3）。决策记录见 `.agents/notes/implemented/architecture/2026-08-31-strategy-tab-and-knowledge-base.md`。

## 包清单与依赖 DAG

```
@dshtrading/api            纯类型包：IAccount/IOrderBook/IQuote 等服务契约、订单/持仓类型、错误词汇
      ▲
@dshtrading/base           bundle（dsh.bundle.patch）：市场无关行——组合管理工具、风控原语工具、
      │                     统一 preset root 配置 [S3]、credentials 引用约定 [S4]
      ▲
@dshtrading/connector-binance   插件：公共行情（REST+WS），实现 api 契约；凭证经 ctx.credentials（BYOK）[S4]
      ▲
@dshtrading/kit-crypto     插件：crypto 专属工具（资金费率、持仓量等）+ skill provider [S2]
      │                     + preset 自安装逻辑（crypto-trader）[S3]
      ▲
@dshtrading/crypto         bundle：依赖安装载体（preset 行从 profile node_modules 解析，S3 坑 3）；
                            工具行在 preset 平面（agent.cordis.yml），不在本层 insert（2026-08-29 修订：
                            preset 级会话隔离；行 id 定稿 dsh-trading-<market>-*）
```

包数：5（不含未来的 UI 包）。版本策略：changesets 统一管理；bundle 对连接器用精确版本钉住。

## 关键接口草案

### 服务契约（@dshtrading/api）
```ts
interface MarketDataService {   // 由连接器实现，ctx 键按市场命名空间：ctx.tradingCrypto 等
  getTicker(symbol: string): Promise<Ticker>
  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]>
  subscribeTicker(symbol: string, cb: (t: Ticker) => void): Disposable
}
interface TradeService {
  placeOrder(req: OrderRequest): Promise<Order>   // dryRun 为默认；实盘前必须 ctx.approval.request [S4]
  cancelOrder(id: string): Promise<void>
  getPositions(): Promise<Position[]>
}
```

### 工具（注册到 ctx.tools，命名带市场前缀防冲突）
- `crypto_get_ticker` / `crypto_get_klines`（公共行情，无鉴权）
- `crypto_place_order`（默认 dryRun:true；dryRun:false 时强制 approval + 实盘开关配置）
- `crypto_get_positions`（需凭证）

### 安全闸门（铁律 #3 落地）
1. 插件 config：`liveTrading: boolean`（默认 false；为 false 时 place_order 强制 dryRun）
2. dryRun=false 的每次调用前 `ctx.approval.request({...})`，无应答者自动拒绝（fail-closed，官方语义）
3. API key 一律 `ctx.credentials` 按名引用，settings/配置里只存引用名

### Skill（随 @dshtrading/kit-crypto 分发）[S2]
- `crypto-funding-rate-basis`：资金费率套利分析框架
- `crypto-risk-checklist`：加密合约风控检查清单
（切片期各 1 篇即可，验证机制为主）

### Preset（crypto-trader）[S3]
- `agent.cordis.yml`：persona 行（加密交易员人设，官方 standard preset 已证明 persona 可遮蔽部署默认）+ 市场工具行 + skill 行；**不**持有审批/沙箱/模型路由（host 面职责，官方注释明确）
- `preset.yml`：name/description/order 展示元数据
- 自安装：kit 插件启动时把 preset 目录幂等写入 base 配置的共享 root（~/.dsh-trading-presets）[S3 待验证]

## 自动化（监控/预警）——本切片不做，设计方向已变

S4 预备调查确认：官方 schedule 仅是「会话内提醒」，不构成后台自动化基座。
后续市场监控的正确基座候选（待专项讨论）：① 插件自管 interval + Cordis dispose 生命周期；② webhook 包接收外部触发；③ 外部 cron 唤起 headless 会话。切片阶段用「会话内提醒」即可模拟。

## 执行顺序（每步都是子 agent 任务，我审查）

1. 脚手架落地（依 S5 TEMPLATES）：根 workspace + 5 包骨架
2. @dshtrading/api + base 最小 bundle，装进 spike-s1 同款 scratch profile 验证分层
3. connector-binance：getTicker 打通（公共接口，无需凭证）
4. kit-crypto：skill provider + preset 自安装（依 S2/S3 结论）
5. crypto bundle 聚合 + 端到端验收（见 README 验收标准）

## 验收标准（与 README 一致，切片级）

- `dsh plugin --profile <scratch> add` 本地路径装齐 crypto 市场包，profile 启动正常
- crypto-trader preset 会话可见 crypto_* 工具；standard preset 会话不可见
- crypto_place_order 默认 dry-run；liveTrading=false 时拒绝实盘；approval 拒绝时不下单
- 卸载后优雅降级（preset broken 带原因，无进程崩溃）
