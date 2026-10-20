# calc 函数契约(SPEC)

口径来源:研究宪法 `methodology/constitution.md` §3(R6.5)。本文件是实现规格;宪法只定口径与判读。版本:`CALC_VERSION = 0.5.0`(formulas.py;0.3.0 新增技术指标 / 筹码分布与 `history_json` 序列输入;0.3.1 新增通用比率 `ratio`;0.4.0 新增财报事件 `earnings.py`;0.5.0 金额支持美元 / 港元、币种不同须带汇率,新增 `fx_convert` / `ttm_from_ytd` / `ttm_yoy_from_ytd`)。

## 0. 通用约定

- 纯函数,无 I/O、无全局可变状态(序列文件的加载由 `cli.py` 做并记录 sha256)。
- 返回结构固定:`{status: ok | not_meaningful | error, value: 数或 null, unit, reason, details}`。
  - `ok`:value 为有限数(或序列类的计数);`not_meaningful`:公式在该输入域无意义(分母 ≤ 0 等),value=null + reason;
    `error`:输入非法(缺失 / 单位未知 / 非有限数 / 布尔 / 越界 / 百分数误传 / 溢出)。
  - **返回树任何位置都不会有 inf / NaN**:`_res` 递归守卫,发现即整体转 error;CLI 以 `allow_nan=False` 序列化。
- 数值校验统一经 `_num`:None(必填时)、布尔、非数、非有限 → error。
- 金额必须带单位参数,只认 `元 / 万元 / 亿元`、`美元 / 万美元 / 亿美元`、`港元 / 万港元 / 亿港元`,内部归一到该币种的基本单位(`to_base`);未知单位 / 换算溢出 → error。
- **两个金额币种不同必须带汇率**:`fx_rate`(正数)+ `fx_unit`(写成「报价币种/基准币种」,如 `CNY/HKD` = 1 港元合多少人民币),两个都从汇率证据照抄;币种不同没给汇率 → error(不猜);币种相同却给了汇率 → error;汇率对不上这两种币 → error。
- 比率一律**小数**(0.25 = 25%):`cagr` 类 |x| ≤ 5(500%),`ttm_yoy` 类 |x| ≤ 20(2000%);超出视为百分数误传 → error。
- `years` 必须是 1..10 的整数(布尔 / 小数 → error)。
- 不做四舍五入;展示层格式化——由 `cli.py` 在落盘前给 `output` 附 **`display`**(`calc/display.py`,确定性:|x|≥1 留 2 位小数、|x|<1 留 4 位有效数字;`小数`→百分比、金额按量级换算到 亿元/万元/元(美元 / 港元同理:亿美元 / 万港元 …;`美元/股` 这类每股单位不换算)、`期` 取整;status ≠ ok 或 value 为 null 时为 `null`)。多结果函数(如 `pe_digestion_scenarios`)顶层 `display` 为 null,`details` 里每个结果形子对象(含 status / value / unit)各自带 `display`。报告正文数字一律照抄 `display`,不抄 `value` 原始浮点;`value` 仍是复算与绑定校验的真理源。
- CLI(`cli.py`):`calculation_id = "calc-" + sha256(function + calc_version + 规范化实参 + 规范化 inputs_refs)[:16]`,
  其中 `history_csv` 实参被替换为文件身份 `{raw_ref, column, where, sha256, rows_used}`;实参规范化:键排序、-0.0→0.0。
  `--evidence` 必须匹配 `ev-[0-9a-f]{6,}`,`--calc` 必须匹配 `calc-[0-9a-f]{6,}`;去重、按(类型, id)排序后写入 `inputs_refs`。
  序列参数 `{"history_csv": {raw_ref, column, where}}`:raw_ref 必须是相对路径(任何绝对路径一律拒绝,含 raw/ 内的),从 `<run-dir>/raw/` 加载,realpath 解析后必须仍在 raw/ 内(拒绝 `..`、符号链接越界、raw/ 外文件);加载记录写入 `inputs_resolved`。
  输入 JSON 严格解析:`NaN` / `Infinity` 字面量 → bad_args;输出兜底信封不回显原始输入,保证 stdout 永远是严格 JSON。
  错误分类(`output.details.kind`):`bad_args`(参数名 / JSON 解析)、`bad_refs`、`bad_input`(序列加载)、`internal_error`(纯函数抛异常 = 库缺陷)、`nonfinite_output`(最后一道闸)。
  退出码:0 = ok;2 = not_meaningful;3 = error。

