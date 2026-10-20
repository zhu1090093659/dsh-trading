---
name: earnings-analysis
description: 财报拆解手册:报告期累计值 → 单季(quarterize)→ 最新单季 / TTM / TTM 同比 / 环比的口径地图,扣非与归母的取舍(一次性损益),季节性与报告期对齐(分子分母同期),三表交叉核对(利润表 / 资产负债表 / 现金流量表),比率(毛利率 / 费用率 / 负债率)一律经 calc ratio,"转向看最新期、规模看 TTM"的判读模板与质量检查清单。当任务涉及财报、季报、业绩、利润拆分、同比环比、毛利率、现金流、扣非时加载;只查行情 / 公告 / 产业链结构、或只讨论概念不涉及财务数字的任务不要加载。取数层不做任何算术,所有派生数字出自 calc;不给投资动作建议。
---

# 财报拆解(earnings-analysis)

对应 company-research SOP 第 2 阶段(financials)的口径说明书,也用于任何"业绩怎么样"的追问。原则:**累计值是原料,单季是基本单位,TTM 看规模,最新期看转向;每一步拆分 / 求和 / 比率都是一次 calc 调用**。

## 0. 四条铁律

1. A 股财报披露的是**报告期累计值**(Q1 / H1 / Q1–Q3 / 全年);任何"单季""环比"都必须经 `quarterize` 拆出来,不在脑子里减。
2. **扣非 vs 归母**:估值分子用扣非(一次性损益不能 ×4),增速主判用归母(与一致预期 EPS 同口径),两者并列报、差异大时必须解释(投资收益 / 补助 / 减值 / 公允价值变动)。
3. 分子分母同期、同口径:同比对同季、TTM 对 TTM,不拿累计值比单季。
4. 比率(毛利率 / 净利率 / 费用率 / 负债率 / 占比)一律 `ratio(numerator, denominator, label, unit_in)`,两数同单位由你保证,calc 不换算单位。

## 1. 口径地图

| 口径 | 定义 | calc 函数 | 用途 | 禁用 |
|---|---|---|---|---|
| 累计值(YTD) | 报告期披露原值 | —(证据) | 原料 | 不直接比较不同长度的报告期 |
| 单季 | Q1 = YTD(Q1);Qn = YTD(n) − YTD(n−1) | `quarterize(cumulative, unit, money=true)` | 基本单位 | 上一期缺失 → 该季无值,不拿平均代替 |
| 最新单季 | 最新非空单季 | `latest_quarter(single_quarters, unit, money=true)` | 估值分子(扣非)、转向判断 | — |
| TTM | 近 4 季之和 | `ttm_sum(single_quarters, end_period, unit, money=true)` | 规模、TTM PE | **任一季缺失即 not_meaningful**(不拿 3 季凑) |
| TTM 同比 | TTM(end) ÷ TTM(end − 4 季) − 1 | `ttm_yoy(...)` | 可持续增速事实、交叉验证前瞻 CAGR | 需 8 季连续 |
| 环比 | Q(end) ÷ Q(end − 1) − 1 | `qoq(...)` | **拐点 / 动量信号** | 禁止当增速、禁止年化、禁止做 PEG 分母 |
| 单季同比 | Q(end) ÷ Q(end − 4) − 1 | `growth_rate(current, base, label)` | 看"这一季相对去年"的方向 | 禁止做 PEG 分母(低基数假性吹大) |
| 比率 | 两个同期同单位科目之比 | `ratio(numerator, denominator, label, unit_in)` | 毛利率 / 净利率 / 费用率 / 负债率 / 经营现金流 ÷ 净利润 | 分母 ≤ 0 → not_meaningful,如实写 |

EPS 序列(元/股)用 money=false;金额类 money=true 由 calc 归一单位。

## 2. 拆解流程(与 SOP financials 阶段一致)

1. `fetch_financials`(★ 必需)→ 营收 / 归母 / 扣非 / EPS 的累计值序列(近 8–12 报告期)。
2. `quarterize` 各跑一次:revenue_cum、net_profit_parent_cum、net_profit_deducted_cum(unit=元, money=true)。
3. `latest_quarter`(扣非)→ 估值分子;`ttm_sum`(归母与扣非各一次)→ 中间量;`ttm_yoy`(主用归母,扣非并列)→ 增速事实;`qoq`(最新单季扣非)→ 拐点信号。
4. 三表交叉(○ 可选端点):`sina_income_statement` / `sina_balance_sheet` / `sina_cashflow`(A 股)、`em_global_income` / `em_global_balance` / `em_global_cashflow` 或 `yahoo_financials`(US / HK;`period` = annual 全年 / quarterly 单季 / trailing 近四季,金额按报告币种)。只作核对与补充科目(毛利、费用、经营现金流、应收、存货、有息负债),**科目原值按源原样记录**,不换算。
5. 比率:毛利率 = `ratio(毛利, 营收)`;净利率 = `ratio(净利润, 营收)`;费用率 = `ratio(某费用, 营收)`;经营现金流 / 净利润 = `ratio(经营现金流净额, 净利润)`;资产负债率 = `ratio(总负债, 总资产)`——每个比率一次调用,分子分母同期同单位,记 calc id。
6. 每次 calc 调用都传 `--run-dir`(CLI 会把该次计算记录写入运行目录的 `calcs/`,编排器收尾时合并为契约产物 `calculations.json`;不要手工写任何文件),阶段 JSON 引用 calculation_id;缺口走 SOP §2 的结构化 gaps。

