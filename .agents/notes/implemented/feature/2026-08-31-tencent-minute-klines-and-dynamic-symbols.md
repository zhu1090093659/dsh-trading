# Agent Note: 腾讯分钟 K 线（5m/30m）与动态标的全集联想融合（结清 Issue #14, #15）

Status: implemented

## Problem

1. **[Issue #14](https://github.com/zhu1090093659/dsh-trading/issues/14)**: A 股（cn）此前仅支持日/周/月线（fqkline 端点），无法查看盘中 5m/30m 短周期 K 线；需要将 API 契约中的 5m/30m 接入腾讯分钟线端点并在 GUI 周期条与各连接器映射中落地。
2. **[Issue #15](https://github.com/zhu1090093659/dsh-trading/issues/15)**: 前端左侧自选/搜索输入框使用的是静态快照字典（symbol-catalog.ts），对于新币/未预置代码无法自动联想；需要扩展数据契约 MarketDataService.listInstruments，在 Binance（/api/v3/exchangeInfo）与 OKX（/api/v5/public/instruments?instType=SPOT）实现全集提取，经 HTTP 桥端点带进程内 TTL 缓存暴露，并在 GUI 侧与静态种子无缝融合。

## Decision

- **腾讯分钟 K 线（@dsh-trading/connector-tencent）**:
  - 分钟分支（5m/30m）走腾讯 mkline 端点: https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={wire},{tf},,{count}（host 无 web.，param 无 qfq 段）；
  - 时间戳解析: 解析 12 位紧凑字符串 YYYYMMDDHHmm，按 Asia/Shanghai 墙钟精准计算 epoch ms；
  - 港股分流安全: 由于公共 mkline 暂不支持港股代码，港股请求 5m/30m 明确返回 TRADING_UNSUPPORTED_INTERVAL；
  - GUI 联动（@dsh-trading/client-ui-trading）: 行情间隔栏补齐 5分/30分（中英文文案与周期列表），MARKET_INTERVALS 中 cn 与 crypto 开放 5m/30m。
- **动态标的全集（@dsh-trading/api, connectors, bridge, client）**:
  - 契约层: MarketDataService 增加可选方法 listInstruments(): Promise<Array<{ symbol: string; name?: string }>>，输出 symbol 一律遵循市场规范词汇；
  - Binance 连接器: 调用 /api/v3/exchangeInfo，过滤 status === TRADING，输出 { symbol: s.symbol, name: baseAsset/quoteAsset }；
  - OKX 连接器: 调用 /api/v5/public/instruments?instType=SPOT，输出规范形 toCanonicalOkxSymbol(s.instId) 与 { symbol, name: baseCcy/quoteCcy }；
  - 腾讯 / Yahoo / Stooq: 遵循铁律 #4（不过早抽象），无公共全集端点保持最小缺省，由桥与前端优雅回退；
  - HTTP 桥端点: /dshtrading/api/symbols?market=m 实现 30 分钟进程内 TTL 缓存（防高频重打全量接口），未实现或失败静默回退空数组；
  - 前端联想融合: symbol-catalog.ts 实现静态快照并集动态全集融合（静态优先保留中文名，动态新标的作为扩充项），切页签异步预取，超时/离线静默降级不阻塞输入。

## Consequences

- 结清 Issue #14 与 Issue #15 全部要求。
- A 股与 Crypto 在 GUI 及数据面均支持 5m/30m 分钟级别 K 线。
- Binance 与 OKX 支持动态全量标的联想（如搜索新币或冷门代币均能直接联想出规范符号与币种名称），无端点市场保持极速静态字典打底。
- 全仓单测用例增至 252 个，19 个包构建与测试全绿。