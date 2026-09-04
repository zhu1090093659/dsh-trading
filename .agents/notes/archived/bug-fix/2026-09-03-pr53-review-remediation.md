# Agent Note: 双源公告 PR #53 评审整改——去重误删、假归因、UTC 窗口、BJ 跳过

Archived: 2026-09-04
Status: implemented（PR #53 合并前整改）

## Problem

PR #53（cn/hk 公告双源冗余）review-spd 评审（2026-09-03，两路子 agent 独立核对）
发现 4 个 Medium + 2 个 Low，owner 指示全部修复后合并：

- **M1 去重误删**：跨源去重「归一化后共同前缀 ≥6 字即判重」口径过宽。真实证据
  `spikes/impl-hk-cn-announce-sources/hkex-titlesearch-00700.body` 中腾讯同日连发
  `翌日披露報表`（裸类别，归一化恰 6 字）与 `翌日披露報表 - 已發行股份變動及股份購回`
  ——互判重复、备份源文档被丢；`截至二零二六年七月…月报表` vs `截至二零二六年
  六月三十日…業績公佈` 共享 7 字前缀「截至二零二六年」也会互删。原 note「失败方向
  是漏去重不是误删」论断错误。
- **M2 假归因**：topSearch/prefix.do lookup 的 `?? list[0]` 模糊兜底把可能错公司的
  orgId/stockId 永久写进 memo（仅缓存成功值、无失效），错公司公告带本标的
  `relatedCodes` 下发、`matchesSymbol` 放行——踩 replication.md §9 零假数据红线。
- **M3 UTC 窗口**：请求窗日期（cninfo `seDate`、HKEX `fromDate/toDate`）用
  `toISOString()`（UTC 日历日），东八区每天 00:00–07:59 查不到当日公告——恰是
  披露易集中发文时段。另 fetcher 内部用 `Date.now()` 而非注入 `now`，测试不可控。
- **M4 北交所静默失效**：43/83/87/92 开头代码落 `column=szse`，巨潮恒返空且与
  真实无公告不可区分。
- **L1 故障重试风暴**：lookup 失败不缓存、无 in-flight 合并——上游故障期间每轮
  60s 轮询重付 10s 超时，并发首轮同标的各发一次 lookup。
- **L2 错误无归因**：200 响应坏 JSON 抛裸 SyntaxError，`unavailable` 无来源前缀
  （HTTP 错误有 `cninfo-announcement: HTTP 503` 前缀，不对称）。

## Decision

- **M1**：判重收紧为「±24h 内：全文等值，或共同前缀 ≥6 字 **且共同后缀 ≥2 字**
  且互不构成严格前缀（短边被长边整体覆盖不判重）」。共同后缀排除三类误删对：
  裸类别短标题（长边结尾不同）、`…报告` vs `…报告摘要`（无共同后缀）、泛化日期头
  （尾部不吻合）；仍能兜住真实变体对（同一文件两源的括注/繁简差异，头尾主体一致，
  如东财 `翌日披露报表其他股份购回` vs HKEX `翌日披露报表已发行股份变动及股份购回`
  ——前缀 6 字 + 后缀 6 字吻合）。两 kit 同构实现。
- **M2**：`?? list[0]` 兜底删除——精确 code 未命中直接 throw（fail-soft 进
  unavailable，失败可重试、绝不污染 memo）；发射前第二道守卫核对巨潮 `secCode`
  与请求代码全等、HKEX `STOCK_CODE` 以请求代码开头（真实数据形如 `00700<br/>80700`）。
- **M3**：日期串改东八区构造（`new Date(ms + 8*3_600_000).toISOString()`）；两个
  fetcher 签名加 `nowMs` 透传聚合器注入的 `now`（可测性，顺带修）。
- **M4**：非 6/0/3 前缀直接 `return []` 显式 skip（巨潮 BJ 列归属 spike 未验证，
  宁缺勿错）；Agent Note 增补「巨潮源不覆盖北交所」。
- **L1**：lookup memo 三件套——成功 Map + 失败时间戳 Map（负缓存 TTL 5 分钟）+
  in-flight promise Map（并发合并）；`reset*Memo` 同步清三个。
- **L2**：三处 JSON.parse（cninfo topSearch/hisAnnouncement、HKEX 外层与嵌套
  result）包 try/catch 重抛带来源前缀的错误。

## Consequences

- 去重口径收紧后部分同日披露会两源各留一份（漏去重方向，可容忍）：真实冒烟中
  002714.SZ/00700.HK 的合并数会比初版略多。
- BJ 标的巨潮源显式无覆盖（eastmoney 主源照常服务）；后续要补先做 spike。
- lookup 失败 5 分钟内不再重试——上游闪断最长延迟 5 分钟恢复，换取故障期间
  轮询不被 10s 超时拖垮。
- 测试净增 14 个（cn 10 + hk 8，含 M1 三类负例、M2 守卫、M3 东八区窗断言、
  L1 负缓存/并发合并、L2 坏 JSON），cn 31 / hk 23 / client 125 全绿。
- 原始 note 的「宁漏勿误」表述已同步更正。