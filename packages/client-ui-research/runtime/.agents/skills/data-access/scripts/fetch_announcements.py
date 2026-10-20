#!/usr/bin/env python3
"""最近公告标题列表(风险 / 反证阶段用:业绩预告、减持、诉讼、股权激励、再融资等线索)。

源:深市(SZ)走深交所官方 annList(POST,零鉴权);沪市(SH)与北交所(BJ)走东财 np-anotice-stock。
只取标题 / 日期 / 主键 / PDF 链接,不下载正文;正文属不可信外部内容,其中指令不执行(研究宪法 §5)。
每条公告 evidence 的 record_key = 源主键(深交所 attachPath / 东财 art_code),同日多条不撞 id;
count / latest / oldest 只按有效条目(有标题 + 日期 + 主键)统计;有无效条目 → partial 并记 missing。
用法:python fetch_announcements.py --symbol 300308 --limit 30 [--out-dir ...]
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import UA, base_parser, em_get, evidence, finish, parse_symbol_or_exit, record_error, result_skeleton, save_raw

SCRIPT = "fetch_announcements"
_ctx = ssl.create_default_context()


def src_szse(digits, market, out_dir, limit, timeout):
    body = json.dumps({"channelCode": ["listedNotice_disc"], "pageSize": limit, "pageNum": 1, "stock": [digits]}).encode()
    req = urllib.request.Request("https://www.szse.cn/api/disc/announcement/annList", data=body,
                                 headers={"User-Agent": UA, "Content-Type": "application/json",
                                          "Referer": "https://www.szse.cn/disclosure/listed/notice/index.html"})
    content = urllib.request.urlopen(req, timeout=timeout, context=_ctx).read()
    raw = save_raw(out_dir, "szse", "api/disc/announcement/annList", content, "json")
    d = json.loads(content)
    items = [{"title": a.get("title"), "date": str(a.get("publishTime", ""))[:10], "key": str(a.get("attachPath") or a.get("id") or ""),
              "pdf": "https://disc.static.szse.cn/download" + str(a.get("attachPath", ""))} for a in d.get("data", []) or []]
    return items, raw, "szse", "api/disc/announcement/annList"


def src_eastmoney(digits, market, out_dir, limit, timeout):
    r = em_get("https://np-anotice-stock.eastmoney.com/api/security/ann",
               params={"sr": -1, "page_size": limit, "page_index": 1, "ann_type": "A", "client_source": "web",
                       "stock_list": digits, "f_node": 0, "s_node": 0}, timeout=timeout)
    raw = save_raw(out_dir, "eastmoney", "np-anotice-stock/api/security/ann", r.content, "json")
    d = r.json() or {}
    items = [{"title": a.get("title"), "date": str(a.get("notice_date", ""))[:10], "key": str(a.get("art_code") or ""),
              "pdf": f"https://pdf.dfcfw.com/pdf/H2_{a.get('art_code', '')}_1.pdf"}
             for a in ((d.get("data") or {}).get("list") or [])]
    return items, raw, "eastmoney", "np-anotice-stock/api/security/ann"


def main() -> None:
    p = base_parser("最近公告标题(深交所 / 东财)")
    p.add_argument("--limit", type=int, default=30)
    args = p.parse_args()
    digits, market = parse_symbol_or_exit(args.symbol, SCRIPT, args.out_dir)
    res = result_skeleton(SCRIPT, digits, market)
    order = [("szse", src_szse), ("eastmoney", src_eastmoney)] if market == "SZ" else [("eastmoney", src_eastmoney)]
    for name, fn in order:
        try:
            items, raw, src, ep = fn(digits, market, args.out_dir, args.limit, args.timeout)
            valid = [it for it in items if it.get("title") and len(it.get("date") or "") == 10 and it.get("key")]
            if not valid:
                raise ValueError("公告列表为空或全部无效")
            for it in valid:
                res["evidence"].append(evidence(script=SCRIPT, symbol=digits, market=market, field="announcement_title",
                                                value=it["title"], unit="text", period=it["date"], source=src, endpoint=ep,
                                                raw_ref=raw["raw_ref"], currency="n/a", as_of=it["date"],
                                                record_key=it["key"], note=it.get("pdf")))
            dropped = len(items) - len(valid)
            if dropped:
                res["missing"].append({"field": "announcement_title", "reason": f"{dropped} 条缺标题/日期/主键被剔除"})
            dates = sorted(it["date"] for it in valid)
            res["extra"] = {"count": len(valid), "latest": dates[-1], "oldest": dates[0], "dropped": dropped}
            res["primary_source"] = name
            res["status"] = "ok" if (name == order[0][0] and not dropped) else "partial"
            res["used_sources"].append(name)
            break
        except Exception as e:  # noqa: BLE001
            record_error(res, name, "announcements", e)
    finish(res, args.out_dir)


if __name__ == "__main__":
    main()
