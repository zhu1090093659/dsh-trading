"""确定性估值公式库(纯函数)。口径来源:研究宪法 §3(R6.5);精确契约见 SPEC.md。

约定:
- 所有函数返回 dict:{"status": "ok" | "not_meaningful" | "error", "value": 数值或 None, "unit": 单位,
  "reason": 说明(非 ok 时), "details": 中间量}。绝不抛出业务异常;返回树中任何位置都不会出现 inf / NaN(递归守卫)。
- 金额输入必须带单位:人民币 元 / 万元 / 亿元,美元 美元 / 万美元 / 亿美元,港元 港元 / 万港元 / 亿港元;内部归一到
  该币种的基本单位。两个金额币种不同又没给汇率 → error,不猜;未知单位 / 缺失 / 溢出 → error。
- 比率一律小数(0.25 = 25%);疑似百分数误传(|x| 超出业务合理域)→ error。
- 不做四舍五入;展示层自行格式化。
"""
from __future__ import annotations

import math
import re
from typing import Any, Iterable, Literal, Optional, overload

CALC_VERSION = "0.5.0"  # 0.5.0:金额单位支持美元 / 港元(币种不同须带汇率),新增 fx_convert / ttm_from_ytd / ttm_yoy_from_ytd,forward_pe 可带单位核对币种;0.4.0:新增 earnings.py(earnings_reaction / earnings_surprise);0.3.2:output 增 display 展示字符串(cli 层附加,公式层不变);0.3.1:ratio;0.3.0:新增 technical_indicators / chip_distribution 与 history_json 序列输入

UNIT_TO_YUAN = {"元": 1.0, "万元": 1e4, "亿元": 1e8}
# 金额单位 → (币种, 倍数)。人民币沿用「元」的写法,美元 / 港元按币种名写
MONEY_UNITS = {
    "元": ("CNY", 1.0), "万元": ("CNY", 1e4), "亿元": ("CNY", 1e8),
    "美元": ("USD", 1.0), "万美元": ("USD", 1e4), "亿美元": ("USD", 1e8),
    "港元": ("HKD", 1.0), "万港元": ("HKD", 1e4), "亿港元": ("HKD", 1e8),
}
BASE_UNIT = {"CNY": "元", "USD": "美元", "HKD": "港元"}
_AMOUNT_SUFFIX = {"CNY": "yuan", "USD": "usd", "HKD": "hkd"}
# 汇率单位写成「报价币种/基准币种」:CNY/HKD = 1 港元合多少人民币
_FX_UNIT_RE = re.compile(r"^(CNY|USD|HKD)/(CNY|USD|HKD)$")
MAX_ABS_CAGR = 5.0       # 年化增速 |x| > 500% 视为百分数误传
MAX_ABS_YOY = 20.0       # 同比 |x| > 2000% 视为误传(低基数极端情形仍在此内)
MAX_YEARS = 10


class CalcInputError(ValueError):
    """输入非法(缺失 / 单位未知 / 非有限数 / 越界),由各函数转为 status=error。"""


def _has_nonfinite(obj: Any) -> bool:
    """递归检查返回树中是否有 inf / NaN。"""
    if isinstance(obj, bool):
        return False
    if isinstance(obj, float):
        return not math.isfinite(obj)
    if isinstance(obj, dict):
        return any(_has_nonfinite(v) for v in obj.values())
    if isinstance(obj, (list, tuple)):
        return any(_has_nonfinite(v) for v in obj)
    return False


def _res(status: str, value: Optional[float] = None, unit: str = "", reason: str = "", **details) -> dict:
    """统一返回结构。value 或 details 任何位置出现 inf / NaN 一律转为 error,绝不伪装成结果。"""
    out = {"status": status, "value": value, "unit": unit, "reason": reason, "details": details}
    if _has_nonfinite(out):
        return {"status": "error", "value": None, "unit": unit,
                "reason": "结果或中间量出现非有限数(溢出 / NaN),输入量级或内容不合理", "details": {}}
    return out


def _err(reason: str, **details) -> dict:
    return _res("error", reason=reason, **details)


