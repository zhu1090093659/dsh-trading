# Agent Note: 行情读数行昨收跟随十字光标K线（原为恒定官方锚点）

Archived: 2026-09-04
Status: implemented

## Problem

用户报告（2026-09-01，附两张 BTCUSDT 日K 对照截图）：行情页 K 线读数行
「昨收/开/高/低/量」中，开/高/低/量随十字光标切换到悬停K线，但 昨收 恒定
不变（始终显示最新交易日的官方昨收锚点 77757.50）。全市场所有标的同样复现。

### 根因

`QuoteStage` 读数行的 开/高/低/量 取自 `readoutCandle`（= `klines[readoutIndex]`，
`readoutIndex` 跟随 TvChart `subscribeCrosshairMove` 上抛的 `hoverIndex`），
唯独 昨收 直接渲染 `stats.prevClose`（官方快照锚点 `ticker.prevClose`，
见 [us-quote-prevclose-yahoo-anchor](2026-09-01-us-quote-prevclose-yahoo-anchor.md)）。
该锚点只对「最新交易日」语义正确，对历史悬停K线恒定不变，属字段取值错位。

## Decision

`QuoteStage` 新增 `readoutPrevClose`，读数行昨收改为：

- 悬停历史K线（`0 < readoutIndex < klines.length-1`）：取**当前周期序列的
  前一根收盘价**（`klines[readoutIndex-1].close`；日K下即该日昨收，与该行
  开/高/低/量同源同窗，悬停跨周期切换自动成立）。
- 未悬停 / 悬停最新一根：沿用官方锚点 `stats.prevClose`——不回退今晨
  yahoo-anchor 修复（Yahoo 日K补齐滞后时序列倒数第二根会错位一个交易日，
  该修复明确警示过「用日K尾部推昨收的新消费方会复发」）。
- 序列首根（无前一根）：留空显示 `—`，不伪造锚点。
- 顶部报价头的实时价/涨跌额/涨跌幅仍用官方锚点（富途语义：大盘报价常驻
  实时，读数行跟随光标），两者解耦互不影响。

## Consequences

- 读数行五个字段对悬停K线语义一致（同序列同窗）；对最新一根/未悬停保持
  官方昨收口径，头部涨跌锚点行为零变化。
- 浏览器半不写单测（仓库约定），走实机验证链：`pnpm build` + `pnpm test`
  66 文件 484 用例全绿 → client 产物经硬链接即时生效（profile file: 副本
  与仓库 lib 同 inode，实例运行中无需 install/重启）→ 真实 Chrome 实测
  BTCUSDT 日K：悬停 4 根不同历史K线，昨收逐一变化且与 API 序列前一根
  收盘逐位相等（80911.30/63331.30/63817.20/63478.90 全匹配）；移出图表
  回落官方锚点；悬停 2026-06-08 截图留证。
- 排查插曲：实机首验时图表空白为 `usePoll` 的 visibilityState 门控在后台
  标签页暂停轮询所致（既有省流设计，非回归）；activate_tab 后恢复正常。
