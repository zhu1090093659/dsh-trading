#!/usr/bin/env python3
"""季度财务(报告期累计值):营业总收入 / 归母净利润 / 扣非净利润 / 基本每股收益,最近 N 期。

主源:新浪财务摘要(经 akshare `stock_financial_abstract`,零 key;落盘为 extracted CSV,非传输层原始响应);
备源:新浪财报利润表直连(quotes.sina.cn getFinanceReport2022,零依赖,传输层原始 JSON)——只有营收与归母净利,**无扣非**;
     主源成功但部分 (营收 / 归母, 报告期) 缺失时,也会用它**只补缺失项**(note 标"备源补齐"),扣非缺失无法补。
完整性:关键字段 = revenue_cum / net_profit_parent_cum / net_profit_deducted_cum 在最近 `--required-periods`(默认 8)个报告期内逐期齐全;
任一缺失 → status=partial(退出码 2)并在 missing 列出缺失矩阵;eps_basic_cum 为可选字段。
输出只给累计值(YTD);单季拆分 / TTM / 同比环比一律交给 calc 库。
用法:python fetch_financials.py --symbol 300308 --periods 12 [--required-periods 8] [--out-dir ...]
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (UA, base_parser, evidence, finish, lib_versions, parse_symbol_or_exit, record_error,
                    result_skeleton, save_raw, tencent_code, to_float)

SCRIPT = "fetch_financials"
REQUIRED_FIELDS = ("revenue_cum", "net_profit_parent_cum", "net_profit_deducted_cum")
ABSTRACT_FIELDS = {  # 新浪摘要指标名 → 契约字段名(报告期累计值)
    "营业总收入": ("revenue_cum", "元"),
    "归母净利润": ("net_profit_parent_cum", "元"),
    "扣非净利润": ("net_profit_deducted_cum", "元"),
    "基本每股收益": ("eps_basic_cum", "元/股"),
}
LRB_FIELDS = {  # 新浪利润表科目 → 字段名
    "营业总收入": ("revenue_cum", "元"),
    "归属于母公司所有者的净利润": ("net_profit_parent_cum", "元"),
}


def fmt_period(p: str) -> str:
    p = str(p)
    return f"{p[:4]}-{p[4:6]}-{p[6:8]}" if len(p) == 8 and p.isdigit() else p


def completeness(res: dict, periods: list[str], required_periods: int) -> None:
    """按 关键字段 × 必需报告期 校验;报告期数不足 required_periods 本身就是缺失;缺失写入 res['missing']。"""
    if len(periods) < required_periods:
        res["missing"].append({"field": "*", "period": f"仅 {len(periods)} 期 < 要求 {required_periods} 期",
                               "reason": "报告期数不足,不得拼凑 TTM / 同比序列"})
    have = {(e["field"], e["period"]) for e in res["evidence"]}
    for f in REQUIRED_FIELDS:
        for p in periods[:required_periods]:
            if (f, p) not in have:
                res["missing"].append({"field": f, "period": p})


def src_akshare_abstract(digits, market, out_dir, periods, res):
    import warnings
    warnings.filterwarnings("ignore")
    import akshare as ak

    df = ak.stock_financial_abstract(symbol=digits)
    raw = save_raw(out_dir, "sina_abstract", "akshare.stock_financial_abstract", df.to_csv(index=False).encode("utf-8"),
                   "csv", kind="extracted")
    period_cols = [c for c in df.columns if str(c)[:2] == "20" and len(str(c)) == 8][:periods]
    if not period_cols:
        raise ValueError("新浪财务摘要无报告期列")
    seen, n = set(), 0
    for _, row in df.iterrows():
        name = str(row["指标"])
        if name not in ABSTRACT_FIELDS or name in seen:
            continue
        seen.add(name)
        field, unit = ABSTRACT_FIELDS[name]
        for c in period_cols:
            val = to_float(row[c])
            if val is None:
                continue
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field=field, value=val, unit=unit,
                                            period=fmt_period(c), source="sina_abstract",
                                            endpoint="akshare.stock_financial_abstract", raw_ref=raw["raw_ref"],
                                            note="报告期累计值(YTD);extracted:akshare DataFrame 落盘"))
            n += 1
    if n == 0:
        raise ValueError("新浪财务摘要未解析出目标指标")
    res["extra"]["periods"] = [fmt_period(c) for c in period_cols]
    res["extra"]["fields"] = sorted({ABSTRACT_FIELDS[k][0] for k in seen})
    res["used_sources"].append("sina_abstract")
    return res["extra"]["periods"]


def src_sina_lrb(digits, market, out_dir, periods, res):
    url = ("https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022?"
           + urllib.parse.urlencode({"paperCode": tencent_code(digits, market), "source": "lrb", "type": "0",
                                     "page": "1", "num": str(periods)}))
    content = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=20).read()
    raw = save_raw(out_dir, "sina_report", "getFinanceReport2022.lrb", content, "json")
    j = json.loads(content.decode("utf-8", errors="ignore")) or {}
    report_list = ((j.get("result") or {}).get("data") or {}).get("report_list") or {}
    if not report_list:
        raise ValueError("新浪利润表无数据")
    n, got = 0, set()
    ordered = sorted(report_list.keys(), reverse=True)[:periods]
    for period in ordered:
        for it in report_list[period].get("data", []) or []:
            title = it.get("item_title", "")
            if title in LRB_FIELDS and it.get("item_value") not in (None, ""):
                field, unit = LRB_FIELDS[title]
                val = to_float(str(it["item_value"]).replace(",", ""))
                if val is None:
                    continue
                res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field=field, value=val,
                                                unit=unit, period=fmt_period(period), source="sina_report",
                                                endpoint="getFinanceReport2022.lrb", raw_ref=raw["raw_ref"],
                                                note="报告期累计值(YTD);利润表无扣非净利润"))
                got.add(field)
                n += 1
    if n == 0:
        raise ValueError("新浪利润表未解析出目标科目")
    res["extra"]["periods"] = [fmt_period(p) for p in ordered]
    res["extra"]["fields"] = sorted(got)
    res["used_sources"].append("sina_report")
    return res["extra"]["periods"]


def backfill_from_lrb(digits, market, out_dir, periods, res) -> int:
    """主源部分缺失(营收 / 归母)时,用利润表备源只补缺失的 (field, period);扣非无法补。返回补齐条数。"""
    need = {(m["field"], m["period"]) for m in res["missing"] if m.get("field") in {f for f, _ in LRB_FIELDS.values()}}
    if not need:
        return 0
    tmp = result_skeleton(SCRIPT, digits, market)
    src_sina_lrb(digits, market, out_dir, periods, tmp)
    added = 0
    for e in tmp["evidence"]:
        if (e["field"], e["period"]) in need:
            e["note"] = (e.get("note") or "") + ";备源补齐主源缺失"
            res["evidence"].append(e)
            added += 1
    if added:
        res["used_sources"].append("sina_report(backfill)")
        res["missing"] = [m for m in res["missing"] if not ((m.get("field"), m.get("period")) in need and any(
            e["field"] == m.get("field") and e["period"] == m.get("period") for e in res["evidence"]))]
    return added


def main() -> None:
    p = base_parser("季度财务累计值(新浪摘要主源 / 新浪利润表备源)")
    p.add_argument("--periods", type=int, default=12, help="最近 N 个报告期(默认 12)")
    p.add_argument("--required-periods", type=int, default=8, help="关键字段必须齐全的最近报告期数(默认 8)")
    args = p.parse_args()
    digits, market = parse_symbol_or_exit(args.symbol, SCRIPT, args.out_dir)
    res = result_skeleton(SCRIPT, digits, market)
    for name, fn in (("sina_abstract", src_akshare_abstract), ("sina_report", src_sina_lrb)):
        try:
            periods = fn(digits, market, args.out_dir, args.periods, res)
            res["primary_source"] = name
            completeness(res, periods, args.required_periods)
            if name == "sina_abstract" and res["missing"]:
                try:
                    n_fill = backfill_from_lrb(digits, market, args.out_dir, args.periods, res)
                    if n_fill:
                        res["extra"]["backfilled"] = n_fill
                except Exception as e:  # noqa: BLE001 — 补齐失败只记录
                    record_error(res, "sina_report", "backfill", e)
            if name == "sina_report":
                res["extra"]["degraded"] = "主源新浪财务摘要失败,降级新浪利润表:缺扣非净利润,扣非×4 PE 不可计算"
            backfilled = res["extra"].get("backfilled", 0)
            res["status"] = "ok" if (name == "sina_abstract" and not res["missing"] and not backfilled) else "partial"
            if name == "sina_abstract" and (res["missing"] or backfilled):
                parts = []
                if backfilled:
                    parts.append(f"主源部分缺失,已用利润表备源补齐 {backfilled} 项(走了备源)")
                if res["missing"]:
                    parts.append(f"关键字段×报告期仍缺失 {len(res['missing'])} 处,见 missing")
                res["extra"]["degraded"] = ";".join(parts)
            break
        except Exception as e:  # noqa: BLE001
            record_error(res, name, "financials", e)
    res["extra"]["provenance"] = lib_versions("akshare", "pandas")
    finish(res, args.out_dir)


if __name__ == "__main__":
    main()
