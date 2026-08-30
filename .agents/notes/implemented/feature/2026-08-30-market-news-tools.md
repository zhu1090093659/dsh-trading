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
- hk 新闻留待有干净公共源（或按「需 JS/合规抓取前提」裁决）时与 WS4 其余子工作流同批推进；`#6` 保持开放作跟踪伞。
- 全量 `pnpm -r build`/`-r test` 由 PR CI 承接；本地已对 kit-crypto（16）、kit-us（6）、kit-cn（4）验证。