@overload
def _num(x: Any, name: str, required: Literal[True] = ...) -> float: ...
@overload
def _num(x: Any, name: str, required: bool) -> Optional[float]: ...
def _num(x: Any, name: str, required: bool = True) -> Optional[float]:
    """数值校验:None(required 时)/ 布尔 / 非数 / 非有限 → CalcInputError。"""
    if x is None:
        if required:
            raise CalcInputError(f"{name} 缺失")
        return None
    if isinstance(x, bool):
        raise CalcInputError(f"{name} 不能是布尔值")
    try:
        v = float(x)
    except (TypeError, ValueError) as e:
        raise CalcInputError(f"{name} 不是数值:{x!r}") from e
    if not math.isfinite(v):
        raise CalcInputError(f"{name} 不是有限数")
    return v


def _ratio(x: Any, name: str, max_abs: float) -> float:
    """比率(小数)校验;|x| > max_abs 视为百分数误传。"""
    v = _num(x, name)
    if abs(v) > max_abs:
        raise CalcInputError(f"{name}={v} 超出合理域(|x| ≤ {max_abs}),疑似把百分数当小数传入")
    return v


def _int_years(x: Any, name: str = "years") -> int:
    if isinstance(x, bool) or not isinstance(x, int):
        raise CalcInputError(f"{name} 必须是正整数")
    if x < 1 or x > MAX_YEARS:
        raise CalcInputError(f"{name} 必须在 1..{MAX_YEARS}")
    return x


def to_yuan(value: Any, unit: str, name: str = "金额") -> float:
    """金额归一到 元;缺失 / 非数 / 未知单位 / 溢出 → CalcInputError。"""
    v = _num(value, name)
    if unit not in UNIT_TO_YUAN:
        raise CalcInputError(f"{name} 单位 {unit!r} 不支持;只认 元 / 万元 / 亿元")
    y = v * UNIT_TO_YUAN[unit]
    if not math.isfinite(y):
        raise CalcInputError(f"{name} 换算为元后溢出")
    return y


def to_base(value: Any, unit: str, name: str = "金额") -> tuple:
    """金额归一到该币种的基本单位(元 / 美元 / 港元),返回 (数额, 币种);缺失 / 非数 / 未知单位 / 溢出 → CalcInputError。"""
    v = _num(value, name)
    if not isinstance(unit, str) or unit not in MONEY_UNITS:
        raise CalcInputError(f"{name} 单位 {unit!r} 不支持;只认 {' / '.join(MONEY_UNITS)}")
    ccy, scale = MONEY_UNITS[unit]
    y = v * scale
    if not math.isfinite(y):
        raise CalcInputError(f"{name} 换算后溢出")
    return y, ccy


def _finite(x: float, what: str) -> float:
    if not math.isfinite(x):
        raise CalcInputError(f"{what} 溢出")
    return x


def _fx(fx_rate: Any, fx_unit: Any) -> tuple:
    """汇率 + 单位「报价币种/基准币种」→ (rate, 报价币种, 基准币种)。汇率必须为正;两边币种不能相同。"""
    r = _num(fx_rate, "fx_rate")
    if r <= 0:
        raise CalcInputError("fx_rate 必须为正数")
    m = _FX_UNIT_RE.match(fx_unit) if isinstance(fx_unit, str) else None
    if not m or m.group(1) == m.group(2):
        raise CalcInputError(f"fx_unit {fx_unit!r} 非法;写成「报价币种/基准币种」,如 CNY/HKD(1 港元合多少人民币)")
    return r, m.group(1), m.group(2)


def _convert(amount: float, ccy: str, to_ccy: str, fx: tuple) -> float:
    """按汇率把 ccy 金额换成 to_ccy:金额是基准币种 → 乘;是报价币种 → 除。汇率对不上这两种币 → error。"""
    rate, quote, base = fx
    if ccy == base and to_ccy == quote:
        return _finite(amount * rate, "汇率换算")
    if ccy == quote and to_ccy == base:
        return _finite(amount / rate, "汇率换算")
    raise CalcInputError(f"汇率 {quote}/{base} 不能把 {ccy} 换成 {to_ccy}")


def _no_fx(fx_rate: Any, fx_unit: Any, why: str) -> None:
    if fx_rate is not None or fx_unit is not None:
        raise CalcInputError(why)


