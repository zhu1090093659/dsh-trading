# Agent Note: 行情板块优化——图表/基本面页签 + 左价格/右涨跌幅双轴 + 区间统计框选

Status: implemented

## Problem

owner 参考同花顺 Web 端行情页（截图：牧原股份 002714，头部「图表/基本面」页签 + 左价格轴/右相对涨跌幅轴 + 右键统计区间涨跌幅）提出三项优化：

1. **行情板块只有图表**：公司基本信息（市值/估值/换手率/52周区间）在 GUI 无处可看——agent 侧早有 `cn/hk/us/crypto_get_fundamentals` 工具（kit 包，preset 平面），GUI 桥却不透传基本面。
2. **单价格轴**：看一段行情的相对涨跌要心算。
3. **区间统计无入口**：同花顺的右键「统计区间涨跌幅」在 owner 的裁决下不做右键菜单，改为「技术指标」同排按钮「区间统计」。

## Decision

1. **基本面数据面 = 连接器可选契约**（不进 shell、不进 kit 复制）：
   - `@dsh-trading/api` 的 `MarketDataService` 增可选 `getFundamentals(symbol): Promise<StockFundamentals>`——仅当数据源在同一公共端点携带基本面字段时实现；
   - connector-tencent 实现（cn/hk 同包双实例各一行）：`getFundamentals` 与 `getTicker` **同一行报价**零额外请求（fetch 路径抽 `#fetchQuoteFields` 共用）；
   - 桥新增 `GET /fundamentals?market&symbol`（registry-first 透传）；连接器未实现 → 业务错误 `TRADING_NOT_IMPLEMENTED`（HTTP 200 ok:false），前端降级；
   - **字段序实证修正**：52 周高/低在真实 cn 报价行的 f67/f68（`spikes/impl-cn-hk/r4-fundamentals/` 2026-09-02 实测核字段）——**kit-cn 的 68/69 映射偏了一位**（其夹具比真实行多一个空位，生产会拿 -0.95 当牧原 52 周低），同变更修复。
2. **GUI「基本面」页签**（QuoteStage 头部 tab 条，跨标的保持）：
   - `FundamentalsPane`：估值/规模/交易信息网格，值缺省整格隐藏；市值单位按市场（元/港元/美元）；
   - us/crypto 派生模式：`fetchFundamentals` 失败/未实现 → null，面板显示降级说明 + 日K派生 52 周高低（DAILY_LIMIT 60→260），不报错横幅（沿用「桥业务错误信封必须转 rejection」纪律，catch 后落 null）。
3. **双价格轴（左价格/右相对涨跌幅，同花顺式）**：TvChart 蜡烛 + 主图叠加指标迁到 `left` 价格轴；右轴放三根**透明镜像 LineSeries**（high/low 包络 = 蜡烛高低 ∪ 主图指标输出，close 序列供徽标）。关键：**镜像序列的数值仍是价位，百分比只出现在 priceFormat custom formatter 里**——这样右轴刻度行与左轴逐行对齐（若直接喂百分数值，两轴 nice-tick 生成各行其是，行对不齐）。参考价 = 可视区最左一根K线收盘（visibleLogicalRange 订阅 + rAF 去抖 applyOptions 换新 formatter 对象强制重绘）；徽标色随最后一根K线方向。
4. **区间统计**：
   - `range-stats.ts` 纯计算层（基准=首根收盘；振幅相对基准；上涨/下跌根数以前收为参照），单测冻结口径；
   - TvChart `rangeSelectionMode`：applyOptions 关 handleScroll/handleScale，指针拖拽画高亮带，抬起时 `coordinateToLogical` 换算闭区间上报（单击=清除）；
   - QuoteStage「区间统计」按钮紧挨「技术指标」左侧，统计浮层挂 chartBox 右上角（日期跨度 + 着色涨跌行 + × 关闭），ESC 退出模式并清选区。

## Alternatives considered

- **shell 导入 kit 的 fundamentals 模块**：base 壳依赖四个市场 kit，层次倒挂；连接器才拥有数据源，且 cn/hk 报价行本来就带这些字段（零新请求）。
- **MarketDataService 契约加必选方法**：us（stooq）/crypto（binance）数据源根本不携带基本面字段，可选方法 + 消费方降级才诚实。
- **右轴直接喂百分数值序列**：autoscale 范围是百分数域，与左轴价格域的 nice-tick 行错位（参照截图逐行测得：右轴标签就是左轴价签的 reference 变换，如 52→+2.04%、44→-13.65%）；formatter 方案才是行对齐的充要条件。
- **区间高亮走 ISeriesPrimitive canvas**：v5 primitive 面要处理 hit-test/重绘生命周期；DOM overlay（pointer-events:none 绝对定位 div）在禁用平移的框选模式下坐标恒定，成本趋零。
- **框选期间不 pan 用 pointer capture 硬拦**：直接 handleScroll/handleScale 关掉，图表自身不消费拖拽，crosshair 仍可用（与同花顺框选时十字线跟随一致）。

## Consequences

- us/crypto 的「基本面」页签是派生口径（52周高低），待 connector-yahoo/binance 实现可选 `getFundamentals` 后自动升级，前端零改动；扩展点已写进 api 契约注释。
- 右轴参考价随滚动实时变化（同花顺同款语义）：同一根K线的右轴读数会随视口起点漂移，固定锚点的需求（若有）未来加锁存按钮。
- 框选模式关闭图表平移/缩放，ESC 或再点按钮退出；选区不持久化（刷新即清）。
- kit-cn 52 周高低字段修正随本变更生效：`cn_get_fundamentals` 工具输出自此与真实行情行一致（修正前 52周低恒为涨跌幅字段值）。

## Verification

- pnpm build / test 全绿：666 passed（+9：connector +2、bridge +3、range-stats +4）。
- 桥端点实机 curl（profile 实例）：cn 600519.SH 全量、hk 00700.HK 含股息率 0.0122、us AAPL `TRADING_NOT_IMPLEMENTED`。
- trading-web profile 副本经 inode 核对 + `ln -f` 重建硬链接（client-ui-trading 原本就直达；connector-tencent/kit-cn/api 分叉已归一），实例按端口重启（3081，勿动 3080）。
- 真实 Chrome（browser-use CDP）走查：牧原 002714——图表页签双轴对齐（52↔+2.04%、44↔-13.65%、现价 42.10↔-17.38% 绿徽标）；基本面页签八格全量渲染（PE TTM 15.69 / PB 3.07 / 总市值 2430.43亿元 / 52周 58.34~31.81）+ 数据来源行；区间统计按钮激活态、拖拽高亮带、浮层统计（2026-04-20~09-02，-6.23%/46.03/31.81/振幅+31.67%/94根/涨41跌52）与口径自洽；ESC 退出清选区；AAPL 切换显示派生降级说明 + 仅 52 周两格。
- **可复用坑**：CDP 验证隐藏标签页时 `Page.bringToFront` 无效（Chrome 原生遮挡检测仍报 hidden，usePoll 冻结、图表空白）——`Emulation.setFocusEmulationEnabled(true)` 才能让 `visibilityState` 变 visible，验证完务必关掉恢复原生行为。
