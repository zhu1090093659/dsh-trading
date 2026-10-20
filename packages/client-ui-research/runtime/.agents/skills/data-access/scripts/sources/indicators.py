"""技术指标层(纯计算,global-stock-data Layer 3 移植):MA / EMA / MACD / RSI / KDJ / BOLL + 统一快照;K 线按市场取:CN → baostock 前复权,US → 新浪,HK → Yahoo。
指标是对公开 K 线的确定性计算,不是交易所数据;证据 note 标明窗口与参数。"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import TZ_SH  # noqa: E402

ALGO_VERSION = "indicators-1.0.0"  # 计算型端点的算法版本(进信封 extra.computation,供复算)


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    out = [values[0]]
    k = 2 / (period + 1)
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def calc_ma(klines: list[dict], periods: Optional[list[int]] = None) -> list[dict]:
    periods = periods or [5, 10, 20, 60]
    closes = [k["close"] for k in klines]
    ema12, ema26 = _ema(closes, 12), _ema(closes, 26)
    out = []
    for i, k in enumerate(klines):
        row = {"date": k["date"], "close": k["close"]}
        for p in periods:
            row[f"ma{p}"] = round(sum(closes[i - p + 1:i + 1]) / p, 4) if i >= p - 1 else None
        row["ema12"], row["ema26"] = round(ema12[i], 4), round(ema26[i], 4)
        out.append(row)
    return out


def calc_macd(klines: list[dict], fast: int = 12, slow: int = 26, signal: int = 9) -> list[dict]:
    closes = [k["close"] for k in klines]
    ef, es = _ema(closes, fast), _ema(closes, slow)
    dif = [round(f - s, 4) for f, s in zip(ef, es)]
    dea = _ema(dif, signal)
    return [{"date": k["date"], "close": k["close"], "dif": round(dif[i], 4), "dea": round(dea[i], 4), "macd_hist": round((dif[i] - dea[i]) * 2, 4)} for i, k in enumerate(klines)]


def calc_rsi(klines: list[dict], periods: Optional[list[int]] = None) -> list[dict]:
    periods = periods or [6, 12, 24]
    closes = [k["close"] for k in klines]
    changes = [0.0] + [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains, losses = [max(c, 0) for c in changes], [max(-c, 0) for c in changes]
    out = []
    for i, k in enumerate(klines):
        row = {"date": k["date"], "close": k["close"]}
        for p in periods:
            if i < p:
                row[f"rsi{p}"] = None
                continue
            ag, al = sum(gains[i - p + 1:i + 1]) / p, sum(losses[i - p + 1:i + 1]) / p
            row[f"rsi{p}"] = 100.0 if al == 0 else round(100 - 100 / (1 + ag / al), 2)
        out.append(row)
    return out


def calc_kdj(klines: list[dict], n: int = 9, m1: int = 3, m2: int = 3) -> list[dict]:
    kv, dv = 50.0, 50.0
    out = []
    for i, k in enumerate(klines):
        if i < n - 1:
            out.append({"date": k["date"], "close": k["close"], "k": None, "d": None, "j": None})
            continue
        w = klines[i - n + 1:i + 1]
        hn, ln = max(x["high"] for x in w), min(x["low"] for x in w)
        rsv = (k["close"] - ln) / (hn - ln) * 100 if hn != ln else 50.0
        kv = (1 / m1) * rsv + (1 - 1 / m1) * kv
        dv = (1 / m2) * kv + (1 - 1 / m2) * dv
        out.append({"date": k["date"], "close": k["close"], "k": round(kv, 2), "d": round(dv, 2), "j": round(3 * kv - 2 * dv, 2)})
    return out


def calc_boll(klines: list[dict], period: int = 20, num_std: float = 2.0) -> list[dict]:
    closes = [k["close"] for k in klines]
    out = []
    for i, k in enumerate(klines):
        if i < period - 1:
            out.append({"date": k["date"], "close": k["close"], "upper": None, "middle": None, "lower": None, "bandwidth": None})
            continue
        w = closes[i - period + 1:i + 1]
        ma = sum(w) / period
        std = (sum((x - ma) ** 2 for x in w) / period) ** 0.5
        up, lo = ma + num_std * std, ma - num_std * std
        out.append({"date": k["date"], "close": k["close"], "upper": round(up, 4), "middle": round(ma, 4), "lower": round(lo, 4), "bandwidth": round((up - lo) / ma * 100, 2) if ma else None})
    return out


def indicator_snapshot(klines: list[dict]) -> dict:
    """最新一根的全部指标值 + 窗口信息。klines 需按日期升序,含 date/open/high/low/close。"""
    ks = [k for k in klines if k.get("close") not in (None, 0)]
    if len(ks) < 30:
        raise ValueError(f"K 线不足 30 根({len(ks)}),指标不可靠,拒绝计算")
    ks.sort(key=lambda k: str(k["date"]))
    ma, macd, rsi, kdj, boll = calc_ma(ks)[-1], calc_macd(ks)[-1], calc_rsi(ks)[-1], calc_kdj(ks)[-1], calc_boll(ks)[-1]
    return {"date": str(ks[-1]["date"])[:10], "close": ks[-1]["close"], "points": len(ks), "window": (str(ks[0]["date"])[:10], str(ks[-1]["date"])[:10]),
            "ma": {k: v for k, v in ma.items() if k.startswith(("ma", "ema"))}, "macd": {k: macd[k] for k in ("dif", "dea", "macd_hist")}, "rsi": {k: v for k, v in rsi.items() if k.startswith("rsi")},
            "kdj": {k: kdj[k] for k in ("k", "d", "j")}, "boll": {k: boll[k] for k in ("upper", "middle", "lower", "bandwidth")}}


def indicators_for(symbol: str, market: str = "CN", n: int = 250) -> dict:
    """按市场取 K 线并计算指标:CN → baostock 前复权日 K;US → 新浪日 K;HK → Yahoo 日 K(1y)。"""
    if market in ("SH", "SZ", "BJ", "CN"):
        from sources.baostock_src import baostock_kdata
        start = (datetime.now(TZ_SH) - timedelta(days=int(n * 1.6))).strftime("%Y-%m-%d")
        k = [r for r in baostock_kdata(symbol, start, None, fields="date,open,high,low,close,volume,tradestatus", adjustflag="2") if r.get("tradestatus") == "1"]
        src = "baostock qfq"
    elif market == "US":
        from sources.sina import us_stock_kline_sina
        k = us_stock_kline_sina(symbol, num=n)
        src = "sina US daily"
    elif market == "HK":
        from sources.yahoo import yahoo_kline
        k = yahoo_kline(symbol, market="HK", interval="1d", range_="1y")
        src = "yahoo chart 1y"
    else:
        raise ValueError(f"不支持的市场 {market}")
    snap = indicator_snapshot(k)
    return {"market": market, "symbol": symbol, "klines_source": src, "snapshot": snap, "tail": k[-5:], "algo_version": ALGO_VERSION}