## 1. 公式类(formulas.py)

| 函数 | 公式 | 输入(单位) | not_meaningful | error |
|---|---|---|---|---|
| `pe_deducted_annualized(total_market_cap, cap_unit, latest_quarter_deducted_profit, profit_unit)` | 总市值 ÷ (最新单季扣非 × 4) | 金额 + 单位 | 市值 ≤ 0;单季扣非 ≤ 0 | 缺失 / 单位未知 / 非数 / 溢出 |
| `pe_ttm_from_parts(total_market_cap, cap_unit, ttm_profit, profit_unit, fx_rate=None, fx_unit=None)` | 总市值 ÷ 近 4 季净利和(交叉验证数据源 PE_TTM);币种不同时分母先按汇率换成市值的币种,details 另带 currency / denominator_original | 金额 + 单位(人民币 / 美元 / 港元) | 市值 ≤ 0;TTM ≤ 0 | 同上;币种不同没给汇率 / 币种相同给了汇率 |
| `forward_pe(price, eps_forecast, price_unit=None, eps_unit=None, fx_rate=None, fx_unit=None)` | 现价 ÷ 一致预期 EPS(FY T 均值);给单位时核对币种,不同须带汇率(EPS 换成价格币种,details.eps_converted) | 价格 元 / 美元 / 港元,EPS 加 /股;两个单位要么都给、要么都不给 | 价格 ≤ 0;(换算后)EPS ≤ 0 | 缺失 / 非数;只给一个单位;没给单位却传汇率;币种不同没给汇率 |
| `fx_convert(value, unit, fx_rate, fx_unit)` | 金额按汇率换到另一币种:金额是基准币种 → 乘,是报价币种 → 除;结果单位是目标币种的基本单位;负数照常换算 | 金额 + 单位;汇率 + 「报价币种/基准币种」 | — | 金额币种与汇率不对应 / 汇率 ≤ 0 / 单位非法 |
| `forward_cagr(eps_t, eps_t_plus_n, years=2)` | (EPS[T+n] ÷ EPS[T])^(1/n) − 1 | 元/股;years 1..10 整数 | 任一 EPS ≤ 0(跨零) | years 非法 / 缺失 |
| `growth_rate(current, base, label)` | current ÷ base − 1 | 同单位 | base ≤ 0 | 缺失 / 非数 |
| `ratio(numerator, denominator, label, unit_in)` | numerator ÷ denominator(毛利率 / 费用率 / 负债率 / 占比等同单位两数之比;0.3.1 新增,不做单位换算,unit_in 只留痕) | 同单位 | denominator ≤ 0 | 缺失 / 非数 |
| `peg(pe, cagr)` | PE ÷ (CAGR × 100) | 倍、小数 | PE ≤ 0;CAGR ≤ 0 | |cagr| > 5 |
| `pe_digestion_years(pe, cagr, anchor)` | ln(PE ÷ 锚) ÷ ln(1 + CAGR);**PE ≤ 锚 → ok 0 年,details.below_anchor=true** | 倍、小数、倍 | PE ≤ 0;CAGR ≤ 0(且 PE > 锚) | 锚 ≤ 0;|cagr| > 5 |
| `pe_digestion_scenarios(pe, cagr)` | 四锚 {景气延续 30, 中性减速 25, 周期重定级_上沿 22, 周期重定级_下沿 18} 各算一次 | 同上 | 全部无意义 | 任一情景 error |
| `percentile_rank(history, current, exclude_nonpositive=True)` | 历史中 ≤ 当前值的占比 × 100;非数 / 非有限 / 布尔 / ≤0 的历史值跳过并计数(details.skipped) | 数值列表 | 有效样本 < 20;当前值 ≤ 0 | history 非列表 / current 缺失或非有限 |
| `consensus_dispersion(low, mean, high)` | max ÷ min;details.range_over_mean = (max − min) ÷ mean | 元/股 | min ≤ 0 或 mean ≤ 0 | 不满足 low ≤ mean ≤ high;缺失 |
| `forward_vs_ttm_judgement(forward_cagr_value, ttm_yoy_value, tolerance_pp=10)` | 差值(百分点)→ `approx` / `forward_below` / `forward_above`(details.category / label) | 小数(|cagr| ≤ 5,|yoy| ≤ 20)、百分点 ≥ 0 | — | 越界 / 阈值 < 0 / 缺失 |

