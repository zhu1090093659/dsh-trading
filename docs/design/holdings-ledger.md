# 统一资产台账（Unified Holdings Ledger）设计契约

> Issue #65。本文是两个并行实施流（node 半 / client 半）的共同契约：任何字段、路由、
> 事件名的改动必须先改本文并同步双工。目标架构与取舍见 Issue 正文，本文只写定稿。

## 1. 词汇

- `origin`：持仓血缘，`'paper' | 'live' | 'imported'`，创建后不可变。
- `kind`：用户面向标签，`'real' | 'sim'`。paper 源恒 sim、live 源恒 real（运行时推导，
  不落库）；imported 源缺省 real、**可改标**（截图也可能来自模拟盘）。
- 「待确认区」（staged）：Agent 解析截图后的缓冲，用户在抽屉确认/编辑后才转正式。

## 2. Holding 存储模型（@dshtrading/holdings，宿主侧）

```ts
export type HoldingMarket = 'crypto' | 'us' | 'cn' | 'hk'
export type HoldingCurrency = 'USD' | 'CNY' | 'HKD' | 'USDT'
export type HoldingKind = 'real' | 'sim'

export interface Holding {
  id: string                    // `hd-<ts>-<rand>`
  market: HoldingMarket         // 行情路由依据，必填
  symbol: string                // 连接器词汇（与行情 API 对齐，如 AAPL / 002714.SZ / BTCUSDT）
  name?: string                 // 显示名（截图里的中文名等）
  side: 'long'                  // 一期仅 long（股票/现货截图场景）
  size: number                  // 持仓数量 > 0
  entryPrice?: number           // 成本价；截图没有则缺省（uPnL 不显示）
  currency?: HoldingCurrency    // 缺省按 market 推导：crypto→USDT, us→USD, cn→CNY, hk→HKD
  account: string               // 用户命名账户（'富途'/'IBKR'/'币安'），必填，缺省 '默认账户'
  kind: HoldingKind             // 缺省 real
  note?: string
  source: 'imported'            // store 只承载导入持仓；paper/live 是运行时源
  importedAt: number
  updatedAt: number
}

export type NewHolding = Omit<Holding, 'id' | 'source' | 'importedAt' | 'updatedAt'>
```

- 文件：`~/.dsh/holdings/book.json`，原子写（tmp+rename），形状
  `{ revision: number, staged: Holding[], holdings: Holding[] }`。
- Store 接口：`snapshot()`（返回 revision+两区）、`stage(items: NewHolding[])`、
  `confirm(ids, edits?)`、`discard(ids)`、`add(item)`、`update(id, patch)`、`remove(id)`；
  全部写操作自增 revision 并落盘。
- 默认值推导（currency/account/kind）在 store 写入侧完成，读侧不做猜测。

## 3. REST 契约（/dshtrading/api 桥，认证栅栏后）

| 方法 | 子路径 | body | 返回 |
|---|---|---|---|
| GET | `/holdings` | — | `{ ok:true, revision, staged: Holding[], holdings: Holding[] }` |
| POST | `/holdings/stage` | `{ items: NewHolding[] }` | `{ ok:true, revision }` |
| POST | `/holdings/confirm` | `{ ids: string[], edits?: Record<string, Partial<NewHolding>> }` | `{ ok:true, revision }` |
| POST | `/holdings/discard` | `{ ids: string[] }` | `{ ok:true, revision }` |
| POST | `/holdings` | `NewHolding` | `{ ok:true, revision, id }` |
| PUT | `/holdings` | `{ id: string, patch: Partial<NewHolding> }` | `{ ok:true, revision }` |
| DELETE | `/holdings` | `?id=` | `{ ok:true, revision }` |
| GET | `/fx?base=USD` | — | `{ ok:true, base, rates: Record<string,number>, asOf: number, stale: boolean }` |

- 全部写成功 → `tradingEvents.emit('holdings')`（SSE store 名 `'holdings'`）。
- 桥侧 envelope 惯例不变：业务错误 HTTP 200 + `{ ok:false, code, message }`；
  校验失败 code `TRADING_HOLDINGS_INVALID`。
- FX：`rates` 语义「1 单位基准币 = rates[c] 单位 c」……**改为更直观的
  `rates[c] = 1 单位 c 折合多少 base`**（USD 基准时 `{USD:1, USDT:1, CNY:0.14, HKD:0.128}`）。
  `stale:true` 表示用了过期缓存（首次拉取失败且无缓存时 `stale:true` + rates 只含
  `{base:1, USDT≈USD}` 兜底恒等项）。

## 4. FX 服务（@dshtrading/holdings/fx）

- 源：`https://api.frankfurter.dev/v1/latest?base=<base>&symbols=USD,CNY,HKD`
  （ECB 汇率，免费无 key，个人用途；USDT 不入请求，恒定锚定 USD：`rates.USDT = rates.USD`）。
