#!/usr/bin/env python3
"""实时行情 / 估值快照。主源:腾讯 qt.gtimg.cn(不封 IP,GBK,~ 分隔);备源:东财 push2(delay) stock/get。

字段口径(腾讯索引,实测校准):1 名称 / 3 现价 / 4 昨收 / 30 行情时间(YYYYMMDDHHMMSS)/ 32 涨跌幅% / 37 成交额(万元)/
38 换手率% / 39 PE_TTM / 43 振幅%(不是 PB)/ 44 流通市值(亿)/ 45 总市值(亿)/ 46 PB / 52 PE 静态。
东财 push2 字段(2026-08-21 实测对照腾讯):f43 现价 / f60 昨收 / f47 成交量(手)/ f48 成交额(元)/ f86 行情时间戳(秒)/
f164 PE_TTM / f163 PE 静态 / f167 PB / f168 换手率% / f170 涨跌幅% / f116 总市值(元)/ f117 流通市值(元)。
僵尸报价疑似:成交额 0 且 现价 == 昨收 → is_stale=true,原因是 停牌 / 废码 / 盘前(未开盘)三者之一,本脚本不区分;
status=partial(退出码 2),价格 / 市值类 evidence 带 note。**是否可用于估值由 SOP 结合 fetch_trade_calendar 的 session_phase /
reference_quote_day 判定**(盘前且日期吻合 → 按昨收继续;否则 stale)。无法判定(备源缺字段)→ is_stale="unknown",同样 partial。
单位按源原样:腾讯市值 亿元、成交额 万元;东财市值 元、成交额 元;换算交给 calc。
用法:python fetch_quote.py --symbol 300308 [--out-dir .local/runs/x]
"""
from __future__ import annotations

import os
import sys
import urllib.request
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (EM_PUSH2_HOSTS, TZ_SH, UA, base_parser, em_multi_host, em_secid, evidence, finish,
                    parse_symbol_or_exit, record_error, result_skeleton, save_raw, tencent_code, to_float, today_str)

SCRIPT = "fetch_quote"
SRC_TX, EP_TX = "tencent", "qt.gtimg.cn/q"
SRC_EM, EP_EM = "eastmoney", "push2/api/qt/stock/get"
STALE_NOTE = "is_stale 命中(成交额 0 且现价 == 昨收):停牌 / 废码 / 盘前之一;估值可用性由 SOP 结合交易日历 session_phase 判定"
VALUATION_FIELDS = ("price", "last_close", "total_market_cap", "float_market_cap", "pe_ttm", "pe_static", "pb")


def _emit(res, digits, market, src, ep, raw_ref, quote_date, fields, stale, extra_note=None):
    for f, val, u, adj in fields:
        if val is None:
            res["missing"].append({"field": f, "period": quote_date})
            continue
        note = STALE_NOTE if (stale is True and f in VALUATION_FIELDS) else None
        if extra_note and f in ("total_market_cap", "float_market_cap"):
            note = (note + ";" if note else "") + extra_note
        res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field=f, value=val, unit=u,
                                        period=quote_date, source=src, endpoint=ep, raw_ref=raw_ref, adjustment=adj,
                                        note=note))


def fetch_tencent(digits, market, out_dir, timeout, res):
    url = "https://qt.gtimg.cn/q=" + tencent_code(digits, market)
    content = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout).read()
    raw = save_raw(out_dir, SRC_TX, EP_TX, content, "txt")
    text = content.decode("gbk", errors="ignore")
    if '"' not in text:
        raise ValueError("腾讯返回无载荷")
    v = text.split('"')[1].split("~")
    if len(v) < 53 or not v[3]:
        raise ValueError("腾讯字段不足或无报价")
    ts = v[30] if len(v) > 30 and len(v[30]) >= 8 else ""
    quote_date = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}" if ts else today_str()
    price, last_close, amount = to_float(v[3]), to_float(v[4]), to_float(v[37])
    stale = bool(amount == 0 and price == last_close and price and price > 0)
    fields = [
        ("price", price, "元", "none"), ("last_close", last_close, "元", "none"),
        ("change_pct", to_float(v[32]), "%", "none"), ("turnover_pct", to_float(v[38]), "%", "none"),
        ("pe_ttm", to_float(v[39]), "倍", "not_applicable"), ("pe_static", to_float(v[52]), "倍", "not_applicable"),
        ("pb", to_float(v[46]), "倍", "not_applicable"),
        ("float_market_cap", to_float(v[44]), "亿元", "not_applicable"),
        ("total_market_cap", to_float(v[45]), "亿元", "not_applicable"),
        ("amount", amount, "万元", "not_applicable"),
    ]
    _emit(res, digits, market, SRC_TX, EP_TX, raw["raw_ref"], quote_date, fields, stale)
    res["extra"].update({"name": v[1], "quote_date": quote_date, "quote_time": ts or None, "is_stale": stale,
                         "raw_sha256": raw["sha256"]})
    return stale


