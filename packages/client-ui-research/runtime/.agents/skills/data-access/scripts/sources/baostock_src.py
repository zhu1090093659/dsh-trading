"""baostock 源(证券宝,SDK/TCP,零鉴权):估值历史(PE/PB/PS/PCF + 换手 + 停牌 + ST)/ 标的基本信息 / 前复权 K 线 + 筹码分布 CYQ(纯计算)。移植自 a-stock-data SKILL.md §6.5 / §6.6 / §4.6。
SDK 返回不经 HTTP,结果以 extracted_ 前缀落盘(不冒充传输层原文)。北交所代码在登录前即拒绝。"""
from __future__ import annotations

import math
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import TZ_SH, bs_code, bs_paging_error, norm_ticker, quiet_stdout  # noqa: E402
from sources._http import dump_json_bytes, record_raw  # noqa: E402


@contextmanager
def bs_session():
    import baostock as bs
    with quiet_stdout():
        lg = bs.login()
    if lg.error_code != "0":
        raise RuntimeError(f"baostock 登录失败: {lg.error_code} {lg.error_msg}")
    try:
        yield bs
    finally:
        with quiet_stdout():
            bs.logout()


def _rs_rows(rs) -> list[dict]:
    if rs.error_code != "0":
        raise RuntimeError(f"baostock 查询失败: {rs.error_code} {rs.error_msg}")
    rows = []
    while rs.next():
        rows.append(dict(zip(rs.fields, rs.get_row_data())))
    # 🔴 SDK 每页 2000 行，翻下一页失败（别的 baostock 会话把登录挤掉「用户未登录」、或网络异常）时
    #    next() 只返回 False、不抛异常 —— 不再检查就会拿着前 2000 行当完整序列。两种情况见 common.bs_paging_error。
    why = bs_paging_error(rs)
    if why:
        raise RuntimeError(f"baostock 翻页失败: {why}（只取到 {len(rows)} 行，不完整）")
    return rows


def _num(v):
    try:
        return float(v) if v not in ("", None) else None
    except (TypeError, ValueError):
        return None


def _code(code: str) -> str:
    digits, market = norm_ticker(code, stock_only=True)
    return bs_code(digits, market)


def baostock_kdata(code: str, start_date: Optional[str] = None, end_date: Optional[str] = None, fields: str = "date,code,open,high,low,close,volume,amount,turn,tradestatus,pctChg,peTTM,pbMRQ,psTTM,pcfNcfTTM,isST",
                   adjustflag: str = "3", frequency: str = "d") -> list[dict]:
    """日频 K 线 / 估值:adjustflag 3=不复权 2=前复权 1=后复权。数值列已转 float(空为 None)。"""
    bc = _code(code)
    end_date = end_date or datetime.now(TZ_SH).strftime("%Y-%m-%d")
    start_date = start_date or (datetime.now(TZ_SH) - timedelta(days=365 * 5)).strftime("%Y-%m-%d")
    with bs_session() as bs:
        rows = _rs_rows(bs.query_history_k_data_plus(bc, fields, start_date=start_date, end_date=end_date, frequency=frequency, adjustflag=adjustflag))
    for r in rows:
        for k in list(r):
            if k not in ("date", "code", "tradestatus", "isST"):
                r[k] = _num(r[k])
    record_raw(dump_json_bytes({"query": {"code": bc, "fields": fields, "start": start_date, "end": end_date, "adjustflag": adjustflag}, "rows": rows}), "json", f"baostock://query_history_k_data_plus/{bc}", kind="extracted")
    return rows


def baostock_valuation_history(code: str, start_date: Optional[str] = None, end_date: Optional[str] = None) -> list[dict]:
    """估值历史(不复权):date/close/peTTM/pbMRQ/psTTM/pcfNcfTTM/turn/tradestatus/isST"""
    return baostock_kdata(code, start_date, end_date, fields="date,code,close,peTTM,pbMRQ,psTTM,pcfNcfTTM,turn,tradestatus,isST", adjustflag="3")


def baostock_stock_basic(code: str) -> dict:
    """{code, code_name, ipoDate, outDate(在市为空), type, status(1 上市 / 0 退市)}"""
    bc = _code(code)
    with bs_session() as bs:
        rows = _rs_rows(bs.query_stock_basic(code=bc))
    record_raw(dump_json_bytes(rows), "json", f"baostock://query_stock_basic/{bc}", kind="extracted")
    return rows[0] if rows else {}


