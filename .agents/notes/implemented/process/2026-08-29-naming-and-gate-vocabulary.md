# Agent Note: 命名与闸门词汇约定（dsh-trading-<market>-* 行 id / <market>_* 工具名）

Status: implemented

## Problem

插件名、patch 行 id、工具名、skill 名、服务键五类词汇若不统一约定，多市场并存与统一闸门（按工具名模式匹配）都会失配。实现期真实发生过：闸门模式按 `dsh-trading-crypto_place_order` 写，而连接器注册的工具叫 `crypto_place_order`——两边单测各自绿、集成永不拦截（commit 0ca1ea2）。

## Decision

| 对象 | 形态 | 例 |
|---|---|---|
| npm 包名 | `@dsh-trading/<域>-<名>` | `@dsh-trading/connector-binance` |
| 插件名 = patch 行 id | `dsh-trading-<market>-*`（id 与 Cordis name 同值，TEMPLATES §8） | `dsh-trading-crypto-connector-binance` |
| 工具名 | `<market>_<verb>` 短市场前缀，绝无 `dsh-trading-` 前缀（模型面向词汇，对齐官方 read/write 短名惯例） | `crypto_place_order` |
| 闸门模式 | `/^(?:crypto\|us\|cn\|hk)_(?:place\|cancel)_order$/`（锚定首尾 + 市场枚举，新增市场须扩枚举） | base/src/index.ts |
| skill 名 | `<market>-*` | `crypto-risk-checklist` |
| 服务键 | `trading<Market>MarketData`（api 包模块增强声明） | `tradingCnMarketData` |
| preset id | `<market>-trader`（roster id = 目录名） | `hk-trader` |

## Alternatives considered

- **工具名带 `dsh-trading-` 长前缀**：模型工具体验差且与官方短名惯例相悖——否决（但曾因此前缀假设导致闸门失配 bug）。
- **闸门按工具参数/元数据判定而非名字模式**：工具注册表无统一「这是下单」元数据面，名字模式是最便宜的可靠信号——采纳模式匹配 + 市场枚举。

## Consequences

复制手册 §2 有对表；base 闸门测试含回归护栏（旧前缀形式必须不匹配）。双市场同包（connector-tencent）用行 id 分流 + `config.market` 注册不同前缀工具。
