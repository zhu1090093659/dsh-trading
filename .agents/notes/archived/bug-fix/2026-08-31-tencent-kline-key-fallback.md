# Agent Note: 腾讯 K 线响应键回落——hk 无前权代码返回 day 而非 qfqday

Status: implemented

## Problem

用户实测（HK 预设选中美团-W 03690）：K 线加载失败
`TRADING_UNSUPPORTED_SYMBOL: Tencent klines for 03690: no qfqday rows`。
同端点对腾讯控股 00700 正常——解析只认 `qfqday` 键，而腾讯 hkfqkline 端点对
**无前权事件的代码**返回 `day`（未复权）键（curl 实证留痕：hk03690 → day，
hk00700 → qfqday）。此前 hk 种子只测过 00700，未覆盖"无前权事件代码"形态。

## Decision

解析键回落：`qfqday ?? day`（week/month 同理 `qfqweek ?? week`/`qfqmonth ?? month`）。
裸键行结构与 qfq 行相同（附加对象字段可能为空对象 {}，解析本就丢弃）——无结构风险；
语义上该代码当前无前权事件，未复权价即前权价。

## Alternatives considered

- **报错让用户换代码**：荒谬——代码本身有效（报价 r_hk03690 正常返回 77.50）。
- **只对 hk 回落**：cn 的 fqkline 同端点族同样可能有此形态，回落逻辑不区分市场。

## Consequences

- 美团 03690 K 线经桥真实数据验证 ✓（78.2/79.45/77.75 与原始响应一致）；00700
  qfqday 路径回归不受影响。
- 坑清单补录（connector-playbook §6）：**同端点的响应键形态因代码而异**——凡是
  "按可选字段取数"的解析都要测有/无两形态。
- 验证：tencent 28 例（+1 day 回落用例）。