# ---------- 4.6 筹码分布(纯计算,输入需含 date/high/low/close/turn,turn 为百分数) ----------
CHIP_ALGO_VERSION = "chip-1.0.0"
def _tri_weights(grid, low: float, high: float, avg: float):
    import numpy as np
    w = np.zeros_like(grid)
    if not np.isfinite([low, high, avg]).all() or high < low:
        return w
    if high - low < 1e-9:
        w[np.argmin(np.abs(grid - low))] = 1.0
        return w
    avg = min(max(avg, low), high)
    left = (grid >= low) & (grid <= avg)
    right = (grid > avg) & (grid <= high)
    w[left] = (grid[left] - low) / (avg - low) if avg - low > 1e-9 else 1.0
    w[right] = (high - grid[right]) / (high - avg) if high - avg > 1e-9 else 1.0
    total = w.sum()
    if total > 0:
        return w / total
    w[np.argmin(np.abs(grid - avg))] = 1.0  # 振幅窄于网格步长时映射到最近网格点,不丢换手衰减
    return w


def chip_distribution(rows: list[dict], grid_size: int = 300, decay: float = 1.0) -> dict:
    """筹码分布:首日播种全部流通筹码,逐日按换手率 × decay 衰减 + 三角分布注入。输入按 date 升序排序(内部强制)。"""
    import numpy as np
    d = [r for r in rows if all(r.get(k) is not None for k in ("date", "high", "low", "close", "turn")) and float(r["high"]) > 0]
    if not d:
        raise ValueError("chip_distribution: 有效行数为 0(检查是否全是停牌日,或字段类型不对)")
    d.sort(key=lambda r: str(r["date"]))
    lo = min(float(r["low"]) for r in d)
    hi = max(float(r["high"]) for r in d)
    pad = (hi - lo) * 0.02 or max(lo * 0.02, 0.01)
    grid = np.linspace(lo - pad, hi + pad, grid_size)
    chips = None
    for r in d:
        t = min(max(float(r["turn"]) / 100.0 * decay, 0.0), 1.0)
        high, low, close = float(r["high"]), float(r["low"]), float(r["close"])
        w = _tri_weights(grid, low, high, (high + low + close) / 3.0)
        if w.sum() <= 0:
            continue
        if chips is None:
            chips = w.copy()
            continue
        chips = chips * (1.0 - t) + w * t
    if chips is None:
        raise RuntimeError("chip_distribution: 所有交易日的价格区间都无效,无法构建分布")
    total = chips.sum()
    if total <= 0:
        raise RuntimeError("chip_distribution: 筹码总量为 0,无法计算指标")
    chips = chips / total
    price = float(d[-1]["close"])
    cum = np.cumsum(chips)

    def price_at(q: float) -> float:
        return float(np.interp(q, cum, grid))

    p05, p15, p85, p95 = (price_at(q) for q in (0.05, 0.15, 0.85, 0.95))
    peak_i = int(np.argmax(chips))
    return {"price": price, "profit_ratio": float(chips[grid <= price].sum()), "avg_cost": float((grid * chips).sum()), "cost_90": (p05, p95), "cost_70": (p15, p85),
            "concentration_90": float((p95 - p05) / (p95 + p05)) if p95 + p05 else None, "concentration_70": float((p85 - p15) / (p85 + p15)) if p85 + p15 else None,
            "peak_price": float(grid[peak_i]), "window": (str(d[0]["date"]), str(d[-1]["date"])), "days": len(d), "cum_turnover_pct": float(sum(float(r["turn"]) for r in d)),
            "histogram": [(float(pp), float(cc)) for pp, cc in zip(grid, chips) if cc > 1e-6]}


def baostock_chip_distribution(code: str, start_date: Optional[str] = None, end_date: Optional[str] = None, decay: float = 1.0) -> dict:
    """前复权 K 线(含换手)→ 筹码分布;默认窗口近 250 个自然日。停牌日不参与。"""
    start_date = start_date or (datetime.now(TZ_SH) - timedelta(days=250)).strftime("%Y-%m-%d")
    k = baostock_kdata(code, start_date, end_date, fields="date,open,high,low,close,turn,tradestatus", adjustflag="2")
    k = [r for r in k if r.get("tradestatus") == "1"]
    res = chip_distribution(k, decay=decay)
    res["adjust"] = "qfq"
    res["algo_version"] = CHIP_ALGO_VERSION
    return res