- 宿主内存缓存 1h + 文件缓存 `~/.dsh/holdings/fx-cache.json` 兜底（重启可用）。
- 失败链：内存 → 文件 → 恒等兜底；后两者 `stale:true`。fetch 超时 5s。
- base 支持 USD/CNY/HKD；非法 base → 400。

## 5. Agent 工具（holdings plugin，host 平面注册）

- `holdings_stage(items: NewHolding[])`：唯一写入口。description 自带完整纪律：
  解析券商/交易所截图 → 只 stage 不 confirm → 提醒用户「到资产抽屉确认入账」；
  market 词汇表（crypto/us/cn/hk）与 symbol 连接器词汇要求；数字必须原样取自截图，
  不确定的字段缺省不编造；一张截图一个 account 名（用户未说明时用截图里的券商名）。
- `holdings_list()`：只读，返回当前 staged+holdings 概要（供 agent 回答「我录入了什么」）。
- 工具**不经过审批闸门**（ORDER_GATE_PATTERN 不匹配，天然放行）：纯本地数据，无交易语义。

## 6. Client 半（client-ui-trading）

### 6.1 类型（client/holdings-types.ts，不动 @dshtrading/api）

```ts
export type PositionOrigin = 'paper' | 'live' | 'imported'
export interface TaggedPosition extends Position {   // 结构扩展，契约不改
  origin: PositionOrigin
  kind: 'real' | 'sim'
  market: MarketId | undefined  // paper 旧数据可能未知 → undefined
  account: string               // paper→'模拟账户' live→provider 名 imported→用户命名
  holdingId?: string            // origin==='imported' 时回指 store 记录
  currency?: HoldingCurrency
}
```

### 6.2 聚合引擎（client/holdings-aggregate.ts，纯函数，vitest 重点）

输入 `TaggedPosition[]` + `prices: Record<`${market}:${symbol}`, number>` + fx → 输出：
- 明细行：markPrice、marketValue（原币 + 折算）、uPnL（原币 + 折算，无成本价则 undefined）；
- 汇总行：按 `market:symbol` 聚合（总 size、加权成本、总市值、总 uPnL、来源/账户分布）；
- 顶部小计：按 origin 分（真实/模拟/实盘）、按币种分；总资产 = Σ折算市值。
- FX stale 或缺汇率 → 该币种进「未折算小计」分区，总资产仍给出但标注近似。

### 6.3 UI（TradeDrawer 重构）

- 持仓 tab：统一表，新增列「来源」（徽章：模拟/实盘/真实导入）、「账户」、「市值」；
  过滤 chips：全部/真实/模拟/实盘。imported 行支持编辑/删除（对话框）。
- 新增「汇总」tab：聚合行可展开分账户明细；顶部基准币选择（USD/CNY/HKD，
  localStorage `dshtrading:holdings:baseCurrency`，缺省 USD）+ 总资产 + 分来源小计。
- 待确认横幅：staged 非空时 drawer 置顶条「N 条待确认持仓」→ 确认对话框
  （可编辑表格：market/symbol/size/entryPrice/account/kind）→ 确认/丢弃。
- 「导入持仓」按钮：fillComposer 填入引导文案（只填不发，与「发给 Agent」同款纪律），
  文案提示用户把截图贴进 composer；按钮 title 明示「截图将发送给当前 AI 模型解析」。
  同时提供「手动新增」对话框（同字段表单）。
- 价格供给：drawer 展开时对全部持仓按 market 分组 fetchTickers 批量盯市，
  30s 轮询；折叠时暂停。paper 持仓维持现有 updatePrices 链路不变。
- 委托/成交/资金 tab 语义不变（仍随 live/paper 模式）。

### 6.4 其他

- 缺省 tradeMode 翻转：localStorage 无记录时 paper（已有显式记录不动）。
- paper store：placeOrder 记录 market（PaperPosition = Position & { market?: MarketId }），
  旧数据无 market → TaggedPosition.market = undefined（汇总显示「未知市场」，不参与批量盯市，
  维持原 activeMarket 盯市行为）。
- live 源：对四个市场逐个 GET /trade/positions?market=（失败静默跳过），
  origin='live'、kind='real'、account=该市场 provider 名。
- locales：新增 key 走 contract.ts MarketLocaleKey 联合类型 + zh/en 双语（i18n 包构建期自动拾取）。

## 7. 测试基线

- holdings 包：store 全操作 + 默认值推导 + revision 自增 + 原子写；fx 缓存/降级链；
  工具 stage/list 行为。vitest。
- client：聚合引擎（多来源/多币种/加权成本/缺成本价/FX stale 降级）；
  api 封装 envelope 解析。vitest。
- 全仓 `pnpm build` `pnpm test` 绿。