def _pe(mcap_value, cap_unit, denom_value, denom_unit, denom_label: str, scale: float = 1.0,
        fx_rate=None, fx_unit=None) -> dict:
    """PE 公共实现:总市值 ÷(分母金额 × scale),两者先归一到同一币种的基本单位。
    币种不同必须给汇率(分母换成市值的币种);币种相同却给了汇率 → error。市值 ≤ 0 或分母 ≤ 0 → not_meaningful;溢出 → error。
    明细键:人民币且没用汇率时沿用 mcap_yuan / denominator_yuan;其余按市值币种写 mcap_usd / mcap_hkd …,另带 currency。"""
    extra: dict = {}
    try:
        mcap, c_cap = to_base(mcap_value, cap_unit, "total_market_cap")
        d, c_den = to_base(denom_value, denom_unit, denom_label)
        if c_cap != c_den:
            if fx_rate is None and fx_unit is None:
                raise CalcInputError(f"总市值是 {c_cap}、{denom_label}是 {c_den},币种不同;先取汇率证据,"
                                     f"再传 fx_rate 与 fx_unit(如 {c_den}/{c_cap})")
            fx = _fx(fx_rate, fx_unit)
            extra = {"fx_rate": fx[0], "fx_unit": fx_unit, "denominator_original": d * scale,
                     "denominator_original_currency": c_den}
            d = _convert(d, c_den, c_cap, fx)
        else:
            _no_fx(fx_rate, fx_unit, "总市值与分母币种相同,不要传汇率")
        annual = _finite(d * scale, f"{denom_label}×{scale}")
    except CalcInputError as e:
        return _err(str(e))
    sfx = _AMOUNT_SUFFIX[c_cap]
    if c_cap != "CNY" or extra:
        extra["currency"] = c_cap
    if mcap <= 0:
        return _res("not_meaningful", unit="倍", reason="总市值 ≤ 0", **{f"mcap_{sfx}": mcap}, **extra)
    if annual <= 0:
        return _res("not_meaningful", unit="倍", reason=f"{denom_label} ≤ 0,PE 无意义",
                    **{f"mcap_{sfx}": mcap, f"denominator_{sfx}": annual}, **extra)
    try:
        v = _finite(mcap / annual, "PE")
    except CalcInputError as e:
        return _err(str(e))
    return _res("ok", v, "倍", **{f"mcap_{sfx}": mcap, f"denominator_{sfx}": annual}, denominator_label=denom_label, **extra)


def _amount_suffix(details: dict) -> str:
    return _AMOUNT_SUFFIX[details.get("currency", "CNY")]


# ---------------------------------------------------------------- PE 类
def pe_deducted_annualized(total_market_cap, cap_unit: str, latest_quarter_deducted_profit, profit_unit: str) -> dict:
    """扣非×4 年化 PE = 总市值 ÷ (最新单季扣非净利润 × 4)。单季扣非 ≤ 0 或市值 ≤ 0 → not_meaningful。"""
    out = _pe(total_market_cap, cap_unit, latest_quarter_deducted_profit, profit_unit, "最新单季扣非净利润", 4.0)
    if out["status"] == "ok":
        s = _amount_suffix(out["details"])
        out["details"][f"quarter_profit_{s}"] = out["details"][f"denominator_{s}"] / 4.0
        out["details"][f"annualized_profit_{s}"] = out["details"][f"denominator_{s}"]
    return out


def pe_ttm_from_parts(total_market_cap, cap_unit: str, ttm_profit, profit_unit: str, fx_rate=None, fx_unit=None) -> dict:
    """TTM PE = 总市值 ÷ 近 4 季净利和(与数据源 PE_TTM 交叉验证)。币种不同须带汇率。TTM ≤ 0 或市值 ≤ 0 → not_meaningful。"""
    out = _pe(total_market_cap, cap_unit, ttm_profit, profit_unit, "TTM 净利润", 1.0, fx_rate, fx_unit)
    if out["status"] == "ok":
        s = _amount_suffix(out["details"])
        out["details"][f"ttm_{s}"] = out["details"][f"denominator_{s}"]
    return out


def _price_currency(unit: Any, name: str, per_share: bool) -> str:
    """价格单位 元 / 美元 / 港元;每股单位再加「/股」。万 / 亿这类倍数单位不收(价格不会这么写)。"""
    if not isinstance(unit, str):
        raise CalcInputError(f"{name} 必须是字符串")
    if per_share != unit.endswith("/股"):
        raise CalcInputError(f"{name} {unit!r} 不对:{'每股收益写 元/股、美元/股、港元/股' if per_share else '价格写 元、美元、港元'}")
    base = unit[:-2] if per_share else unit
    if base not in MONEY_UNITS or MONEY_UNITS[base][1] != 1.0:
        raise CalcInputError(f"{name} {unit!r} 不支持;只认 元 / 美元 / 港元{'(加 /股)' if per_share else ''}")
    return MONEY_UNITS[base][0]


