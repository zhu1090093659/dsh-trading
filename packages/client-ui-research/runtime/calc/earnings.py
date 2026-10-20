"""财报事件(0.4.0 新增):财报后第一个交易日的涨跌、实际 vs 预期的偏差。确定性纯函数,只给数值,
不解读方向、不预测、不出目标价;与其它 calc 函数同契约 {status, value, unit, reason, details}。

反应日的认定(和 himself65 的 earnings_reaction 同思路):市场第一次能对财报作出反应的那个交易日。
- 盘前 / 盘中发布 → 发布日当天或之后的第一根日 K;盘后发布 → 发布日之后的第一根日 K。
- A 股定期报告的「披露日」是公告的正式日期:晚上发的记作次日(例:2026-08-14 20:41 发、正式日期 2026-08-15),
  所以按「盘前」口径传正式日期即可。
- 发布日之后还没有日 K(比如今晚才发)→ 这一次 not_meaningful,details.pending = true(反应待定)。
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from datetime import date
from typing import Any, Dict

from calc.formulas import CalcInputError, _err, _num, _res
from calc.indicators import _day, _rows

TIMINGS = {"before_open": "盘前发布", "during": "盘中发布", "after_close": "盘后发布"}
MIN_PRIOR = 2
MAX_EVENTS = 40
POSITION_LABEL = {"below": "低于区间下限", "within": "落在区间内", "above": "高于区间上限"}
POINT_LABEL = {"below": "低于预告值", "within": "等于预告值", "above": "高于预告值"}


def _events(events) -> list[dict]:
    if not isinstance(events, (list, tuple)) or not events:
        raise CalcInputError("events 必须是非空列表 [{id, date, timing}]")
    if len(events) > MAX_EVENTS:
        raise CalcInputError(f"events 最多 {MAX_EVENTS} 个")
    out, seen = [], set()
    for i, e in enumerate(events):
        if not isinstance(e, dict):
            raise CalcInputError(f"events[{i}] 不是对象")
        eid = e.get("id")
        if not isinstance(eid, str) or not eid.strip() or len(eid) > 80:
            raise CalcInputError(f"events[{i}].id 必须是 1–80 字的字符串")
        if eid in seen:
            raise CalcInputError(f"events 有重复 id {eid!r}")
        seen.add(eid)
        timing = e.get("timing")
        if timing not in TIMINGS:
            raise CalcInputError(f"events[{i}].timing 必须是 {' / '.join(TIMINGS)} 之一,收到 {timing!r}")
        out.append({"id": eid, "date": _day(e.get("date"), f"events[{i}]"), "timing": timing})
    return out


def earnings_reaction(klines, events, lookback=4) -> dict:
    """财报后反应日的收盘涨跌,和此前 lookback 次的平均绝对涨跌对照。
    涨跌 = 反应日收盘 ÷ 前一根日 K 收盘 − 1(小数;日 K 应为复权价;当天大盘的涨跌没有扣除)。
    几个事件落在同一个反应日(例:年报和一季报同一天发)→ 合并成一次,不重复计数。
    value = 最近一次之前、算得出的 lookback 次的平均绝对涨跌;少于 2 次 → not_meaningful(明细照给)。
    details.reactions 从新到旧,每项是结果形 {status, value, unit, reason, …};
    details.latest_abs_over_mean = 最近一次的绝对涨跌 ÷ 平均(倍)。"""
    try:
        rows = _rows(klines, ("close",))
        evs = _events(events)
        if isinstance(lookback, bool) or not isinstance(lookback, int) or not 1 <= lookback <= 12:
            raise CalcInputError("lookback 必须是 1..12 的整数")
    except CalcInputError as ex:
        return _err(str(ex))
    if len(rows) < 2:
        return _err("klines 至少要 2 根")
    dates = [r["date"] for r in rows]

    groups: dict[str, dict] = {}
    singles: list[dict] = []
    for e in sorted(evs, key=lambda x: (x["date"], x["id"])):
        idx = bisect_right(dates, e["date"]) if e["timing"] == "after_close" else bisect_left(dates, e["date"])
        if idx >= len(rows):
            singles.append({"status": "not_meaningful", "value": None, "unit": "小数", "pending": True,
                            "reason": f"反应日还没到:K 线只到 {dates[-1]}(反应待定)",
                            "id": e["id"], "ids": [e["id"]], "date": e["date"], "events": [e],
                            "reaction_day": None, "prev_day": None, "prev_close": None, "close": None, "gap_days": None})
            continue
        if idx == 0:
            singles.append({"status": "not_meaningful", "value": None, "unit": "小数", "pending": False,
                            "reason": f"K 线不够早:反应日 {dates[0]} 之前没有日 K 可比",
                            "id": e["id"], "ids": [e["id"]], "date": e["date"], "events": [e],
                            "reaction_day": dates[0], "prev_day": None, "prev_close": None, "close": None, "gap_days": None})
            continue
        rd, prev = rows[idx], rows[idx - 1]
        g = groups.get(rd["date"])
        if g:
            g["events"].append(e)
            g["ids"].append(e["id"])
            g["id"] = " + ".join(g["ids"])
            continue
        groups[rd["date"]] = {
            "status": "ok", "value": rd["close"] / prev["close"] - 1.0, "unit": "小数", "reason": "", "pending": False,
            "id": e["id"], "ids": [e["id"]], "date": e["date"], "events": [e],
            "reaction_day": rd["date"], "prev_day": prev["date"], "prev_close": prev["close"], "close": rd["close"],
            "gap_days": (date.fromisoformat(rd["date"]) - date.fromisoformat(e["date"])).days,
        }

    reactions = sorted([*groups.values(), *singles], key=lambda r: (r["date"], r["id"]), reverse=True)
    latest = reactions[0]
    prior = [r for r in reactions[1:] if r["status"] == "ok"][:lookback]
    n = len(prior)
    mean = sum(abs(r["value"]) for r in prior) / n if n else None
    if latest["status"] != "ok":
        ratio = {"status": "not_meaningful", "value": None, "unit": "倍", "reason": "最近一次没有算出涨跌"}
    elif mean is None or n < MIN_PRIOR:
        ratio = {"status": "not_meaningful", "value": None, "unit": "倍", "reason": f"此前算得出的只有 {n} 次,少于 {MIN_PRIOR} 次不比"}
    elif mean == 0:
        ratio = {"status": "not_meaningful", "value": None, "unit": "倍", "reason": "此前平均绝对涨跌为 0"}
    else:
        ratio = {"status": "ok", "value": abs(latest["value"]) / mean, "unit": "倍", "reason": ""}
    details = {
        "reactions": reactions, "latest_id": latest["id"], "prior_ids": [r["id"] for r in prior], "prior_n": n,
        "lookback": lookback, "latest_abs_over_mean": ratio,
        "bars": {"first": dates[0], "last": dates[-1], "count": len(dates)},
        "note": "涨跌 = 反应日收盘 ÷ 前一交易日收盘 − 1,含当天大盘涨跌;只描述过去,不预测下一次",
    }
    if n < MIN_PRIOR:
        return _res("not_meaningful", unit="小数", reason=f"此前算得出的只有 {n} 次,少于 {MIN_PRIOR} 次不算平均", **details)
    return _res("ok", mean, "小数", **details)


def earnings_surprise(actual, estimate=None, low=None, high=None, unit="") -> dict:
    """实际 vs 预期:偏差 = (实际 − 预期) ÷ |预期|(小数)。给了区间 [low, high] 时另报实际落在区间的哪一边
    (details.position = below / within / above;low = high 时是单点预告)。
    预期缺省且给了区间 → 用区间中点(details.estimate_is_midpoint = true)。预期 = 0 → not_meaningful。
    只给 low / high 之一、low > high、预期和区间都没给 → error。unit 只留痕:实际与预期必须同单位,不做换算。"""
    try:
        a = _num(actual, "actual")
        est = _num(estimate, "estimate", required=False)
        lo = _num(low, "low", required=False)
        hi = _num(high, "high", required=False)
        if (lo is None) != (hi is None):
            raise CalcInputError("low 和 high 要么都给,要么都不给")
        band = (lo, hi) if lo is not None and hi is not None else None
        if band is not None and band[0] > band[1]:
            raise CalcInputError(f"low={lo} 大于 high={hi}")
        midpoint = est is None
        if est is None:
            if band is None:
                raise CalcInputError("estimate 和区间 [low, high] 至少给一个")
            est = (band[0] + band[1]) / 2.0
        if not isinstance(unit, str):
            raise CalcInputError("unit 必须是字符串")
    except CalcInputError as ex:
        return _err(str(ex))
    details: Dict[str, Any] = {"actual": a, "estimate": est, "estimate_is_midpoint": midpoint, "difference": a - est,
                               "low": lo, "high": hi, "unit_in": unit}
    if band is not None:
        pos = "below" if a < band[0] else "above" if a > band[1] else "within"
        point = band[0] == band[1]
        details.update(position=pos, point=point, position_label=(POINT_LABEL if point else POSITION_LABEL)[pos])
    if est == 0:
        return _res("not_meaningful", unit="小数", reason="预期为 0,偏差比例无意义", **details)
    return _res("ok", (a - est) / abs(est), "小数", **details)
