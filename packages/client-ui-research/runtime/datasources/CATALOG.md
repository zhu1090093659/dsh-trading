# 数据源端点目录(registry v1.0.0,共 168 个)

由 `datasources/gen_catalog.py` 从 `registry.json` 生成,勿手改。调用方式:`.venv/bin/python .agents/skills/data-access/scripts/fetch_endpoint.py --endpoint <id> --symbol <代码> [--args '<JSON>'] --out-dir <运行目录>`;legacy 端点为 Phase 0 的独立脚本。合规级:cn-public = 国内公开网页接口;S = 官方政府数据;B = 非官方 / 个人研究;C = 仅个人研究(CBOE 条款);rss-public = 公开 RSS。
symbol_kind:cn6 = A 股 6 位码;us = 美股 ticker;hk = 港股 5 位;global = 美股 / 港股自动判别;raw = 原样透传(指数 / 关键词 / 期权标的);none = 不需要标的。

## 6 基础数据(14)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `fetch_profile` | 公司概况(名称 / 上市日 / 行业 / 股本 / 市值) | CN | tencent+baostock | cn-public | cn6 | profile:required |  |
| `fetch_financials` | 季度报告期累计财务(营收 / 归母 / 扣非 / EPS) | CN | sina_abstract | cn-public | cn6 | financials:required | 关键 |
| `fetch_pe_history` | PE_TTM / PB 日频历史(5 年) | CN | baostock | cn-public | cn6 | valuation:optional |  |
| `em_stock_info` | 东财个股基本面(股本 / 市值 / 行业 / 上市日) | CN | eastmoney | cn-public | cn6 | profile:optional | 与 fetch_profile(腾讯 + baostock)交叉核对用 |
| `sina_income_statement` | 新浪财报三表 — 利润表(近 8 期) | CN | sina | cn-public | cn6 | financials:optional | 与 fetch_financials(新浪 abstract)交叉核对;科目原值未换算 |
| `sina_balance_sheet` | 新浪财报三表 — 资产负债表(近 8 期) | CN | sina | cn-public | cn6 | financials:optional | 与 fetch_financials(新浪 abstract)交叉核对;科目原值未换算 |
| `sina_cashflow` | 新浪财报三表 — 现金流量表(近 8 期) | CN | sina | cn-public | cn6 | financials:optional | 与 fetch_financials(新浪 abstract)交叉核对;科目原值未换算 |
| `sw_industry` | 申万行业分类(当前归属 + 变迁史,消除前视偏差) | CN | swsresearch | cn-public | cn6 | profile:optional |  |
| `bs_valuation_history` | baostock 估值历史(PE/PB/PS/PCF + 换手 + 停牌 + ST,日频) | CN | baostock | cn-public | cn6 | valuation:optional | fetch_pe_history 已覆盖 PE/PB;本端点补 PS/PCF/换手/ST/停牌 |
| `bs_stock_basic` | baostock 标的基本信息(上市日 / 退市日 / 状态) | CN | baostock | cn-public | cn6 | profile:optional |  |
| `tdx_finance` | 通达信财务快照(37 字段季报) | CN | mootdx | cn-public | cn6 | - | 按财务命令验活(K 线命令失效不影响,上游 #52);证据只收每股净资产与股本,金额字段量纲与报表不一致、只放 extra;海外网络通常全部超时 |
| `tdx_f10` | 通达信 F10 文本(服务器现只给「最新提示」:互动问答 / 公告 / 报道 / 大宗 / 两融 / 风险提示) | CN | mootdx | cn-public | cn6 | - | 类别以服务器 F10C 实际提供的为准(2026-09 起只剩「最新提示」,上游 #52);海外网络通常全部超时 |
| `st_stock_list` | ST / *ST 股票名单(沪深京) | CN | eastmoney | cn-public | none | - | 东财名单不可用时上游自动改用 baostock(只覆盖沪深,结果标 partial 并写明原因)。上游 a-stock-data §6 |
| `em_main_business` | 主营构成(按行业 / 产品 / 地区;收入 / 占比 / 毛利率) | CN | eastmoney | cn-public | cn6 | profile:optional | 收入占比 / 毛利率是源给的小数(0.86 = 86%) |

## 1 行情(11)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `fetch_quote` | 实时行情 / 估值快照(含僵尸报价判定) | CN | tencent | cn-public | cn6 | profile:required | 关键 |
| `fetch_trade_calendar` | 交易日历(参考报价日 / 盘前盘后) | CN | baostock | cn-public | none | profile:required |  |
| `fetch_kline` | 日 K 前复权序列 | CN | tencent | cn-public | cn6 | risk:optional |  |
| `tx_quote` | 腾讯实时行情(个股 / 指数 / ETF / 北交所,含僵尸报价判定) | CN | tencent | cn-public | raw | - | 指数 / ETF 请带前缀(sh000001 / sh510050);fetch_quote 仍是阶段必需的主行情脚本 |
| `tx_quotes_batch` | 腾讯批量行情(默认 A股四大指数 + 美股道指纳指 + 港股恒生与恒生科技) | CN/US/HK | tencent | cn-public | none | - |  |
| `sina_adjust_factor` | 新浪复权因子(qfq / hfq) | CN | sina | cn-public | cn6 | - |  |
| `bs_kline_qfq` | baostock 前复权日 K(OHLC + 成交量 + 换手 + 停牌标记;供 calc 读 raw 算筹码 / 指标) | CN | baostock | cn-public | cn6 | risk:optional | raw 为 extracted JSON {query, rows:[{date,open,high,low,close,volume,turn,tradestatus}]};calc 用 history_json(rows_path=rows, where tradestatus=1)读取 |
| `tx_kline` | 腾讯 K 线(日 / 周 / 月前后复权 + 1~60 分钟;沪深个股 / ETF / 指数) | CN | tencent | cn-public | raw | - | 代码原样传:个股 600519,指数带前缀 sh000001(不带前缀的 000001 是平安银行);period=day/week/month/m1/m5/m15/m30/m60;日周月默认前复权、分钟只有不复权;科创板成交量是股、其余是手;没有成交额(要成交额用 tdx_daily_package);不支持北交所。替代 2026-09 起失效的通达信 K 线。上游 a-stock-data §1.2 |
| `tdx_daily_package` | 通达信官网盘后包(某交易日全市场日线含成交额,沪深京) | CN | tdx | cn-public | none | - | HTTP 下载约 2.7MB 压缩包(不是失效的 TCP 行情命令);date 缺省 = 最近一个 17 点后已收盘的交易日;codes 缺省 = 主要指数(sh999999 上证 / sz399001 / sz399006 / sh000300 / sh000688 / bj899050),逗号分隔、可带 sh/sz/bj 前缀;全市场原表在 raw 压缩包里。个股成交量是股、指数为通达信原值。上游 a-stock-data §1.3 |
| `tx_ticks` | 腾讯当日逐笔成交(沪深个股 / ETF,最近一个交易日) | CN | tencent | cn-public | cn6 | - | 替代 2026-09 起失效的通达信逐笔;一页 70 笔逐页翻到底;15:31 以后才核对盘后定价段(之前取到的标 partial);成交量是手(科创板也是);不支持北交所 / 指数。上游 a-stock-data §1.4 |
| `bse_quote_backup` | 北交所官网行情快照(单只:开高低收 + 量额 + 五档) | CN | bse | cn-public | cn6 | - | 只接受北交所代码(920 / 4 / 8 开头);官网当前快照,trade_date 缺省 = 今天(交易日)或最近一个交易日,快照日期对不上时上游直接报错、不冒充别的日子;成交量是股。上游 a-stock-data §12 官方备胎 |

## 2 研报(5)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `fetch_estimates` | 机构一致预期 EPS(FY T/T+1/T+2) | CN | ths | cn-public | cn6 | estimates:required | 关键 |
| `em_reports` | 个股研报列表(标题 / 机构 / 评级 / 三年 EPS 预测) | CN | eastmoney | cn-public | cn6 | estimates:optional, risk:optional | PDF 可由 infoCode 拼 pdf.dfcfw.com 下载;reportapi 只认 6 位码 |
| `em_industry_reports` | 行业研报列表 | CN | eastmoney | cn-public | none | - |  |
| `iwencai_search` | 问财 NL 语义搜索(研报 / 公告 / 新闻) | CN | iwencai | cn-public | none | - | env IWENCAI_API_KEY; 需 IWENCAI_API_KEY;--args {"query":"..."} |
| `iwencai_query` | 问财 NL 数据查询(结构化) | CN | iwencai | cn-public | none | - | env IWENCAI_API_KEY |

## 7 公告(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `fetch_announcements` | 公告标题(深交所 / 东财) | CN | szse+eastmoney | cn-public | cn6 | risk:optional |  |
| `cninfo_announcements` | 巨潮公告(全文检索,动态 orgId) | CN | cninfo | cn-public | cn6 | risk:optional |  |
| `exchange_announcements` | 公告备源(深市深交所 / 沪市北交所东财 np-anotice,带 PDF 直链) | CN | szse+eastmoney | cn-public | cn6 | - |  |

## 3 信号(11)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_concept_blocks` | 个股所属板块 / 概念归属 | CN | eastmoney | cn-public | cn6 | profile:optional |  |
| `em_fund_flow_minute` | 个股资金流(分钟级,当日) | CN | eastmoney | cn-public | cn6 | - | 盘中才有;ETF 不覆盖 |
| `em_dragon_tiger` | 个股龙虎榜(上榜记录 / 席位 / 机构) | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_lockup_expiry` | 限售解禁(历史 + 未来 90 天) | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_industry_comparison` | 行业板块涨跌排名 | CN | eastmoney | cn-public | none | - |  |
| `em_board_fund_flow` | 板块资金流向(行业 / 概念 / 地域 × 今日 / 5 日 / 10 日) | CN | eastmoney | cn-public | none | - |  |
| `sina_board_flow` | 板块资金流·新浪(行业 / 概念,当日;东财板块资金流的备源) | CN | sina | cn-public | none | - | 口径是新浪的「流入 − 流出」、板块是新浪自己的分类(行业约 48 个),和东财「主力净额」不能互相比较或接起来画趋势;只有当日。 |
| `em_daily_dragon_tiger` | 全市场龙虎榜 | CN | eastmoney | cn-public | none | - |  |
| `ths_hot_reason` | 同花顺当日强势股 + 题材归因 | CN | ths | cn-public | none | - | --args {"date":"YYYY-MM-DD"} |
| `ths_hsgt_realtime` | 沪深股通分钟累计净买入(亿元) | CN | ths | cn-public | none | - |  |
| `exchange_dragon_tiger` | 龙虎榜官方备源(深交所结构化 + 上交所全文) | CN | szse+sse | cn-public | none | - | --args {"trade_date":"YYYY-MM-DD"},默认北京时间当天 |

## 4 资金筹码(12)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_fund_flow_120d` | 个股资金流(日级 120 日) | CN | eastmoney | cn-public | cn6 | - | push2his 在部分网络(含本机)不通,失败属预期;备源见 fund_flow_backup |
| `em_margin_trading` | 融资融券明细(日级) | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_block_trade` | 大宗交易 | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_holder_num` | 股东户数变化(季度) | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_dividend_history` | 分红送转历史 | CN | eastmoney | cn-public | cn6 | valuation:optional |  |
| `sina_fund_flow` | 新浪个股资金流(日度,东财备源) | CN | sina | cn-public | cn6 | risk:optional |  |
| `bs_chip_distribution` | 筹码分布 CYQ(获利比例 / 平均成本 / 成本区间 / 集中度,前复权 + 换手衰减模型) | CN | baostock+calc | cn-public | cn6 | - | 计算型端点:取数层确定性计算(非 calc DAG),信封 extra.computation 记库 / 版本 / 输入 raw / 参数供复算;不进研究阶段计划(计算型端点待迁 calc);仅供手工调用 |
| `etf_shares` | ETF 份额(上交所按日归档 / 深交所当前快照,万份) | CN | exchange | cn-public | none | - | exchange=SH / SZ;date 缺省:上交所 = 上一个交易日,深交所 = 今天的快照(深交所只给最新一天,T 日晚为预估、T+1 早为确认值);codes 逗号分隔只留指定 ETF,缺省全表、证据给份额前 30。上游 a-stock-data §4 |
| `margin_backup` | 两融明细官方备胎(上交所 / 深交所,单只) | CN | exchange | cn-public | cn6 | - | 交易所按代码所属市场自动选;trade_date 缺省 = 上一个交易日(两融数据次日发布);不覆盖北交所;筛不到代码 = 不是两融标的。⚠️ 上游上交所分支 2026-10-08 实测分页判断有误(2002 条分 2 页被当成不完整),上交所代码暂时报错,深交所正常。上游 a-stock-data §12 官方备胎 |
| `em_market_margin` | 全市场两融余额(逐日两融余额、融资净买入,最新融资余额占流通市值) | CN | eastmoney | cn-public | none | - | T 日数据 T+1 发布,最新一条通常是上一个交易日。 |
| `em_top10_holders` | 十大股东(最近两期;持股数 / 占总股本 / 较上期变动) | CN | eastmoney | cn-public | cn6 | - |  |
| `em_top10_free_holders` | 十大流通股东(最近两期;持股数 / 占流通股本 / 股东性质) | CN | eastmoney | cn-public | cn6 | risk:optional |  |

## 5 新闻(6)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_stock_news` | 东财个股新闻 | CN | eastmoney | cn-public | cn6 | risk:optional |  |
| `em_global_news` | 东财全球财经资讯 7x24 | CN | eastmoney | cn-public | none | - |  |
| `cls_telegraph` | 财联社电报(全市场快讯) | CN | cls | cn-public | none | - |  |
| `rss_news` | RSS 新闻雷达(106 个 tier-1 策展源 × 12 行业,红线关键词标记) | CN/US/HK | rss(investment-news) | rss-public | none | - | --args {"industry":"semiconductor"} 或 {"sources":["OpenAI"]};行业 key 见 rss_sources.json |
| `wscn_lives` | 华尔街见闻 7×24 快讯 | CN | wallstreetcn | cn-public | none | - | channel 例 global-channel / a-stock-channel / us-stock-channel;cursor 翻页(上一页的 next_cursor);快讯常无标题,证据取正文前 300 字。上游 a-stock-data §5 |
| `cctv_news` | 新闻联播文字稿(标题 + 正文) | CN | cctv | cn-public | none | - | 每天都播(含节假日);date 缺省 = 北京时间 20 点后取今天、否则昨天;只陈述原文,不做政策解读。上游 a-stock-data §5 |

## 8 打板(9)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_zt_pool` | 东财涨停池 | CN | eastmoney | cn-public | none | - | --args {"date":"YYYYMMDD"} 指定交易日,默认北京时间当天 |
| `em_zb_pool` | 东财炸板池 | CN | eastmoney | cn-public | none | - | --args {"date":"YYYYMMDD"} 指定交易日,默认北京时间当天 |
| `em_dt_pool` | 东财跌停池 | CN | eastmoney | cn-public | none | - | --args {"date":"YYYYMMDD"} 指定交易日,默认北京时间当天 |
| `em_yzt_pool` | 东财昨日涨停池(今日表现) | CN | eastmoney | cn-public | none | - | --args {"date":"YYYYMMDD"} 指定交易日,默认北京时间当天 |
| `em_limit_up_sentiment` | 打板三池计数(涨停 / 炸板 / 跌停;炸板率等由 calc 算) | CN | eastmoney | cn-public | none | - |  |
| `em_stock_monitor` | 东财重点监控池 | CN | eastmoney | cn-public | none | - |  |
| `em_price_anomaly` | 日内严重异常波动明细 | CN | eastmoney | cn-public | none | - |  |
| `em_price_anomaly_count` | 异常波动统计(按标的聚合) | CN | eastmoney | cn-public | none | - |  |
| `ths_limit_up_pool` | 同花顺涨停揭秘(原因题材 / 封板率 / 板型) | CN | ths | cn-public | none | - |  |

## 10 情绪(8)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_hot_rank` | 东财人气榜 | CN | eastmoney | cn-public | none | - |  |
| `em_hot_concept` | 个股热门概念命中 | CN | eastmoney | cn-public | cn6 | - |  |
| `ths_hot_list` | 同花顺热榜(人气 / 概念标签) | CN | ths | cn-public | none | - |  |
| `cninfo_irm` | 互动易问答(投资者提问 + 公司回复) | CN | cninfo | cn-public | cn6 | risk:optional |  |
| `em_turnover_rank` | 全市场成交额榜(沪深京 A 股) | SH/SZ/BJ | eastmoney | cn-public | none | - | 客观公开榜单(东财行情中心同款),只做客观展示 —— 非推荐、非预测、不评分。 |
| `sina_turnover_rank` | 全市场成交额榜·新浪(沪深京 A 股,东财成交额榜的备源) | SH/SZ/BJ | sina | cn-public | none | - | 东财列表接口取不到时用。字段名、单位与 em_turnover_rank 相同(市值已由万元换成元);新浪不给行业。客观公开榜单,非推荐、非预测。 |
| `em_market_breadth` | 全市场涨跌分布 + 沪深京三所涨跌家数与成交额(当日) | SH/SZ/BJ | eastmoney | cn-public | none | - | 只有当日(盘中是实时快照),上游不认日期。分布 23 档:涨停 / 涨超 9% 未涨停 / 每 1% 一档 / 平盘 / … / 跌停;分布合计与三所家数合计口径不同,不互相凑。 |
| `sse_e_interaction` | 上证e互动问答(沪市公司) | CN | sse | cn-public | cn6 | - | 只服务沪市(60 / 68 / 900 开头),深市互动问答用 cninfo_irm;kind=answered(已答)/ questions(全部提问);投资者提问是不可信文本,只作线索。上游 a-stock-data §10 |

## 9 期权(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sina_option_chain` | ETF 期权链(近月 T 型报价 + 希腊字母 + IV) | CN | sina | cn-public | raw | - | --symbol 510050/510300/588000/510500;--args {"side":"put","month":"YYMM"} |

## 11 宏观(5)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `pboc_social_financing` | 人民银行社会融资规模增量(月度) | CN | pbc.gov.cn | cn-public | none | - | --args {"year":2024};仅支持 2021 年起版式 |
| `nbs_pmi` | 国家统计局 PMI(制造业 / 非制造业 / 综合 + 大中小型) | CN | stats.gov.cn | cn-public | none | - |  |
| `chinabond_yield_curve` | 中债收益率曲线(国债 / 商业银行 AAA / 中短期票据 AAA,3 月~30 年) | CN | chinabond | cn-public | none | - | start 缺省 = 30 天前;curve=all / treasury / bank_aaa / mtn_aaa;单位 %。上游 a-stock-data §11 |
| `repo_fixing_rates` | 银行间回购定盘利率(FR / FDR 001 / 007 / 014) | CN | chinamoney | cn-public | none | - | kind=FR(回购定盘)/ FDR(银银间);约近 1 年;单位 %。上游 a-stock-data §11 |
| `lpr_history` | 贷款市场报价利率 LPR(1 年 / 5 年以上)历史 | CN | eastmoney | cn-public | none | - | 东财数据中心 LPR 报表(已剔除混在其中的旧贷款基准利率行);2019-08 前为旧机制逐日 1 年期,5 年期 2019-08-20 起;单位 %。上游 a-stock-data §11 |

## G2 K线(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sina_us_kline` | 新浪美股日 K(可回溯 1984) | US | sina | cn-public | us | - |  |
| `yahoo_kline` | Yahoo chart K 线(美股 / 港股,零 crumb) | US/HK | yahoo | B | global | risk:optional |  |

## G3 指标(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `indicators_cn` | 技术指标快照(A 股,baostock 前复权日 K → MA/EMA/MACD/RSI/KDJ/BOLL) | CN | calc(baostock) | cn-public | cn6 | - | 计算型端点:取数层确定性计算(非 calc DAG),信封 extra.computation 记库 / 版本 / 输入 raw / 参数供复算;不进研究阶段计划(计算型端点待迁 calc);仅供手工调用 |
| `indicators_us` | 技术指标快照(美股,新浪日 K) | US | calc(sina) | cn-public | us | - | 计算型端点:取数层确定性计算(非 calc DAG),信封 extra.computation 记库 / 版本 / 输入 raw / 参数供复算 |
| `indicators_hk` | 技术指标快照(港股,Yahoo 日 K) | HK | calc(yahoo) | B | hk | - | 计算型端点:取数层确定性计算(非 calc DAG),信封 extra.computation 记库 / 版本 / 输入 raw / 参数供复算 |

## G4 财务(12)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_global_income` | 东财全球财报 — 利润表(美股 / 港股,按科目行) | US/HK | eastmoney | cn-public | global | financials:optional |  |
| `em_global_balance` | 东财全球财报 — 资产负债表(美股 / 港股,按科目行) | US/HK | eastmoney | cn-public | global | financials:optional |  |
| `em_global_cashflow` | 东财全球财报 — 现金流量表(美股 / 港股,按科目行) | US/HK | eastmoney | cn-public | global | financials:optional |  |
| `em_global_key_indicators` | 东财关键财务指标(美股 49 列 / 港股 75 列) | US/HK | eastmoney | cn-public | global | - |  |
| `global_financials_pit` | 港美股关键财务(按公告日过滤;单季 / 年初至今累计 / 全年分清) | US/HK | eastmoney | cn-public | global | financials:required | 关键; period 一律写起止日(财年不按自然年);东财旧期公告日会被后续再次披露覆盖,按它过滤只会多丢不会多放,留下的值可能是重述口径;金额按报告币种(港股 / 中概常为人民币);部分银行股(如汇丰 00005)源里没有 |
| `yahoo_consensus` | Yahoo 年度一致预期(当前财年 T / T+1:EPS 均值 / 最低 / 最高 / 分析师数 / 营收) | US/HK | yahoo | B | global | estimates:required | 关键; 期间按财年截止日所在年写 FYyyyy;金额按报告币种(financialCurrency);只有两个财年,前瞻增速只能算 T → T+1 |
| `baidu_pe_history_3y` | 百度港美股市盈率(TTM)近三年日序列(历史分位用) | US/HK | baidu | cn-public | global | valuation:optional | 全序列存为提取 CSV(列 date / pe_ttm),历史分位用 calc percentile_rank 的 history_csv;百度的 TTM 口径与本次用财报算的 TTM 不一定一致,分位只作参照 |
| `yahoo_key_statistics` | Yahoo 关键指标(PE/PB/EV/利润率/ROE/Beta) | US/HK | yahoo | B | global | valuation:optional | 不输出分析师目标价与评级(产品口径);raw 原样落盘存证 |
| `yahoo_analyst_estimates` | Yahoo 分析师预期(EPS / 营收预期趋势 / 评级分布 / 财报惊喜) | US/HK | yahoo | B | global | estimates:optional | 评级分布是机构聚合篇数;逐家升降级与目标价不输出(产品口径) |
| `yahoo_institutional_holders` | Yahoo 机构持仓(前 10 + 内部人 / 机构占比) | US/HK | yahoo | B | global | risk:optional |  |
| `yahoo_financials` | Yahoo 财务时间序列(收入 / 利润 / 现金流 / 资产负债关键科目,全年 / 单季 / 近四季) | US/HK | yahoo | B | global | financials:optional | period=annual 全年 / quarterly 单季 / trailing 近四季(只含利润表与现金流科目);金额按报告币种(港股常以人民币列报) |
| `baidu_valuation_global` | 百度港美股估值历史(市盈率 TTM / 市净率 / 总市值,近一年日序列) | US/HK | baidu | cn-public | global | - | 全序列存为提取 CSV(列 date / pe_ttm / pb / market_cap),历史分位用 calc percentile_rank 的 history_csv;源在周末节假日延续上一日值,周末已剔除、节假日可能仍有重复 |

## G1 行情(4)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `global_quote_ref` | 港美股报价 + 基准指数(报价日 / 参考交易日 / 交易时段 / 僵尸报价判定) | US/HK | tencent | cn-public | global | profile:required | 关键; 港美股没有可查的公众假期日历:以基准指数(标普 500 / 恒生指数)的报价日作参考交易日,交易时段按交易所当地时钟推算;pe_vendor 为腾讯口径未注明的市盈率,只作原值 |
| `fx_rates` | 汇率(美元 / 港元兑人民币、美元兑港元) | US/HK | tencent | cn-public | none | valuation:optional | 跨币种估值(如港股市值港元、利润人民币)先用计算库 fx_convert 换算;单位写「报价币种/基准币种」 |
| `ah_premium_a` | AH 溢价(按 A 股代码查对应 H 股;A 价 / H 价 / 汇率原值 + 溢价) | CN | tencent+eastmoney+calc | cn-public | cn6 | - | 计算型端点:溢价 = A ÷ (H × 港元兑人民币) − 1,三个原值与时间戳都留证(两边收盘时间不同);不是 AH 两地上市 → 文本证据说明没有对应股票(ok,不算失败);不进研究阶段计划 |
| `ah_premium_h` | AH 溢价(按港股代码查对应 A 股) | HK | tencent+eastmoney+calc | cn-public | hk | profile:optional | 同 ah_premium_a,入口换成港股代码 |

## G5 资金(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_global_fund_flow` | 东财日级资金流(美股 / 港股) | US/HK | eastmoney | cn-public | global | risk:optional |  |
| `em_southbound_flow` | 南向资金每日成交(港股通沪深合计;净买入 / 买入 / 卖出 / 笔数 / 恒指,百万港元) | HK | eastmoney | cn-public | none | - | 全市场口径(symbol 记 MARKET);channel=all 合计 / sh 港股通(沪)/ sz 港股通(深);单位与港交所披露核对过,是百万港元 |
| `em_southbound_holding` | 个股南向持股(港股通持股数 / 市值 / 占已发行港股比例) | HK | eastmoney | cn-public | hk | risk:optional | 没有记录 = 不在港股通名单或源未收录,不是 0 持股 |

## G6 期权(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `cboe_options` | CBOE 官方延时期权链(按到期筛选 + 成交量前 N 合约;聚合留给 calc) | US | cboe | C | us | - | --args {"expiry":"0DTE"} 或 {"dte_max":7} |
| `cboe_quote` | CBOE 个股快照(含 IV30) | US | cboe | C | us | - |  |
| `yahoo_options` | Yahoo 期权链(后备,无希腊字母,仅美股) | US | yahoo | B | us | - |  |

## G7 SEC(4)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sec_ticker_cik` | SEC ticker → CIK | US | sec | S | us | - | env VRA_SEC_CONTACT |
| `sec_filings` | SEC 申报列表(10-K/10-Q/8-K/4/13F...) | US | sec | S | us | - | env VRA_SEC_CONTACT |
| `sec_xbrl_facts` | SEC XBRL 结构化财务(companyfacts,默认 10 个核心指标) | US | sec | S | us | - | env VRA_SEC_CONTACT |
| `sec_earnings_8k_dates` | 美股业绩 8-K 提交日(SEC EDGAR 全文检索,Item 2.02 经营业绩) | US | sec | S | us | - | env VRA_SEC_CONTACT; SEC 官方全文检索(2001 年至今),按 8-K 自带的 items 只留 2.02,更正版 8-K/A 不算;一般一页取完,大银行也能取全;检索结果按相关度排,翻到上限才记 truncated(缺的不一定是最早的);外国公司(ADR)用 6-K 报业绩,取不到;日期是美东提交日;需在「接入 AI」页填 SEC 联系方式(英文姓名和邮箱;或环境变量 VRA_SEC_CONTACT);事件回看填了就优先用它,没填或取不到时用东财的 us_earnings_8k_dates |

## G10 申报流(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sec_daily_filings` | EDGAR 每日申报流(Form 4 / 8-K / 13F) | US | sec | S | none | - | env VRA_SEC_CONTACT |
| `sec_fulltext_search` | EDGAR 全文检索(2001 至今) | US | sec | S | raw | - | env VRA_SEC_CONTACT; --symbol '"HBM4"' |

## G11 横截面(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `sec_market_frame` | EDGAR frames 全市场横截面(免费 screener) | US | sec | S | raw | - | env VRA_SEC_CONTACT; --symbol 净利润/NetIncomeLoss --args {"year":2025,"quarter":2} |

## G9 做空(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `finra_short_volume` | FINRA Reg SHO 单票日度空头成交占比 | US | finra | B | us | risk:optional |  |
| `finra_short_ranking` | FINRA 空头占比排行(最近一日全市场) | US | finra | B | none | - |  |

## G12 宏观(4)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `treasury_yield_curve` | 美债收益率曲线(财政部,每日 1M~30Y) | US | treasury.gov | S | none | - |  |
| `cftc_cot` | CFTC 持仓报告 COT | US | cftc | S | none | - | --args {"market_contains":"GOLD"} |
| `nasdaq_earnings_calendar` | Nasdaq 财报日历 | US | nasdaq | B | none | - |  |
| `fred_us_macro` | FRED 美国宏观历史序列(CPI / 核心 CPI / 核心 PCE / 失业率 / 非农 / 联邦基金利率 / 实际 GDP 等) | US | fred | S | none | - | 免 key 的 CSV 下载(不用要 key 的 API);只收单位核对过的 12 个系列(另有 GDP / M2SL / INDPRO / ICSA / T10Y2Y),版权受限的系列不收;默认取近 10 年;全序列存为提取 CSV,环比同比交给 calc |

## G8 工具(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `em_stock_search` | 东财全球股票搜索(代码 / 市场 / 中文名) | US/HK | eastmoney | cn-public | raw | - |  |
| `em_market_list` | 东财全市场列表(NASDAQ / NYSE / 美股 ETF / 港股 排名) | US/HK | eastmoney | cn-public | none | - |  |
| `yahoo_news` | Yahoo Finance 新闻搜索 | US/HK | yahoo | B | raw | - |  |

## 12 市场声音(2)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `exa_market_voice` | 市场声音 · 全网语义搜索(Exa 免 key MCP):新闻 / 深度文 / KOL 帖,按主题分组,前 N 条读摘录 | CN | exa-mcp | web-search-free(mcp.exa.ai,无 key;结果为公开网页索引,只作线索) | cn6 | risk:optional | 查询词由模块按公司名确定性生成(业绩进展 / 风险 / 行业竞争 / 英文分析师);标题与摘录经 textsafe 脱敏(动作词替换、控制字符剥离、截断),原文在 raw;数字不可作事实引用 |
| `exa_forum_voice` | 市场声音 · 雪球 / 股吧讨论(经 Exa 索引,只取标题 / 作者 / 日期 / 链接;正文受 WAF 限制不可读) | CN | exa-mcp | web-search-free(mcp.exa.ai,无 key;雪球 / 股吧页面本身受 WAF,只用索引元数据) | cn6 | risk:optional | 雪球 / 股吧匿名直连被阿里云 WAF 拦截(2026-08-23 实测),Jina 读帖子正文也被 IP 频繁墙挡;本端点只提供讨论的存在性与热度线索 |

## 13 产业温度计(4)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `tw_monthly_revenue` | 产业温度计 · 台系供应链月营收(FinMind 零鉴权):台光 / 台燿 / 金像电 / 联亚,环比 · 同比 · 累计同比 · 台光×金像电差分 | CN | finmind | public-api-free(api.finmindtrade.com,无 key;台股法定月营收) | none | risk:optional | 每月 10 日前披露、滞后 ~10 天;402 = 配额 / 限流必须出声;资料期 > 2 个月标 partial;证据 market=TW / symbol=台股代码,币种 TWD。读法护栏在 note 与 extra.guard;history_fields=月营收 / 环比 / 同比进用户数据区序列,下次运行出 _prev / _change_*(累计同比与差分文本不做历史) |
| `gpu_rent_thermometer` | 产业温度计 · GPU 租金(近一年逐日中位 + 现货 + Kalshi 远期概率):算力缺不缺的一根线 | CN | 500farm+kalshi | public-api-free(500.farm Prometheus 代理 + api.elections.kalshi.com trade-api v2,无 key) | none | risk:optional | 曲线 = 500.farm 对 Vast 可租挂单的逐日中位(按机型档位分组统计后聚合,**不是**逐张挂单精确中位);🔴 现货 = 曲线的最新采样点,同源同算法 ⇒ 卡片数字与曲线末端严格一致(旧版现货走 Vast bundles,与曲线对不上且只有两张卡);型号名用统计站 label 原文(H100 SXM / A100 SXM4,写错只会安静返回空序列);Prometheus 空窗会给 NaN/Inf,必须丢弃(进 JSON 会让整条端点失败);挂单卡数是规模读数不是信号本体,拿不到给 None 不算失败;Kalshi 三分判定(格式变 / 未开盘 / 有报价);$3 是折旧参考线不是保本线;证据 market=US / symbol=GPU 型号;曲线走 extra(序列不是证据) |
| `cn_commodity_futures` | 产业温度计 · 上游大宗期货(新浪连续合约:沪铜 / 沪锡 / 沪铝 / 沪镍 / 工业硅) | CN | sina_futures | public-api-free(akshare futures_zh_daily_sina,无 key) | none | risk:optional | 全市场证据 → symbol=MARKET / record_key=品种代码;期货价不是本公司采购价(护栏原样进 note);工业硅需求由光伏主导对半导体是弱信号;资料超 10 天未更新标 stale 并降 partial;逐品种隔离失败,全失败才抛;DataFrame 非传输层原文 → record_raw(kind=extracted) |
| `dram_spot_thermo` | 产业温度计 · DRAM / NAND 现货均价(GitHub 社区仓转录的 DRAMeXchange) | CN | github-community | public-repo-free(raw.githubusercontent.com,无 key) | none | risk:optional | 🔴 社区转录的 DRAMeXchange 存档不是官方一手(可能有转录误差与停更),护栏必须原样带出;DRAM 现货是 HBM 的影子指标不是 HBM 价格(HBM 走年度长约无公开现货价);ddr5 序列无 product 字段 → 规格如实写"未在数据中标明";全市场证据 symbol=MARKET / record_key=品类;超 14 天标 stale 降 partial |

## 14 管制与准入(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `policy_access` | 管制与准入 · 美方名单状态(1260H 全文检索 / BIS 规则提及 / FCC Covered List)+ 中方出口管制公告事件流 | CN | federalregister+cninfo+fcc+mofcom | public-api-free(federalregister.gov API / cninfo companyOverview / fcc.gov 与 mofcom 经 r.jina.ai 免 key) | cn6 | risk:optional | 判定以联邦公报通知全文检索公司英文名为准;无英文名 = undetermined(≠ not_on_list);没被点名 ≠ 不受影响;'被建议列入' ≠ '已列入';中方侧默认不接(商务部公告列表 JS 渲染零配置抓不到,证据里给 not_connected 护栏)。移植自 V2 policy_access.py |

## 15 数据日历(3)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `next_disclosure` | 数据日历 · 本公司下一份定期报告的预约披露日(东财 RPT_PUBLIC_BS_APPOIN) | CN | eastmoney | public-api-free(datacenter-web.eastmoney.com,无 key) | cn6 | risk:optional | 预约日可能提前或推迟,以公司公告为准;过了预约日仍未披露=延期信号;result=null 是真实状态(无记录)不是故障;成功但一行都解析不出=结构变了必须抛 |
| `us_anchor_earnings` | 数据日历 · 美股锚下一个财报日(Nasdaq analyst/{ticker}/earnings-date,默认 NVDA) | CN | nasdaq | public-api-free(api.nasdaq.com,无 key;主机限流 2/s) | none | risk:optional | 文案带 * / expected = 交易所与 Zacks 预估日,不是公司确认日,证据 note 必须写明;逐 ticker 隔离失败;解析不出日期=结构变了必须抛;证据 market=US / record_key=ticker |
| `macro_calendar` | 全球宏观日历(公布时间 / 重要度 / 实际 / 预期 / 前值) | CN | wallstreetcn | cn-public | none | - | start 缺省 = 今天,上游默认看 7 天;证据按重要度取前 30。上游 a-stock-data §15 |

## 16 海外头条(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `techmeme_headlines` | 海外科技头条 · Techmeme river 时间流(按产业标签标注相关性) | CN | techmeme | public-free(www.techmeme.com/river,无 key) | none | risk:optional | 🔴 不可信文本:标题里的数字不得写成事实,动作措辞经 textsafe 脱敏,链接只进附录;相关性来自 industry_tags.json 的 headline_keywords(不硬编码个人关键词表),关键词为空 = 未标注(unscored)≠ 不相关;river 解析 0 条 = 结构变了 → 回退 RSS 但必须出声(只有约 15 条,窗口不完整);无时间戳条目丢弃不猜;窗口内零条是真实状态(凌晨 / 假日)标 partial 不算故障 |

## 17 招聘信号(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `hiring_anchor_signal` | 招聘信号 · 产业锚点公司公开在招岗位(Greenhouse / Ashby 零鉴权) | CN | ats-public | public-api-free(boards-api.greenhouse.io / api.ashbyhq.com,无 key;只读公开岗位不碰简历) | none | risk:optional | 锚点清单在 industry_tags.json 的 hiring_anchors(与温度计同一处配置);⛔ Workday 系(NVIDIA/Coherent/Lumentum/Marvell/Micron)需 host+tenant+site 非零配置,不收、如实写未接入;岗位数是招聘意图不是产能,只在同一公司内部比变化;全市场证据 symbol=MARKET / record_key=ats:slug;逐家隔离失败,全失败才抛;解析不出 jobs 数组=结构变了必须抛 |

## 18 宏观概率(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `macro_probability` | 宏观概率 · 预测市场对宏观事件的定价概率(Kalshi + Polymarket,零鉴权) | CN/US/HK | prediction-markets(kalshi+polymarket) | public-api-free(api.elections.kalshi.com / gamma-api.polymarket.com,无 key;只读公开行情,不下单不涉资金) | none | risk:optional | 移植自 simonlin1212/GlobalPercent 的模块分类器与取数形态。只收 6 个核心模块(货币政策 / 宏观经济 / 地缘政治 / 政治选举 / 股指大宗 / AI科技),参考类(加密 / 体育 / 娱乐 / 其他)丢弃;每模块取前 3(排序键 = max(24h 成交量, 未平仓量) —— 月度宏观合约典型是持仓大、当日安静,只看当日量会被冷门合约挤掉)。**近端允许安静、远期必须有 24h 成交量** —— 纯日期窗口会误杀有意义的远期宏观合约(实测「Recession in 2027?」有真实成交却结算在 500 多天后),纯流动性又留不住 2099 年的僵尸盘。⚠️ 这是**市场当前的定价预期,不是事实也不是预测**,概率随时在变、只在 as_of 那一刻成立;低成交量合约噪音极大。⚠️ Kalshi 的成交量字段是 volume_24h_fp / volume_fp(不是 volume_24h),且服务端**忽略 category 查询参数**,只能翻页后本地分类。 |

## 19 指数(4)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `index_constituents` | 指数成分股(中证 / 国证官网文件) | CN | csindex | cn-public | raw | - | 代码原样传 6 位指数代码(如 000300 沪深300、000905 中证500);provider=csi(中证)/ cni(国证)。上游 a-stock-data §12 官方数据 |
| `index_weights` | 指数成分权重(中证 / 国证官网文件) | CN | csindex | cn-public | raw | - | 中证权重文件为月度收盘权重;证据按权重取前 30,全表在 raw。上游 a-stock-data §12 官方数据 |
| `index_valuation` | 指数估值(中证官网 PE / 股息率,近期) | CN | csindex | cn-public | raw | - | 总股本 / 计算用股本两种口径分列,不含 PB。上游 a-stock-data §12 官方数据 |
| `em_market_trend` | 主要指数中长线(5/20/60/250 日涨跌、年初至今、均线、250 日高低点)+ 沪深两市成交额近 60 日 | CN | tencent+eastmoney+baostock | cn-public | none | - | 上证 / 深成 / 创业板 / 沪深300 / 中证500 / 中证1000 / 科创50 / 北证50;按收盘价的固定算法,公式写在每条证据的 note。两市成交额 = 上证指数 + 深证综指。盘中最新一根没收完;传 end(某个交易日)只用那天及以前的日线。 |

## 20 期货与大宗(7)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `futures_daily` | 期货日行情(上期所 / 能源中心 / 郑商所 / 中金所 / 广期所,全部合约) | CN | exchange | cn-public | none | - | exchange=SHFE / INE / CZCE / CFFEX / GFEX(大商所官网有反爬,未接入;大商所品种用 futures_kline / futures_realtime);date 缺省 = 最近一个 17 点后已收盘的交易日;证据按持仓量取前 30,价格单位是各品种的交易所计价单位(股指期货为点、国债期货为百元面值)。上游 a-stock-data §13 |
| `options_daily` | 商品 / 股指期权日行情(含隐含波动率) | CN | exchange | cn-public | none | - | exchange=SHFE / INE / CZCE / CFFEX / GFEX;ETF 期权不在这里(见 sina_option_chain);证据按持仓量取前 30。上游 a-stock-data §13 |
| `futures_position_rank` | 期货会员持仓排名(成交 / 多头 / 空头前 20) | CN | exchange | cn-public | none | - | exchange=SHFE / INE / CZCE / CFFEX(广期所、大商所未接入);symbol 可限定品种或合约;缺品种时上游报错、不返回部分品种。上游 a-stock-data §13 |
| `futures_realtime` | 期货实时行情(新浪,主力连续 / 具体合约) | CN | sina | cn-public | raw | - | 代码原样传,例 RB0(螺纹主力连续)/ CU2610 / IF2609;一次一个。上游 a-stock-data §13 |
| `futures_kline` | 期货日 K(新浪,含结算价与持仓量) | CN | sina | cn-public | raw | - | 例 RB0 / M2601 / MA2601(郑商所也写 4 位年月);含大商所。上游 a-stock-data §13.7 |
| `a50_futures` | 富时中国 A50 期指(连续合约报价) | CN | sina | cn-public | none | - | 盘前 / 夜盘观察外资对 A 股的情绪,只陈述报价。上游 a-stock-data §13 |
| `sge_spot` | 上海黄金交易所日线(黄金 / 白银 / 铂) | CN | sge | cn-public | raw | - | 代码原样传,例 Au99.99 / Au(T+D) / Ag(T+D) / Pt99.95;黄金 元/克、白银 元/千克;少数日子收盘价略超出高低区间是原始数据如此(标 partial 并列出日期)。上游 a-stock-data §13 |

## 21 事件驱动(10)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `earnings_forecast` | 业绩预告(类型 / 金额区间 / 同比区间) | CN | eastmoney | cn-public | cn6 | - | 单只;report_date 为报告期(如 2026-09-30);金额单位元。上游 a-stock-data §14 |
| `institution_survey` | 机构调研(调研日 / 机构数 / 方式) | CN | eastmoney | cn-public | cn6 | - | 单只;detail=true 时返回逐家机构明细。上游 a-stock-data §14 |
| `holder_trades` | 股东增减持(重要股东二级市场 / 大宗交易) | CN | eastmoney | cn-public | cn6 | - | 单只;股数单位万股,减持为负。上游 a-stock-data §14 |
| `share_buyback` | 股票回购(方案与实施进度) | CN | eastmoney | cn-public | cn6 | - | 单只;股数单位股、金额单位元。上游 a-stock-data §14 |
| `em_buyback_history` | 个股历次回购方案(带首次公告日) | CN | eastmoney | cn-public | cn6 | - | 单只;一个方案一行,按首次公告日倒序;金额单位元。first_notice=方案第一次公告那天(share_buyback 没有这一列)。事件回看用 |
| `em_dragon_tiger_history` | 个股历次上龙虎榜(全部历史) | CN | eastmoney | cn-public | cn6 | - | 单只;一条上榜理由一行;金额单位元,按累计偏离上榜的是那几天的合计;不取东财自编的成功率。em_dragon_tiger 只看近 30 天。事件回看用 |
| `em_lockup_history` | 个股历次限售解禁(全部历史 + 已排期) | CN | eastmoney | cn-public | cn6 | - | 单只;一批一行;实际可流通股数(万股)和占总股本(%);源的占流通股比例新旧批次分母不一致,不取。em_lockup_expiry 历史只取 15 条。事件回看用 |
| `equity_pledge` | 股权质押比例(中国结算每周统计) | CN | eastmoney | cn-public | cn6 | - | 单只历次统计;只覆盖沪深;股数万股、市值万元。上游 a-stock-data §14 |
| `ipo_calendar` | 新股申购日历(沪深京,含排期) | CN | eastmoney | cn-public | none | - | 按申购日倒序;定价前发行价为空。上游 a-stock-data §14 |
| `em_suspensions` | 当日停复牌名单(沪深京;停牌原因 / 期限 / 预计复牌日) | CN | eastmoney | cn-public | none | - | 全市场口径(源不支持按个股过滤);默认当天,可传 date=YYYY-MM-DD |

## 22 可转债(1)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `convertible_bonds` | 可转债全表(条款 + 转股价 / 债价 / 转股价值 / 溢价率) | CN | eastmoney | cn-public | none | - | stock_code 给正股 6 位代码只留该公司转债;证据按发行规模取前 30,全表在 raw。上游 a-stock-data §15 |

## G13 公司资料(5)

| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |
|---|---|---|---|---|---|---|---|
| `yahoo_events` | Yahoo 分红 / 拆合股历史(近 10 年,每股派息 + 拆股比例) | US/HK | yahoo | B | global | valuation:optional | 日期按交易所时区换算;未区分常规 / 特别派息 |
| `em_global_profile` | 东财港美股公司资料(名称 / 行业 / 上市板块 / 上市日 / 注册地 / 员工 / 简介) | US/HK | eastmoney | cn-public | global | profile:required | 简介 / 主营是源文本,经净化截断(600 字);港股另给已发行港股数、每手股数、是否港股通标的 |
| `em_hk_dividend` | 东财港股派息历史(方案原文 + 除净日 / 派付日 / 过户日) | HK | eastmoney | cn-public | hk | valuation:optional | 港股方案币种不一(港币 / 人民币 / 美元),方案原文不解析成数字 |
| `hkex_results_dates` | 港股业绩公告日(港交所披露易:末期 / 中期 / 季度业绩,带发布时间) | HK | hkex | S | hk | - | 零鉴权;披露易存档从 1999 年起;发布时间是香港时间(16:00 收市后发布的,市场反应在下一个交易日);同一份公告挂几个分类只留一次;事件回看读它 |
| `us_earnings_8k_dates` | 美股业绩 8-K 提交日(SEC 8-K Item 2.02 经营业绩,东财转载) | US | eastmoney | cn-public | us | - | 东财按栏目筛不了,从新到旧每页 100 份翻到 max_pages;大银行每年上千份债券申报翻不完(truncated → partial);外国公司(ADR)用 6-K 报业绩,取不到;日期是美东提交日,没有可靠的提交时刻;事件回看在没填 SEC 联系方式、或 SEC 这次取不到时读它 |
