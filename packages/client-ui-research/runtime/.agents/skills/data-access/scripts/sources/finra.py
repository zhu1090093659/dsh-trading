"""FINRA Reg SHO 每日空头成交量(B 级,仅美股):全市场快照 / 单票序列 / 占比排行。移植自 global-stock-data Layer 9;经 _http.official_get 限流。"""
from __future__ import annotations

import math
import os
import re
import sys
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import ResourceUnavailable, last_raw_ref, official_get, us_ticker_for  # noqa: E402


def _recent_weekdays(days_back: int = 7) -> list[str]:
    d, out = datetime.utcnow(), list[str]()
    while len(out) < days_back:
        if d.weekday() < 5:
            out.append(d.strftime("%Y%m%d"))
        d -= timedelta(days=1)
    return out


def short_volume_all(date: Optional[str] = None, market: str = "CNMS") -> dict:
    """{date, market, count, data:{SYMBOL:{short, short_exempt, total, ratio}}};market: CNMS / FNSQ / FNYX / FNRA"""
    if market not in {"CNMS", "FNSQ", "FNYX", "FNRA"}:
        raise ValueError("不支持的 FINRA 市场文件")
    last_error = None
    for d in ([date] if date else _recent_weekdays(7)):
        if len(d) != 8 or not d.isascii() or not d.isdigit():
            raise ValueError("FINRA 日期必须是 YYYYMMDD")
        datetime.strptime(d, "%Y%m%d")
        try:
            raw = official_get(f"https://cdn.finra.org/equity/regsho/daily/{market}shvol{d}.txt")
        except ResourceUnavailable as exc:
            last_error = exc
            continue
        # 官方布局：表头 + 数据行 + 记录数尾行；合法零记录文件仍有表头和 0。
        # 不完整正文/拦截页不能被当成「该标的无记录」。
        lines = raw.strip().splitlines()
        header = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market"
        if len(lines) < 2 or lines[0].replace(" ", "") != header or not lines[-1].isascii() or not lines[-1].isdigit():
            raise RuntimeError("FINRA 日文件表头或记录数尾行不合法，无法确认数据")
        rows = {}
        for line in lines[1:-1]:
            p = line.split("|")
            if (len(p) != 6 or p[0] != d or not p[1] or p[1] in rows or not p[5]
                    or not all(re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", v) for v in p[2:5])):
                raise RuntimeError("FINRA 日文件包含无效、重复或错日期记录，无法确认数据")
            # 2026-09-03 官方日文件含六位小数成交量；不能沿用旧布局的整数假设。
            sv, se, tv = map(float, p[2:5])
            if not all(math.isfinite(v) for v in (sv, se, tv)):
                raise RuntimeError("FINRA 成交量超出有效数值范围，无法确认数据")
            rows[p[1]] = {"short": sv, "short_exempt": se, "total": tv, "ratio": round(sv / tv, 4) if tv else None}
        if len(rows) != int(lines[-1]):
            raise RuntimeError("FINRA 日文件记录数不符，无法确认数据完整性")
        return {"date": d, "market": market, "count": len(rows), "data": rows, "_raw": last_raw_ref()}
    raise ResourceUnavailable(f"未取得 {market} {'该日' if date else '近 7 个工作日'}的有效 Reg SHO 文件，无法确认是否有数据") from last_error


class SymbolRows(list):
    """short_volume_symbol 的结果:就是逐日记录的列表,另带 coverage(请求几天、哪些日期的日文件没取到)给 mapper 判断完整性"""
    coverage: dict


def short_volume_symbol(symbol: str, days: int = 5, market: str = "CNMS") -> list[dict]:
    """单票近 N 个交易日空头成交占比:[{date, short, short_exempt, total, ratio}]

    🔴 只取到一部分日期时(请求 5 天、9 个日文件没取到、只拿到 1 天),以前直接返回这一条、信封标「完整」(审计第三轮 B7)。
       现在结果带 coverage,mapper 据此标部分结果并写明哪些日期没取到。
    """
    t = us_ticker_for("finra", symbol)   # 日文件里 BRK.B 写成 BRK/B
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 252:
        raise ValueError("FINRA days 必须为 1–252 的整数")
    out = SymbolRows()
    checked = 0
    last_error = None
    failed: list[str] = []
    for d in _recent_weekdays(days * 2):
        if len(out) >= days:
            break
        try:
            snap = short_volume_all(date=d, market=market)
        except ResourceUnavailable as exc:
            last_error = exc
            failed.append(d)
            continue
        checked += 1
        rec = snap["data"].get(t)
        if rec:
            out.append({"date": d, **rec, "_raw": snap.get("_raw")})
    if not checked:
        raise ResourceUnavailable("FINRA 未取得任何有效日文件，无法确认该标的是否有记录") from last_error
    if not out and last_error:
        raise ResourceUnavailable("FINRA 已取得的日文件未检出该标的，但部分日期未取得，无法确认完整查询范围") from last_error
    out.coverage = {"requested_days": days, "got_days": len(out), "checked_files": checked, "failed_dates": failed}
    return out


def short_volume_ranking(snapshot: dict, min_total: float = 1_000_000, top: int = 20) -> list[dict]:
    rows = [{"symbol": s, **v} for s, v in snapshot["data"].items() if v["total"] >= min_total and v["ratio"] is not None]
    return sorted(rows, key=lambda x: -x["ratio"])[:top]


def short_volume_ranking_latest(min_total: float = 1_000_000, top: int = 20, market: str = "CNMS", date: Optional[str] = None) -> dict:
    """端点函数:最近一日全市场快照 → 占比排行:{date, market, count, ranking:[...]}"""
    snap = short_volume_all(date=date, market=market)
    return {"date": snap["date"], "market": market, "count": snap["count"], "ranking": short_volume_ranking(snap, min_total=min_total, top=top)}