## 2. 序列类(series.py)

输入统一 `[{"period": "YYYY-MM-DD", "value": 数或 null}]`:period 严格匹配 `YYYY-MM-DD` 且为季末日(03-31 / 06-30 / 09-30 / 12-31);重复 period → error;value null = 缺失,非数 / 布尔 / 非有限 → error;`unit` 必须非空并原样随结果传递;`money=True`(财务金额序列,SOP 默认)时 unit 必须是金额单位(元 / 万元 / 亿元,美元 / 万美元 / 亿美元,港元 / 万港元 / 亿港元),否则 error;非金额序列(EPS 元/股)用 `money=False`。

| 函数 | 语义 | not_meaningful | error |
|---|---|---|---|
| `quarterize(cumulative, unit, money=False)` | 累计(YTD)→ 单季:Q1 = YTD;Qn = YTD(n) − YTD(n−1);上一期缺失 → 该季 value=null + reason;`value` = 可拆出的单季数;`details.series` 升序;`details.value_unit` | 无任何可拆分单季 | 空序列 / 格式 / 重复 / 非有限 / unit 空 |
| `latest_quarter(single_quarters, unit, money=False)` | 最新非空单季(value、unit 透传、details.period / quarter) | 无可用值 | 同上 |
| `ttm_sum(single_quarters, end_period, unit, money=False)` | 以 end 为末季的近 4 季和;**任一缺失即 not_meaningful(不拿 3 季冒充)** | 缺季 | 同上 / end_period 非法 |
| `ttm_yoy(single_quarters, end_period, unit, money=False)` | TTM(end) ÷ TTM(end − 4 季) − 1(小数);需 8 季连续;当期为负照实报告 | 缺季;基期 TTM ≤ 0 | 同上 |
| `qoq(single_quarters, end_period, unit, money=False)` | Q(end) ÷ Q(end − 1) − 1(小数);仅拐点 / 动量信号,**禁止当增速分母**(details.note) | 缺季;前季 ≤ 0 | 同上 |

### 2a. 按累计值推近四季(港美股,0.5.0 新增)

输入 `cumulative = [{"period": "起始日..截止日", "value": 数或 null}]`(同一字段,年初至今累计,含全年);期间按起止日期认,月数 = 天数 ÷ 30.44 四舍五入(52 / 53 周财年都落在 12 个月),不要求季末日,适合苹果这类不按自然季度的财年和只发半年报的港股。`end_period` 必须是 cumulative 里的一项。

| 函数 | 语义 | not_meaningful | error |
|---|---|---|---|
| `ttm_from_ytd(cumulative, end_period, unit, money=False)` | 当期是全年 → TTM = 全年;否则 TTM = 当期累计 + 上一财年 − 上年同期累计。上一财年按「截止日 = 当期起始日前一天、跨 12 个月」认,上年同期按「起始日 = 上一财年起始日、月数相同」认;details 带 method(full_year / ytd_bridge)、periods、values | 当期跨的不是 3 / 6 / 9 / 12 个月;缺上一财年或上年同期(或不唯一);相关累计值为 null | 格式 / 重复期间 / 截止日不晚于起始日 / end_period 不在序列里 / unit 非法 |
| `ttm_yoy_from_ytd(cumulative, end_period, unit, money=False)` | TTM(当期)÷ TTM(一年前同一期)− 1(小数),两个 TTM 都按 ttm_from_ytd 的规则算;需要往前两年的累计值 | 当期或基期 TTM 算不出;找不到一年前的同一期;基期 TTM ≤ 0 | 同上 |

