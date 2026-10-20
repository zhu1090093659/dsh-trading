"""CBOE 官方延时期权链(C 级:仅个人研究,仅美股):全链 + 希腊字母 + 0DTE / 异动 / 链级聚合。移植自 global-stock-data §6.1;经 _http.official_get 限流。"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import DataNotAvailable, assert_us_ticker, official_get  # noqa: E402

CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes"
_OSI = re.compile(r"^(?P<root>[A-Z][A-Z0-9]*)(?P<y>\d{2})(?P<m>\d{2})(?P<d>\d{2})(?P<cp>[CP])(?P<strike>\d{8})$")


def parse_osi(symbol: str) -> dict:
    m = _OSI.match(symbol or "")
    if not m:
        return {}
    g = m.groupdict()
    return {"expiry": f"20{g['y']}-{g['m']}-{g['d']}", "type": "call" if g["cp"] == "C" else "put", "strike": int(g["strike"]) / 1000.0}


def options_chain_cboe(ticker: str) -> dict:
    t = assert_us_ticker(ticker)
    raw = official_get(f"{CBOE_BASE}/options/{t}.json", as_json=True)
    data = raw.get("data") or {}
    cs = []
    for o in data.get("options") or []:
        meta = parse_osi(o.get("option", ""))
        if not meta:
            continue
        cs.append({"symbol": o["option"], **meta, "bid": o.get("bid"), "ask": o.get("ask"), "volume": o.get("volume") or 0, "open_interest": o.get("open_interest") or 0, "iv": o.get("iv"), "delta": o.get("delta"),
                   "gamma": o.get("gamma"), "vega": o.get("vega"), "theta": o.get("theta"), "rho": o.get("rho"), "last_trade_price": o.get("last_trade_price")})
    if not cs:
        raise DataNotAvailable(f"{t} 未返回任何期权合约(该标的可能无期权或不在 CBOE 覆盖范围)")
    return {"ticker": t, "timestamp": raw.get("timestamp"), "spot": data.get("current_price"), "contracts": cs}


def _et_today() -> str:
    now = datetime.now(timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        return now.astimezone(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
    except Exception:  # noqa: BLE001
        y = now.year
        mar8 = datetime(y, 3, 8, tzinfo=timezone.utc)
        dst_start = (mar8 + timedelta(days=(6 - mar8.weekday()) % 7)).replace(hour=7)
        nov1 = datetime(y, 11, 1, tzinfo=timezone.utc)
        dst_end = (nov1 + timedelta(days=(6 - nov1.weekday()) % 7)).replace(hour=6)
        return (now - timedelta(hours=4 if dst_start <= now < dst_end else 5)).strftime("%Y-%m-%d")


def filter_expiry(chain: dict, expiry: Optional[str] = None, dte_max: Optional[int] = None) -> list[dict]:
    cs = chain["contracts"]
    if expiry == "0DTE":
        return [c for c in cs if c["expiry"] == _et_today()]
    if expiry:
        return [c for c in cs if c["expiry"] == expiry]
    if dte_max is not None:
        today = datetime.strptime(_et_today(), "%Y-%m-%d")
        return [c for c in cs if 0 <= (datetime.strptime(c["expiry"], "%Y-%m-%d") - today).days <= dte_max]
    return cs


def unusual_activity(contracts: list[dict], min_volume: int = 500, vol_oi_min: float = 1.0) -> list[dict]:
    out = []
    for c in contracts:
        vol, oi = c["volume"], c["open_interest"]
        if vol < min_volume:
            continue
        ratio = vol / oi if oi > 0 else float("inf")
        if ratio >= vol_oi_min:
            out.append({**c, "vol_oi_ratio": round(ratio, 2) if oi > 0 else None})
    return sorted(out, key=lambda x: -x["volume"])


def chain_summary(contracts: list[dict]) -> dict:
    calls = [c for c in contracts if c["type"] == "call"]
    puts = [c for c in contracts if c["type"] == "put"]
    cv, pv = sum(c["volume"] for c in calls), sum(c["volume"] for c in puts)
    coi, poi = sum(c["open_interest"] for c in calls), sum(c["open_interest"] for c in puts)
    traded = [c for c in contracts if c["volume"] > 0 and c.get("iv")]
    tv = sum(c["volume"] for c in traded)
    vwiv = sum(c["iv"] * c["volume"] for c in traded) / tv if tv else None
    net_delta = sum((c.get("delta") or 0) * c["volume"] * 100 for c in contracts)
    return {"call_volume": cv, "put_volume": pv, "put_call_volume_ratio": round(pv / cv, 3) if cv else None, "call_oi": coi, "put_oi": poi, "put_call_oi_ratio": round(poi / coi, 3) if coi else None,
            "volume_weighted_iv": round(vwiv, 4) if vwiv else None, "net_delta_exposure_shares": round(net_delta), "contracts_total": len(contracts), "contracts_traded": len([c for c in contracts if c["volume"] > 0])}


def cboe_quote(ticker: str) -> dict:
    return official_get(f"{CBOE_BASE}/quotes/{assert_us_ticker(ticker)}.json", as_json=True)["data"]


def cboe_options_summary(ticker: str, expiry: Optional[str] = None, dte_max: Optional[int] = None, top_unusual: int = 20) -> dict:
    """端点函数:全链 → (可选按到期筛选)→ 按成交量排序前 N 张合约 + 到期日清单。链级聚合(量比 / 加权 IV / 净 delta)与异动比值属派生量,留给 calc(全链在 raw)。"""
    chain = options_chain_cboe(ticker)
    sel = filter_expiry(chain, expiry=expiry, dte_max=dte_max)
    return {"ticker": chain["ticker"], "timestamp": chain["timestamp"], "spot": chain["spot"], "filter": {"expiry": expiry, "dte_max": dte_max}, "selected": len(sel), "all_contracts": len(chain["contracts"]),
            "expiries": sorted({c["expiry"] for c in chain["contracts"]}), "top_by_volume": sorted(sel, key=lambda c: -(c["volume"] or 0))[:top_unusual]}