## 3. 质量检查清单(写进推断段)

- **一次性损益**:归母与扣非差异 > 20% 时必须解释来源(投资收益 / 政府补助 / 减值 / 公允价值变动),并说明估值与增速各用哪个口径。
- **季节性**:标出最新单季是 Q1 / Q2 / Q3 / Q4,以及该公司历史上淡旺季方向(从单季序列看),提醒"单季×4"的方向性偏差(valuation §1)。
- **报告期对齐**:同比对同季、TTM 对 TTM;跨公司比较先列各自报告期。
- **现金流 vs 利润**:经营现金流 ÷ 净利润长期 < 1 → 标注"利润质量待查",看应收 / 存货变化(三表交叉)。
- **资产负债**:有息负债、应收 / 存货增速 vs 营收增速(用 `growth_rate` 各算一次再比较,不用心算)。
- **审计与公告**:年报审计意见、业绩预告 / 快报与正式报告差异(`fetch_announcements` / `cninfo_announcements`)。

## 4. 判读模板("转向看最新期、规模看 TTM")

| 问题 | 看什么 | calc |
|---|---|---|
| 在加速还是减速? | 最新单季扣非环比(拐点)、单季同比方向、连续两季趋势 | `qoq`、`growth_rate` |
| 增长兑现了吗? | TTM 同比(归母)与前瞻 CAGR 的差 | `ttm_yoy` → valuation 的 `forward_vs_ttm_judgement` |
| 利润质量如何? | 扣非 / 归母、经营现金流 / 净利润、毛利率趋势 | `ratio` |
| 规模多大? | TTM 营收 / 利润 | `ttm_sum` |

五问自查(研究宪法 §1):算出来的还是心算的?拉的字段里有没有能推翻结论的?来源 / 用途、同期?转向 vs 规模?强结论找反证了?

## 4b. 财报前瞻与复盘

只描述过去几次财报后的表现,不预测下一次;界面上的「财报前瞻与复盘」卡片(编排器 `earnings_brief` 视图)就是这套口径。

- **下一份财报日**:A 股 `next_disclosure`(东财预约披露表;公司可以改期,以交易所公告为准,改过期、预约日已过还没披露都写明);港美股 `yahoo_analyst_estimates` 的财报日(写明 Yahoo 标的是估计日期还是公司公布的日期,盘前盘后没注明)。
- **反应日涨跌**:`earnings_reaction(klines, events, lookback=4)`。A 股定期报告用正式披露日、timing=before_open(晚上发的公告正式日期是次日);港美股按发布时刻换算交易所当地时间判定盘前 / 盘中 / 盘后,当地 00:00 当作时刻不明、不传。K 线用复权价:A 股 `tx_kline`(前复权),港美股 `yahoo_kline` 的 adjclose。涨跌含当天大盘,**不写成超额收益**。
- **实际 vs 预期**:`earnings_surprise`。A 股:当期累计归母净利(`fetch_financials` 的 net_profit_parent_cum)对照当期业绩预告区间(`earnings_forecast`,同一期取最新一次公告;low / high,unit=元);港美股:实际每股收益对照 Yahoo 当季一致预期。
- **一致预期分歧**:`consensus_dispersion(low, mean, high)`。A 股同花顺给的是**全年**每股收益,写明「全年的,不是这一季的」;港美股 Yahoo 是当季,截止日和当前季度对不上要写缺口。
- 不做:拿平均涨跌推下一次、目标价、「超预期就会涨」这类判断。

## 5. 产出

- 事实表:指标 | 值 | 单位 | 报告期 | 来源(ev id)
- 派生表:口径 | 值 | 报告期 | calc id
- 推断段:季节性 / 一次性损益 / 利润质量 / 转向判断(每条带依据 id,可信度按研究宪法 §1 的四档标)
- 缺口:缺哪期 / 哪个科目、试过哪些源、对结论的影响

## 6. 不做的事

- 不心算、不自己换算单位、不把 3 季凑成 TTM、不用环比当增速。
- 不把一致预期当事实(那是 estimates 阶段,且标为预测)。
- 不给投资动作建议。