## 3. 口径约定(与 SOP 对齐)

- 扣非×4 PE 的分子用腾讯 `total_market_cap`(亿元)或东财(元),分母用 `quarterize(net_profit_deducted_cum, unit=元, money=true)` → `latest_quarter(…, unit=元, money=true)`;**财务金额序列一律传 money=true**(非金额序列如 EPS 元/股 用 money=false);单位由函数归一,调用方不得自行换算。
- TTM 序列同理:`ttm_sum / ttm_yoy / qoq(…, unit=元, money=true)`。
- TTM 同比主用 `net_profit_parent_cum`(归母,与一致预期 EPS 同口径);扣非口径并列作交叉。
- 前瞻 CAGR:`eps_t` = FY T 一致预期均值,`eps_t_plus_n` = FY T+2 均值,`years=2`;T = 当前财年(Asia/Shanghai)。
- 分位:`percentile_rank(history={"history_csv": {raw_ref: baostock CSV, column: peTTM, where: {tradestatus: "1"}, date_column: date}}, current = pe_ttm)`。
- 港美股(0.5.0):财务只用按公告日筛过的累计值(`global_financials_pit` 的 `*_cum`),TTM 用 `ttm_from_ytd`、同比用 `ttm_yoy_from_ytd`(money=true,unit 照抄证据);不算扣非×4 PE 与单季环比。一致预期只有 FY T 与 T+1:前瞻 CAGR `years=1`,分歧度看 T+1。币种不同(如港股股价港元、财报人民币)时 `forward_pe` / `pe_ttm_from_parts` 带汇率,汇率与单位照抄 `fx_rates` 证据。分位用百度估值历史:`history_csv: {raw_ref: baidu_pe_history_3y 的 CSV, column: pe_ttm, where: {}, date_column: date}`,`current = pe_ttm_latest`。
- 判读阈值默认 10 个百分点,可配置;"锚"只用于消化年数,本产品不输出价格锚(红线)。

## 2b. 技术指标与筹码分布(indicators.py,0.3.0 新增;数值不解读)

| 函数 | 定义 | 输入 | not_meaningful | error |
|---|---|---|---|---|
| `technical_indicators(klines, ma=[5,10,20,60], ema=[12,26], macd=[12,26,9], rsi=[6,12,24], kdj=[9,3,3], boll=[20,2.0], min_points=30)` | 最新一根的 MA(简单均线)/ EMA(首值为种子,k=2/(n+1))/ MACD(dif=EMA12−EMA26,dea=EMA9(dif),hist=(dif−dea)×2)/ RSI(简单平均,无跌 → 100)/ KDJ(初值 50,RSV 按 n 日高低,高低同价 → 50)/ BOLL(总体标准差);value = 最新收盘价(单位随输入,不换算),全部指标在 details(ma/ema/macd/rsi/kdj/boll/points/window/params) | klines = 行列表 {date, open, high, low, close}(乱序自动按日期升序;重复日期 → error) | 行数 < min_points | 缺列 / 非数 / 非有限 / 重复日期 / 周期非法 |
| `chip_distribution(klines, grid_size=300, decay=1.0, min_points=20)` | 首日播种全部流通筹码,逐日按 turn/100×decay 衰减并按三角分布(峰在 (高+低+收)/3)注入;value = 获利比例(小数,= 成本 ≤ 现价的筹码占比);details:avg_cost / cost_90 / cost_70 / concentration_90 / concentration_70 / peak_price / days / window / cum_turnover_pct | klines = {date, high, low, close, turn}(turn 为百分数;应为前复权价并已剔除停牌日 —— 用 history_json.where) | 行数 < min_points | 价格非正 / turn 越界 / grid_size ∉ 50..2000 / decay ∉ (0,5] |