def forward_pe(price, eps_forecast, price_unit=None, eps_unit=None, fx_rate=None, fx_unit=None) -> dict:
    """前瞻 PE = 现价 ÷ 一致预期 EPS(FY T 均值)。给单位时核对币种,不同须带汇率(EPS 换成价格币种)。价格 ≤ 0 或 EPS ≤ 0 → not_meaningful。"""
    extra: dict = {}
    try:
        p, e = _num(price, "price"), _num(eps_forecast, "eps_forecast")
        e_used = e
        if (price_unit is None) != (eps_unit is None):
            raise CalcInputError("price_unit 与 eps_unit 要么都给、要么都不给")
        if price_unit is None:
            _no_fx(fx_rate, fx_unit, "传汇率时必须同时给 price_unit 与 eps_unit")
        else:
            pc = _price_currency(price_unit, "price_unit", False)
            ec = _price_currency(eps_unit, "eps_unit", True)
            extra = {"currency": pc, "price_unit": price_unit, "eps_unit": eps_unit}
            if pc != ec:
                if fx_rate is None and fx_unit is None:
                    raise CalcInputError(f"现价是 {pc}、EPS 是 {ec},币种不同;先取汇率证据,再传 fx_rate 与 fx_unit(如 {ec}/{pc})")
                fx = _fx(fx_rate, fx_unit)
                e_used = _convert(e, ec, pc, fx)
                extra.update(fx_rate=fx[0], fx_unit=fx_unit, eps_converted=e_used)
            else:
                _no_fx(fx_rate, fx_unit, "现价与 EPS 币种相同,不要传汇率")
    except CalcInputError as ex:
        return _err(str(ex))
    if p <= 0:
        return _res("not_meaningful", unit="倍", reason="价格 ≤ 0", price=p, **extra)
    if e_used <= 0:
        return _res("not_meaningful", unit="倍", reason="一致预期 EPS ≤ 0,前瞻 PE 无意义", eps=e, **extra)
    try:
        v = _finite(p / e_used, "前瞻 PE")
    except CalcInputError as ex:
        return _err(str(ex))
    return _res("ok", v, "倍", price=p, eps=e, **extra)


def fx_convert(value, unit: str, fx_rate, fx_unit: str) -> dict:
    """金额按汇率换到另一币种:fx_unit 写成「报价币种/基准币种」(CNY/HKD = 1 港元合多少人民币);
    金额是基准币种 → 乘,是报价币种 → 除。结果单位是目标币种的基本单位(元 / 美元 / 港元);负数照常换算。"""
    try:
        amt, ccy = to_base(value, unit, "value")
        fx = _fx(fx_rate, fx_unit)
        rate, quote, base = fx
        if ccy not in (quote, base):
            raise CalcInputError(f"金额币种 {ccy} 与汇率 {fx_unit} 不对应")
        to = quote if ccy == base else base
        out = _convert(amt, ccy, to, fx)
    except CalcInputError as e:
        return _err(str(e))
    return _res("ok", out, BASE_UNIT[to], from_amount=amt, from_currency=ccy, to_currency=to, fx_rate=rate, fx_unit=fx_unit)


# ---------------------------------------------------------------- 增速类
def forward_cagr(eps_t, eps_t_plus_n, years: int = 2) -> dict:
    """前瞻 CAGR = (EPS[T+n] ÷ EPS[T])^(1/n) − 1(默认 n=2,n 为 1..10 的整数)。任一 EPS ≤ 0(跨零)→ not_meaningful。结果为小数。"""
    try:
        a, b = _num(eps_t, "eps_t"), _num(eps_t_plus_n, "eps_t_plus_n")
        n = _int_years(years)
    except CalcInputError as ex:
        return _err(str(ex))
    if a <= 0 or b <= 0:
        return _res("not_meaningful", unit="小数", reason="起点或终点 EPS ≤ 0(跨零),年化增速无意义", eps_t=a, eps_t_plus_n=b)
    return _res("ok", (b / a) ** (1.0 / n) - 1.0, "小数", eps_t=a, eps_t_plus_n=b, years=n)


