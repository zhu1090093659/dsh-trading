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
## 重命名与清扫纪律（2026-10-01 补充）

全局重命名（词汇更替、包/行改名、状态机枚举改名）时按两类分别处置，**两类不能混**：

1. **行为定义 / 规范性用法**必须换成新名；**被否决方案记录**必须保留原名并显式标注弃用（否则后来者会把已否决的旧名当成备选方案重新拾起）。
2. **清扫不能用抽样计数确认，必须按上述两类逐处分类全量核对**。

第 2 条的由来是一次实测失败：改完一轮后只统计「全文还剩 N 处旧名」便判定「都在解释性语境」，复核发现**同一节内的两个规范性位置口径不一致**（开头词汇表列旧名、下一行的唯一状态量已列新名）。同节自相矛盾是 review 最难抓的形态——读者通常只读一段，两段各自看起来都对。**计数正确不等于分类正确。**
