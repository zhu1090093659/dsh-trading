# Agent 标的定性分析能力路线图

> 2026-08-31 立（deep-discuss 定稿，用户裁决 Q1-Q4）。目标：Agent 运行时能通过
> 行情/技术指标/动态新闻/扩展数据插件获取真实准确的标的信息，完成**定性分析**
> （而非只报数字）。本文件是任务划分与 issue 的母文档；实施纪律仍受 README 铁律与
> docs/symbol-vocabulary.md 等已定规范约束。

## 已锁决策

| # | 问题 | 定稿 | 理由 |
|---|---|---|---|
| Q1 | 技术指标放哪层 | **共享纯函数包** `@dsh-trading/indicators`：GUI 指标注册表的 compute 抽出，GUI 与 Agent 工具共用 | 一次维护两边一致；符合铁律 #6（数据层契约不动） |
| Q2 | 定性分析编排 | **基础工具 + skill 知识**（铁律 #2 哲学的延伸），不做宏分析工具 | 分析框架是知识不是代码；宏工具会让模型退化为播报员，框架调整还得改代码 |
| Q3 | 新闻数据源 | **A 打底（无 key 公共源：交易所公告/RSS）+ B 增强（CryptoPanic 等免费层，用户自备 key，settings 加字段、无 key 优雅降级）**；先 spike 验证可达性 | 铁律 #5（不内置 key）；B 源覆盖好但必须有合规获取路径 |
| Q4 | 推进方式 | 规划文档 → 推 GitHub（private）→ 按本文件建 issue → 协作者认领 | 任务自包含、验收明确才可外发 |

## 工作流分解

### WS1 技术指标共享包 + Agent 指标工具

**做什么**：
1. 新包 `@dsh-trading/indicators`：从 `client-ui-trading/src/client/indicator-registry.ts` 抽出
   纯函数 compute（MA/EMA/BOLL/MACD/RSI/KDJ）+ 参数 schema + 定义注册表；零 DOM/浏览器依赖。
2. `client-ui-trading` 改为依赖共享包（注册表外壳留在 UI 包：pane/渲染逻辑不抽）。
3. kit 侧新增 `<market>_get_indicators` 工具（crypto 先行）：入参 symbol + interval + 指标
   列表，内部经 `MarketDataService.getKlines` 取数后调共享包计算，输出最新值序列（截尾，
   默认只回最近 N 点，防 token 爆炸）。

**验收**：
- 共享包单测：与 GUI 现行输出对拍（同一 K 线输入，数值一致）；
- GUI 指标渲染回归无肉眼差异；
- `crypto_get_indicators` 工具单测（mock MarketDataService）+ headless 会话实测输出合理值。

**依赖**：无。**工作量**：中（抽包是主体，工具薄）。**协作者友好度**：高（自包含）。

### WS2 动态新闻插件（crypto 先行）

**WS2a spike（前置，必须先做）**：调研无 key 公共源的可达性与数据形态——
Binance/OKX 公告页（RSS 或 HTML 列表）、主流加密媒体 RSS（CoinDesk/The Block 等，
注意 ToS 抓取条款）、CryptoPanic 免费层 API 形态。证据留 `spikes/impl-crypto-news/`
（原始响应 + EVIDENCE.md，replication 手册纪律）。产出：源清单（可达/字段/更新频率/ToS
风险分级）+ 推荐接入面。

**WS2b 新闻工具实现**（依赖 WS2a）：新增 `@dsh-trading/connector-news-crypto`（命名/形态
以 spike 结论为准——若源都是 RSS 聚合，可能是 kit 内薄工具而非完整连接器，手册生成器
是否需要 news 类模板也在 spike 里回答）。工具面：`<market>_get_news`（入参 symbol/币种
过滤 + 时间窗 + 条数上限），输出带来源名 + 发布时间 + 链接（Agent 引用溯源用）。

**WS2c 用户 key 增强**（依赖 WS2b）：settings `dshtrading.news.cryptoPanicKey`（或 spike
选定的源）可选字段；无 key 时工具优雅降级到 WS2b 的公共源并在输出注明。

**验收**：工具单测（mock fetch）+ headless 实测拉取真实新闻；无 key 环境全程可用。
**工作量**：spike 小、实现中。**协作者友好度**：spike 高、实现中。

### WS3 定性分析框架知识层（crypto 先行）

**做什么**：kit-crypto 新增 skill（如 `crypto-instrument-analysis`）：定性分析框架——
趋势结构（多周期）→ 量价 → 波动率 → 资金面（ funding rate/持仓量）→ 新闻面 的
分析顺序、每步用哪个工具、判读规则与常见陷阱（如 funding 极端值的反向指标性、
低流动性标的的量价失真）。写作纪律参照现有 `crypto-risk-checklist`。

**验收**：headless 会话给一个标的跑完整分析，输出结构覆盖框架各环节且数据引用正确。
**依赖**：WS1（指标工具）+ WS2b（新闻工具）落地后内容才完整；可先写框架骨架留占位。
**工作量**：小（纯知识写作，但需要领域判断力）。**协作者友好度**：中。

### WS4 扩展数据（已全线交付 ✅）

1. **us/cn/hk 新闻源**（✅ 已交付，PR #10 / #11 / #12）：
   - `us_get_news`：Yahoo Finance + Google News RSS
   - `cn_get_news`：东方财富快讯 API
   - `hk_get_news`：东方财富港股过滤降级源
2. **衍生品数据面**（✅ 已交付）：
   - `crypto_get_derivatives`：Binance Futures / OKX 公共端点（OI 持仓量、多空人数比、大户持仓比、Taker 买卖比、资金费率），支持 `-SWAP` 规范词汇。
3. **四市场基本面与估值**（✅ 已交付）：
   - `crypto_get_fundamentals`：CoinCap + Binance（市值、FDV、流通量、总供应量、全球排名、24h 交易量与换手）
   - `us_get_fundamentals`：Yahoo Finance Quote API（市值、PE(TTM)、Forward PE、PB、EPS、股息率、52周区间、Beta）
   - `cn_get_fundamentals`：腾讯行情端点（总市值、流通市值、动态 PE、静态 PE、PB、换手率、振幅、涨跌停区间）
   - `hk_get_fundamentals`：腾讯港股端点（总市值、流通市值、PE(TTM)、动态 PE、PB、股息率、换手率、52周区间）

## 时序（全路线图均已结清）

```
WS1（指标包+工具）──┐
WS2（新闻工具体系）──┴──→ WS3（知识层）──→ WS4（新闻/衍生品/四市场基本面全线完成 ✅）
```

## 与既有规范的对照（实施时不可逾越）

- 符号一律市场规范词汇（docs/symbol-vocabulary.md）；
- 新闻/指标工具进 kit（preset 平面），需要 GUI 消费时另行走 dataplane 注册表
  （定稿 #8）；下单类工具不在本路线图范围；
- 铁律 #5：新闻内容**缓存/引用给 Agent 可以，再分发不行**；工具输出必须带来源标注；
- 每个非平凡变更写 Agent Note（.agents/notes/ 规则）。
