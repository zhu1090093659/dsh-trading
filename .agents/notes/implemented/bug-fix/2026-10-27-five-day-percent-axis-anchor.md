# Agent Note: 五日级别右轴百分比锚点——从「可视区首根收盘」改为昨收

Status: implemented

## Problem

owner 2026-10-27 报「五日界面右侧涨幅算得不对」：头部是「41.61 +0.0700 +0.17%」（牧原股份 002714.SZ，
10/27 13:15），同一根现价对应的右轴徽标却是 `0.75%`。

反解右轴标签（`percentLabel`）得当时参考价 ≈ 41.30 = 当天 09:30 首根 K 线收盘；`0.17%` 的基准是昨收
41.54。两者差 0.58 个百分点——不是算错，是锚错：[双轴与区间统计](../../archived/feature/2026-09-02-quote-fundamentals-tab-dual-axis-range-stats.md)
定的参考价是「可视区最左一根 K 线收盘」，而五日档位默认只显示 1 个交易日（同花顺式分时），最左一根
恰好是当日开盘那一根。于是右轴读「相对开盘的涨幅」，头部读「相对昨收的涨幅」，两个数必然打架。

## Decision

- **五日级别（视图级别 `5d`）右轴锚点 = 昨收**：`QuoteStage` 把 `stats.prevClose`（快照官方
  `ticker.prevClose`，缺省退日 K 倒数第二根收盘）作为 `TvChart` 的新 prop `percentRef` 传入。锚点固定，
  滚动、缩放、换档位都不再重算——右轴读数恒等于头部涨跌幅的口径。
- **其余级别不变**：日K/周K/月K/分钟K 继续用「可视区最左一根收盘」，区间累计涨跌的读法保留。
- `axis-width.ts` 新增 `percentAxisRef(percentRef)`：合法正价 → 该值，否则 null。右轴 formatter
  （`mirrorPercentFormat` 经 `refPriceRef`）与宽度下限共用这一个判据，口径不复制。
- `percentLabelCandidates` 增可选 `ref`：给了就按锚点直接算两端标签。固定锚点可以落在可视收盘
  区间之外，旧的「参考价必落在收盘极值区间内」包络会把标签算窄（宽度下限偏窄 → [抖动](./2026-09-15-chart-axis-width-feedback-jitter.md)
  的反馈链重新闭合）。
- `TvChart` 新增锚点变化的 effect：进出五日级别、换标的换昨收时立刻按新口径重设参考价，不等下一次
  可视区事件——否则退出五日级别后右轴会停在昨收口径上。

## Alternatives considered

- **五日锚「可视窗口首个交易日的昨收」**（同花顺五日口径）：档位=1 天时同样等于头部涨幅，但档位≥2 天
  时当前价那一行仍是跨日累计，与头部涨跌幅依旧不一致；而且窗口首日的昨收不在 5 日 1m 序列里，需要
  额外一次日 K 取数。2026-10-27 的问答里 owner 选了「锚昨收」，本条落选。
- **全部级别统一锚昨收**：日K 上「这段行情涨了多少」的读法直接消失，owner 未采纳。
- **保留可漂移的锚点、只在头部标注口径**：读数仍随滚动变化，用户看到的仍是两个不一致的百分比。
- **把右轴改成百分数域序列**：与左轴刻度行对不齐（见归档记录的同一否决）。

## Consequences

- 五日级别的右轴读数恒定（原来随视口起点漂移的同花顺式语义在五日级别上不再成立）；其余级别的漂移
  语义不变。
- 昨收缺省（`getTicker` 无 prevClose 且日 K 不足两根）时自动退回可视区首根口径，渲染不中断。
- 右轴宽度下限在五日级别按昨收算：锚点落在可视收盘区间外时标签可能宽一个字符，换的是不抖。
- 右轴不再随可视区变化，`syncRefPrice` 在五日级别仍挂在 `visibleLogicalRange` 上，只是每次算出同一个值
  就直接返回（不再触发 formatter 刷新）。

## Verification

- `packages/client-ui-trading` 全量：72 个测试文件 / 608 例全绿（2026-10-27，`npx vitest run`）。
- `test/axis-width.test.ts` 新增 3 例：`percentAxisRef` 口径守卫（缺省/0/负数/非有限 → null）、同一价位
  在昨收 41.54 与首根收盘 41.30 两个锚点下分别读 `0.17%` / `0.75%`（用户报的那两个数的对照）、固定锚点
  落在收盘区间外时候选按锚点算（`12.33%`/`11.01%` 而非 `1.10%`/`-1.08%`）。
- 页面级视觉未验收：本次会话未挂载 Computer Use（`cua_driver_native_*`），桌面壳窗口级截图未做；
  右轴读数由上面的 formatter 单测冻结。
- 副本已生效：`scripts/refresh-profile.sh --dsh-home ~/.dsh-trading --package client-ui-trading trading-web`
  刷新后，profile 里那份 `lib/client.js` 与仓库构建产物 sha256 一致（`6d49a1a2…`），包内可见
  `percentRef`/`percentAxisRef`；宿主随后自启于 127.0.0.1:50839。
