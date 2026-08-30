# Agent Note: 自选页签直接添加标的 + 内置字典联想

Status: implemented

## Problem

用户反馈：自选界面没有直接添加标的的入口（添加表单只在市场页签渲染），且输入代码
无自动联想——加一个标的要先切市场页签、且要知道交易所方言（如 00700.HK）。

## Decision

1. **自选页签也渲染添加表单**：跨市场添加需要一个目标市场——加市场轮换按钮
   （crypto→us→cn→hk 循环，显示当前市场名）；该按钮仅兜底"字典外符号回车直接加"
   的目标市场。
2. **内置标的字典联想**（`symbol-catalog.ts`：crypto 50 / us 50 / cn 40 / hk 30，
   symbol+中文名静态快照）：输入触发**跨市场全局搜索**（前缀 > 名字/包含 > 包含
   三级评分），候选项带市场标签，**点选即加**（addInstrument 带上候选 name，行情行
   直接显示中文名）。
3. 联想下拉绝对定位悬浮（首版放 flex 行内挤压表单，截图复查发现后改 absolute）。
4. 词汇纪律：字典 symbol 全部市场规范词汇（docs/symbol-vocabulary.md）。

## Alternatives considered

- **接交易所 instruments 端点做动态全集**：正确终态但要动 api 契约（MarketDataService
  加 listInstruments）+ 各 connector 实现——本迭代不做，字典退化为冷启动加速的定位
  已写在 symbol-catalog.ts 头注。
- **联想仅在输入后回车填入（不直接加）**：多一步无收益，点选即加更顺。

## Consequences

- 字典是静态快照：新上市标的不在联想里，但回车直接添加的能力保留（规范词汇照加）。
- 行情行 name 来自候选/种子；表单直加（字典外）的行 symbol 即 name（显示 symbol）。
- 验证：client 31 例绿；browser 端到端（输'腾'→ 全局联想出 00700.HK 腾讯控股(港股)
  → 点选即加 → 行名正确）；截图复核联想悬浮不挤压表单。
