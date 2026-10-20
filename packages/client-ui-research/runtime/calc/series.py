"""报告期序列处理(纯函数):累计值 → 单季、最新单季、TTM 求和、TTM 同比、环比。

输入统一为 [{"period": "YYYY-MM-DD", "value": 数值或 null}] 列表(同一字段、同一单位,顺序任意):
- period 必须严格匹配 YYYY-MM-DD 且为季末日(03-31 / 06-30 / 09-30 / 12-31),否则 error;重复 period → error(不静默取舍)。
- value 为 null 表示该期缺失;非数 / 布尔 / 非有限 → error。
- unit 必须非空并原样随结果传递;money=True 时(财务金额序列,SOP 默认)unit 必须是金额单位(元 / 万元 / 亿元,
  美元 / 万美元 / 亿美元,港元 / 万港元 / 亿港元),非金额序列(如 EPS 元/股)用 money=False;下游金额运算由 formulas 按 unit 归一。
- 港美股财年不一定按自然季度:ttm_from_ytd / ttm_yoy_from_ytd 的 period 写「起始日..截止日」,按起止日期认期间。
所有函数返回 dict{status, value, unit, reason, details};序列类结果放 details.series。
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Optional

from .formulas import MONEY_UNITS, CalcInputError, _err, _num, _res

QUARTER_END = {(3, 31): 1, (6, 30): 2, (9, 30): 3, (12, 31): 4}
_PERIOD_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_period(p) -> tuple[date, int]:
    if not isinstance(p, str) or not _PERIOD_RE.match(p):
        raise CalcInputError(f"period {p!r} 不是严格的 YYYY-MM-DD")
    try:
        d = date.fromisoformat(p)
    except ValueError as e:
        raise CalcInputError(f"period {p!r} 不是合法日期") from e
    q = QUARTER_END.get((d.month, d.day))
    if q is None:
        raise CalcInputError(f"period {p!r} 不是季末日(03-31/06-30/09-30/12-31)")
    return d, q


def _prev_quarter_end(d: date) -> date:
    if d.month == 3:
        return date(d.year - 1, 12, 31)
    if d.month == 6:
        return date(d.year, 3, 31)
    if d.month == 9:
        return date(d.year, 6, 30)
    return date(d.year, 9, 30)


def _quarter_ends_back(d: date, n: int) -> list[date]:
    out, cur = [], d
    for _ in range(n):
        out.append(cur)
        cur = _prev_quarter_end(cur)
    return out


def _check_unit(unit, money: bool = False) -> str:
    """unit 必须非空;money=True 时必须是金额单位(元 / 万元 / 亿元),供财务金额序列在进入 PE 之前就被拦截。"""
    if not isinstance(unit, str) or not unit.strip():
        raise CalcInputError("unit 必须是非空字符串")
    if money and unit not in MONEY_UNITS:
        raise CalcInputError(f"金额序列 unit {unit!r} 不支持;只认 {' / '.join(MONEY_UNITS)}")
    return unit


def _series_map(items, name: str) -> dict:
    """[{period, value}] → {date: value|None};校验格式、重复、有限性。"""
    if not isinstance(items, (list, tuple)):
        raise CalcInputError(f"{name} 必须是列表")
    m: dict = {}
    for item in items:
        if not isinstance(item, dict) or "period" not in item:
            raise CalcInputError(f"{name} 元素必须是含 period 的对象:{item!r}")
        d, _ = _parse_period(item["period"])
        if d in m:
            raise CalcInputError(f"{name} 报告期重复:{item['period']}")
        m[d] = _num(item.get("value"), f"{name}[{item['period']}].value", required=False)
    return m


def quarterize(cumulative: list, unit: str = "元", money: bool = False) -> dict:
    """报告期累计值(YTD)→ 单季值。Q1 = YTD;Qn = YTD(n) − YTD(n−1)。
    上一报告期缺失 → 该季 value=null 并记 reason(不猜);输出按 period 升序;value = 可拆出的单季数。"""
    try:
        u = _check_unit(unit, money)
        parsed = _series_map(cumulative, "cumulative")
    except CalcInputError as e:
        return _err(f"输入无效:{e}")
    if not parsed:
        return _err("空序列")
    series = []
    for d in sorted(parsed):
        ytd = parsed[d]
        q = QUARTER_END[(d.month, d.day)]
        if ytd is None:
            series.append({"period": d.isoformat(), "quarter": q, "value": None, "reason": "累计值缺失"})
            continue
        if q == 1:
            series.append({"period": d.isoformat(), "quarter": 1, "value": ytd})
            continue
        prev = _prev_quarter_end(d)
        pv = parsed.get(prev)
        if pv is None:
            series.append({"period": d.isoformat(), "quarter": q, "value": None,
                           "reason": f"上一报告期 {prev.isoformat()} 累计值缺失,无法拆单季"})
        else:
            series.append({"period": d.isoformat(), "quarter": q, "value": ytd - pv})
    n_ok = sum(1 for s in series if s["value"] is not None)
    return _res("ok" if n_ok else "not_meaningful", n_ok, "期", reason="" if n_ok else "无任何可拆分单季",
                series=series, value_unit=u)


def latest_quarter(single_quarters: list, unit: str = "元", money: bool = False) -> dict:
    """取序列里最新一季的单季值;unit 原样返回供下游金额运算使用。
    🔴 最新一季是空的(比如上一期累计值缺失、拆不出单季)就是不知道,返回 not_meaningful ——
       不往回找上一个有值的季度:那会把旧季度当最新,下游年化市盈率照算(第四轮审计 B1)。"""
    try:
        u = _check_unit(unit, money)
        m = _series_map(single_quarters, "single_quarters")
    except CalcInputError as e:
        return _err(f"输入无效:{e}")
    if not m:
        return _res("not_meaningful", unit=u, reason="无可用单季值")
    d = max(m)
    v = m[d]
    if v is None:
        return _res("not_meaningful", unit=u, reason=f"最新一季 {d.isoformat()} 单季值缺失,不拿更早的季度顶替",
                    period=d.isoformat(), quarter=QUARTER_END[(d.month, d.day)])
    return _res("ok", v, u, period=d.isoformat(), quarter=QUARTER_END[(d.month, d.day)])


def ttm_sum(single_quarters: list, end_period: str, unit: str = "元", money: bool = False) -> dict:
    """以 end_period 为最后一季的近 4 季单季和。4 季任一缺失 → not_meaningful(不拿 3 季冒充)。"""
    try:
        u = _check_unit(unit, money)
        m = _series_map(single_quarters, "single_quarters")
        end, _ = _parse_period(end_period)
    except CalcInputError as e:
        return _err(f"输入无效:{e}")
    periods = _quarter_ends_back(end, 4)
    vals = [m.get(p) for p in periods]
    known = [v for v in vals if v is not None]
    if len(known) < len(vals):
        missing = [p.isoformat() for p, v in zip(periods, vals) if v is None]
        return _res("not_meaningful", unit=u, reason=f"近 4 季缺失 {missing}", periods=[p.isoformat() for p in periods])
    return _res("ok", sum(known), u, periods=[p.isoformat() for p in periods], values=vals)


def ttm_yoy(single_quarters: list, end_period: str, unit: str = "元", money: bool = False) -> dict:
    """TTM 同比 = TTM(end) ÷ TTM(end − 4 季) − 1(小数)。需 8 季连续;基期 TTM ≤ 0 → not_meaningful。"""
    cur = ttm_sum(single_quarters, end_period, unit, money)
    if cur["status"] != "ok":
        return _res(cur["status"], unit="小数", reason=f"当期 TTM:{cur['reason']}", current=cur)
    end, _ = _parse_period(end_period)
    base_end = _quarter_ends_back(end, 5)[-1]
    base = ttm_sum(single_quarters, base_end.isoformat(), unit, money)
    if base["status"] != "ok":
        return _res(base["status"], unit="小数", reason=f"基期 TTM:{base['reason']}", current=cur, base=base)
    if base["value"] <= 0:
        return _res("not_meaningful", unit="小数", reason="基期 TTM ≤ 0,同比无意义", current=cur, base=base)
    return _res("ok", cur["value"] / base["value"] - 1.0, "小数", current=cur, base=base)


def qoq(single_quarters: list, end_period: str, unit: str = "元", money: bool = False) -> dict:
    """环比 = Q(end) ÷ Q(end−1) − 1(小数)。只作拐点 / 动量信号,禁止当增速分母。前一季 ≤ 0 → not_meaningful。"""
    try:
        _check_unit(unit, money)
        m = _series_map(single_quarters, "single_quarters")
        end, _ = _parse_period(end_period)
    except CalcInputError as e:
        return _err(f"输入无效:{e}")
    prev = _prev_quarter_end(end)
    c, p = m.get(end), m.get(prev)
    if c is None or p is None:
        return _res("not_meaningful", unit="小数", reason="当季或前季缺失", end=end.isoformat(), prev=prev.isoformat())
    if p <= 0:
        return _res("not_meaningful", unit="小数", reason="前季 ≤ 0,环比无意义", current=c, prev=p)
    return _res("ok", c / p - 1.0, "小数", current=c, prev=p, note="拐点/动量信号,不作增速分母")


# ---------------------------------------------------------------- 按累计值算近四季(港美股)
_SPAN_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$")
YTD_MONTHS = (3, 6, 9)


def _parse_span(p, name: str = "period") -> tuple:
    """「起始日..截止日」→ (起, 止, 月数);月数 = 天数 ÷ 30.44 四舍五入(52 / 53 周财年都落在 12)。"""
    m = _SPAN_RE.match(p) if isinstance(p, str) else None
    if not m:
        raise CalcInputError(f"{name} {p!r} 不是「起始日..截止日」(YYYY-MM-DD..YYYY-MM-DD)")
    try:
        s, e = date.fromisoformat(m.group(1)), date.fromisoformat(m.group(2))
    except ValueError as ex:
        raise CalcInputError(f"{name} {p!r} 不是合法日期") from ex
    if e <= s:
        raise CalcInputError(f"{name} {p!r} 的截止日不晚于起始日")
    return s, e, round(((e - s).days + 1) / 30.44)


def _span_map(items, name: str) -> dict:
    """[{period: "起..止", value}] → {(起, 止): (月数, value|None)};校验格式、重复、有限性。"""
    if not isinstance(items, (list, tuple)):
        raise CalcInputError(f"{name} 必须是列表")
    m: dict = {}
    for item in items:
        if not isinstance(item, dict) or "period" not in item:
            raise CalcInputError(f"{name} 元素必须是含 period 的对象:{item!r}")
        s, e, months = _parse_span(item["period"], f"{name} 的 period")
        if (s, e) in m:
            raise CalcInputError(f"{name} 期间重复:{item['period']}")
        m[(s, e)] = (months, _num(item.get("value"), f"{name}[{item['period']}].value", required=False))
    return m


def _span(key: tuple) -> str:
    return f"{key[0].isoformat()}..{key[1].isoformat()}"


def _ttm_at(m: dict, key: tuple, unit: str) -> tuple:
    """近四季合计 = 当期累计 + 上一完整财年 − 上年同期累计;当期本身是全年 → 就是全年。
    返回 (结果 dict, 一年前那一期的键 | None)。上一财年按「截止日 = 当期起始日前一天、跨 12 个月」认,
    上年同期按「起始日 = 上一财年起始日、月数相同」认;找不到或不唯一 → not_meaningful,不拿别的期凑。"""
    months, cur = m[key]
    if cur is None:
        return _res("not_meaningful", unit=unit, reason=f"{_span(key)} 累计值缺失"), None
    fy = [k for k in m if k[1] == key[0] - timedelta(days=1) and m[k][0] == 12]
    if months == 12:
        return _res("ok", cur, unit, method="full_year", periods={"current": _span(key)}), (fy[0] if len(fy) == 1 else None)
    if months not in YTD_MONTHS:
        return _res("not_meaningful", unit=unit, reason=f"{_span(key)} 跨 {months} 个月,不是 3 / 6 / 9 / 12 个月的累计期"), None
    if len(fy) != 1:
        return _res("not_meaningful", unit=unit,
                    reason=f"缺上一完整财年(截止 {(key[0] - timedelta(days=1)).isoformat()}、跨 12 个月)" if not fy else "上一财年不唯一"), None
    same = [k for k in m if k[0] == fy[0][0] and m[k][0] == months]
    if len(same) != 1:
        return _res("not_meaningful", unit=unit,
                    reason=f"缺上年同期累计(自 {fy[0][0].isoformat()} 起 {months} 个月)" if not same else "上年同期不唯一"), None
    fv, sv = m[fy[0]][1], m[same[0]][1]
    if fv is None or sv is None:
        return _res("not_meaningful", unit=unit, reason="上一财年或上年同期累计值缺失"), None
    return _res("ok", cur + fv - sv, unit, method="ytd_bridge",
                periods={"current": _span(key), "prior_full_year": _span(fy[0]), "prior_same_period": _span(same[0])},
                values={"current": cur, "prior_full_year": fv, "prior_same_period": sv},
                formula="当期累计 + 上一财年 − 上年同期累计"), same[0]


def ttm_from_ytd(cumulative: list, end_period: str, unit: str = "元", money: bool = False) -> dict:
    """按累计值(年初至今,含全年)算近四季合计,期间写「起始日..截止日」,适合不按自然季度的财年和半年报公司。
    TTM = 当期累计 + 上一财年 − 上年同期累计;当期是全年则 TTM = 全年。缺期 → not_meaningful。"""
    try:
        u = _check_unit(unit, money)
        m = _span_map(cumulative, "cumulative")
        s, e, _ = _parse_span(end_period, "end_period")
    except CalcInputError as ex:
        return _err(f"输入无效:{ex}")
    if (s, e) not in m:
        return _err(f"输入无效:end_period {end_period} 不在 cumulative 里")
    out, _prev = _ttm_at(m, (s, e), u)
    if out["status"] == "ok":
        out["details"]["end_period"] = end_period
    return out


def ttm_yoy_from_ytd(cumulative: list, end_period: str, unit: str = "元", money: bool = False) -> dict:
    """近四季同比 = TTM(当期)÷ TTM(一年前同一期)− 1(小数),两个 TTM 都按 ttm_from_ytd 的规则算;
    需要往前两年的累计值。基期 TTM ≤ 0 → not_meaningful。"""
    try:
        u = _check_unit(unit, money)
        m = _span_map(cumulative, "cumulative")
        s, e, _ = _parse_span(end_period, "end_period")
    except CalcInputError as ex:
        return _err(f"输入无效:{ex}")
    if (s, e) not in m:
        return _err(f"输入无效:end_period {end_period} 不在 cumulative 里")
    cur, prev_key = _ttm_at(m, (s, e), u)
    if cur["status"] != "ok":
        return _res(cur["status"], unit="小数", reason=f"当期 TTM:{cur['reason']}", current=cur)
    if prev_key is None:
        return _res("not_meaningful", unit="小数", reason="找不到一年前的同一期", current=cur)
    base, _ = _ttm_at(m, prev_key, u)
    if base["status"] != "ok":
        return _res(base["status"], unit="小数", reason=f"基期 TTM:{base['reason']}", current=cur, base=base)
    if base["value"] <= 0:
        return _res("not_meaningful", unit="小数", reason="基期 TTM ≤ 0,同比无意义", current=cur, base=base)
    return _res("ok", cur["value"] / base["value"] - 1.0, "小数", current=cur, base=base,
                end_period=end_period, base_period=_span(prev_key))
