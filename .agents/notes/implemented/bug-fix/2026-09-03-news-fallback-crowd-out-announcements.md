# Agent Note: 移除新闻宏观回退——大盘要闻兜底挤掉标的公告

Status: implemented

## Problem

用户报告（2026-09-03，附三张截图）：牧原股份 002714.SZ 的「公告」页签显示
「暂无相关公告」，而「新闻」页签却展示着兜底的大盘要闻（带 fallback 横幅）；
同日 AAPL 的 SEC 披露仅剩 1 条。用户同时裁决：标的新闻只展示与该标的相关的
内容，没有就不显示（不回退市场要闻）。

### 根因

`TradingBridge.news`（issue #37 引入、PR #48 评审保留）的「智能回退」：
指定标的但 24h 内无**媒体**快讯（公告类源不算）时，拉取大盘最新要闻与标的
条目合并、按时间倒序、按 limit（客户端传 50）截尾。东财 724 快讯一天产出
远超 50 条——50 条宏观要闻的时间跨度常不足 1 小时，全部新于标的公告，截尾
后公告被整体挤出。实测（2026-09-03）：002714.SZ 聚合器直返 6 条公告，经桥
回退合并后剩 0 条。公告越少的标的越容易无媒体覆盖、越容易触发回退——恰好
是「有公告却被隐藏」的重灾区，与「无公告显示暂无」在 UI 上无法区分。

## Decision

按 owner 裁决删除回退，不做「合并后截尾修复」：

- `bridge.ts`：`news()` 移除宏观回退块与 `NewsWire.fallback` 字段，聚合器
  结果原样透传（仅标的相关条目；无相关内容即空列表）；
- 客户端链路同步清理：`api.ts`（ClientNewsResult/wire 类型）、
  `QuoteStage.tsx`（newsFallback state）、`NewsFeedPane.tsx`（fallback prop
  与横幅）、`news-feed-pane.module.css`（.fallbackBanner 死样式）；
- `bridge.test.ts`：「仅剩公告 → 触发宏观回退」改判「不回退、公告原样保留」，
  新增「无任何相关内容 → 空列表透传」用例。

## Consequences

- 公告页签恢复真实数据：002714.SZ 桥级端到端返回 6 条公告；K 线事件图钉
  （issue #41，取自同一 newsItems）随之恢复公告标记。
- 标的无 24h 内相关资讯时，新闻/公告页签如实显示空态，不再混入大盘要闻。
- 单次聚合调用（此前回退路径最多两次），桥保持无状态透传语义不变。
- 验证链：`pnpm build` + `pnpm test` 103 文件 733 用例全绿 → typecheck 棘轮
  547/549 未超基线（净降 2）→ 桥级 e2e（真实聚合器）→ 重启 trading-web
  实例后带 cookie 实测 `GET /dshtrading/api/news?market=cn&symbol=002714.SZ`
  返回公告。
