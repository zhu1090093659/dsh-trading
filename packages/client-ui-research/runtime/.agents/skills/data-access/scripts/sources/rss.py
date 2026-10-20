"""RSS 新闻雷达(移植自 simonlin1212/investment-news):datasources/rss_sources.json 的 106 个 tier-1 策展源 × 12 行业;stdlib xml.etree 解析(不依赖 feedparser),按源超时 + 并发,近 N 天过滤,红线关键词标记。
每个源的响应原文经 _http.http_get 落盘。"""
from __future__ import annotations

import os
import re
import sys
import contextvars
import xml.etree.ElementTree as ET
from html import unescape
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA  # noqa: E402
from sources._http import http_get  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES_PATH = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..", "datasources", "rss_sources.json"))
_NS = {"atom": "http://www.w3.org/2005/Atom", "dc": "http://purl.org/dc/elements/1.1/", "media": "http://search.yahoo.com/mrss/"}


def load_sources(path: str = SOURCES_PATH) -> dict:
    import json
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _text(el, *paths) -> str:
    for p in paths:
        x = el.find(p, _NS)
        if x is not None:
            t = (x.text or "").strip()
            if not t and x.get("href"):
                return x.get("href")
            if t:
                return t
    return ""


def _parse_date(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_feed(content: bytes, limit: int = 20) -> list[dict]:
    """RSS 2.0 / Atom → [{title, link, published(ISO UTC), summary}]"""
    root = ET.fromstring(content)
    items = []
    for it in root.iter():
        tag = it.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        # 标题和摘要常是 HTML 文本(Atom 的 type="html"、RSS 的 description):XML 解析只解一层,
        # 里面的 &#8217; / &amp; 还得再解一次,不然界面原样显示实体(The Verge 的标题就是这样)
        title = unescape(_text(it, "title", "atom:title"))
        link = _text(it, "link", "atom:link[@rel='alternate']", "atom:link", "guid")
        pub = _parse_date(_text(it, "pubDate", "atom:published", "atom:updated", "dc:date"))
        summary = unescape(re.sub(r"<[^>]+>", "", _text(it, "description", "atom:summary", "atom:content")))[:300]
        if title:
            items.append({"title": title.strip(), "link": link, "published": pub.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M") if pub else "", "summary": summary})
        if len(items) >= limit:
            break
    return items


def _fetch_one(src: dict, per_source: int, timeout: int) -> dict:
    try:
        r = http_get(src["url"], headers={"User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5"}, timeout=timeout, ext="xml")
        r.raise_for_status()
        ref = getattr(r, "_vra_raw_ref", None)
        return {"source": src["name"], "industry": src.get("hint"), "ok": True, "items": [{**it, "_raw": ref} for it in parse_feed(r.content, per_source)]}
    except Exception as e:  # noqa: BLE001 — 单源失败不拖垮整体,记入结果
        return {"source": src["name"], "industry": src.get("hint"), "ok": False, "error": f"{type(e).__name__}: {str(e)[:120]}", "items": []}


def rss_news(industry: Optional[str] = None, sources: Optional[list] = None, per_source: int = 10, recent_days: int = 3, timeout: int = 12, workers: int = 8, max_sources: int = 40) -> dict:
    """industry: 行业 key(ai / semiconductor / ...,见 rss_sources.json industries);sources: 指定源名列表;近 recent_days 天内条目;每源 per_source 条。
    返回 {industry, sources_tried, sources_ok, items:[{source, industry, title, link, published, summary, redline}], failures:[...]}"""
    cfg = load_sources()
    pool = cfg["sources"]
    if sources:
        pool = [s for s in pool if s["name"] in set(sources)]
    elif industry:
        pool = [s for s in pool if s.get("hint") == industry]
    pool = [s for s in pool if s.get("type", "rss") == "rss"][:max_sources]
    if not pool:
        raise ValueError(f"无匹配 RSS 源(industry={industry!r}, sources={sources!r});可选行业: {[i['key'] for i in cfg.get('industries', [])]}")
    red = [k for k in cfg.get("redline_keywords", []) if k]
    cutoff = datetime.now(timezone.utc) - timedelta(days=recent_days)
    results = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        # contextvars 不会自动进入工作线程:每个任务拷贝一份上下文,让线程内的 http_get 仍记录到同一个 capture
        futs = [ex.submit(contextvars.copy_context().run, _fetch_one, s, per_source, timeout) for s in pool]
        for f in as_completed(futs):
            results.append(f.result())
    items, failures = [], []
    for r in results:
        if not r["ok"]:
            failures.append({"source": r["source"], "error": r.get("error")})
            continue
        for it in r["items"]:
            if it["published"] and datetime.strptime(it["published"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc) < cutoff:
                continue
            hit = [k for k in red if k in (it["title"] + it.get("summary", ""))]
            items.append({"source": r["source"], "industry": r["industry"], **it, "redline": hit})
    items.sort(key=lambda x: x["published"], reverse=True)
    # industries 一起返回:界面要给用户切换行业,而**能切哪几个只有这份配置知道**。
    # 让界面自己抄一份行业表 = 配置改了界面不知道,选项与真实源静默对不上。
    return {"industry": industry, "sources_tried": len(pool), "sources_ok": len(pool) - len(failures),
            "items": items, "failures": failures, "recent_days": recent_days,
            "industries": [{"key": i.get("key"), "name": i.get("name")} for i in cfg.get("industries", []) if i.get("key")]}
