# Agent Note: 衍生品数据面与四市场基本面扩展（WS4 完整交付，结清 Issue #6）

Status: implemented

## Problem

[Issue #6](https://github.com/zhu1090093659/dsh-trading/issues/6)（路线图 WS4，扩展数据与新闻）在子工作流 #1（us/cn/hk 新闻源工具，PR #10 / #11 / #12）交付后，仍遗留两个关键子工作流：
1. **衍生品数据面（Derivatives Data Plane）**：需要支持未平仓持仓量（Open Interest, OI）、多空账户比（Long/Short Ratio）、大户持仓多空比、主动买卖成交量比（Taker Buy/Sell Volume Ratio）及资金费率，支持 `-SWAP` 规范符号；
2. **四市场基本面与估值（Fundamental & Tokenomics Data Plane）**：
   - Crypto：代币经济学（Tokenomics）、市值排名、流通量、总供应量、FDV、24h 交易量与换手；
   - US：美股市值、滚动市盈率 PE(TTM)、预测市盈率 Forward PE、市净率 PB、稀释 EPS、股息率、Beta、52 周高低区间、3 个月日均成交量；
   - CN：A 股总市值、流通市值、动态 PE、静态 PE、市净率 PB、换手率、振幅、涨跌停区间、52 周区间；
   - HK：港股总市值、流通市值、滚动 PE(TTM)、动态 PE、市净率 PB、股息率、换手率、振幅、今日成交额、52 周区间。

## Decision

- **契约层增强（@dsh-trading/api）**：在 pure type contract 中增加 `DerivativesData`, `CryptoFundamentals`, `StockFundamentals` 类型，保持零运行时、零外部依赖与完全向后兼容。
- **Crypto 衍生品与基本面（packages/kit-crypto）**：
  - `crypto_get_derivatives`：直连 Binance Futures 公共 REST（`/fapi/v1/openInterest`, `/futures/data/globalLongShortAccountRatio`, `/futures/data/topLongShortPositionRatio`, `/futures/data/takerlongshortRatio`, `/fapi/v1/fundingRate`），无 key 公共统计端点，支持 `BTCUSDT` / `BTCUSDT-SWAP` 规范词汇，支持部分子查询失败的 fail-soft 容错；
  - `crypto_get_fundamentals`：直连 CoinCap 公共 REST（`/assets/{id}` 获取全球排名、流通量、最大供应量、流通市值、FDV）+ Binance Spot 24hr Ticker（`/api/v3/ticker/24hr` 获取 24h 交易量、涨跌幅与成交笔数），CoinCap 异常时优雅降级并输出可用数据。
- **US 美股基本面（packages/kit-us）**：
  - `us_get_fundamentals`：直连 Yahoo Finance 公共 quote 端点（`/v7/finance/quote?symbols={symbol}`），获取市值、P/E、P/B、EPS、股息率、Beta、52 周区间与日均交易量，无 key 可用。
- **CN A 股基本面（packages/kit-cn）**：
  - `cn_get_fundamentals`：直连腾讯公共行情端点（`qt.gtimg.cn/q={sh|sz}{code}`），GBK 解码解析总市值、流通市值、动态 PE、静态 PE、PB、换手率、振幅、涨跌停区间、52 周区间。
- **HK 港股基本面（packages/kit-hk）**：
  - `hk_get_fundamentals`：直连腾讯港股公共行情端点（`qt.gtimg.cn/q=r_hk{code5}`），GBK 解码解析总市值、流通市值、PE(TTM)、动态 PE、PB、股息率、换手率、振幅、成交额、52 周区间。
- **Skill 知识层联动**：
  - 升级 `crypto-instrument-analysis` skill，将衍生品/资金面（OI + 多空比 + Taker Vol + 资金费率）与代币经济学（Tokenomics）深度融入六步定性分析流程；
  - 升级 `us-risk-checklist`, `cn-risk-checklist`, `hk-risk-checklist`，增加基本面估值与新闻核对指引。
- **遵循铁律**：
  - 铁律 #1：insert-only，kit 工具在 preset 平面按市场命名空间安全注册；
  - 铁律 #2：知识与代码分离，定性分析判读写入 Skill，代码只负责纯净取数；
  - 铁律 #5：所有数据源均为公共无 key 端点，本仓不内置密钥、不缓存、不再分发数据。

## Consequences

- 路线图 WS4 规划的所有 3 个子工作流（新闻源扩展、衍生品数据面、四市场基本面与估值）全部交付，Issue #6 完成所有目标并结清。
- Agent 在四个市场（Crypto/US/CN/HK）全面具备「行情报价 + K线技术指标 + 市场动态新闻 + 衍生品与资金面 + 基本面估值」的完整定性分析能力闭环。
- 全仓单测与构建均全绿（新增 10 个测试用例，全仓测试用例数由 241 增至 251+）。
