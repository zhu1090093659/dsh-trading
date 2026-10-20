"""同花顺(10jqka / hexin)源:强势股题材归因 / 北向资金分钟流向 / 涨停揭秘 / 热榜。移植自 a-stock-data SKILL.md §3.1 / §3.2 / §8.2 / §10.2。零鉴权。"""
from __future__ import annotations

import os
import sys
from datetime import datetime
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import TZ_SH, UA  # noqa: E402
from sources._http import http_get, http_json  # noqa: E402

_WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36"


def ths_hot_reason(date: Optional[str] = None) -> list[dict]:
    """当日强势股 + 题材归因(reason):[{code, name, reason, close, zhangfu, huanshou, chengjiaoe, market, ...}]"""
    date = date or datetime.now(TZ_SH).strftime("%Y-%m-%d")
    d = http_json(f"http://zx.10jqka.com.cn/event/api/getharden/date/{date}/orderby/date/orderway/desc/charset/GBK/", headers={"User-Agent": _WIN_UA}, timeout=10)
    if d.get("errocode", 0) != 0:
        raise RuntimeError(f"同花顺热点错误: {d.get('errormsg', '')}")
    return d.get("data") or []


def hsgt_realtime() -> dict:
    """沪深股通当日分钟累计净买入(亿元):{times:[...], hgt:[...], sgt:[...]}"""
    d = http_json("https://data.hexin.cn/market/hsgtApi/method/dayChart/", headers={"User-Agent": _WIN_UA, "Host": "data.hexin.cn", "Referer": "https://data.hexin.cn/"}, timeout=10)
    times = d.get("time", []) or []
    return {"times": times, "hgt": (d.get("hgt") or [])[:len(times)], "sgt": (d.get("sgt") or [])[:len(times)]}


def ths_limit_up_pool(date: Optional[str] = None) -> list[dict]:
    """涨停揭秘(涨停原因题材 + 封板成功率 + 板型)。date=YYYYMMDD"""
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    params = {"page": 1, "limit": 200, "field": "199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004", "filter": "HS,GEM2STAR",
              "order_field": "330324", "order_type": "0", "date": date}
    info = (http_json("https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool", params=params, headers={"User-Agent": UA}, timeout=10).get("data") or {}).get("info", []) or []
    out = []
    for it in info:
        ft = it.get("first_limit_up_time")
        out.append({"code": it.get("code"), "name": it.get("name"), "price": it.get("latest"), "pct": it.get("change_rate"), "reason": it.get("reason_type", ""),
                    "board_type": it.get("limit_up_type", ""), "seal_rate": it.get("limit_up_suc_rate"), "break_times": it.get("open_num") or 0, "seal_amount": it.get("order_amount"),
                    "high_days": it.get("high_days", ""), "first_time": datetime.fromtimestamp(int(ft), TZ_SH).strftime("%H:%M:%S") if ft else "", "is_again": it.get("is_again_limit")})
    return out


def ths_hot_list(period: str = "hour") -> list[dict]:
    """同花顺热榜:rank/code/name/heat/pct/rank_chg/concepts/tag。period: hour/day"""
    d = http_json("https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock", params={"stock_type": "a", "type": period, "list_type": "normal"}, headers={"User-Agent": UA}, timeout=10)
    out = []
    for it in (d.get("data") or {}).get("stock_list") or []:
        tag = it.get("tag") or {}
        out.append({"rank": it.get("order"), "code": it.get("code"), "name": it.get("name"), "heat": it.get("rate"), "pct": it.get("rise_and_fall"), "rank_chg": it.get("hot_rank_chg"),
                    "concepts": tag.get("concept_tag") or [], "tag": tag.get("popularity_tag", "")})
    return out
