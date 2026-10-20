# 确定性估值计算库

状态:已实现(Phase 0)。纯函数 + fixture 测试;agent 只选输入、解释输出,计算由代码完成,可复算可审计。

| 文件 | 作用 |
|---|---|
| `formulas.py` | 扣非×4 PE / 前瞻 PE / TTM PE 拼装(币种不同带汇率)/ 汇率换算 / 前瞻 CAGR / 通用增速 / PEG / PE 消化年数(单锚 + 四锚情景)/ 历史分位 / 一致预期分歧 / 前瞻 vs TTM 判读 |
| `earnings.py` | 财报后反应日涨跌与此前平均对照(earnings_reaction)/ 实际 vs 预期偏差,含业绩预告区间落点(earnings_surprise) |
| `series.py` | 报告期累计值 → 单季(quarterize)/ 最新单季 / TTM 求和 / TTM 同比 / 环比;按「起..止」累计值推近四季与同比(港美股) |
| `cli.py` | 唯一调用入口:`python3 calc/cli.py <function> --args '<JSON>' [--evidence ev-…] [--calc calc-…] [--run-dir DIR]`;输出带确定性 `calculation_id`(含实参、引用 DAG、序列文件 sha256)、`inputs_refs`、`inputs_resolved`;严格 JSON(无 NaN);退出码 0 / 2 / 3,错误分类 bad_args / bad_refs / bad_input / internal_error |
| `SPEC.md` | 函数契约:输入单位、无意义域、error 域、口径约定 |
| `tests/` | pytest;`python -m pytest calc/tests -q --cov=calc` |

原则:金额必须带单位(元 / 万元 / 亿元,美元、港元同理)由库归一,币种不同必须带汇率;比率一律小数;绝不返回 inf / NaN;无意义域返回 `not_meaningful` 而不是伪装成数。

## 0.5.0(随 Vibe-Research v2.1.0 发布):港美股的币种与财年

- 金额单位支持美元 / 港元(`美元 / 万美元 / 亿美元`、`港元 / 万港元 / 亿港元`),display 同样按量级换算。
- 两个金额币种不同必须传汇率 `fx_rate` + `fx_unit`(「报价币种/基准币种」,如 `CNY/HKD`);不给就报错,不猜。`forward_pe` 新增可选 `price_unit` / `eps_unit` 核对币种;`pe_ttm_from_parts` 可带汇率;新增 `fx_convert`。
- 新增 `ttm_from_ytd` / `ttm_yoy_from_ytd`:期间写「起始日..截止日」,按上一财年与上年同期的累计值推近四季,适合不按自然季度的财年(苹果 FY 截止 9 月)与只发半年报的港股。
- 测试:`calc/tests/test_currency_ttm.py`。

## 0.4.0(2026-10-08):财报事件

`earnings_reaction` / `earnings_surprise`(`calc/earnings.py`):按发布时刻认反应日(盘前 / 盘中当天、盘后次日),反应日收盘 ÷ 前一交易日收盘 − 1,同一天的合并算一次,和此前最多 lookback 次的平均绝对涨跌对照;实际 vs 预期的偏差,给了业绩预告区间时另报落在哪一边。只描述过去,不预测。测试:`calc/tests/test_earnings.py`。

## 0.3.2(2026-08-22):展示层 `display`

`cli.py` 在记录落盘前给 `output` 附 `display` 字符串(`calc/display.py`,确定性、无 locale):|x|≥1 留 2 位小数、|x|<1 留 4 位有效数字(0.6328580 → "0.6329",小数不只留 2 位免得丢信息;舍入误差都在编排器数字绑定容差内);`小数` → 百分比("200.42%");金额按量级换算("204.53 亿元" / "3.25 万元" / "943.00 元");`期` 取整;status ≠ ok 时为 `null`。报告正文照抄 `display`,不让 agent 对 15 位浮点做心算;`value` 仍是复算 / 绑定校验的真理源,公式层依旧不四舍五入。

## 0.3.0(2026-08-22):技术指标与筹码分布进 calc

`technical_indicators` / `chip_distribution`(`calc/indicators.py`)+ CLI 序列输入 `history_json`(读 raw 的 JSON / JSONP K 线表,含数组行 / 对象行 / where 过滤,路径安全与身份规则同 `history_csv`)。取数层不再计算派生量;这两类数值从此经 calc 记 DAG。测试:`calc/tests/test_indicators.py`。