序列输入 `{"history_json": {raw_ref, rows_path, columns, where?}}`(cli.py):从 `<run-dir>/raw/` 加载 JSON / JSONP(取第一个 `{` 到最后一个 `}`),`rows_path` 点路径(`data.sz300308.qfqday`;数字段当列表下标),`columns` 把字段名映射到数组下标或对象键名(必须含 date),`where` 只对对象行生效;路径安全同 history_csv;身份 = {raw_ref, rows_path, columns, where, sha256, rows_used}。
典型:指标用 `fetch_kline` 的腾讯 fqkline raw(`rows_path: data.<sz|sh><code>.qfqday, columns: {date:0, open:1, close:2, high:3, low:4}`);筹码用 `bs_kline_qfq` 的 baostock extracted raw(`rows_path: rows, columns: {date,open,high,low,close,turn 同名}, where: {tradestatus: "1"}`)。

## 2c. 财报事件(earnings.py,0.4.0 新增;只描述过去,不预测)

| 函数 | 定义 | 输入 | not_meaningful | error |
|---|---|---|---|---|
| `earnings_reaction(klines, events, lookback=4)` | 反应日:盘前 / 盘中发布 → 发布日当天或之后的第一根日 K;盘后发布 → 发布日之后的第一根;涨跌 = 反应日收盘 ÷ 前一根收盘 − 1(小数,含当天大盘涨跌,不扣指数);几个事件落在同一反应日 → 合并为一次(id 用「 + 」连接);value = 最近一次之前、算得出的最多 lookback 次的平均绝对涨跌;details.reactions 从新到旧(每项是结果形,另带 ids / reaction_day / prev_day / gap_days / pending),details.latest_abs_over_mean = 最近一次的绝对涨跌 ÷ 平均(倍) | klines = {date, close}(应为复权价,乱序自动排);events = [{id, date, timing ∈ before_open / during / after_close}](1..40 个,id 不重复);lookback 1..12 | 此前算得出的 < 2 次(明细照给);单次:发布日之后还没有日 K(pending=true,反应待定)/ 反应日之前没有日 K;倍数:最近一次没算出 / 平均为 0 | klines < 2 根 / 缺列 / 重复日期;events 空 / 超 40 / id 重复 / timing 非法;lookback 越界 |
| `earnings_surprise(actual, estimate=None, low=None, high=None, unit="")` | (实际 − 预期) ÷ \|预期\|(小数);给了区间 → details.position = below / within / above + position_label(low = high 为单点预告,标签用「预告值」);没给预期 → 用区间中点(details.estimate_is_midpoint = true) | 实际与预期同单位,unit 只留痕不换算 | 预期 = 0 | 只给 low / high 之一;low > high;预期和区间都没给;非数 / 非有限 |

调用方:编排器 `earnings_brief` 视图。A 股定期报告的披露日是公告的正式日期(晚上发的记作次日),按 before_open 传;港美股按 Yahoo 发布时刻换算交易所当地时间判定,当地 00:00 视为时刻不明、不传。

## 4. 测试

`python -m pytest calc/tests -q --cov=calc`:fixture 均为人工手算常量(`tests/fixtures/formulas_cases.json`,含四锚消化年数固定期望),
覆盖:正常域 / 无意义域 / error 域 / 溢出与 NaN(递归扫描返回树 + 严格 JSON 序列化)/ 单位换算 / 百分数误传 / 年界 / 缺季 / 重复期 /
CLI 退出码 / 错误分类 / calculation_id 身份规则(键序、-0.0、实参、引用 DAG、CSV 内容、where)/ 序列文件加载与路径安全(相对 / 绝对 / symlink / raw 外)。
