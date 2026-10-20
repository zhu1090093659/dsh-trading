#!/usr/bin/env python3
"""日 K 线(前复权)。主源:腾讯 fqkline(qfq,不封 IP);备源:东财 push2his kline(fqt=1 前复权;本域在部分网络断连)。

校验每行:日期 YYYY-MM-DD、OHLC 与成交量可解析为数、日期升序;不合格行剔除并记 missing(→ partial);
最新收盘不可解析 → 该源视为失败,尝试备源。原始序列(传输层响应)落盘 raw/;evidence 只给最新收盘与条数;
均线 / 涨跌幅统计交给 calc。endpoint 用稳定逻辑名,实际主机在 extra.em_host。
用法:python fetch_kline.py --symbol 300308 --bars 250 [--out-dir ...]
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (EM_PUSH2HIS_HOSTS, UA, base_parser, em_multi_host, em_secid, evidence, finish,
                    parse_symbol_or_exit, record_error, result_skeleton, save_raw, tencent_code, to_float)

SCRIPT = "fetch_kline"
EP_EM, EP_TX = "push2his/api/qt/stock/kline/get", "web.ifzq.gtimg.cn/fqkline"


def validate(rows: list[list]) -> tuple[list[list], list[str]]:
    """返回 (合格行, 剔除原因)。合格 = ≥6 列、日期合法、OHLC+量可解析;并要求日期升序。"""
    good, bad = [], []
    for r in rows:
        if len(r) < 6:
            bad.append(f"列数不足:{r[:1]}")
            continue
        try:
            date.fromisoformat(str(r[0])[:10])
        except ValueError:
            bad.append(f"日期非法:{r[0]}")
            continue
        if any(to_float(x) is None for x in r[1:6]):
            bad.append(f"数值非法:{r[0]}")
            continue
        good.append(r)
    if any(good[i][0] >= good[i + 1][0] for i in range(len(good) - 1)):
        raise ValueError("K 线日期非升序")
    return good, bad


def src_eastmoney(digits, market, out_dir, bars, timeout, res):
    r, host = em_multi_host(EM_PUSH2HIS_HOSTS, "/api/qt/stock/kline/get",
                            params={"secid": em_secid(digits, market), "fields1": "f1,f2,f3,f4,f5,f6",
                                    "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "klt": 101, "fqt": 1,
                                    "end": "20500101", "lmt": bars}, timeout=timeout)
    raw = save_raw(out_dir, "eastmoney", EP_EM, r.content, "json")
    res["extra"]["em_host"] = host
    kl = ((r.json() or {}).get("data") or {}).get("klines") or []
    if not kl:
        raise ValueError("东财 K 线为空")
    return [k.split(",") for k in kl], raw, "eastmoney", EP_EM  # date,open,close,high,low,vol,amount,amplitude


def src_tencent(digits, market, out_dir, bars, timeout, res):
    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={tencent_code(digits, market)},day,,,{bars},qfq"
    content = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://gu.qq.com/"}),
                                     timeout=timeout).read()
    raw = save_raw(out_dir, "tencent", EP_TX, content, "json")
    d = json.loads(content).get("data", {}).get(tencent_code(digits, market), {})
    kl = d.get("qfqday") or d.get("day") or []
    if not kl:
        raise ValueError("腾讯 K 线为空")
    return [[k[0], k[1], k[2], k[3], k[4], k[5]] for k in kl], raw, "tencent", EP_TX  # date,open,close,high,low,vol


def main() -> None:
    p = base_parser("日 K 线前复权(腾讯主源 / 东财备源)")
    p.add_argument("--bars", type=int, default=250)
    args = p.parse_args()
    digits, market = parse_symbol_or_exit(args.symbol, SCRIPT, args.out_dir)
    res = result_skeleton(SCRIPT, digits, market)
    for name, fn in (("tencent", src_tencent), ("eastmoney", src_eastmoney)):
        try:
            rows, raw, src, ep = fn(digits, market, args.out_dir, args.bars, args.timeout, res)
            good, bad = validate(rows)
            if not good or to_float(good[-1][2]) is None:
                raise ValueError("无合格 K 线行或最新收盘不可解析")
            last = good[-1]
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field="volume_latest",
                                            value=to_float(last[5]), unit="源单位", period=last[0], source=src, endpoint=ep,
                                            raw_ref=raw["raw_ref"], currency="n/a", adjustment="not_applicable",
                                            note="上游 K 线 vol 原值,未换算;仅用于正成交量校验,不可跨源比较数量"))
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field="close_qfq_latest",
                                            value=to_float(last[2]), unit="元", period=last[0], source=src, endpoint=ep,
                                            raw_ref=raw["raw_ref"], adjustment="qfq"))
            res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field="kline_points", value=len(good),
                                            unit="根", period=f"{good[0][0]}..{last[0]}", source=src, endpoint=ep,
                                            raw_ref=raw["raw_ref"], currency="n/a", adjustment="qfq",
                                            note=f"kline_points = 通过校验的行数;raw_ref 为未过滤原始序列(共 {len(rows)} 行),"
                                                 f"消费 raw 时须重复同样校验;列 date,open,close,high,low,vol[,amount,amplitude]"))
            if bad:
                res["missing"].append({"field": "kline_rows", "reason": f"剔除 {len(bad)} 行:{bad[:3]}"})
            res["extra"].update({"start": good[0][0], "end": last[0], "bars": len(good), "raw_rows_total": len(rows),
                                 "dropped_rows": len(bad)})
            res["primary_source"] = name
            res["status"] = "ok" if (name == "tencent" and not bad) else "partial"
            res["used_sources"].append(name)
            break
        except Exception as e:  # noqa: BLE001
            record_error(res, name, "kline", e)
    finish(res, args.out_dir)


if __name__ == "__main__":
    main()
