# Agent Note: 市场规范符号词汇（symbol-vocabulary）——消费方与交易所方言解耦

Status: implemented

## Problem

用户实测暴露（2026-08-31，3081 实例截图）：settings 路由 crypto.provider=okx 时，
GUI 自选清单（Binance 词汇 BTCUSDT）的报价/K 线全数报 `TRADING_UNSUPPORTED_SYMBOL:
OKX invalid instId`。根因是架构缺口：api 契约从未定义市场级规范符号词汇，消费方
（GUI 自选、Agent 工具参数、存储）直接说交易所原生方言——**切换 provider 即报废
全部已存符号**。对交易平台形态这是不可接受的（用户的符号资产必须与数据源无关），
且注册表热切换（2026-08-30 #1）让该场景从「重启后才发现」变成「保存即撞见」。

## Decision

立规 `docs/symbol-vocabulary.md`（规范先行，用户裁决「先做规范再按规范修复」）：

1. **消费方只说规范形**：crypto=`BTCUSDT`（大写无分隔，多数派词汇）、us=`AAPL`、
   cn=`600519.SH`、hk=`00700.HK`（5 位补零）；衍生品 `-SWAP` 后缀为预留词汇。
2. **连接器 REST 边界互译，输入宽容、输出规范**：
   - okx：`normalizeOkxSymbol`（规范形按已知 quote 后缀表最长匹配拆 base/quote；
     横杠数消歧——`X-SWAP` 单横杠必为规范 SWAP，因无 quote 货币叫 SWAP；
     `BTC-USDT-SWAP` 双横杠为原生）+ `toCanonicalOkxSymbol`；消除 rest/index 两处
     私有校验副本；Ticker/Order/Position 输出规范形。
   - tencent：cn 接受 `600519.SH`（后缀优先于首位推断）/hk 接受 `00700.HK`；
     ticker 输出由请求时 wire 前缀还原规范形（响应体 fields[2] 只是裸代码）。
   - stooq：输出剥 `.US` 后缀（us 规范形无后缀）。binance/yahoo 原生即规范，不动。
3. **错误语义**：`TRADING_UNSUPPORTED_SYMBOL` 只用于所有已知词汇都解析不出或产品
   形态不支持；「不是我家方言」不再报错。
4. 知识下沉：api 契约注释挂规范、connector-playbook §3 加符号词汇行、README 定稿 #10、
   okx 工具描述改教规范形（Agent 读 description 学词汇）。

## Alternatives considered

- **GUI/桥层做翻译**：落选——Agent 工具参数有同样问题，翻译必须在连接器边界才
  一处生效；GUI 只管展示。
- **规范形选 OKX 横杠形**：落选——无分隔符是加密圈多数派（Binance/Coinbase/Kraken），
  选多数派降低用户认知成本；OKX 是少数派，翻译义务归少数派连接器。
- **quote 拆分查 instruments API**：落选——同步字符串翻译不该引入网络往返；
  已知 quote 后缀表（USDT/USDC/USD/EUR/BTC/ETH/OKB）是行业标准做法，表为连接器
  私有实现，新 quote 上线增补即可。
- **api 包提供共享互译工具**：落选（铁律 #4 不过早抽象）——各所互译规则不同，
  共享的只有词汇形态（规范文档），实现各归各。

## Consequences

- provider=okx + 自选 BTCUSDT 从全数报错变为正常取数（规范形自动互译 BTC-USDT）。
- crypto 衍生品规范形 `BTCUSDT-SWAP` 预留；Binance 永续原生形与现货同形（BTCUSDT）
  的歧义留待首个衍生品数据面落地时裁决（届时 Binance 期货连接器内 `X-SWAP`→永续、
  裸形→现货 的映射规则归该连接器）。
- 验证：okx 66+2 skipped（互译矩阵：规范/原生/小写/垃圾输入/未知 quote 后缀）、
  tencent 27（规范形输入 + 输出规范形）、stooq 21（输出剥后缀）；全仓 build/test 绿。
