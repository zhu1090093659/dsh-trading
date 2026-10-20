#!/usr/bin/env python3
"""机构一致预期 EPS(前瞻 CAGR 的唯一输入,也是整条估值链里最软的一环)。

主源:同花顺 basic.10jqka.com.cn/new/<code>/worth.html(直连 HTML 表,零 key,传输层原始响应落盘):
     年度 / 预测机构数 / 最小值 / 均值 / 最大值。均值 = 一致预期 EPS。
完整性:每个年度必须 mean / min / max / count 四元组齐全,且必须覆盖 FY T / T+1 / T+2(T = 当前财年,Asia/Shanghai);
     任一缺失 → partial 并在 missing 列出;机构数 < 3 → extra.warnings。
备源:东财 reportapi 研报列表(每篇研报的 predictThisYearEps / NextYear / NextTwoYear)——**不是一致预期**,
     逐篇单独成证据(record_key = infoCode),聚合交给 calc,状态 partial。
用法:python fetch_estimates.py --symbol 300308 [--out-dir ...]
"""
from __future__ import annotations

import os
import sys
from datetime import datetime
from io import StringIO

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (TZ_SH, UA, base_parser, em_get, evidence, finish, lib_versions, parse_symbol_or_exit, record_error,
                    result_skeleton, save_raw, to_float)

SCRIPT = "fetch_estimates"


def current_fy() -> int:
    return datetime.now(TZ_SH).year


def src_ths(digits, market, out_dir, timeout, res):
    import pandas as pd
    import requests

    url = f"https://basic.10jqka.com.cn/new/{digits}/worth.html"
    r = requests.get(url, headers={"User-Agent": UA, "Referer": "https://basic.10jqka.com.cn/"}, timeout=timeout)
    r.raise_for_status()
    r.encoding = "gbk"
    raw = save_raw(out_dir, "ths", "basic.10jqka.com.cn/worth.html", r.content, "html")
    dfs = pd.read_html(StringIO(r.text))
    table = None
    for df in dfs:
        cols = [str(c) for c in df.columns]
        if "预测机构数" in cols and "均值" in cols and "年度" in cols:
            table = df
            break
    if table is None or table.empty:
        raise ValueError("同花顺页面无一致预期表(可能无机构覆盖)")
    warnings, years = [], []
    for _, row in table.iterrows():
        year = str(row["年度"]).strip()[:4]
        if not year.isdigit():
            continue
        period = f"FY{year}"
        years.append(int(year))
        cnt = to_float(row.get("预测机构数"))
        vals = {"eps_consensus_mean": to_float(row.get("均值")), "eps_consensus_min": to_float(row.get("最小值")),
                "eps_consensus_max": to_float(row.get("最大值"))}
        for f, v in vals.items():
            if v is None:
                res["missing"].append({"field": f, "period": period})
            else:
                res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field=f, value=v,
                                                unit="元/股", period=period, source="ths", endpoint="worth.html",
                                                raw_ref=raw["raw_ref"], note=f"预测机构数={int(cnt) if cnt else '?'}"))
        if cnt is None:
            res["missing"].append({"field": "eps_analyst_count", "period": period})
        else:
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field="eps_analyst_count",
                                            value=int(cnt), unit="家", period=period, source="ths", endpoint="worth.html",
                                            raw_ref=raw["raw_ref"], currency="n/a"))
            if cnt < 3:
                warnings.append(f"{period} 预测机构数 {int(cnt)} < 3,一致预期不可靠")
    if not any(e["field"] == "eps_consensus_mean" for e in res["evidence"]):
        raise ValueError("同花顺表解析后无均值")
    t = current_fy()
    for y in (t, t + 1, t + 2):
        if y not in years:
            res["missing"].append({"field": "eps_consensus_*", "period": f"FY{y}", "reason": "年度缺失,前瞻 CAGR 需 FY T 与 T+2"})
    res["extra"]["years"] = sorted({f"FY{y}" for y in years})
    res["extra"]["current_fy"] = f"FY{t}"
    if warnings:
        res["extra"]["warnings"] = warnings
    res["used_sources"].append("ths")


def src_em_reports(digits, market, out_dir, timeout, res, max_reports: int = 20):
    today = datetime.now(TZ_SH).date()
    r = em_get("https://reportapi.eastmoney.com/report/list",
               params={"industryCode": "*", "pageSize": max_reports, "industry": "*", "rating": "*", "ratingChange": "*",
                       "beginTime": f"{today.year - 1}-{today.month:02d}-01", "endTime": f"{today.year + 1}-12-31",
                       "pageNo": 1, "fields": "", "qType": 0, "orgCode": "", "code": digits, "rcode": ""},
               timeout=timeout)
    raw = save_raw(out_dir, "eastmoney", "reportapi/report/list", r.content, "json")
    items = (r.json() or {}).get("data") or []
    if not items:
        raise ValueError("东财研报列表为空")
    n = 0
    for it in items:
        pub = str(it.get("publishDate", ""))[:10]
        org = it.get("orgSName", "")
        key = str(it.get("infoCode") or it.get("encodeUrl") or f"{org}-{pub}")
        try:
            y0 = int(pub[:4])
        except ValueError:
            continue
        for fld, yr in (("predictThisYearEps", y0), ("predictNextYearEps", y0 + 1), ("predictNextTwoYearEps", y0 + 2)):
            v = to_float(it.get(fld))
            if v is None:
                continue
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field="eps_forecast_single_report",
                                            value=v, unit="元/股", period=f"FY{yr}", source="eastmoney",
                                            endpoint="reportapi/report/list", raw_ref=raw["raw_ref"], as_of=pub,
                                            record_key=f"{key}#{fld}", note=f"{org} {pub} 单篇研报预测,非一致预期"))
            n += 1
    if n == 0:
        raise ValueError("研报列表无 EPS 预测字段")
    res["extra"]["reports"] = len(items)
    res["used_sources"].append("eastmoney_reportapi")


def main() -> None:
    args = base_parser("机构一致预期 EPS(同花顺主源 / 东财研报逐篇备源)").parse_args()
    digits, market = parse_symbol_or_exit(args.symbol, SCRIPT, args.out_dir)
    res = result_skeleton(SCRIPT, digits, market)
    for name, fn in (("ths", src_ths), ("eastmoney_reportapi", src_em_reports)):
        try:
            fn(digits, market, args.out_dir, args.timeout, res)
            res["primary_source"] = name
            if name == "ths":
                res["status"] = "ok" if not res["missing"] else "partial"
                if res["missing"]:
                    res["extra"]["degraded"] = f"一致预期字段 / 年度缺失 {len(res['missing'])} 处,见 missing"
            else:
                res["status"] = "partial"
                res["extra"]["degraded"] = "同花顺一致预期不可得,降级为东财逐篇研报预测;需 calc 聚合且不得当作一致预期"
            break
        except Exception as e:  # noqa: BLE001
            record_error(res, name, "estimates", e)
    res["extra"]["provenance"] = lib_versions("pandas", "lxml")
    finish(res, args.out_dir)


if __name__ == "__main__":
    main()
