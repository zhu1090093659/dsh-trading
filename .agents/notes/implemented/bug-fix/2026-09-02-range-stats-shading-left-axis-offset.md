# Agent Note: 区间统计阴影区整体左移一根左轴宽度（容器坐标误当 pane 坐标）

Status: implemented

## Problem

用户报告（2026-09-02，附截图）：区间统计框选截止 2026-09-02，悬浮面板显示
`2026-07-08 ~ 2026-09-02`（提交的逻辑下标区间正确），但 X 轴阴影高亮带右缘
只画到 08-20，左缘也相应落在约 06-25——整条阴影带相对真实选区左移约 9 根
K 线（一根左价格轴的像素宽度）。

### 根因

TvChart 的框选交互混用了两个坐标系：

- **拖拽/阴影绘制**：以容器 div 左缘为原点（`event.clientX - box.left`、
  overlay `left/width` 样式）。容器包住整个图表控件，**含左价格轴**。
- **lightweight-charts `coordinateToLogical` / `logicalToCoordinate`**：以
  pane（绘图区）左缘为原点——`TimeScale._internal_indexToCoordinate` 用的是
  pane 内部宽度（`_private__width`），不含两侧价格轴。

左价格轴（双轴功能 2026-09-02 引入 `leftPriceScale.visible: true`）使容器
原点在 pane 原点左侧约 60–90px（≈9 根 K 线）。于是：

1. pointerup 把容器像素直接喂 `coordinateToLogical` → 提交区间整体右移
   （右端拖到最新一根时被 `lastIndex` 钳位掩盖，故悬浮面板日期看似正确；
   左端实际提交的是光标右侧约 9 根处的 K 线）；
2. 阴影绘制把 pane 坐标直接当容器 `left` → 已提交选区反查出的坐标整体
   左移一个轴宽，与拖拽中的像素矩形（视觉正确）在松手瞬间发生跳变。

## Decision

TvChart 两处换算补齐 pane 偏移，互为逆变换：

- `handleRangePointerUp`：容器 x 减 `chart.priceScale('left').width()` 后再
  `coordinateToLogical`；
- `selectionRect` 已提交分支：`logicalToCoordinate` 结果加回同宽度再绘制。

`IPriceScaleApi.width()` 对不可见轴返回 0，左轴隐藏时自动退化为旧行为；
拖拽中的纯像素矩形不经过图表 API，无需处理。

## Consequences

- 拖拽矩形 → 提交区间 → 阴影绘制三者在同一坐标系闭环：阴影边缘与光标
  选中的 K 线逐根对齐，松手不再跳变；悬浮面板日期与阴影两端一致。
- 轴宽随价格量级/窗口宽度动态变化，两处均在事件/渲染时实时取值，不缓存。
- 验证链：`pnpm build` + `pnpm test` 93 文件 666 用例全绿 → client 产物经
  硬链接即时生效（profile file: 副本与仓库 lib 同 inode 98184448，实例运行
  中无需 install/重启）→ owner 实机确认阴影与选区对齐后合入。
