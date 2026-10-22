# @dshtrading/connector-ccxt

## 0.6.3

### Patch Changes

- @dshtrading/api@0.6.3
- @dshtrading/authority@0.6.3

## 0.6.2

### Patch Changes

- a838864: CCXT 连接器的 quote 表按所维护、K 线切到九所，并把 `TRADING_SYMBOL_NOT_FOUND` 补进 api 错误码词汇表：

  - `@dshtrading/api`：`TradingErrorCode` 收录 `TRADING_SYMBOL_NOT_FOUND`（已被 8 个连接器实际使用，
    此前只是漏进词汇表；与 `TRADING_UNSUPPORTED_SYMBOL` 的分界写进注释），**运行时错误码不变**。
  - `@dshtrading/connector-ccxt`：七条形态变换分支各有一份 quote 资产表（数据来源 = 该所公开挂牌端点
    普查），表外计价币仍零请求拒绝；K 线从单分支扩到九所（周期按所映射、行结构按所解析、输出升序、
    单请求根数按所裁剪），该所不支持的周期抛 `TRADING_UNSUPPORTED_INTERVAL` 且零请求；`exchange`
    只加在客户端方法与 `crypto_get_klines` 工具上，`MarketDataService.getKlines` 保持三形参；
    包内 `CcxtErrorCode` 下线。
  - 真实网络证据（`spikes/impl-ccxt-exchange-expansion/`）：七份挂牌普查 + 九份 K 线 + 六份上游 400 原文，
    `run-probe.ts` 退出码 0、63/63 判据通过。

- 86bb962: 设置页与 CCXT 连接器的「声明面」收窄到实现事实：

  - 设置页 provider 登记项按连接器 dataplane 的真实注册面改值（ibkr `['us']`、akshare `['cn']`、
    tiger `['hk']`；futu 行情面 hk+us 与实现一致）；futu 的 env 提示改指 Config 字段
    `gatewayUrl`（`FUTU_HOST` 从未被读取），`provider.envPrefix` 改中性措辞；bybit Secret 占位改
    `BYBIT_SECRET_KEY`（原先写 `BYBIT_API_SECRET`，与 schema 默认名不符）。
  - `connector-ccxt` 的所名面在同一天的后续变更里先收窄、再补齐：`SUPPORTED_EXCHANGES` 最终登记九所
    （binance/okx/bybit/gateio/kucoin/kraken/coinbase/bitfinex/htx，各一条真实直连分支），`getKlines`
    撤掉 `exchange` 形参（只剩 binance 一条路径，非 binance 的 `defaultExchange` 在请求前结构化拒绝）；
    登记面之外的所名仍在任何网络请求之前抛 `TRADING_NOT_IMPLEMENTED`（此前 6 个所名静默落 Binance
    兜底，选 `kraken` 会拿到 Binance 报价），两个工具的 `exchange` 枚举与描述同步。
  - 新增设置页登记项一致性测试（用真 dataplane 模块断言登记项 = 注册面）与 CCXT 所名面
    fail-closed 用例（拒绝路径零请求 + 三所分支 + 枚举断言）。

- Updated dependencies [a838864]
- Updated dependencies [add0db1]
  - @dshtrading/api@0.6.2
  - @dshtrading/authority@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies
  - @dshtrading/authority@0.6.1
  - @dshtrading/api@0.6.1

## 0.6.0

### Patch Changes

- @dshtrading/api@0.6.0
- @dshtrading/authority@0.6.0

## 0.5.0

### Patch Changes

- @dshtrading/api@0.5.0

## 0.4.1

### Patch Changes

- @dshtrading/api@0.4.1

## 0.4.0

### Patch Changes

- @dshtrading/api@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [152c0c0]
  - @dshtrading/api@0.3.0

## 0.2.1

### Patch Changes

- @dshtrading/api@0.2.1

## 0.2.0

### Patch Changes

- @dshtrading/api@0.2.0

## 0.1.6

### Patch Changes

- @dshtrading/api@0.1.6

## 0.1.5

### Patch Changes

- @dshtrading/api@0.1.5

## 0.1.4

### Patch Changes

- @dshtrading/api@0.1.4

## 0.1.3

### Patch Changes

- @dshtrading/api@0.1.3

## 0.1.2

### Patch Changes

- @dshtrading/api@0.1.2

## 0.1.1

### Patch Changes

- @dshtrading/api@0.1.1
