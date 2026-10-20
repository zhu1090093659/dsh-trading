"""技术指标与筹码分布(Phase 1 M2-calc 迁移):确定性纯函数,输入为 K 线行列表(由 cli.py 的 history_json 从 raw/ 确定性加载并记 sha256),
输出与其它 calc 函数同契约 {status, value, unit, reason, details}。不做任何解读(方向 / 买卖信号),只给数值。
算法与 a-stock-data / global-stock-data SKILL.md 的参考实现一致:MA 简单均线;EMA 以首值为种子、k=2/(n+1);MACD dif=EMA12−EMA26,dea=EMA9(dif),hist=(dif−dea)×2;
RSI 简单平均(非 Wilder);KDJ 初值 50、RSV 按 n 日高低;BOLL 总体标准差;筹码分布 = 首日播种全部流通筹码 + 逐日按换手率 × decay 衰减并按三角分布注入。"""
from __future__ import annotations

import math
import re
from datetime import date
from typing import Any, Dict, Optional

from calc.formulas import CalcInputError, _err, _num, _res

MIN_POINTS = 30
_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$")  # 可选时间后缀必须是真正的时间(时分秒范围受限;时区只接受 ±HH:MM)


def _day(s, where: str) -> str:
    """日期必须是 YYYY-MM-DD(可带时间后缀,只取日)且为真实日历日;否则 error。"""
    m = _DATE_RE.match(str(s or "").strip())
    if not m:
        raise CalcInputError(f"{where} 日期格式非法:{s!r}(须 YYYY-MM-DD)")
    y, mo, d = (int(x) for x in m.groups())
    try:
        date(y, mo, d)
    except ValueError as ex:
        raise CalcInputError(f"{where} 日期不存在:{s!r}") from ex
    return f"{y:04d}-{mo:02d}-{d:02d}"


def _rows(klines, need: tuple, name: str = "klines", optional: tuple = ()) -> list[dict]:
    """行校验:need 列必填;optional 列出现(非空)时同样校验数值 / 正价 / OHLC 自洽。"""
    if not isinstance(klines, (list, tuple)) or not klines:
        raise CalcInputError(f"{name} 必须是非空的 K 线行列表")
    out = []
    for i, r in enumerate(klines):
        if not isinstance(r, dict):
            raise CalcInputError(f"{name}[{i}] 不是对象")
        if r.get("date") in (None, ""):
            raise CalcInputError(f"{name}[{i}] 缺 date")
        row: Dict[str, Any] = {"date": _day(r.get("date"), f"{name}[{i}]")}
        present_opt = tuple(k for k in optional if r.get(k) not in (None, ""))
        for k in need + present_opt:
            v = r.get(k)
            if v is None or v == "" or isinstance(v, bool):
                raise CalcInputError(f"{name}[{i}]({row['date']})缺 {k}")
            try:
                fv = float(v)
            except (TypeError, ValueError) as ex:
                raise CalcInputError(f"{name}[{i}]({row['date']}){k} 非数:{v!r}") from ex
            if not math.isfinite(fv):
                raise CalcInputError(f"{name}[{i}]({row['date']}){k} 非有限数")
            row[k] = fv
        # 输入域:价格为正;OHLC 自洽(high ≥ low;open / close 在 [low, high] 内)—— 列映射错误或坏数据不得伪装成有效指标
        for k in need + present_opt:
            if k in ("open", "high", "low", "close") and row[k] <= 0:
                raise CalcInputError(f"{name}[{i}]({row['date']}){k} 须为正:{row[k]}")
        if "high" in row and "low" in row:
            if row["high"] < row["low"]:
                raise CalcInputError(f"{name}[{i}]({row['date']})high < low")
            for k in ("open", "close"):
                if k in row and not (row["low"] <= row[k] <= row["high"]):
                    raise CalcInputError(f"{name}[{i}]({row['date']}){k} 不在 [low, high] 内")
        out.append(row)
    out.sort(key=lambda x: x["date"])
    for a, b in zip(out, out[1:]):
        if a["date"] == b["date"]:
            raise CalcInputError(f"{name} 有重复日期 {a['date']}")
    return out


def _int_list(v, name: str, lo: int = 1, hi: int = 500) -> list[int]:
    if not isinstance(v, (list, tuple)) or not v:
        raise CalcInputError(f"{name} 必须是非空整数列表")
    out = []
    for x in v:
        if isinstance(x, bool) or not isinstance(x, int) or not (lo <= x <= hi):
            raise CalcInputError(f"{name} 含非法周期 {x!r}(须为 {lo}..{hi} 的整数)")
        out.append(x)
    return out


