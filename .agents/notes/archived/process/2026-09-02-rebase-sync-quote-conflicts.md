# Agent Note: main 双向分叉 rebase 同步 — send-to-agent/双轴 × 远端主题/edge-limits 冲突裁决

Status: implemented

## Problem

本地 main（10 个提交：watchlist agent 可见性、send to agent、
fillComposer 重构、connector-tencent fundamentals、图表/基本面
tabs、双价格轴、区间统计、trading journal、阴影区修正）与远端
main（6 个提交：provider API credentials UI、行情名动态解析、
主题明暗对比修复、kline edge limits、拼音搜索、provider 卡片
主题）在 a0ac2b4 后双向分叉，双方都改了 client-ui-trading 的
QuotePane / QuoteStage / TvChart，rebase 到 origin/main 时三个
提交产生内容冲突。

## Decision（逐文件裁决）

1. **QuotePane.tsx**：远端把 chatOn/useSessions 逻辑整体删除
   （改为 MutationObserver 监听 `data-dshtrading-chat-folded`/
   主题属性触发重测量，依赖数组 `[chatOn]` → `[]`）。本地
   send-to-agent 链路只需透传 hook，与 chatOn 无耦合 → 保留
   远端结构，签名只加 `fillComposer`（sendToAgent 的改名版），
   丢弃 `useSessions`。
2. **QuoteStage.tsx**：双方新增物独立共存——远端的
   `inferMarketFromSymbol`（symbol 后缀/位数推断市场）+
   本地的 `SendState`/`sendToAgent`。常量冲突取远端
   `KLINE_LIMIT = 500`（kline edge limits 刻意上调）+ 本地
   `DAILY_LIMIT = 260`（基本面页签 52 周高低派生需要一年
   交易日；远端的 60 是未改动的旧基线值，非刻意裁决）。
3. **TvChart.tsx**：远端把单份 options 字面量重构成
   `getChartThemeOptions(dark)` 暗/亮双分支。本地双轴的
   `leftPriceScale` 原本只存在于单一字面量 → **亮暗两个分支
   都补 `leftPriceScale`**（亮 #e5e7eb、暗 #2a2e39，与各自
   rightPriceScale 边框色一致），否则切暗色主题后
   `applyOptions` 丢配置、左轴消失。第二个冲突块两边独立
   （远端主题监听 useEffect + 本地镜像 formatter rAF 去抖），
   依序共存。双轴注释块留在亮色分支。
4. 冲突块 1 解析时引入过一个重复 `},`（构建期 rolldown
   parse error 暴露），已修，并 `--fixup` + autosquash 折回
   双轴提交本体，历史无补丁噪音。

## Consequences

- 验证基线全绿：`pnpm build` exit 0、`pnpm test` 93 文件
  666 passed + 2 skipped。
- main 线性落在 origin/main 之上（ahead 10 → push 后归零，
  `70f7dbe..326e204`），无 merge commit、无 force push。
- 后续远端再动 `getChartThemeOptions` 时，双轴配置在两个
  分支的存在是隐式契约——改主题分支必须两分支同改。
- 教训：rebase 语义冲突不能只信 auto-merge 静默通过的
  后续提交（7-10 全部静默过），必须 build+test 全绿兜底；
  本次 parse error 恰好被构建门禁拦住。
