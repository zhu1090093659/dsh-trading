# @dshtrading/connector-template

**本包是脚手架源，不是可安装的连接器**：不入任何 bundle 依赖，仅在 `pnpm -r build/test`
基线内保证可编译、冒烟测试绿。真实接入用生成器：

```sh
node scripts/new-connector.mjs --slug bybit --title Bybit --market crypto
```

生成后按 [docs/connector-playbook.md](../../docs/connector-playbook.md) 的填写顺序
（src/rest.ts 头部清单 7 项）实现 TODO。每个 TODO 的参照段都在 connector-okx
（packages/connector-okx/），它是本仓第一个真实 TradeService 连接器。

## 结构

- `src/rest.ts` —— 错误载体（TradingServiceError）+ 通用请求管线（超时/错误映射/
  模拟盘头/注入 fetch）直接可用；签名与端点 TODO。
- `src/index.ts` —— Config（enabled/env/dryRun/liveTrading + 三 ref 凭证组）、
  闸门三态判定、凭证解析（BYOK + 环境变量回落）、MarketDataService/TradeService 骨架、
  7 个市场前缀工具注册（duplicate-safe）、apply（enabled=false 静默退出）。
- `test/template.test.ts` —— 结构冒烟 7 用例。

## Token

`qmt`（slug）/ `QMT`（title）/ `QMT`（ref 前缀）/
`crypto`（工具前缀）/ `Crypto`（服务键 infix）。token 未展开也可编译；
生成器保证全部替换。

## 注意（勿改的坑）

- 服务类用 TS 编译期 `private`（禁 ECMAScript `#`，realm 代理会炸）。
- 工具名 = 市场前缀 + 语义词（不带交易所名）——base 闸门正则只认市场前缀。
- 行 id = `dsh-trading-<market>-connector-<slug>`，全仓唯一（insert-only 铁律 #1）。
- 凭证只进 ref，绝不内置/落日志（铁律 #3/#5）。