def _ema(values: list[float], period: int) -> list[float]:
    out = [values[0]]
    k = 2.0 / (period + 1)
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def technical_indicators(klines, ma=(5, 10, 20, 60), ema=(12, 26), macd=(12, 26, 9), rsi=(6, 12, 24), kdj=(9, 3, 3), boll=(20, 2.0), min_points: int = MIN_POINTS) -> dict:
    """最新一根的 MA / EMA / MACD / RSI / KDJ / BOLL。value = 最新收盘价(单位随输入,不换算);全部指标在 details。K 线少于 min_points → not_meaningful。"""
    try:
        rows = _rows(klines, ("open", "high", "low", "close"))
        ma_p = _int_list(ma, "ma")
        ema_p = _int_list(ema, "ema")
        macd_p = _int_list(macd, "macd")
        rsi_p = _int_list(rsi, "rsi")
        kdj_p = _int_list(kdj, "kdj")
        if len(macd_p) != 3 or len(kdj_p) != 3:
            raise CalcInputError("macd / kdj 必须各给 3 个参数")
        if not isinstance(boll, (list, tuple)) or len(boll) != 2:
            raise CalcInputError("boll 必须是 [period, num_std]")
        boll_n = _int_list([boll[0]], "boll.period")[0]
        boll_k = _num(boll[1], "boll.num_std")
        if boll_k <= 0 or boll_k > 10:
            raise CalcInputError("boll.num_std 须在 (0, 10]")
        mp = min_points
        if isinstance(mp, bool) or not isinstance(mp, int) or mp < 5:
            raise CalcInputError("min_points 须为 ≥ 5 的整数")
    except CalcInputError as ex:
        return _err(str(ex))
    n = len(rows)
    if n < mp:
        return _res("not_meaningful", None, "元", reason=f"K 线仅 {n} 根,少于 {mp},指标不可靠", points=n)
    closes = [r["close"] for r in rows]
    last = rows[-1]
    det: dict = {"date": last["date"], "points": n, "window": [rows[0]["date"], last["date"]], "params": {"ma": ma_p, "ema": ema_p, "macd": macd_p, "rsi": rsi_p, "kdj": kdj_p, "boll": [boll_n, boll_k]}}
    det["ma"] = {f"ma{p}": (sum(closes[-p:]) / p if n >= p else None) for p in ma_p}
    det["ema"] = {f"ema{p}": _ema(closes, p)[-1] for p in ema_p}
    f, s, g = macd_p
    dif = [a - b for a, b in zip(_ema(closes, f), _ema(closes, s))]
    dea = _ema(dif, g)
    det["macd"] = {"dif": dif[-1], "dea": dea[-1], "hist": (dif[-1] - dea[-1]) * 2}
    changes = [0.0] + [closes[i] - closes[i - 1] for i in range(1, n)]
    gains, losses = [max(c, 0.0) for c in changes], [max(-c, 0.0) for c in changes]
    rsi_out: Dict[str, Optional[float]] = {}
    for p in rsi_p:
        if n - 1 < p:
            rsi_out[f"rsi{p}"] = None
            continue
        ag, al = sum(gains[-p:]) / p, sum(losses[-p:]) / p
        rsi_out[f"rsi{p}"] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    det["rsi"] = rsi_out
    kn, m1, m2 = kdj_p
    kv, dv = 50.0, 50.0
    kdj_out = None
    for i in range(n):
        if i < kn - 1:
            continue
        w = rows[i - kn + 1:i + 1]
        hn, ln = max(x["high"] for x in w), min(x["low"] for x in w)
        rsv = (rows[i]["close"] - ln) / (hn - ln) * 100 if hn != ln else 50.0
        kv = rsv / m1 + kv * (1 - 1 / m1)
        dv = kv / m2 + dv * (1 - 1 / m2)
        kdj_out = {"k": kv, "d": dv, "j": 3 * kv - 2 * dv}
    det["kdj"] = kdj_out
    if n >= boll_n:
        bw = closes[-boll_n:]
        mid = sum(bw) / boll_n
        std = (sum((x - mid) ** 2 for x in bw) / boll_n) ** 0.5
        up, lo = mid + boll_k * std, mid - boll_k * std
        det["boll"] = {"upper": up, "middle": mid, "lower": lo, "bandwidth_pct": ((up - lo) / mid * 100) if mid else None}
    else:
        det["boll"] = None
    return _res("ok", last["close"], "元", **det)


