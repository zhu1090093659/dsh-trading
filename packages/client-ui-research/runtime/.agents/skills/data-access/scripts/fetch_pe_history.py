#!/usr/bin/env python3
"""PE_TTM / PB 日频历史(算历史分位用)。源:baostock(零鉴权 TCP;不支持北交所)。

落盘:SDK 行数据拼装的 CSV(kind=extracted,非传输层原始响应),列 date,code,close,peTTM,pbMRQ,psTTM,turn,tradestatus,isST。
evidence:pe_ttm_latest / pb_mrq_latest / close_unadjusted(最新交易日)+ pe_ttm_traded_history_points(已剔除停牌日的条数)。
分位由 calc `percentile_rank(history_csv={raw_ref, column: peTTM, where: {tradestatus: "1"}})` 计算,不在取数层做统计。
用法:python fetch_pe_history.py --symbol 300308 --years 5 [--out-dir ...]
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (base_parser, bs_code, bs_paging_error, evidence, finish, lib_versions, parse_symbol_or_exit, quiet_stdout,
                    record_error, result_skeleton, save_raw, to_float)

SCRIPT = "fetch_pe_history"
EP = "query_history_k_data_plus"


def main() -> None:
    p = base_parser("PE/PB 历史序列(baostock)")
    p.add_argument("--years", type=int, default=5)
    args = p.parse_args()
    digits, market = parse_symbol_or_exit(args.symbol, SCRIPT, args.out_dir)
    res = result_skeleton(SCRIPT, digits, market)
    try:
        import baostock as bs
        code = bs_code(digits, market)
        end, start = date.today(), date.today() - timedelta(days=365 * args.years)
        with quiet_stdout():
            lg = bs.login()
            if lg.error_code != "0":
                raise RuntimeError(f"baostock 登录失败 {lg.error_code} {lg.error_msg}")
            try:
                rs = bs.query_history_k_data_plus(code, "date,code,close,peTTM,pbMRQ,psTTM,turn,tradestatus,isST",
                                                  start_date=start.isoformat(), end_date=end.isoformat(),
                                                  frequency="d", adjustflag="3")
                if rs.error_code != "0":
                    raise RuntimeError(f"baostock 查询失败 {rs.error_code} {rs.error_msg}")
                rows = []
                while rs.next():
                    rows.append(rs.get_row_data())
                why = bs_paging_error(rs)
                if why:   # 翻页失败不抛异常（见 common.bs_paging_error），不查就拿着前 2000 行当完整序列
                    raise RuntimeError(f"baostock 翻页失败 {why}（只取到 {len(rows)} 行）")
                fields = list(rs.fields)
            finally:
                bs.logout()
        if not rows:
            raise ValueError("baostock 返回空序列")
        csv = ",".join(fields) + "\n" + "\n".join(",".join(r) for r in rows) + "\n"
        raw = save_raw(args.out_dir, "baostock", EP + ".valuation", csv.encode("utf-8"), "csv", kind="extracted")
        idx = {f: i for i, f in enumerate(fields)}
        traded = [r for r in rows if r[idx["tradestatus"]] == "1"]
        if not traded:
            raise ValueError("序列内无正常交易日")
        last = traded[-1]
        d = last[idx["date"]]
        for f, col, unit, adj in (("pe_ttm_latest", "peTTM", "倍", "not_applicable"), ("pb_mrq_latest", "pbMRQ", "倍", "not_applicable"),
                                  ("close_unadjusted", "close", "元", "none")):
            v = to_float(last[idx[col]])
            if v is None:
                res["missing"].append({"field": f, "period": d})
                continue
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field=f, value=v, unit=unit,
                                            period=d, source="baostock", endpoint=EP, raw_ref=raw["raw_ref"],
                                            adjustment=adj, note="extracted:SDK 行数据拼装"))
        res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field="pe_ttm_traded_history_points",
                                        value=len(traded), unit="个交易日", period=f"{traded[0][idx['date']]}..{d}",
                                        source="baostock", endpoint=EP, raw_ref=raw["raw_ref"], currency="n/a",
                                        note="已剔除 tradestatus!=1 的停牌日;序列在 raw_ref CSV(列 peTTM/pbMRQ/psTTM/turn/tradestatus/isST),"
                                             "calc 用 history_csv where tradestatus=1 加载"))
        res["extra"] = {"start": rows[0][idx["date"]], "end": d, "rows_total": len(rows), "rows_traded": len(traded),
                        "suspended_days": len(rows) - len(traded),
                        "st_days": sum(1 for r in rows if r[idx["isST"]] == "1"), "raw_kind": raw["kind"],
                        "provenance": lib_versions("baostock")}
        res["primary_source"] = "baostock"
        res["status"] = "ok" if not res["missing"] else "partial"
        res["used_sources"].append("baostock")
    except Exception as e:  # noqa: BLE001
        record_error(res, "baostock", EP, e)
        res["status"] = "failed"
    finish(res, args.out_dir)


if __name__ == "__main__":
    main()
