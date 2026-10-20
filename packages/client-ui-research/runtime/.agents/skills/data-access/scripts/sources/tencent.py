"""腾讯财经源:批量实时行情(个股 / 指数 / ETF / 北交所),含僵尸报价判定。移植自 a-stock-data SKILL.md §1.2。零鉴权。"""
from __future__ import annotations

import os
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import http_get  # noqa: E402

SH_INDEX = {"000300", "000905", "000016", "000688", "000852", "000010"}  # 沪指数白名单(裸码会被当成深市)
_HDR = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}


def tencent_prefix(code: str) -> str:
    """与 a-stock-data get_prefix 一致的前缀路由;显式 sh/sz/bj 前缀透传(解决 000001 歧义)。"""
    c = str(code).strip()
    low = c.lower()
    # 🔴 美股 / 港股代码**原样透传,不转小写**:腾讯对它们大小写敏感 ——
    #    `usDJI` 有数据、`usdji` 返回 `v_usdji="1";`(空壳,20 字节)。
    #    转了小写不会报错,只是那一条**静默地没有了** —— 界面上表现为"少一张卡片"。
    if low.startswith(("us", "hk")):
        return c
    if low.startswith(("sh", "sz", "bj")):
        return low
    if c.startswith("92"):
        return f"bj{c}"
    if c in SH_INDEX or c.startswith(("5", "6", "9")):
        return f"sh{c}"
    if c.startswith(("4", "8")):
        return f"bj{c}"
    return f"sz{c}"


def _f(vals: list, i: int) -> Optional[float]:
    """取不到 / 空 / 非数 → None。🔴 以前读成 0.0:涨跌幅为空就成了一条「涨跌幅 0%」的有效证据(审计 B4)。"""
    try:
        v = float(vals[i]) if vals[i] not in ("", None) else None
    except (ValueError, IndexError, TypeError):
        return None
    return None if v is None or v != v else v


def _opt(vals: list, i: int, zero_is_missing: bool = False) -> Optional[float]:
    """取不到 / 空 / 非数 → None（不当 0）。zero_is_missing：这个字段源用 0 表示没有（如市净率）。"""
    try:
        v = float(vals[i])
    except (ValueError, IndexError, TypeError):
        return None
    return None if v != v or (zero_is_missing and v == 0) else v


# 🔴 港股、美股的字段布局和 A 股不一样（2026-10-09 逐位核对腾讯、阿里、建行、平安、苹果、伯克希尔）：
#    A 股的 46 号位在港美股是英文名，按 A 股读出来市净率永远是 0；港股 38 号位恒为 0，换手率在 59 号位
#    （= 成交量 ÷ 港股股数，建行、平安这类 A+H 公司也对得上）；47–49、52 号位在港美股是每股收益、52 周高低价等，
#    不是涨跌停价、量比、静态市盈率 —— 港美股没有涨跌停，这几样一律不出。
_GLOBAL_LAYOUT = {
    "hk": {"pb": 58, "turnover_pct": 59},
    "us": {"pb": 51, "turnover_pct": 38},
}
_NOT_IN_GLOBAL = ("limit_up", "limit_down", "vol_ratio", "pe_static", "amplitude_pct")