def growth_rate(current, base, label: str = "growth") -> dict:
    """通用增速 = current ÷ base − 1(小数)。base ≤ 0 → not_meaningful(负基数下的比率无意义);current 可为负。"""
    try:
        c, b = _num(current, "current"), _num(base, "base")
    except CalcInputError as ex:
        return _err(str(ex))
    if b <= 0:
        return _res("not_meaningful", unit="小数", reason=f"{label}:基期值 ≤ 0,增速无意义", current=c, base=b)
    return _res("ok", c / b - 1.0, "小数", current=c, base=b, label=label)


def ratio(numerator, denominator, label: str = "ratio", unit_in: str = "") -> dict:
    """通用比率 = numerator ÷ denominator(小数)。用于毛利率 / 费用率 / 负债率 / 占比等"同单位两数之比"。
    分母 ≤ 0 → not_meaningful(负或零分母下的比率无意义);分子可为负(亏损毛利为负照实)。
    unit_in 只作记录(两数必须同单位,由调用方保证并在 details 留痕);不做任何单位换算。"""
    try:
        n, d = _num(numerator, "numerator"), _num(denominator, "denominator")
    except CalcInputError as ex:
        return _err(str(ex))
    if d <= 0:
        return _res("not_meaningful", unit="小数", reason=f"{label}:分母 ≤ 0,比率无意义", numerator=n, denominator=d, unit_in=unit_in)
    return _res("ok", n / d, "小数", numerator=n, denominator=d, label=label, unit_in=unit_in)


# ---------------------------------------------------------------- 估值合成
def peg(pe, cagr) -> dict:
    """PEG = PE ÷ (CAGR × 100)。PE ≤ 0 或 CAGR ≤ 0 → not_meaningful;|CAGR| > 5 视为百分数误传 → error。"""
    try:
        p, g = _num(pe, "pe"), _ratio(cagr, "cagr", MAX_ABS_CAGR)
    except CalcInputError as ex:
        return _err(str(ex))
    if p <= 0:
        return _res("not_meaningful", unit="倍", reason="PE ≤ 0", pe=p, cagr=g)
    if g <= 0:
        return _res("not_meaningful", unit="倍", reason="CAGR ≤ 0,PEG 无意义", pe=p, cagr=g)
    return _res("ok", p / (g * 100.0), "倍", pe=p, cagr=g)


def pe_digestion_years(pe, cagr, anchor) -> dict:
    """PE 消化年数 = ln(PE ÷ 锚) ÷ ln(1 + CAGR)。
    PE ≤ 锚 → 0 年(已在锚下,details.below_anchor=True);PE ≤ 0 或 CAGR ≤ 0(且 PE > 锚)→ not_meaningful;
    锚 ≤ 0 → error;|CAGR| > 5 → error。"""
    try:
        p, g, a = _num(pe, "pe"), _ratio(cagr, "cagr", MAX_ABS_CAGR), _num(anchor, "anchor")
    except CalcInputError as ex:
        return _err(str(ex))
    if a <= 0:
        return _err("锚必须 > 0", anchor=a)
    if p <= 0:
        return _res("not_meaningful", unit="年", reason="PE ≤ 0", pe=p, anchor=a)
    if p <= a:
        return _res("ok", 0.0, "年", pe=p, cagr=g, anchor=a, below_anchor=True)
    if g <= 0:
        return _res("not_meaningful", unit="年", reason="CAGR ≤ 0,PE 永远消化不到锚", pe=p, cagr=g, anchor=a)
    return _res("ok", math.log(p / a) / math.log(1.0 + g), "年", pe=p, cagr=g, anchor=a, below_anchor=False)


ANCHOR_SCENARIOS = {"景气延续": 30.0, "中性减速": 25.0, "周期重定级_上沿": 22.0, "周期重定级_下沿": 18.0}


