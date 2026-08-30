# Agent Note: 标的定性分析框架 skill（WS3 骨架交付）

Status: implemented

## Problem

docs/analysis-roadmap.md Q2 已裁决：定性分析走「基础工具 + skill 知识」而非宏工具。
WS1b（#2）交付了 crypto_get_indicators 后，知识层缺一块骨架：Agent 有工具但没有
「五步怎么走、判读规则是什么、什么情况降置信度」的方法论——不同会话的分析深度与
格式不可控。

## Decision

kit-crypto 新增 bundled skill `crypto-instrument-analysis`（assets/skills/，与既有
crypto-risk-checklist 同形态），provider 改双候选按名分发（get 未知名回落防御）：

- **五步框架**：定位（规范词汇 + 报价新鲜度）→ 趋势结构（多周期一致法：三周期一致
  才许用"趋势"一词）→ 量价配合（背离与异常量标注；低流动性降权）→ 波动率（BOLL
  位置 + 带宽收窄变盘临近）→ 资金面（funding 极端值 = 反向拥挤指标而非方向指标）
  → 新闻面占位（WS2b 的 crypto_get_news 交付后写实；未交付前明确写"未覆盖"而非编造）。
- **输出纪律**：定性结论 + 依据清单（每数据点标工具/参数/数值/时间）+ 反方情景
  （必须具体到指标与阈值）+ 置信度（单周期/新闻未覆盖/低流动性任一即不得标高）。
- **禁止事项**：无数据引用的结论、把滞后指标当预测、跳过反方情景。

## Alternatives considered

- **宏工具 crypto_analyze_instrument**：roadmap Q2 已裁决落选——分析框架是知识，
  硬编码进工具会让模型退化为播报员且框架迭代要改代码。
- **等新闻工具齐了再写 skill**：落选——骨架先行让 WS2a/WS2b 的验收（headless 跑
  完整分析）有对照物；新闻面占位显式标注即可。

## Consequences

- 分析能力闭环现状：行情（四 kit 工具）+ 指标（crypto_get_indicators）+ 方法论
  （本 skill）已齐；唯一缺口是新闻面（#3 spike → #4 实现）。
- kit-crypto 首次引入 test 脚本（vitest）+ provider 分发 3 例单测；provider 导出
  仅为可测性（命名空间不变）。
- 验证：kit 3 例、全仓 build/test 绿。
