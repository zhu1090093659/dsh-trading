# 上游对账单

本产品的数据层是从三个上游仓库**移植代码**(不是依赖引用),所以**上游更新不会自动流过来**。
这份文件记录「移植自哪个 tag、上次核到哪、哪些上游修复不适用」,以后再核只看这一个文件。

> 为什么不做成依赖:产品要求 clone 即用、自包含零外部文件(见 `.agents/skills/data-access/SKILL.md` §7)。
> 代价就是这里记的漂移风险,因此**每次发布前应对一次账**(见 `docs/release-checklist.md`)。

| 上游 | 移植自 | 上次核对 | 上游当时最新 | 结论 |
|---|---|---|---|---|
| [a-stock-data](https://github.com/simonlin1212/a-stock-data) | **v3.7.0**(既有端点)+ **v3.10.1**(新端点,生成) | 2026-10-08 | v3.10.1(`8f6a6a5`) | v3.8.0–v3.10.1 新增的 33 个入口已移植,见 ④ |
| [global-stock-data](https://github.com/simonlin1212/global-stock-data) | **v2.0.3** | 2026-10-08 | v2.0.3 | 发布版本未变(最新 Release 仍是 2026-07-26 的 v2.0.3);沿用既有移植,不声称全部端点重新实连 |
| [investment-news](https://github.com/simonlin1212/investment-news) | 源清单(`sources.json`) | 2026-09-07 | v1.0.3 | 发布版本未变；抓取器修复适用性见 ② |

> **2026-10-10 删掉 8 个和在用源重复的端点**(注册表 179 → 171):港美股报价 `tx_us_quote` `sina_us_quote` `tx_hk_quote` `sina_hk_quote` `em_global_quote`
> (界面和研究都用 `global_quote_ref`)、`baidu_kline_ma`(A 股日 K 用 `fetch_kline` / `bs_kline_qfq`)、`sina_reports`(研报用 `em_reports`)、
> `szse_trading_calendar`(交易日历用 `fetch_trade_calendar`)。对账时**不要按上游清单重新登记**这几个;
> `sina_research_reports` / `trading_calendar` 仍由生成脚本照原样留在 `astock_ported.py` 里(后者被默认日期内部使用)。
> 同日又删了默认停用的通达信 K 线 / 五档 / 逐笔 `tdx_bars` `tdx_quotes` `tdx_transaction`(注册表 171 → 168,全部可用);上游仍留档,同样别重新登记。

## ⑤ 产品自己接的端点(不来自上游,v2.1.0)

这些端点是本产品直接对接公开接口写的,**上游没有对应代码**,对上游账时跳过:
`em_southbound_flow` `em_southbound_holding` `em_hk_dividend` `em_global_profile` `em_top10_holders` `em_top10_free_holders`
`em_main_business` `em_suspensions`(东财数据中心)、`ah_premium_a` / `ah_premium_h`(东财 F10 查对应股票 + 腾讯报价)、
`yahoo_events`(Yahoo K 线事件段)、`baidu_valuation_global`(百度股市通)、`fred_us_macro`(FRED 免 key CSV)。`yahoo_financials` 也从 quoteSummary 换成了财务时间序列接口,
与 global-stock-data v2.0.3 的写法不再一致。2026-10-08 逐个经 `fetch_endpoint` 实测与 `health.py --only` 全部 ok。

港美股六阶段研究另接了 5 个(同样不来自上游):`global_quote_ref`(腾讯报价 + 标普 500 / 恒生指数基准)、`fx_rates`(腾讯汇率)、
`global_financials_pit`(东财港美股主要指标,按公告日过滤)、`yahoo_consensus`(Yahoo 年度一致预期)、`baidu_pe_history_3y`(百度股市通 PE TTM 三年序列)。
2026-10-08 逐个实测,2026-10-09 `health.py --only` 全部 ok。

事件回看的港美股业绩公布另接了 2 个(同样不来自上游):`hkex_results_dates`(港交所披露易按分类检索末期 / 中期 / 季度业绩公告,带香港发布时间)、
`us_earnings_8k_dates`(东财转载的 SEC 8-K,按栏目「8-K 2.02」筛出业绩公布的提交日)。2026-10-09 `health.py --only` 两个都 ok。
之后又接了 `sec_earnings_8k_dates`(SEC EDGAR 全文检索,按申报自带的 items 只留 2.02;要 SEC 联系方式):东财那条大银行翻不完,
摩根大通一份都取不到。2026-10-09 用测试联系方式实跑:苹果 2004 年以来 94 份、摩根大通 2015 年以来 47 份(与把 8-K 全部翻完再筛逐份一致)、阿里巴巴 0 份(ADR 用 6-K)。

## ④ a-stock-data v3.10.1 新端点移植(2026-10-08,随 v2.1.0 发布)

**怎么移植的**:`datasources/port_astock.py <a-stock-data 的 SKILL.md>` 把上游带 `<!-- 标记:start -->` 的 19 个代码块
(外加没有标记的 `get_prefix` / `norm_ticker` 前置定义)原样拼成 `sources/astock_ported.py`(约 3000 行,勿手改)。
与上游的差别**只有联网入口**,全部写在生成脚本的 `SUBS` 里、每条都校验命中次数:

1. `em_get` → 产品的东财统一入口 `sources._http.em`(跨进程串行锁 + 代理回退 + 落盘);
2. `_v39_http` 拿到响应先落盘;
3. 官方指数文件的 `requests.get`、两融 / 北交所备胎的会话请求同样落盘;
4. baostock 会话用产品的 `bs_session`(登录打印不进 stdout)。

离线测试 `tests/test_astock_ported.py` 用语法树检查生成文件里直接发请求的只剩两个落盘包装,上游新增的请求入口没走包装会变红。
升级上游:重跑生成脚本 → `--check` 确认 → 跑测试与 `fetch_endpoint` 实测;`SUBS` 命中次数对不上会直接报错,先核对上游再改。

**产品侧补的两层**(都不改上游业务逻辑):

- `sources/astock_defaults.py`:上游要求必须传日期的函数补默认值(按深交所官方日历取「最近一个数据已发布的交易日」:
  交易所收盘文件 17 点后算当天、两融与上交所 ETF 份额次日发布、新闻联播 20 点后算当天),以及盘后包 / ETF 份额 / 可转债的按代码筛选;
- `sources/mappers_astock.py`:每次调用把整表落一个 `extracted_` 行表文件(内含各次请求的传输层原文路径),全部证据指向它;
  时间序列附 `calc_hint`。新端点全部 `stages: {}`,**不进六阶段研究计划**,按需调用。

**33 个新端点**(注册表 150 个、34 层,新增 19 指数 / 20 期货与大宗 / 21 事件驱动 / 22 可转债 四层):
行情 `tx_kline` `tdx_daily_package` `tx_ticks` `bse_quote_backup`;研报 `sina_reports`;资金 `etf_shares` `margin_backup`;
新闻 `wscn_lives` `cctv_news`;基础 `st_stock_list`;情绪 `sse_e_interaction`;宏观 `chinabond_yield_curve` `repo_fixing_rates` `lpr_history`;
日历 `macro_calendar` `szse_trading_calendar`;指数 `index_constituents` `index_weights` `index_valuation`;
期货与大宗 `futures_daily` `options_daily` `futures_position_rank` `futures_realtime` `futures_kline` `a50_futures` `sge_spot`;
事件 `earnings_forecast` `institution_survey` `holder_trades` `share_buyback` `equity_pledge` `ipo_calendar`;可转债 `convertible_bonds`。
2026-10-08 上午(交易时段)本机逐个经 `fetch_endpoint` 实测,全部正常返回:30 个 ok;`tx_ticks` partial(盘中取数,上游没法核对完整,按设计如实标注);
`st_stock_list` partial(东财列表接口连不上,按上游设计改用 baostock);
`sse_e_interaction` 用 600519 为 partial(源页面原文「近1个月暂无回复」,0 条是真实结果)。

**通达信(上游 #52)**:2026-09 起公开服务器的 K 线 / 盘口 / 逐笔命令返回空,`tdx_bars` / `tdx_quotes` / `tdx_transaction`
默认禁用、代码留档(2026-10-10 已整个删除,见文首),禁用原因里指向替代端点(K 线 → `tx_kline` / `tdx_daily_package`,逐笔 → `tx_ticks`,实时价 → `tx_quote`;买卖五档暂无替代);`tdx_finance` / `tdx_f10` 改按财务命令验活(原来拿 K 线验活,会把正常服务器全判死、
最后卡在 bestip 测速),F10 类别以服务器 `F10C` 实际提供的为准(现只剩「最新提示」)。`tdx_finance` 的证据改读 `meigujingzichan`
(mootdx 0.11.7 没有 eps / bvps / roe 字段名,原映射每次都只有部分结果),期间取快照自带的 `updated_date`。

**发版前审计**(Codex 只读 4 轮:7 / 2 / 3 / 2 条,均已修;后两轮都是对前一轮修法的追查):逐笔完整性三态(上游 `complete` 为 None 时原来记 ok)、盘后包里 ETF / 可转债的成交量被标成「股」
(上游只保证个股是股,现在只有 A 股个股标股)、深市 ETF 默认日期在快照还没切到当天时会报错(先试今天、对不上再试上一个交易日)、
机构调研明细模式把机构行数当调研次数且证据 ID 撞车、F10 部分类别失败仍记 ok、禁用原因把 `tx_quote` 说成能替代五档、
显式传入的空串 / 0 被悄悄换成默认值;复验补上:机构名很长时记录键截断后仍会撞 ID(记录键一律不截断,证据 id 本来就由完整键哈希)、
逐笔缺号是逐个序号却写成「段」;第 3、4 轮针对记录键:改为不合并任何行、键用 JSON 数组、完全相同的行加 #n(且避开真实键)。
另自查两处:去掉三处合计(逐笔量 / 额合计、ETF 份额合计,取数层不算聚合);东财事件表上游取满 `limit` 行就停、不报错,
个股事件(业绩预告 / 机构调研 / 增减持 / 回购 / 质押)取满记 partial 并写明更早的没取,新股日历(本来就是「最近 N 只」)只在计数备注里说明。

**发现但未改的上游问题**(属于 a-stock-data,本产品照原样移植,修好后重跑生成即可):

- `margin_trading_backup` 上交所分支:2026-10-08 实测上交所返回 pageSize 2000、共 2002 条 2 页,上游要求单页完整,
  报「上交所该日数据未发布或分页不完整」;深交所正常。所以 `margin_backup` 目前对沪市代码报错。
- SKILL.md §6.1 的注释仍写 `eps / bvps / roe` 字段,mootdx 0.11.7 实际没有这三个字段名。

## ③ M37 发布候选对账（2026-09-07）

已实时读取三个官方仓库的 latest Release，以及 a-stock-data 的 CHANGELOG。
[a-stock-data v3.8.0](https://github.com/simonlin1212/a-stock-data/releases/tag/v3.8.0)
新增指数成分、权重、估值和交易所数据入口；这些属于能力扩充，不是现有 Research 端点依赖升级，
本轮不把新端点数量写入产品承诺，也不整包覆盖产品已修复的数据层。

其中 v3.7.2 将北交所宽号段判断统一为 4/8/92；产品现有 `natural_market` 为
43/83/87/92（现行北交所股票号段的既有覆盖），不是逐字同步后的宽号段实现。
未新增对其他 4/8 开头证券的支持；上游新增接口和宽号段支持仍作为后续扩展项，不能称“全量对齐 v3.8.0”。
v3.7.1 后缀归一化修复的产品路径对照仍见 ①。

[global-stock-data v2.0.3](https://github.com/simonlin1212/global-stock-data/releases/tag/v2.0.3)
与 [investment-news v1.0.3](https://github.com/simonlin1212/investment-news/releases/tag/v1.0.3)
未出现更新发布；下方源清单逐键一致性是 8 月 24 日历史证据，不冒称本次全量重新抓取。

Research 自身公开 main 本次只读核对为 `09e8404a33ba0d05e036e01207be4701c61d692c`。
开放 PR #45 的损坏计算记录问题，本地已有显式校验与错误回报；不采用静默跳过坏记录的简化修法。
PR #47 的 Markdown/引用展示，本地已有 GFM 与精确证据定位；其归档删除接口未合入。
这不是对全部开放 PR 的接受或审结，也未发生合并、推送或发布。

## ① a-stock-data v3.7.1 的 `get_prefix()` 路由 bug:本产品**架构上不适用**

上游 v3.7.1 修的是:`get_prefix()` 不认 `.SH` 后缀写法 → `em_secid("000016.SH")` 落到深市分支,
secid 拼成 `0.000016`(\*ST康佳A)而非 `1.000016`(上证50),**静默返回另一只标的的数据**。

本产品不会发生,因为拼 secid 的路径不同:

| | 上游 v3.7.0 | 本产品 |
|---|---|---|
| 调用形态 | `em_secid(原始用户串)`,函数内部再猜市场 | `norm_ticker(code)` → `(digits, market)`,再 `em_secid(digits, market)` |
| 猜错的可能 | 有(原串直接进号段推断) | 无(拼接只接受已归一化的两个值) |

`common.py` 的 `norm_ticker()` 明确支持前缀式与后缀式两种写法,且**解析失败抛 `ValueError` 绝不猜**;
矛盾写法(`SZ600519` / `BJ000001`)与股票接口收到指数写法都会被拒。2026-08-24 实测:

```
000016.SH → 1.000016      600519.SH → 1.600519      000016 → 0.000016
SZ600519  → 拒绝(市场标识与号段矛盾)   000016.SH(股票模式) → 拒绝(沪市指数,本接口只服务个股)
```

⚠️ 上游发布说明里那句总原则——「**拿到用户输入先过 `norm_ticker()`**」——正是本产品的既有做法。
**新增任何 A 股端点时都要守住它**:不要把用户原串直接拼进 secid / URL。

## ② investment-news:只移植了源清单,抓取端修复不适用

产品只取了 `sources.json`(106 个 tier-1 策展源 × 12 行业 + `redline_keywords`)→ `datasources/rss_sources.json`;
**抓取逻辑是产品自有的 `sources/rss.py`**,不是上游代码。

上游 v1.0.1–v1.0.3 修的都是抓取端(安全加固 / 中文 Windows 兼容 / 条目层去重 / 去重基准时间),
与本产品无关。**需要跟进的只有源清单本身的增删。**

2026-08-24 核对:产品副本与上游 `sources.json` 的 `fetch` / `industries` / `sources` / `redline_keywords`
四个业务键**逐字节一致**。

## 怎么再对一次账

```bash
gh release list --repo simonlin1212/a-stock-data --limit 5
gh release list --repo simonlin1212/global-stock-data --limit 5
gh release list --repo simonlin1212/investment-news --limit 5
```

比对上表的「移植自」列;有新版本就读 release notes,逐条判断**是否适用于本产品的移植形态**
(如 ① 那样架构不同就不适用),然后更新本表的「上次核对」与结论。

🔴 **判据是「这个修复在本产品的代码路径上会不会发生」,不是「版本号是否落后」。**
一个上游 bug 修复,可能因为移植时结构不同而根本不存在;也可能一个看似无关的小版本
恰好改了本产品直接照抄的那段。**必须读 release notes 逐条对,不能只比版本号。**
