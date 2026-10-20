"""巨潮资讯源:公告全文检索(动态 orgId)/ 互动易问答。移植自 a-stock-data SKILL.md §7.1 / §10.1。零鉴权。"""
from __future__ import annotations

import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import TZ_SH, UA, norm_ticker  # noqa: E402
from sources._http import http_get, http_post_json  # noqa: E402

_ORGID: dict = {}


def _ts_to_date(ts) -> str:
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000, TZ_SH).strftime("%Y-%m-%d")
    return str(ts)[:10] if ts else ""


def cninfo_orgid(code: str) -> str:
    """股票 → 巨潮 orgId:官方映射表(HTTPS,经捕获层落 raw,进程内缓存)。查不到即抛错——orgId 决定后续查询对象,不猜、不用老格式硬编码回退。"""
    global _ORGID
    digits, _ = norm_ticker(code, stock_only=False)
    if not _ORGID:
        r = http_get("https://www.cninfo.com.cn/new/data/szse_stock.json", headers={"User-Agent": UA}, timeout=20, ext="json")
        r.raise_for_status()
        _ORGID = {s["code"]: s["orgId"] for s in (r.json() or {}).get("stockList", []) if s.get("code") and s.get("orgId")}
        if not _ORGID:
            raise RuntimeError("巨潮 orgId 映射表为空(接口变更?),拒绝猜测 orgId")
    org = _ORGID.get(digits)
    if not org:
        raise RuntimeError(f"巨潮映射表无 {digits} 的 orgId(未收录 / 代码错误),不回退硬编码")
    return org


def cninfo_announcements(code: str, page_size: int = 30) -> list[dict]:
    """[{title, type, date, url}]"""
    digits, _ = norm_ticker(code, stock_only=True)
    payload = {"stock": f"{digits},{cninfo_orgid(digits)}", "tabName": "fulltext", "pageSize": str(page_size), "pageNum": "1", "column": "", "category": "", "plate": "", "seDate": "",
               "searchkey": "", "secid": "", "sortName": "", "sortType": "", "isHLtitle": "true"}
    headers = {"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Referer": "https://www.cninfo.com.cn/new/disclosure", "Origin": "https://www.cninfo.com.cn"}
    d = http_post_json("https://www.cninfo.com.cn/new/hisAnnouncement/query", data=payload, headers=headers, timeout=15)
    return [{"title": it.get("announcementTitle", ""), "type": it.get("announcementTypeName", ""), "date": _ts_to_date(it.get("announcementTime")),
             "url": f"https://www.cninfo.com.cn/new/disclosure/detail?annoId={it.get('announcementId', '')}"} for it in d.get("announcements", []) or []]


def cninfo_irm(code: str, page_size: int = 30, page_num: int = 1) -> list[dict]:
    """互动易问答(深沪统一):[{code, company, question, answer(None=未回复), answerer, ask_time}]"""
    digits, _ = norm_ticker(code, stock_only=True)
    d1 = http_post_json("https://irm.cninfo.com.cn/newircs/index/queryKeyboardInfo", data={"keyWord": digits}, headers={"User-Agent": UA}, timeout=10).get("data") or []
    if not d1:
        return []
    params = {"_t": 1, "stockcode": digits, "orgId": d1[0].get("secid"), "pageSize": page_size, "pageNum": page_num, "keyWord": "", "startDay": "", "endDay": ""}
    rows = http_post_json("https://irm.cninfo.com.cn/newircs/company/question", params=params, headers={"User-Agent": UA}, timeout=10).get("rows") or []
    out = []
    for it in rows:
        pdt = it.get("pubDate")
        out.append({"code": it.get("stockCode"), "company": it.get("companyShortName"), "question": it.get("mainContent"), "answer": it.get("attachedContent"), "answerer": it.get("attachedAuthor"),
                    "ask_time": datetime.fromtimestamp(pdt / 1000, TZ_SH).strftime("%Y-%m-%d %H:%M") if pdt else ""})
    return out
