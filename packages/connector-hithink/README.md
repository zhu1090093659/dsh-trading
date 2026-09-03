# @dsh-trading/connector-hithink

HiThink (同花顺/问财开放平台 OpenAPI) A 股连接器，提供基本面数据、估值快照、集合竞价与特色选股数据。

## 能力边界

- **数据服务 (`MarketDataService`)**：
  - `getTicker(symbol)`：实时行情快照与最新量价；
  - `getStockFundamentals(symbol)`：总市值、流通市值、市盈率 (PE-TTM/动/静)、市净率 (PB)、市销率 (PS)、股息率；
  - `getAuctionSnapshot(symbol)`：早盘集合竞价匹配量、未匹配量与竞价强弱；
  - `getLimitUpPool(date?)`：连板池、封单量与炸板分析；
- **交易服务 (`TradeService`)**：
  - 不提供直接委托下单通道（A 股实盘执行由本地 MiniQMT 负责，遵循铁律 #3 统一安全闸门）。

## 配置项 (Config)

```json
{
  "enabled": true,
  "apiKey": "ref:env/HITHINK_FINANCE_API_KEY",
  "baseUrl": "https://fuyao.aicubes.cn/openapi/v1"
}
```

- `apiKey`：同花顺/问财开放平台认证 Token（遵循 BYOK 铁律 #5，仅支持 ref 引用或环境变量 `HITHINK_FINANCE_API_KEY`）；
- `baseUrl`：开放平台端点网关。

## 合规与条款边界 (ToS Compliance)

- **个人使用**：仅供用户自主鉴权后获取个人看盘与研报所需数据；
- **严禁再分发 (铁律 #4)**：不缓存转售、不批量扒取、不落地再分发原始行情。
