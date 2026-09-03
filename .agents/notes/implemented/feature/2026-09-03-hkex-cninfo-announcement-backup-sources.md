# Agent Note: cn/hk 公告双源冗余——接入巨潮与港交所披露易

Status: implemented（PR 待审）

## Problem

2026-09-03 owner 指出「不同市场应选不同信源，免费信源不稳定」。现状盘点：
us（Yahoo/Google News/SEC EDGAR）与 crypto（7 源）已多源聚合，但 **cn 与 hk
的快讯+公告四路全押东财单供应商**，东财封出口/改版即两市场新闻与公告同时
归零。spike（`spikes/impl-hk-cn-announce-sources/`，双 A 级）验证巨潮资讯与
HKEX 披露易可达后，owner 批准接入。

## Decision

- **kit-cn**：新增 `fetchCninfoAnnouncements` 备份源——orgId 经 topSearch
  中转（POST 空 body，服务端要求 Content-Length；模块级 memo），公告经
  `hisAnnouncement/query`（沪深分列：6 开头 `column=sse`，其余 `szse`，
  seDate 14 天窗）。source=`cninfo-announcement`。
- **kit-hk**：新增 `fetchHkexAnnouncements` 备份源——stockId 经
  `prefix.do` JSONP 中转（冷请求 ~3.7s，模块级 memo，仅缓存成功值），公告经
  `titleSearchServlet.do`（result 是 JSON 字符串需二次 parse；DATE_TIME 为
  `DD/MM/YYYY HH:MM` 日月倒序，`parseHkexDateTime` 显式解析东八区）。
  source=`hkex-announcement`。
- **跨源去重**（两 kit 各自实现）：归一化标题（去 `公司:` 前缀 → hk 侧繁转
  简映射表 → 去标点空白）后**全文等值或共同前缀 ≥6 字**且发布时间 ±24h 内
  判同一条披露；**同源永不去重**；先到先得保留主源（东财，秒级时间精度）。
- **现状澄清**：kit-hk 原有 `ann_type=H` 港股公告变体（非借用 A 股接口），
  00700.HK 本就有公告；本次是冗余而非从零补源。
- 客户端 `formatSourceLabel` 增加港交所披露/巨潮公告标签；bridge/client
  契约零改动（新 source 名被 `isAnnouncementSource` 关键词兜底自动识别）。

## Key Invariants / 坑

- **巨潮空结果是 `announcements: null`**（非 []）——null 是合法空（该标的
  14 天窗内确无公告），只有非 null 非数组才算 payload 异常；迭代前必须
  归一成数组（实测 600519 首冒烟即踩：`list is not iterable`）。
- **繁简标题差异**：HKEX 繁体 vs 东财转简体，且东财会缩写类别描述
  （`翌日披露报表 - [其他 / 股份購回]` vs `翌日披露報表 - 已發行股份變動及
  股份購回`），全文等值不可靠 → 共同前缀 ≥6 字兜底。失败方向是漏去重
  （重复展示），不是误删——宁漏勿误。
- 去重时间容差 ±24h：东财 `display_time`（披露时点）vs 巨潮日精度
  `announcementTime`（00:00+08）可差半天以上（跨日边界）。
- 两 fetcher 都带 10s AbortSignal + fail-soft（throw → unavailable，不拖垮
  聚合）；memo 仅缓存成功值且导出 `reset*Memo` 供单测隔离。

## Consequences

- cn/hk 公告从单供应商变双源：东财挂时巨潮/披露易仍在，公告页签与 K 线
  事件图钉不归零。
- 单标的新闻轮询（60s）从 2 个上游请求变 3 个（cn）/3 个（hk，memo 命中后
  stockId/orgId 查询省略）；均在 10s 超时与 fail-soft 保护内。
- 真实网络验证：002714.SZ 合并 6 条（巨潮 7 条原始 → 跨源重复全部去重）；
  00700.HK 合并 5 条（HKEX 11 条原始 14 天 → 同类别重复全部去重）；600519
  巨潮合法空不再误报 unavailable。
- 媒体快讯第二源（新浪/财联社，spike 判 C/D 级）维持押后，另案处理。