def fetch_eastmoney(digits, market, out_dir, timeout, res):
    r, host = em_multi_host(EM_PUSH2_HOSTS, "/api/qt/stock/get",
                            params={"fltt": "2", "invt": "2", "secid": em_secid(digits, market),
                                    "fields": "f43,f47,f48,f57,f58,f60,f86,f116,f117,f163,f164,f167,f168,f170"},
                            timeout=timeout)
    raw = save_raw(out_dir, SRC_EM, EP_EM, r.content, "json")
    d = (r.json() or {}).get("data") or {}
    if not d or to_float(d.get("f43")) is None:
        raise ValueError("东财 push2 无数据")
    ts = to_float(d.get("f86"))
    if ts:
        dt = datetime.fromtimestamp(ts, TZ_SH)
        quote_date, quote_time = dt.strftime("%Y-%m-%d"), dt.strftime("%Y%m%d%H%M%S")
    else:
        quote_date, quote_time = today_str(), None
    price, last_close, amount = to_float(d.get("f43")), to_float(d.get("f60")), to_float(d.get("f48"))
    stale: bool | str
    if price is None or last_close is None or amount is None:
        stale = "unknown"
    else:
        stale = bool(amount == 0 and price == last_close and price > 0)
    fields = [
        ("price", price, "元", "none"), ("last_close", last_close, "元", "none"),
        ("change_pct", to_float(d.get("f170")), "%", "none"), ("turnover_pct", to_float(d.get("f168")), "%", "none"),
        ("pe_ttm", to_float(d.get("f164")), "倍", "not_applicable"), ("pe_static", to_float(d.get("f163")), "倍", "not_applicable"),
        ("pb", to_float(d.get("f167")), "倍", "not_applicable"),
        ("float_market_cap", to_float(d.get("f117")), "元", "not_applicable"),
        ("total_market_cap", to_float(d.get("f116")), "元", "not_applicable"),
        ("amount", amount, "元", "not_applicable"),
    ]
    _emit(res, digits, market, SRC_EM, EP_EM, raw["raw_ref"], quote_date, fields, stale is True,
          extra_note="东财市值单位为元(腾讯为亿元),换算交给 calc")
    res["extra"].update({"name": d.get("f58"), "quote_date": quote_date, "quote_time": quote_time, "is_stale": stale,
                         "raw_sha256": raw["sha256"], "em_host": host})
    if quote_date != today_str():
        res["extra"]["warnings"] = [f"行情时间 {quote_date} 与抓取日 {today_str()} 不同(非交易日或停牌),按源端日期记 period"]
    return stale


def main() -> None:
    args = base_parser("实时行情 / 估值快照(腾讯主源,东财备源)").parse_args()
    digits, market = parse_symbol_or_exit(args.symbol, SCRIPT, args.out_dir)
    res = result_skeleton(SCRIPT, digits, market)
    for name, fn in ((SRC_TX, fetch_tencent), (SRC_EM, fetch_eastmoney)):
        try:
            stale = fn(digits, market, args.out_dir, args.timeout, res)
            res["primary_source"] = name
            res["used_sources"].append(name)
            degraded = []
            if name != SRC_TX:
                degraded.append("主源腾讯失败,已降级东财 push2")
            if stale is True:
                degraded.append(STALE_NOTE)
            elif stale == "unknown":
                degraded.append("备源缺昨收/成交额字段,无法判定是否僵尸报价")
            if res["missing"]:
                degraded.append(f"字段缺失 {len(res['missing'])} 个,见 missing")
            res["status"] = "ok" if not degraded else "partial"
            if degraded:
                res["extra"]["degraded"] = ";".join(degraded)
            break
        except Exception as e:  # noqa: BLE001 — 记录后尝试备源
            record_error(res, name, EP_TX if name == SRC_TX else EP_EM, e)
    finish(res, args.out_dir)


if __name__ == "__main__":
    main()