def _tri_weights(grid: list[float], low: float, high: float, avg: float) -> list[float]:
    w = [0.0] * len(grid)
    if high < low:
        return w
    if high - low < 1e-9:
        j = min(range(len(grid)), key=lambda i: abs(grid[i] - low))
        w[j] = 1.0
        return w
    avg = min(max(avg, low), high)
    for i, g in enumerate(grid):
        if low <= g <= avg:
            w[i] = (g - low) / (avg - low) if avg - low > 1e-9 else 1.0
        elif avg < g <= high:
            w[i] = (high - g) / (high - avg) if high - avg > 1e-9 else 1.0
    tot = sum(w)
    if tot > 0:
        return [x / tot for x in w]
    j = min(range(len(grid)), key=lambda i: abs(grid[i] - avg))  # 振幅窄于网格步长:映射最近网格点,不丢换手衰减
    w[j] = 1.0
    return w


def chip_distribution(klines, grid_size: int = 300, decay: float = 1.0, min_points: int = 20) -> dict:
    """筹码分布:输入需含 date/high/low/close/turn(turn 为百分数,0.31 = 0.31%;应为前复权价并已剔除停牌日)。
    value = 获利比例(小数,= 成本 ≤ 现价的筹码占比);details:avg_cost / cost_90 / cost_70 / concentration_90 / concentration_70 / peak_price / days / cum_turnover_pct。"""
    try:
        rows = _rows(klines, ("high", "low", "close", "turn"), optional=("open",))  # open 非必填,但给了就要自洽
        if isinstance(grid_size, bool) or not isinstance(grid_size, int) or not (50 <= grid_size <= 2000):
            raise CalcInputError("grid_size 须为 50..2000 的整数")
        dk = _num(decay, "decay")
        if not (0 < dk <= 5):
            raise CalcInputError("decay 须在 (0, 5]")
        mp = min_points
        if isinstance(mp, bool) or not isinstance(mp, int) or mp < 2:
            raise CalcInputError("min_points 须为 ≥ 2 的整数")
        for r in rows:
            if r["turn"] < 0 or r["turn"] > 100:
                raise CalcInputError(f"{r['date']} turn 须在 0..100(百分数)")
    except CalcInputError as ex:
        return _err(str(ex))
    if len(rows) < mp:
        return _res("not_meaningful", None, "小数", reason=f"K 线仅 {len(rows)} 根,少于 {mp}", points=len(rows))
    lo = min(r["low"] for r in rows)
    hi = max(r["high"] for r in rows)
    pad = (hi - lo) * 0.02 or max(lo * 0.02, 0.01)
    g0, g1 = lo - pad, hi + pad
    grid = [g0 + (g1 - g0) * i / (grid_size - 1) for i in range(grid_size)]
    chips: Optional[list[float]] = None
    for r in rows:
        t = min(max(r["turn"] / 100.0 * dk, 0.0), 1.0)
        w = _tri_weights(grid, r["low"], r["high"], (r["high"] + r["low"] + r["close"]) / 3.0)
        if sum(w) <= 0:
            continue
        if chips is None:
            chips = list(w)  # 首日 = 期初全部流通筹码
            continue
        chips = [c * (1.0 - t) + x * t for c, x in zip(chips, w)]
    if chips is None:
        return _err("所有交易日的价格区间都无效,无法构建分布")
    tot = sum(chips)
    if tot <= 0:
        return _err("筹码总量为 0")
    chips = [c / tot for c in chips]
    price = rows[-1]["close"]
    cum, acc = [], 0.0
    for c in chips:
        acc += c
        cum.append(acc)

    def price_at(q: float) -> float:
        for i, cv in enumerate(cum):
            if cv >= q:
                if i == 0 or cum[i] == cum[i - 1]:
                    return grid[i]
                frac = (q - cum[i - 1]) / (cum[i] - cum[i - 1])
                return grid[i - 1] + (grid[i] - grid[i - 1]) * frac
        return grid[-1]

    p05, p15, p85, p95 = (price_at(q) for q in (0.05, 0.15, 0.85, 0.95))
    peak_i = max(range(len(chips)), key=lambda i: chips[i])
    step = (g1 - g0) / (grid_size - 1)
    profit = sum(c for g, c in zip(grid, chips) if g <= price + step / 2)  # 现价所在网格格(半步容差)计入获利,避免离散化漏判
    return _res("ok", profit, "小数", price=price, avg_cost=sum(g * c for g, c in zip(grid, chips)), cost_90=[p05, p95], cost_70=[p15, p85],
                concentration_90=((p95 - p05) / (p95 + p05)) if (p95 + p05) else None, concentration_70=((p85 - p15) / (p85 + p15)) if (p85 + p15) else None,
                peak_price=grid[peak_i], days=len(rows), window=[rows[0]["date"], rows[-1]["date"]], cum_turnover_pct=sum(r["turn"] for r in rows), grid_size=grid_size, decay=dk)