def pe_digestion_scenarios(pe, cagr) -> dict:
    """四锚(30 / 25 / 22 / 18)下的消化年数。返回 details.scenarios = {情景: 结果};任一情景 error 则整体 error。"""
    scen = {name: pe_digestion_years(pe, cagr, a) for name, a in ANCHOR_SCENARIOS.items()}
    if any(r["status"] == "error" for r in scen.values()):
        first = next(r for r in scen.values() if r["status"] == "error")
        return _err(first["reason"], scenarios=scen)
    ok_any = any(r["status"] == "ok" for r in scen.values())
    return _res("ok" if ok_any else "not_meaningful", None, "年",
                reason="" if ok_any else "所有情景均无意义(见 scenarios)", scenarios=scen, anchors=ANCHOR_SCENARIOS)


# ---------------------------------------------------------------- 分位与分歧
def percentile_rank(history: Iterable, current, exclude_nonpositive: bool = True) -> dict:
    """当前值在历史序列中的分位(0–100,百分比;= 历史中 ≤ 当前值的占比)。
    历史中非数 / 非有限值跳过并计数;默认剔除 ≤ 0 的历史值(亏损期 PE 无意义);有效样本 < 20 → not_meaningful。"""
    try:
        cur = _num(current, "current")
        if not isinstance(history, (list, tuple)):
            raise CalcInputError(f"history 必须是数值列表,收到 {type(history).__name__}")
    except CalcInputError as ex:
        return _err(str(ex))
    vals, skipped = [], 0
    for v in history:
        if isinstance(v, bool):
            skipped += 1
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not math.isfinite(fv) or (exclude_nonpositive and fv <= 0):
            skipped += 1
            continue
        vals.append(fv)
    n = len(vals)
    if n < 20:
        return _res("not_meaningful", unit="%", reason=f"有效历史样本 {n} < 20", n=n, skipped=skipped)
    if exclude_nonpositive and cur <= 0:
        return _res("not_meaningful", unit="%", reason="当前值 ≤ 0", n=n, skipped=skipped)
    le = sum(1 for v in vals if v <= cur)
    s = sorted(vals)
    med = s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    return _res("ok", 100.0 * le / n, "%", n=n, skipped=skipped, min=s[0], median=med, max=s[-1], current=cur)


def consensus_dispersion(low, mean, high) -> dict:
    """一致预期分歧:max ÷ min 与 (max − min) ÷ mean。要求 low ≤ mean ≤ high(否则 error);min ≤ 0 或 mean ≤ 0 → not_meaningful。"""
    try:
        lo, m, hi = _num(low, "low"), _num(mean, "mean"), _num(high, "high")
    except CalcInputError as ex:
        return _err(str(ex))
    if not (lo <= m <= hi):
        return _err("必须满足 low ≤ mean ≤ high", low=lo, mean=m, high=hi)
    if lo <= 0 or m <= 0:
        return _res("not_meaningful", reason="min 或 mean ≤ 0", low=lo, mean=m, high=hi)
    return _res("ok", hi / lo, "倍", low=lo, mean=m, high=hi, range_over_mean=(hi - lo) / m)


def forward_vs_ttm_judgement(forward_cagr_value, ttm_yoy_value, tolerance_pp=10.0) -> dict:
    """前瞻 CAGR 与 TTM 同比对照(研究宪法 §3 三档)。输入为小数;tolerance_pp 为百分点阈值(默认 10pp,可配置,≥ 0)。
    |差| ≤ 阈值 → approx;前瞻低于 TTM 超阈值 → forward_below;高于 → forward_above。value = 差值(百分点)。"""
    try:
        f = _ratio(forward_cagr_value, "forward_cagr_value", MAX_ABS_CAGR)
        t = _ratio(ttm_yoy_value, "ttm_yoy_value", MAX_ABS_YOY)
        tol = _num(tolerance_pp, "tolerance_pp")
    except CalcInputError as ex:
        return _err(str(ex))
    if tol < 0:
        return _err("tolerance_pp 必须 ≥ 0", tolerance_pp=tol)
    diff_pp = (f - t) * 100.0
    cat = "approx" if abs(diff_pp) <= tol else ("forward_below" if diff_pp < 0 else "forward_above")
    label = {"approx": "前瞻 ≈ TTM:增长已兑现,可信度高", "forward_below": "前瞻远低于 TTM:隐含大幅减速,需说明依据",
             "forward_above": "前瞻远高于 TTM:预期偏高风险,需在手订单/产能/业绩预告等额外证据"}[cat]
    return _res("ok", diff_pp, "百分点", category=cat, label=label, forward_cagr=f, ttm_yoy=t, tolerance_pp=tol)
