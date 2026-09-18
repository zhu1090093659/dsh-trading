# Agent Note: TvChart 副图 legend 下漂——paneTops 测量未扣底部时间轴

Status: implemented

## Problem

自定义副图指标（pane 2+）图例垂直落进绘图区中段、与柱/线重叠（用户实测
2026-09-18 截图，VOL pane 1 同病但被成交量上方留白掩盖）。根因：paneTops
测量用 `container.clientHeight - Σpane.getHeight()` 反推分隔条厚度，而
lightweight-charts 的容器高度**包含底部时间轴** → 分隔条被高估
`timeAxis/(panes-1)`，pane 越靠后 top 下漂越多：pane 1 多漂半条时间轴，
末位 pane 恰好多漂一整条时间轴高度（≈28px），legend 正好落进绘图区中段。

## Decision

measure 前先扣 `chart.timeScale().height()` 再反推分隔条
（packages/client-ui-trading/src/client/TvChart.tsx，单点修复直走 main，
不引入 paneSeparators 等未公开 API）。门禁：tsc --noEmit 0 错，
client-ui-trading vitest 53 文件 450 用例全绿。

## Consequences

- **硬链接穿透（本轮实测）**：pnpm 对 file: 依赖建硬链接（同 inode），
  tsdown 原地覆写 lib/client.js 后 profile 副本（trading-web 实例磁盘
  bundle）内容立即一致（inode 98184448 双侧 cmp 一致，含新代码标记）——
  此类 client 单包重建后**无需跑 refresh-trading-web-profile.sh**，刷新
  页面即可取新 bundle。但 tsdown 若改为 unlink+重建 inode，穿透静默失效，
  刷新脚本仍是权威路径；重建后用 `ls -i`/`cmp` 核对 profile 副本再下结论。
- pane 几何相关后续改动（分隔线拖拽、stretch、pane 增删）务必把「容器高 =
  Σpane 高 + Σ分隔条 + 时间轴高」恒等式记全，反推量只能来自扣除时间轴后
  的差值。