def tencent_quotes(codes) -> dict:
    """批量行情:{入参写法: {name, price, last_close, open, change_pct, high, low, amount_wan, turnover_pct, pe_ttm, pb, mcap_yi, float_mcap_yi, limit_up, limit_down, vol_ratio, pe_static, quote_time, is_stale, stale_reason?}}

    quote_time 是腾讯给的成交时间(交易所当地时间,原样):A股 20261009110653、港股 2026/10/09 10:51:51、美股 2026-10-08 16:00:01。
    节假日里它停在节前最后一个交易日,首页「当日盈亏」靠它判断这份行情属于哪一天。
    """
    if isinstance(codes, str):
        codes = [x for x in codes.replace(" ", "").split(",") if x]
    prefixed, key_of = [], {}
    for c in codes:
        p = tencent_prefix(c)
        prefixed.append(p)
        key_of[p] = c
    r = http_get("https://qt.gtimg.cn/q=" + ",".join(prefixed), headers=_HDR, timeout=10, encoding="gbk", ext="txt")
    r.raise_for_status()
    result: dict = {}
    for line in r.text.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        vals = line.split('"')[1].split("~")
        if len(vals) < 53:
            continue
        code = key_of.get(key, key[2:])
        q = {"name": vals[1], "price": _f(vals, 3), "last_close": _f(vals, 4), "open": _f(vals, 5), "change_amt": _f(vals, 31), "change_pct": _f(vals, 32), "high": _f(vals, 33), "low": _f(vals, 34),
             "amount_wan": _f(vals, 37), "turnover_pct": _f(vals, 38), "pe_ttm": _f(vals, 39), "amplitude_pct": _f(vals, 43), "float_mcap_yi": _f(vals, 44), "mcap_yi": _f(vals, 45), "pb": _f(vals, 46),
             "limit_up": _f(vals, 47), "limit_down": _f(vals, 48), "vol_ratio": _f(vals, 49), "pe_static": _f(vals, 52), "quote_time": vals[30].strip(), "query": key}
        layout = _GLOBAL_LAYOUT.get(key[:2].lower())
        if layout:
            q["pb"] = _opt(vals, layout["pb"], zero_is_missing=True)   # 真实公司市净率不会恰好是 0
            q["turnover_pct"] = _opt(vals, layout["turnover_pct"])
            for k in _NOT_IN_GLOBAL:
                q[k] = None
        # 成交额 / 现价 / 昨收任一缺失:判断不了,不标僵尸(未知 ≠ 停牌)
        q["is_stale"] = bool(q["amount_wan"] == 0 and q["price"] is not None and q["price"] == q["last_close"] and q["price"] > 0)
        if q["is_stale"] and key[2:4] in ("43", "83", "87"):
            q["stale_reason"] = "北交所老号段,多数已迁至 920xxx,请按名称反查现行代码"
        elif q["is_stale"]:
            q["stale_reason"] = "成交量为 0(停牌 / 未开盘 / 废码),报价非当日真实成交"
        result[code] = q
    return result


def tencent_quote(code: str) -> dict:
    """单标的(个股 / 指数 / ETF 皆可,可带 sh/sz/bj 前缀)。"""
    return tencent_quotes([code])


def ah_premium(code: str, side: str = "A") -> dict:
    """A / H 两地上市比价:A 股代码(side=A)或港股代码(side=H)→ 东财 F10 查另一边 → 腾讯**一次请求**取 A 股、H 股、港元兑人民币三条报价。
    premium_pct = (A 股价 ÷ (H 股价 × 港元兑人民币) − 1) × 100,正数 = A 股比 H 股贵。三个原值和各自时间戳都返回,时间不同步(A 股 15:00 收、港股 16:10 收、汇率实时)写在 note。
    没有另一边 → {"pair": None}(源里查不到对应的 A / H 股,不是 0 溢价)。"""
    from sources.eastmoney import ah_pair
    pair = ah_pair(code, side)
    if not pair:
        return {"pair": None, "query": str(code), "side": side}
    a_key, h_key = f"{pair['a_market'].lower()}{pair['a_code']}", f"r_hk{pair['h_code']}"
    r = http_get(f"https://qt.gtimg.cn/q={a_key},{h_key},whHKDCNY", headers=_HDR, timeout=10, encoding="gbk", ext="txt")
    r.raise_for_status()
    lines = {}
    for line in r.text.strip().split(";"):
        if "=" in line and '"' in line:
            lines[line.split("=")[0].strip().replace("v_", "", 1)] = line.split('"')[1].split("~")

    def _num(vals, i):
        try:
            v = float(vals[i])
            return v if v > 0 else None  # 腾讯用 0 / 空表示没有报价
        except (ValueError, IndexError, TypeError):
            return None

    a, h, fx = lines.get(a_key) or [], lines.get(h_key) or [], lines.get("whHKDCNY") or []
    a_price, h_price, rate = _num(a, 3), _num(h, 3), _num(fx, 3)
    a_amt = _num(a, 37)
    out = {"pair": pair, "a_price": a_price, "a_time": a[30] if len(a) > 30 else "", "a_traded": a_amt is not None,
           "h_price": h_price, "h_time": h[30] if len(h) > 30 else "", "hkdcny": rate, "fx_time": fx[5] if len(fx) > 5 else "", "premium_pct": None, "ah_ratio": None}
    if a_price and h_price and rate:
        out["ah_ratio"] = round(a_price / (h_price * rate), 4)
        out["premium_pct"] = round((out["ah_ratio"] - 1) * 100, 2)
    return out
