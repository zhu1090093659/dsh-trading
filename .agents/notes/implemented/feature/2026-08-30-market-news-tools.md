# Agent Note: us/cn 市场新闻工具（WS4 #1）——kit 薄工具 + 补 dsh-tools peer

Status: implemented

## Problem

WS4 #1（docs/analysis-roadmap.md，[#6](https://github.com/zhu1090093659/dsh-trading/issues/6) 子工作流）要按 crypto 新闻模式
（[#8](../../../../spikes/impl-crypto-news/EVIDENCE.md) 的 `crypto_get_news` 薄工具）复制到 us/cn/hk。前置 spike
（[PR #10](../../../../spikes/impl-uscnhk-news/EVIDENCE.md)）实测：us 有两源（Yahoo news API + Google News RSS）、cn 有东财快讯（均 A 级），
hk 无干净公共源。遗留一个复制期结构性坑：kit-us/kit-cn 的 SDK peer 缺 `@deepseek-ai/dsh-tools`。

## Decision

- **us_get_news**（kit-us）：主源 **Yahoo Finance news API**（`/v1/finance/search`，news[] 带 publisher 直链/providerPublishTime）+ 媒体面 **Google News RSS**（`<source>` 为原始媒体名，link 为 Google 跳转——溯源用 source，跳转属已知局限）。`source` 用真实 publisher（铁律 #5 溯源正确）。
- **cn_get_news**（kit-cn）：主源 **东财快讯**（`getFastNewsList?fastColumn=102`）；`summary` 是正文，**工具只引 title/showTime/链接**（铁律 #5 不再分发）；url 由 `code` 构造 `finance.eastmoney.com/a/<code>.html`（实测 200）；showTime 按东八区无时区后缀 `YYYY-MM-DD HH:MM:SS` 解析为 ISO。
- **hk_get_news 本轮不实现**：无干净公共源（东财港股列混 A 股不纯、AAStocks 302+JS、HKEX JS/CSRF）——诚实的阻塞项，与 CryptoPanic 同类处置，不当伪完成。
- 均为 **kit 内薄工具**（非 connector+dataplane——新闻不进行情桥/路由，复用 crypto 判据）；`inject = ['skills','tools']` + duplicate-safe register。
- **复制期结构性修复（replication.md §1 坑实锤）**：kit-us/kit-cn 的 peerDependencies **漏 `@deepseek-ai/dsh-tools`** → 加入 `defineTool` 后 tsdown 找不到 peer → **内联整个 deepseek-harness vendor 树**（构建 45 文件/419KB，与 kit-crypto 的 3 文件对比鲜明）→ profile 内 import 必崩。已补 `"@deepseek-ai/dsh-tools": ">=0.1.2-alpha.1"`，重建回 3 文件。**replication.md §1 第 1 条的实证反例，后续复制检查点须含「kit 引入新 SDK 面时同步补 peer」**。

## Alternatives considered

- **hk 用东财港股列降级实现**：落选——快讯是统一 CN 金融流、非干净按市场分离，卖「港股新闻」会误导模型与用户；作为阻塞项如实标注比降级掺水更符合定性分析工具的中立性。
- **us/cn 抽共享 `@dsh-trading/news-core` 包避免聚合逻辑三份**：落选——roadmap 把新闻定为 kit 薄工具（preset 平面、无 GUI 消费），且三源差异大，聚合逻辑重叠低；共享包会引入新包 + replication 建包清单 + profile overrides 同步等成本，铁律 #4（不过早抽象）暂不做。
- **cn symbol 过滤建中文名映射（600519→贵州茅台）**：落选——隐式维护名称表易漂移；先用东财快讯自带的 `stockList` 关联代码匹配（标题含公司名时按代码命中），中文名限定为已知局限。

## Consequences

- `us_get_news` / `cn_get_news` 无 key 全程可用；us/cn 单测全绿（us 6 / cn 4），tsdown 构建 3 文件（vendor 未内联）。
- symbol 过滤已知局限：us 媒体多用全名（"Apple"）非 ticker（"AAPL"）→ 标题子串不命中；cn 标题用中文名（贵州茅台）非代码（600519）→ 靠 stockList 代码命中（快讯自带）。均写入工具 description 明示。
- **hk_get_news（2026-08-30 用户裁决「用降级」）**：东财快讯第 103 列 + 按 `stockList` 的**港交所 marketId=116** 代码 / 港股关键词过滤；工具描述**明确标注 DEGRADED/部分覆盖**（港交所 news 若无关联代码/关键词则不捕获；东财是统一 CN 金融流，非专用港股源）。live 实测（本出口）取到「浙江海亮向港交所提交上市申请」+ 多只 **A+H 双重上市**公司公告（辽港/国航/东航/迈威——均带 `116.` 港股代码）——降级确有真实港股内容。单测 5 例全绿。
- **live 实测暴露并修复的东财参数坑（cn/hk 共患）**：`getFastNewsList` **必须带 `sortEnd`（空串即可）与 `req_trace=1`**，否则返回 `data:null`（"Required String parameter 'sortEnd'/'req_trace' is not present"）。mock 测试不校验 URL 参数故未捕获，**真网络复测才暴露**——东财这类参数坑应入复制手册注意项。
- **另一个 live 暴露并修复的契约坑**：东财 `stockList` 是**字符串数组 `<marketId>.<code>`**（如 `'1.600519'`/`'116.00700'`/`'105.AMZN'`），非对象数组；`relatedCodes` 保留全串，匹配时取 `.` 后 code 段（cn 按 code、hk 额外要求 `116.` 前缀）。
- `#6` 保持开放作跟踪伞；hk 已按降级交付（不再阻塞），WS4 剩余为基本面（#2）、衍生品（#3）。
- 全量 `pnpm -r build`/`-r test` 由 PR CI 承接；本地已对 kit-crypto（16）、kit-us（6）、kit-cn（4）、kit-hk（5）验证。

