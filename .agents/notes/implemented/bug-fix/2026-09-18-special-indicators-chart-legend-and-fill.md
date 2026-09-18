# Agent Note: 特殊指标四张图的价格轴文字压折线 + 固定像素高留白

Status: implemented

## Problem

用户 2026-09-18 实测截图反馈两条（中栏「特殊指标」四个二级页签通用）：

1. 图的「y 轴文字说明」压在折线上，部分折线看不清；
2. 图表按固定像素高绘制，中栏高度富余时卡片下方留大片空白。

第 1 条的机制在库契约里：组件把序列名交给 lightweight-charts v5 的 `series.title`，
而 v5 的定义是「显示在最新价标签旁边」（typings.d.ts `SeriesOptionsCommon.title`：
*Will be displayed on the label next to the last value label*）。最新价标签本身画在价格轴上，
紧随其后的序列名却向绘图区内延伸——左轴（板块指数/中证全指）的文字从左缘伸进绘图区约 80 px，
右轴（融资余额/恒科卖空占比）的文字向内侧延伸跨过折线末端。

第 2 条的机制在布局里：`.panel > .card` 只约束最大宽度、不参与中栏高度分配，卡片高度
= 内容高度；每张图又写死 `height={240}`（板块明细 280），于是中栏越高、卡片下方空白越大
（1600x913 视口下约 40%）。

## Decision

- **序列名改由组件自绘的 HTML 图例承载**：`LineChart` 在画布上方渲染
  `.chartLegend`（色块 + 名称，flex 自动换行），`series.title` 不再写进
  lightweight-charts 的序列选项（价格轴只留数值型最新价标签）。图例名进 zh/en 词典，
  不在视图里硬编码。
- **四张图统一补齐图例名**：恐慌指数（右轴）/ 中证全指（左轴）、IF / IM、卖空占比（右轴）/
  恒科指数（左轴）、融资余额（亿元）/ 板块指数。恒科页签的两条序列此前**没有**名称
  （图上无任何标识），本次一并补上；恐慌页签由此新增 `si.sentiment.scoreLine`，
  并把 `si.sentiment.indexOverlay` 由「中证全指（右轴）」改为「（左轴）」——该序列
  实现是 `scale: 'left'`，实机截图里 5600–7000 的刻度也在左轴，原文案与实现不符。
- **尺寸改由容器驱动**：`LineChart` 删除 `height` prop（包内私有组件，四个
  调用点同步改），画布改 `autoSize: true`（lightweight-charts 内部 ResizeObserver），
  `width/height` 仅作 ResizeObserver 不可用时的回退值；CSS 面
  `.chart { flex: 1; min-height: 160px }` + `.chartCanvas { flex: 1; min-height: 0 }`；
  同时删掉只监听 `window.resize` 的手工重排——中栏被外层网格改宽时它不触发。
- **卡片吃掉中栏剩余高度**：`.panel > .card { flex: 1 1 auto }`（配合卡片自身
  `min-height: auto`，内容高于中栏时不压缩、由 `.panel` 滚动）；板块双栏
  `.sectorLayout { flex: 1; min-height: 240px; align-items: stretch }`——排行表在自己栏内
  滚动（`.tableScroll` 的 320 px 上限撤掉）、明细图吃掉右栏余量；窄窗单栏堆叠时
  （`max-width: 1100px`）排行表恢复 320 px 内滚动。

## Alternatives considered

- **只关掉 `lastValueVisible`**：折线上确实不再有任何遮挡，但最新价读数（图的常用
  信息）也一起没了，且序列名仍然无处安放。
- **把序列名放进绘图区左上角的 overlay**（多数看盘页面的做法）：overlay 直接压在绘图区上，
  面积图的填充区尤其明显，与「不压折线」是同一类问题；HTML 图例在画布外，零遮挡。
- **保留固定像素高、只在面板里垂直居中**：空白从下方挪成上下各一半，中栏高度仍未被利用，
  窗口越高越浪费。
- **给每张图写死一个更大的高度**：中栏高度随窗口与左右侧栏变化，任何定值都会在某些窗口下
  留白、另一些窗口下溢出。
- **`.panel` 改 grid `1fr`**：能填满，但卡片内的图区还要再分配一次，等于
  同一套 flex 逻辑换个写法，还得重排既有滚动契约。
- **给 lwc 的 `priceScale.title`**：它是竖排在轴顶部/底部的另一处文字，不解决
  「名称紧贴最新价标签」这条机制，也与「放到上方」的诉求不符。

## Consequences

- 四张图各多一行图例（约 15 px），图形高度改为「吃掉卡片余量」：1600x913 视口下恐慌
  指数图由 240 px 长到约 480 px；矮窗口下不低于 160 px（双栏布局 240 px），再超出由面板滚动。
- `series.title` 语义收敛为「图例名」：不再影响画布，也不参与轴宽计算；无名序列
  不占图例位（`test/line-chart.smoke.test.tsx` 钉住）。
- `LineChart` 的公开面变化（删 `height`）只影响本包四个调用点，无跨包消费者。
- **与 [行情图轴宽互馈抖动](./2026-09-15-chart-axis-width-feedback-jitter.md) 不冲突**：那条
  反馈环由「百分比标签文本随可视区变化」驱动（自定义 formatter + 参考价取可视区最左收盘）；
  本视图价格轴用 lwc 默认数值格式、数据 `fitContent` 全量可见，刻度文本不随可视区
  翻转，且 ResizeObserver 观察的是容器（容器尺寸不依赖画布），不构成回路。
- 实机验证（桌面宿主 127.0.0.1:56280；桌面端与 CLI 共用 `~/.dsh-trading/profiles/trading-web`，
  file: 副本与工作区 `lib/client.js` 同 inode，宿主按盘读取重建产物）：四个二级页签图例
  均在画布上方、零「加载失败」；1600x913 下卡片吃满中栏、折线上无任何文字覆盖；1000x900 下
  板块页签单栏堆叠、排行表在 320 px 内滚动、明细图吃掉余量。
- 门禁：包内 36 例（7 文件，新增 `test/line-chart.smoke.test.tsx` 2 例）全绿；
  `node scripts/typecheck-gate.mjs` 475 = 基线 475；`pnpm i18n:check` OK
  （新增 3 键 zh/en 同步）；`pnpm test:audit` 无新增测试债；`pnpm -r build`、
  `pnpm -r test`、`pnpm test:scripts`、`pnpm test:desktop` 全绿。
