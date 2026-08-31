# 全市场连接器申请与配置全景指引 (Connectors Guide)

本项目支持 A 股 (CN)、美股 (US)、港股 (HK)、加密货币 (Crypto) 四大市场共 19 个连接器。为了方便用户获取 API 密钥、了解免费/付费政策与本地网关安装要求，本文档汇总了各连接器的官方指引。

---

## 一、A 股市场 (CN)

| 连接器 | 类型 | 认证方式与环境变量 | 官网与申请/下载地址 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **东方财富 (`eastmoney`)** | 免密公共行情 | 无需配置 | [eastmoney.com](https://www.eastmoney.com) | 免密开箱即用，支持 1m~1M 分钟 K 线与五档盘口（纯行情，无交易通道） |
| **腾讯行情 (`tencent`)** | 免密公共行情 | 无需配置 | [finance.qq.com](https://finance.qq.com) | 免密开箱即用，支持分时与前复权 K 线 |
| **Tushare Pro (`tushare`)** | 商业/量化社区 | `TUSHARE_TOKEN` | [tushare.pro/register](https://tushare.pro/register) | 免费注册送积分，可获取 PE/PB 估值指标与分钟线 |
| **AkShare (`akshare`)** | 开源量化/宏观数据 | 免密 / `AKSHARE_API_URL` | [akshare.xyz](https://akshare.xyz) | 支持行业板块资金流排行与宏观指标（注：交易所自 2024-08 已停发实时北向资金，北向接口已下线；纯数据源，无交易通道） |
| **迅投 MiniQMT (`qmt`)** | 券商实盘网关 | `QMT_GATEWAY_URL` (默认 `http://127.0.0.1:5800`)<br>`QMT_ACCOUNT_ID` | 联系开户券商申请 (如国金/华泰/中信/银河) | 需在本机运行券商提供的 MiniQMT 客户端与本地 RPC/HTTP 网关桥（见下方契约说明）；支持真实可用资金查询、股票委托申报与撤单 |

> **MiniQMT 本地网关桥契约说明**：
> 由于 MiniQMT 官方仅提供 Python `xtquant` SDK，连接器通过本地 HTTP 桥通信。桥服务需实现以下标准契约：
> - `GET /api/v1/trade/asset?account_id={id}`: 返回 `{ code: 0, data: { cash, total_asset, frozen_cash, currency } }`
> - `POST /api/v1/trade/order`: 接收 `{ account_id, stock_code, order_type, order_side, price, order_volume }`，返回 `{ code: 0, data: { order_id } }`
> - `POST /api/v1/trade/cancel`: 接收 `{ account_id, order_id }`，返回 `{ code: 0 }`
> - `GET /api/v1/trade/positions?account_id={id}`: 返回 `{ code: 0, data: [{ stock_code, volume, can_use_volume, open_price }] }`

---

## 二、美股市场 (US)

| 连接器 | 类型 | 认证方式与环境变量 | 官网与申请/下载地址 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **Yahoo Finance (`yahoo`)** | 免密公共 | 无需配置 | [finance.yahoo.com](https://finance.yahoo.com) | 免密开箱即用，支持美股历史与日内行情 |
| **Alpaca (`alpaca`)** | 商业券商 API | `ALPACA_API_KEY`<br>`ALPACA_SECRET_KEY` | [alpaca.markets](https://alpaca.markets) | 免费注册提供 Paper 模拟盘与美股实盘交易 API |
| **Financial Modeling Prep (`fmp`)** | 商业量化 API | `FMP_API_KEY` | [financialmodelingprep.com/developer](https://site.financialmodelingprep.com/developer) | 免费注册每天 250 次请求，支持深度财报与分钟线 |
| **Finnhub (`finnhub`)** | 商业金融 API | `FINNHUB_API_KEY` | [finnhub.io/register](https://finnhub.io/register) | 免费注册每分钟 60 次调用，支持实时报价与市场新闻 |
| **Polygon.io (`polygon`)** | 机构级高频 API | `POLYGON_API_KEY` | [polygon.io](https://polygon.io) | 免费 Basic 计划每分钟 5 次请求，提供微秒级 K 线 |
| **盈透证券 (`ibkr`)** | 机构券商网关 | `IBKR_GATEWAY_URL` (默认 `https://127.0.0.1:5000/v1/api`)<br>`IBKR_ACCOUNT_ID` | [interactivebrokers.com/campus/ibkr-api-page/cpapi/](https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi/) | 需在本机运行 Client Portal Gateway (`localhost:5000`)；支持真实 Ledger 资金拉取、Pre-order Warning 自动确认、委托申报与撤单 |

---

## 三、港股市场 (HK)

| 连接器 | 类型 | 认证方式与环境变量 | 官网与申请/下载地址 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **腾讯港股 (`tencent`)** | 免密公共 | 无需配置 | [finance.qq.com](https://finance.qq.com) | 免密开箱即用，支持港股日 K 与分时行情 |
| **长桥证券 (`longbridge`)** | 现代云端券商 | `LONGBRIDGE_APP_KEY`<br>`LONGBRIDGE_APP_SECRET`<br>`LONGBRIDGE_ACCESS_TOKEN` | [open.longportapp.com](https://open.longportapp.com) | 注册开发者即获港美股实时 L2 行情与交易 OpenAPI；遵循 LongPort 官方规范带 `x-api-signature: HMAC-SHA256 SignedHeaders=authorization;x-api-key;x-timestamp, Signature=...` 头部签名 |
| **富途牛牛 (`futu`)** | 专业券商网关 | `FUTU_HOST` / `FUTU_PORT` (默认 11111) | [futunn.com/download/open-api](https://www.futunn.com/download/open-api) | 需在本机启动 Futu OpenD 客户端 |
| **老虎证券 (`tiger`)** | 全球券商 OpenAPI | `TIGER_ID`<br>`TIGER_PRIVATE_KEY` (RSA PEM 格式)<br>`TIGER_ACCOUNT_ID` | [developer.itigerup.com](https://developer.itigerup.com) | 基于标准 RSA-SHA256 签名算法直连 TigerOpen 网关；支持港美股全品种交易与实时资产/委托申报 |

---

## 四、加密货币市场 (Crypto)

| 连接器 | 类型 | 认证方式与环境变量 | 官网与申请/下载地址 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **Binance (`binance`)** | 全球主流所 | 行情免密 / 交易 `BINANCE_API_KEY` | [binance.com/en/binance-api](https://www.binance.com/en/binance-api) | 行情开箱即用，交易支持 API Key 认证 |
| **OKX (`okx`)** | 全球衍生品所 | 行情免密 / 交易 `OKX_API_KEY` 等 | [okx.com/docs-v5/zh/](https://www.okx.com/docs-v5/zh/) | 支持 Demo 模拟盘与实盘下单 |
| **Bybit (`bybit`)** | 衍生品三大所 | 行情免密 / 交易 `BYBIT_API_KEY` 等 | [bybit.com/en/api-overview](https://www.bybit.com/en/api-overview) | Bybit v5 统一账户，免密行情 + 签名交易 |
| **CCXT (`ccxt`)** | 开源百所聚合 | 通用免密 / 各所凭证 | [ccxt.com](https://ccxt.com) | 支持 100+ 加密交易所的通用行情聚合 |

---

## 五、环境变量配置建议

可以将所需连接器的 Key 写入根目录 `.env` 或 `~/.dsh/settings.yaml` 中，例如：
```bash
# 美股与全球
FMP_API_KEY="your_fmp_api_key"
FINNHUB_API_KEY="your_finnhub_api_key"
POLYGON_API_KEY="your_polygon_api_key"
ALPACA_API_KEY="your_alpaca_key"
ALPACA_SECRET_KEY="your_alpaca_secret"
IBKR_GATEWAY_URL="https://127.0.0.1:5000/v1/api"
IBKR_ACCOUNT_ID="U1234567"

# A 股
TUSHARE_TOKEN="your_tushare_token"
QMT_GATEWAY_URL="http://127.0.0.1:5800"
QMT_ACCOUNT_ID="12345678"

# 港股
LONGBRIDGE_APP_KEY="your_longbridge_key"
LONGBRIDGE_APP_SECRET="your_longbridge_secret"
LONGBRIDGE_ACCESS_TOKEN="your_longbridge_token"
TIGER_ID="your_tiger_id"
TIGER_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
TIGER_ACCOUNT_ID="your_tiger_account_id"
```
