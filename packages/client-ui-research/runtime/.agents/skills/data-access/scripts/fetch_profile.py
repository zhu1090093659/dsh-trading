#!/usr/bin/env python3
"""公司画像:名称 / 上市日期 / 在市状态 / 行业 / 股本 / 市值。

源组合(各自独立,任一失败只影响对应字段):
- 腾讯 qt.gtimg.cn:名称、总市值、流通市值(核心,单位 亿元)
- baostock:上市日 / 退市日 / 状态、证监会行业分类(核心;零鉴权 TCP;不支持北交所)
- 东财 push2(delay) stock/get:东财行业 f127、总股本 f84、流通股 f85、上市日 f189(可选增强;失败只记 warning)
状态:两个核心源都成功且关键字段(名称 / 市值 / 上市日 / 证监会行业)齐 = ok;核心源一个失败或关键字段缺失 = partial;核心源都失败 = failed。可选源失败不降级状态。
用法:python fetch_profile.py --symbol 300308 [--out-dir ...]
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (EM_PUSH2_HOSTS, UA, base_parser, bs_code, bs_paging_error, em_multi_host, em_secid, evidence, finish,
                    lib_versions, parse_symbol_or_exit, quiet_stdout, record_error, result_skeleton, save_raw,
                    tencent_code, to_float, today_str)

SCRIPT = "fetch_profile"


def part_tencent(digits, market, out_dir, timeout, res):
    url = "https://qt.gtimg.cn/q=" + tencent_code(digits, market)
    content = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout).read()
    raw = save_raw(out_dir, "tencent", "qt.gtimg.cn/q", content, "txt")
    text = content.decode("gbk", errors="ignore")
    if '"' not in text:
        raise ValueError("腾讯返回无载荷")
    v = text.split('"')[1].split("~")
    if len(v) < 53 or not v[1]:
        raise ValueError("腾讯字段不足或无名称")
    res["extra"]["name"] = v[1]
    n = 0
    for f, val, u in (("total_market_cap", to_float(v[45]), "亿元"), ("float_market_cap", to_float(v[44]), "亿元")):
        if val is not None:
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field=f, value=val, unit=u,
                                            period=today_str(), source="tencent", endpoint="qt.gtimg.cn/q",
                                            raw_ref=raw["raw_ref"]))
            n += 1
    if n == 0:
        raise ValueError("腾讯无市值字段")
    res["used_sources"].append("tencent")


def _bs_rows(rs, what: str) -> list:
    if rs.error_code != "0":
        raise RuntimeError(f"baostock {what} 失败 {rs.error_code} {rs.error_msg}")
    rows = []
    while rs.next():
        rows.append(dict(zip(rs.fields, rs.get_row_data())))
    why = bs_paging_error(rs)
    if why:   # 翻页失败不抛异常（见 common.bs_paging_error）
        raise RuntimeError(f"baostock {what} 翻页失败 {why}（只取到 {len(rows)} 行）")
    return rows


def part_baostock(digits, market, out_dir, timeout, res):
    import baostock as bs
    code = bs_code(digits, market)
    with quiet_stdout():
        lg = bs.login()
        if lg.error_code != "0":
            raise RuntimeError(f"baostock 登录失败 {lg.error_code} {lg.error_msg}")
        try:
            basic = _bs_rows(bs.query_stock_basic(code=code), "query_stock_basic")
            ind = _bs_rows(bs.query_stock_industry(code=code), "query_stock_industry")
        finally:
            bs.logout()
    payload = json.dumps({"basic": basic, "industry": ind}, ensure_ascii=False).encode("utf-8")
    raw = save_raw(out_dir, "baostock", "query_stock_basic+query_stock_industry", payload, "json", kind="extracted")
    if not basic:
        raise ValueError("baostock 无基本信息(代码不存在或不支持)")
    b = basic[0]
    res["extra"].setdefault("name", b.get("code_name"))
    res["extra"]["listing_status"] = "listed" if b.get("status") == "1" else "delisted"
    for f, val in (("ipo_date", b.get("ipoDate")), ("delist_date", b.get("outDate") or None)):
        if val:
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field=f, value=val, unit="date",
                                            period=val, source="baostock", endpoint="query_stock_basic",
                                            raw_ref=raw["raw_ref"], currency="n/a", note="extracted:SDK 行数据拼装"))
    if ind:
        i = ind[0]
        res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field="industry_csrc",
                                        value=i.get("industry"), unit="text", period=i.get("updateDate") or today_str(),
                                        source="baostock", endpoint="query_stock_industry", raw_ref=raw["raw_ref"],
                                        currency="n/a", note=i.get("industryClassification")))
    else:
        res["missing"].append({"field": "industry_csrc", "reason": "baostock 行业查询为空"})
    res["used_sources"].append("baostock")


def part_eastmoney(digits, market, out_dir, timeout, res):
    r, host = em_multi_host(EM_PUSH2_HOSTS, "/api/qt/stock/get",
                            params={"fltt": "2", "invt": "2", "secid": em_secid(digits, market),
                                    "fields": "f57,f58,f84,f85,f127,f189"}, timeout=timeout)
    raw = save_raw(out_dir, "eastmoney", "push2/api/qt/stock/get", r.content, "json")
    res["extra"]["em_host"] = host
    d = (r.json() or {}).get("data") or {}
    if not d or not d.get("f58"):
        raise ValueError("东财 push2 无数据")
    res["extra"].setdefault("name", d.get("f58"))
    items = [("industry_em", d.get("f127"), "text", "n/a"), ("total_shares", to_float(d.get("f84")), "股", "n/a"),
             ("float_shares", to_float(d.get("f85")), "股", "n/a")]
    ld = str(d.get("f189") or "")
    if len(ld) == 8:
        items.append(("ipo_date_em", f"{ld[:4]}-{ld[4:6]}-{ld[6:8]}", "date", "n/a"))
    for f, val, u, cur in items:
        if val not in (None, "", "-"):
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field=f, value=val, unit=u,
                                            period=today_str(), source="eastmoney", endpoint="push2/api/qt/stock/get",
                                            raw_ref=raw["raw_ref"], currency=cur))
    res["used_sources"].append("eastmoney")


def main() -> None:
    args = base_parser("公司画像(腾讯 + baostock 核心,东财可选)").parse_args()
    digits, market = parse_symbol_or_exit(args.symbol, SCRIPT, args.out_dir)
    res = result_skeleton(SCRIPT, digits, market)
    core_ok = []
    for name, fn, core in (("tencent", part_tencent, True), ("baostock", part_baostock, True),
                           ("eastmoney", part_eastmoney, False)):
        try:
            fn(digits, market, args.out_dir, args.timeout, res)
            if core:
                core_ok.append(name)
        except Exception as e:  # noqa: BLE001
            record_error(res, name, "profile", e)
            if core:
                res["missing"].append({"source": name, "reason": f"核心源失败:{type(e).__name__}"})
            else:
                res["extra"].setdefault("warnings", []).append(f"可选增强源 {name} 失败:{type(e).__name__}")
    res["primary_source"] = "+".join(core_ok) if core_ok else None
    if not core_ok:
        res["status"] = "failed"
    elif len(core_ok) == 2 and not res["missing"]:
        res["status"] = "ok"
    else:
        res["status"] = "partial"
        res["extra"]["degraded"] = "核心源部分失败或关键字段(如证监会行业)缺失,见 missing / errors;缺失字段未伪造"
    res["extra"]["provenance"] = lib_versions("baostock")
    finish(res, args.out_dir)


if __name__ == "__main__":
    main()
