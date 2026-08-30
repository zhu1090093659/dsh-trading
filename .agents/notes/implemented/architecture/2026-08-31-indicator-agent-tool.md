# Agent Note: 指标能力接通 Agent 工具面（WS1a 核验关闭 + WS1b 交付）

Status: implemented

## Problem

docs/analysis-roadmap.md 定稿后开工 WS1a（#1）/ WS1b（#2）。开工前盘点发现两个
前置判断需要修正：

1. **#1 前提错误**：评审时"技术指标只在 GUI"不成立——`@dsh-trading/indicators`
   纯库早已在 main（287ca66「3.2 指标系统插件化」），且 GUI 的
   indicator-registry.ts 仅 9 行薄壳转发，双实现不存在。#1 的"抽包"任务实为
   已完成状态。
2. **#2 的架构约束**：kit（preset 平面、会话 isolate）拿不到 host/connector
   isolate 里的 MarketDataService（isolate 键互不可见）——crypto_funding_rate
   自取数 Binance 直连正是既有绕行先例。指标工具若放 kit，要么破坏路由语义
   （数据源固定），要么无法取数。

## Decision

- **#1 核验关闭**：指标集合/schema（6 指标 + IndicatorParamSpec）、GUI 单源、
  math 测试质量（手算金值 + 独立数学期望，非同义反复）三项核验通过，issue 关闭。
- **#2 = 工具工厂放 indicators 包子路径导出**（`@dsh-trading/indicators/tool`）：
  `createGetIndicatorsTool({ marketData, market?, providerLabel?, klineLimit? })`
  → `<market>_get_indicators`。connector-okx / connector-binance 各两行接入
  （inject 行情服务后注册，providerLabel 传 slug 供 Agent 溯源）。不独立建包——
  接入面就一个函数，单独建包过重（铁律 #4）。

Alternatives considered：

- **kit 侧注册**：落选——见上，isolate 键不可达；自取数绕行会固定数据源。
- **宏分析工具**（一次出完整定性报告）：落选——roadmap Q2 已裁决，分析框架是
  知识（WS3 skill），工具只提供可组合的原子能力。

## Consequences

- Agent 在任一激活 connector 下可用 `crypto_get_indicators`：入参 symbol
  （市场规范词汇）/ interval / indicators（逗号分隔，默认 6 个全算）/ points
  （截尾防 token 爆炸，默认 30 上限 100）；K 线走路由选中的数据源。
- required 缺失由 dsh-tools 框架校验拦截（execute 内同名校验为防御性冗余）；
  未知指标 id 报参数错误并列出可选集。
- WS3（分析框架 skill）的"每步用哪个工具"可以写实了。
- 验证：indicators 25 例（tool 5 例新增，含手算锚点 MA5=397）、全仓 build/test
  绿；connector-okx/binance 构建接入无回归。
