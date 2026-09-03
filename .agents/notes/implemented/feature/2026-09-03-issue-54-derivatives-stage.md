# Agent Note: 衍生品决策页签（issue #54）——历史序列契约 + 摘要条入口化 + 基差卡

Status: implemented

## Problem

issue #38/#39/#40 分批落地后，crypto 衍生品数据面「有快照、无决策语境」：
OI/费率/多空比全是时间点裸数字；OKX 响应里已解析的 `nextFundingRate` /
`nextFundingTime` 被契约丢弃；盘口、交易台、快照条三个入口各自孤立，无衍生品
专属页面；#38 结项时明确把「历史序列」留作后续任务。用户定调：GUI 要能做
费率/OI 决策（不是只扫一眼情绪）。

## Decision

- **契约（api 包）**：`DerivativesData` 增四个可选字段 `nextFundingRate` /
  `nextFundingTime` / `markPrice` / `indexPrice`；新增 `DerivativesPoint` 与
  `DerivativesHistory`（fundingRates + openInterest 双序列，时间升序）；`MarketDataService`
  增可选 `getDerivativesHistory?`。可选语义与 #38 快照同款：不实现不破坏编译，
  消费方按卡降级（隐藏趋势图、保留快照读数）。
- **三家连接器**（真实网络证据 spikes/impl-crypto-derivatives/parsed-history-probe.json，
  11 项新子查询全过）：
  - okx：funding-rate 响应的 next 两字段接线（实测可能为空字符串 → 缺省不显示）；
    新增 `public/mark-price` + `market/index-tickers`（基差对）+ `funding-rate-history`
    + rubik `open-interest-history`（必须传 instId，传 ccy 报 50014；行取 oiCcy 列与
    快照同语义）。
  - binance：新增 `fapi/v1/premiumIndex`（单端点带 mark/index/lastFunding/nextFundingTime）
    + `fundingRate` 历史 + `futures/data/openInterestHist`（1d）。
  - bybit：linear tickers 行内已有 nextFundingTime/markPrice/indexPrice（快照零新增
    请求）；历史走 `funding/history` + `open-interest?intervalTime=1d`。
- **桥**：`GET /derivatives/history`（TRADING_NOT_IMPLEMENTED 词汇同族）；
  client `fetchDerivativesHistory`。
- **UI（client-ui-trading）**：
  - 新页签「衍生品」（crypto 专属，图表|衍生品|基本面|新闻|公告）：四卡决策面——
    费率卡（当前/预测/1s 走时倒计时/近 30 期 sparkline）、OI 卡（当前/价值/24h 变化/
    近 30 日趋势）、多空比卡、基差卡；24h 变化由历史序列末点 vs 24h 前采样点算出，
    不占契约字段。
  - 摘要条入口化：格子变按钮，点击跳页签；title tooltip 承载语义解释；footer 标注
    规范 SWAP 符号（现货→永续映射显式化）；「分析资金面」按钮经 fillComposer 把
    结构化快照上下文发给 Agent（只填不发）。
  - 历史序列轮询 5min 且仅页签激活时拉（费率 8h 一期、OI 1D，无需快频）；
    切非 crypto 市场自动回图表页签。
- **轮询/配额纪律**：快照沿用 30s（#38 定）；历史 5min；页签不激活零请求。

## Alternatives considered

- **OI 24h 变化进契约（openInterestChange24h）**：落选——可由历史序列首末点在前端
  算出，快照路径不因此多打一次历史端点；契约保持薄。
- **爆仓统计卡**：不做——三家公共 REST 均无（#38 EVIDENCE 已裁决）。
- **跨所费率对比**：不做——当前路由是单 provider，跨所需要 registry 多激活，
  超出本期范围。

## Consequences

- GUI crypto 具备「费率倒计时 + 预测费率 + 费率/OI 历史趋势 + 基差」的完整
  决策面；Binance 源无 OI value、OKX 源无大户比等差异沿用缺格隐藏纪律。
- `getDerivativesHistory` 为可选契约成员：第三方/现货连接器不实现不破坏编译运行。
- OKX `nextFundingRate` 空字符串语义以 spikes/impl-crypto-derivatives/EVIDENCE.md
  2026-09-03 追加节为准。
- 页签激活才拉历史：盯盘停在图表页签时历史端点零消耗。

## Review remediation（PR #55 评审，三路并行焦点）

- **M1**：三家 num() 统一空串→undefined（Number('')===0 会编造预测费率 0.0000% /
  倒计时 1970；spike 自述与实际行为矛盾，已据修复改 EVIDENCE）。
- **M2**：bybit normalizeCryptoSymbol 先剥 -SWAP 后缀（规范形入参此前 100% 失败，
  存量缺陷被新方法复制；修复对现货端点零影响）。
- **M3**：衍生品快照/历史轮询补 requestRef 竞态守卫（对齐 K 线模式）。
- **L1**：全失败守卫计入 mark/index/nextFunding 新字段（不误抛已到手的基差数据）。
- **L2**：历史「加载中 vs 不可用」分态（historyLoaded），不可用提示真正可渲染。
- **L3**：渲染期 viewTab 归一（非 crypto 市场不再闪公告帧）。
- **L4**：oiChange24h 历史不足 24h 时该行隐藏，不拿「上市以来」冒充 24h。
- **L5**：补 binance funding 兜底、okx OI 张数兜底、bybit SWAP 入参等回归测试；
  okx 基底路由表登记 mark/index 端点（happy-path 不再靠吞错静默通过）。
