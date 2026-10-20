"""港交所披露易(www1.hkexnews.hk)源:按标题分类检索港股业绩公告(末期 / 中期 / 季度),带港交所给的发布时间(香港时间)。零鉴权。

给事件回看用:业绩公告的发布时间决定第 0 天(港股 16:00 收市后发布的,反应在下一个交易日)。
2026-10-09 实测:00700 取到 2010 年以来末期 17 次、中期 18 次、季度 34 次;00005 季度业绩 12:00 午休时段发布。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA  # noqa: E402
from sources._http import DataNotAvailable, http_get, norm_hk  # noqa: E402

BASE = "https://www1.hkexnews.hk"
#: 披露易「公告及通告」下的业绩分类(t2code)→ 名字
RESULT_TYPES = (("13300", "末期业绩"), ("13400", "中期业绩"), ("13600", "季度业绩"))
#: 披露易电子存档从 1999 年 4 月开始
SINCE = "19990401"
#: 每类一次最多取这么多条;港交所用 hasNextRow 说明后面还有没有
ROW_RANGE = 500


def _jsonp(text: str) -> dict:
    try:
        return json.loads(text[text.index("(") + 1:text.rindex(")")])
    except ValueError as e:
        raise RuntimeError(f"港交所代码查询的返回看不懂(前 80 字:{text[:80]!r})") from e


def _stock(code: str) -> tuple[int, str]:
    """港股代码 → (披露易内部编号, 股票名)。前缀查询会带出一串相近代码,只认完全相同的那个。"""
    r = http_get(f"{BASE}/search/prefix.do", params={"callback": "callback", "lang": "ZH", "type": "A", "name": code, "market": "SEHK"},
                 headers={"User-Agent": UA}, timeout=20)
    r.raise_for_status()
    hit = next((x for x in _jsonp(r.text).get("stockInfo") or [] if str(x.get("code")) == code), None)
    if not hit or not isinstance(hit.get("stockId"), int):
        raise DataNotAvailable(f"披露易查不到 {code}(代码不对、已退市或不是主板 / 创业板股票)")
    return hit["stockId"], str(hit.get("name") or "")


def _when(s: str) -> datetime:
    return datetime.strptime(s.strip(), "%d/%m/%Y %H:%M")


def _result_items(d, label: str) -> list:
    """检索结果里的公告列表。result 是 JSON 字符串(实测空分类给 "[]");空串 / "null" / None,或没有 result 但 recordCnt=0,都算这类没有公告。
    其余看不懂的都报来源坏了,不当没有。"""
    if not isinstance(d, dict) or ("result" not in d and d.get("recordCnt") != 0):
        raise RuntimeError(f"披露易{label}检索的返回结构变了(没有 result)")
    raw = d.get("result")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw.strip() else None
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"披露易{label}检索的 result 不是 JSON") from exc
    if raw is None:
        cnt = d.get("recordCnt")
        if isinstance(cnt, int) and cnt > 0:
            raise RuntimeError(f"披露易{label}检索说有 {cnt} 条却没给 result")
        return []
    if not isinstance(raw, list):
        raise RuntimeError(f"披露易{label}检索的 result 不是列表")
    return [x for x in raw if isinstance(x, dict)]


def hk_results_announcements(code: str) -> dict:
    """港股业绩公告:{code, name, rows: [{date, time(香港时间 HH:MM), category, title, url, news_id}], truncated: [分类名]}。

    同一份公告挂在几个分类下时只留一次(按 NEWS_ID)。标题是源原文,映射层净化。"""
    code = norm_hk(code)
    stock_id, name = _stock(code)
    rows: list[dict] = []
    seen: set[str] = set()
    truncated: list[str] = []
    for t2, label in RESULT_TYPES:
        params = {"sortDir": "0", "sortByOptions": "DateTime", "category": "0", "market": "SEHK", "stockId": str(stock_id), "documentType": "-1",
                  "fromDate": SINCE, "toDate": date.today().strftime("%Y%m%d"), "title": "", "searchType": "1", "t1code": "10000", "t2Gcode": "-2",
                  "t2code": t2, "rowRange": str(ROW_RANGE), "lang": "zh"}
        r = http_get(f"{BASE}/search/titleSearchServlet.do", params=params, headers={"User-Agent": UA}, timeout=30)
        r.raise_for_status()
        d = r.json()
        items = _result_items(d, label)
        if d.get("hasNextRow"):
            truncated.append(label)
        for x in items:
            nid = str(x.get("NEWS_ID") or "")
            if nid and nid in seen:
                continue
            seen.add(nid)
            try:
                when = _when(str(x.get("DATE_TIME") or ""))
            except ValueError:
                rows.append({"date": None, "time": None, "category": label, "title": x.get("TITLE"), "url": None, "news_id": nid})
                continue
            link = str(x.get("FILE_LINK") or "")
            rows.append({"date": when.date().isoformat(), "time": when.strftime("%H:%M"), "category": label, "title": x.get("TITLE"),
                         "url": f"{BASE}{link}" if link.startswith("/") else None, "news_id": nid})
    rows.sort(key=lambda x: (x.get("date") or "", x.get("time") or ""), reverse=True)
    return {"code": code, "name": name, "rows": rows, "truncated": truncated}
