# Agent Note: 自选迷你走势改为日内分时（intraday sparkline）

Status: implemented

## Problem

自选列表「走势」列此前用近 32 根**日 K 收盘**拼迷你图（SPARK_INTERVAL='1d'），且只在自选列表变化时惰性拉取、10min TTL 形同虚设——长期挂着的面板走势永不刷新。主流行情软件（富途/雪球/TradingView）的自选迷你图是**单个交易日的日内实时走势**：交易日显示今天盘中走势；非交易日显示最近一个交易日的完整走势；分钟线拉不到时用 1m K 线收盘拼当日走势。

## Decision

数据语义转向（视觉结构不变，仍 Sparkline.tsx 56×22 渐变面积图）：

- **crypto**（7×24 无交易日）：滚动 24h，取 5m×288。1m×1440 超交易所单次取数上限（MAX_KLINE_LIMIT=1000 之外还有交易所自身上限），288 点对 56px 迷你图视觉无差。
- **股票（us/cn/hk）**：分钟线粒度**按连接器能力自适应**——候选 1m→5m 按序尝试，首个成功粒度记入缓存条目（ReferenceSeries.interval）后续直用，避免每拍重打必失败的粒度。实证驱动：腾讯 A 股无 1m（支持 5m/30m/1d/1w/1M），港股腾讯公开端分钟线全不支持（TRADING_UNSUPPORTED_INTERVAL）；Yahoo 美股 1m 可用（窗口 7 天）。取数上限 1m×500（覆盖美股常规时段 390 根 + 余量）/ 5m×200。按**最后一根 bar 的市场本地日期**筛当日 bar（us=America/New_York、cn=Asia/Shanghai、hk=Asia/Hong_Kong，DST 由 Intl.DateTimeFormat 处理）。**不维护节假日历**：非交易日时上游最后一根 bar 自然落在最近交易日，筛选语义自动满足「显示最近交易日」。
- **降级链**：分钟线抛错或返回空（如腾讯公开端明确不支持港股分钟线，connector-tencent/src/rest.ts:595）→ 回落 1d×32 日 K 走势（原行为），mode:'daily' 条目 10min TTL 内复用、过后重试分钟线。
- **刷新**：走势序列独立 usePoll 60s 一拍（分钟 bar 粒度下足够「活」又对公共端温和），页面隐藏暂停；不再挂在 rowsKey effect 上（旧实现 TTL 永不触发的问题随之消失）。
- **prevClose 兜底不变**：涨跌幅锚点仍 ticker.prevClose 优先；仅当缓存缺 prevClose 时补拉一次 1d×2（日 K 缺最新收盘 bar 的错位风险仍在，故永远让位于快照官方锚点）。
- **固定交易时段 x 轴（同日后续修正）**：盘中未走完的交易日不得把已有数据拉伸铺满全宽（否则上午 11 点的分时看起来像已收盘）。股票每点带 xFractions——bar 开盘时刻映射到固定时段窗口的 0..1 位置（us 9:30–16:00 ET=390min；cn 9:30–11:30+13:00–15:00=240min，午休压缩；hk 9:30–12:00+13:00–16:00=330min），时段外钳制到最近边界；Sparkline 按 xFractions 定位、面积填充只覆盖已绘线段（右侧留白）。crypto 滚动 24h 与日 K 降级窗口天然固定，等距铺满不变。
- 纯函数选材逻辑抽为 src/client/intraday-series.ts（intradayCandidates / intradayRequest / selectIntradaySeries / sessionXFraction），ReferenceSeries 增 mode / interval / xFractions 字段。

## Alternatives considered

- **维护美股/A股/港股三套节假日历判断「是否交易日」**：准确但长期易错、需持续运营；「最后一根 bar 的本地日期」语义零维护且覆盖停牌等日历外场景。否决日历方案。
- **crypto 按 UTC 当日分组**：与「最新价/涨跌幅」列的 24h 口径不一致（Binance ticker 的 prevClose 是 24h 前价格），迷你图与涨跌幅各说各话。选滚动 24h。
- **为东财 trends2 等专用分时接口加连接器抽象**：当前连接器只有 getKlines 一个面，为迷你图单开抽象成本不成比例；1m K 线即用户所说兜底链路，本身已是统一解。个别连接器的分时优化留待日后。
- **降采样到 ~60 点**：240–390 点的 SVG polyline 渲染无压力，全量点保留「毛刺真实感」。不降采样。

## Consequences

- 自选走势对盘中用户「活」了：60s 粒度跟随当日分时；非交易日静态展示最近交易日全天。
- 港股走哪个源决定走势形态：腾讯源分钟线全不支持 → 日 K 降级（10min 重试）；**eastmoney 源已打通港股分钟线**（trends2，见 [2026-09-08-eastmoney-hk-market](2026-09-08-eastmoney-hk-market.md)）→ hk.provider=eastmoney 时港股同样走日内分时；A 股（腾讯源）自动落到 5m 日内分时。
- 轮询成本：每标的每分钟 1 次分钟线请求（N 标的 = N 请求/分），公共端可承受；首屏 prevClose 补拉一次性。
- Yahoo 公共端 1m 有约 15min 延迟（美股迷你图相应滞后），属数据源固有限制。
- 测试：test/intraday-series.test.ts 覆盖候选粒度与取数上限、crypto 滚动不分组、us/cn/hk 本地日筛选、节假日回落最近交易日（2026-09-07 美国劳动节实证）、三市场固定时段 x 映射（含午休压缩与时段外钳制）。真机实证：11:07 CST A 股盘中走势只占左 ~40% 宽度。门禁 pnpm build / pnpm test 全绿；真机验证走 trading-web profile（3081 实例）+ CDP 延迟截图——注意 headless Chrome --timeout 是上限不是等待，load 事件一到就截图，行情面板须用 CDP 主动等 ~20s 再 Page.captureScreenshot。
- 视觉结构记录见 [2026-08-31-futu-ui-visual-upgrade](2026-08-31-futu-ui-visual-upgrade.md)（本记录取代其数据语义面）。