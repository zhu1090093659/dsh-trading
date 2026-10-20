"""市场声音(一手信源)层 —— **金融包**的查询词构造与端点。

通用的 Exa MCP 客户端已拆到 `core/exa_client.py`(Core 检索通道);
本文件只保留**属于金融的那部分**:公司名解析、主题查询模板、market_voice / forum_voice 两个端点。

  - 查询词由本模块按公司名**确定性**生成(不是 agent 想的),结果按主题分组;同一运行内相同输入得到相同查询;
  - web_fetch_exa 能读静态页,JS 页(财联社电报)拿不到正文,微信公众号与雪球帖子正文都读不到;
  - 雪球 / 股吧匿名直连被阿里云 WAF 拦截,Jina 读帖子正文被"IP 频繁"墙挡 → 论坛只做标题 / 作者 / 日期 / 链接。
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from core.exa_client import ExaClient, ExaError, domain_of, exa_fetch, exa_search, parse_search_text
from sources.textsafe import sanitize_untrusted   # 不可信文本纪律(脱敏 / 规范形匹配)
# 传输层内部函数:既有测试从本模块引用(测的是同一份实现,客户端拆走后在这里透出)
from core.exa_client import _parse_rpc, parse_sse_events   # noqa: F401

#: 论坛域名是**金融的**(雪球 / 股吧),不属于通用 Exa 客户端
FORUM_DOMAINS = ("xueqiu.com", "guba.eastmoney.com")

# 主题 → 查询模板(确定性;{name} 公司简称,{code} 6 位代码)
MARKET_QUERIES = [
    ("进展", "{name} 最新 业绩 订单 产能 交付 进展"),
    ("风险", "{name} 风险 减持 解禁 诉讼 处罚 问询函"),
    ("行业", "{name} 行业 竞争格局 技术路线 客户 份额"),
    ("英文", "{name} {code} China analyst outlook orders 2026"),
]
FORUM_QUERIES = [
    ("雪球", "{name} 雪球 讨论 观点 帖子"),
    ("股吧", "{name} 股吧 讨论 热帖"),
]



def _company_name(code: str) -> str:
    from sources.tencent import tencent_quote
    try:
        q = tencent_quote(code)
        name = next(iter(q.values())).get("name") if q else None
        return str(name).strip() if name else str(code)
    except Exception:  # noqa: BLE001 — 拿不到简称就用代码搜,不让线索层拖垮运行
        return str(code)


def _parse_iso(ts: str) -> Optional[datetime]:
    """'2026-08-21T02:11:00.000Z' / '2026-08-21' / 带偏移 → aware datetime(UTC);解析不了 → None。"""
    t = (ts or "").strip()
    if not t:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}$", t):
        t += "T00:00:00+00:00"
    t = re.sub(r"Z$", "+00:00", t)
    t = re.sub(r"(\.\d{3})\d+(?=[+-]\d{2}:\d{2}$|$)", r"\1", t)  # 纳秒级小数 → 毫秒(fromisoformat 只吃 3/6 位)
    try:
        d = datetime.fromisoformat(t)
    except ValueError:
        return None
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _normalize_published(published_iso: str, now: Optional[datetime] = None) -> tuple[str, Optional[datetime]]:
    """→ (YYYY-MM-DD 或 '', aware datetime 或 None)。按完整时刻判未来(> now + 1 天容忍时区差)→ 当未注明;非法 → 未注明。"""
    now = now or datetime.now(timezone.utc)
    d = _parse_iso(published_iso)
    if d is None or d > now + timedelta(days=1):
        return "", None
    return d.strftime("%Y-%m-%d"), d


def _is_recent(d: Optional[datetime], days: int, now: Optional[datetime] = None) -> Optional[bool]:
    """近 days 天内(按完整时刻,不是按日期零点)→ True;更早 → False;未注明 → None(语义:不知道,不是"不近")。"""
    if d is None:
        return None
    now = now or datetime.now(timezone.utc)
    return d >= now - timedelta(days=int(days))


def _collect(client: ExaClient, name: str, code: str, templates: list, num_results: int, recent_days: int, only_forum: bool,
             now: Optional[datetime] = None) -> tuple[list, list]:
    now = now or datetime.now(timezone.utc)  # 一次取 now,全部条目同一把尺子
    items, seen, queries = [], set(), []
    for topic, tpl in templates:
        q = tpl.format(name=name, code=code)
        queries.append({"topic": topic, "query": q})
        for it in exa_search(q, num_results, client):
            url = it["url"]
            dom = domain_of(url)
            is_forum = any(dom == d or dom.endswith("." + d) for d in FORUM_DOMAINS)
            if only_forum and not is_forum:
                continue
            if url in seen:
                continue
            seen.add(url)
            pub, pub_dt = _normalize_published(it.get("published_iso") or it.get("published") or "", now)
            items.append({"topic": topic, "kind": "forum" if is_forum else "web", "domain": dom, "url": url,
                          "title": sanitize_untrusted(it["title"], 200), "author": sanitize_untrusted(it["author"], 60),
                          "published": pub, "recent": _is_recent(pub_dt, recent_days, now),
                          "highlights": sanitize_untrusted(it["highlights"], 240), "raw_ref": it.get("raw_ref")})
    # 确定性排序:日期倒序,同日期按 url(查询顺序已固定,去重按首次出现)
    items.sort(key=lambda x: (x["published"] or "", x["url"]), reverse=True)
    return items, queries


def _counts(items: list) -> dict:
    return {"total": len(items), "recent": sum(1 for x in items if x["recent"]), "stale": sum(1 for x in items if x["recent"] is False),
            "undated": sum(1 for x in items if x["recent"] is None)}


def exa_market_voice(code: str, num_results: int = 8, recent_days: int = 60, read_top: int = 3, max_chars: int = 1200, limit: int = 40,
                     now: Optional[datetime] = None) -> dict:
    """全网语义搜索(新闻 / 深度文 / KOL 帖)按主题分组,近 recent_days 天内且非论坛的前 read_top 条再读摘录;items 最多 limit 条。
    返回 {name, code, queries:[{topic,query}], items:[{topic,kind,domain,url,title,author,published,recent,highlights,raw_ref}],
          excerpts:[{url,published,excerpt,chars,raw_ref|error}], counts, recent_days, limit}"""
    name = _company_name(code)
    client = ExaClient().connect()
    items, queries = _collect(client, name, code, MARKET_QUERIES, num_results, recent_days, only_forum=False, now=now)
    items = items[:max(0, int(limit))]
    excerpts = []
    candidates = [x for x in items if x["kind"] == "web" and x["recent"]][:max(0, int(read_top))]
    for it in candidates:
        try:
            txt, raw_ref = exa_fetch(it["url"], max_chars, client)
        except ExaError as e:
            excerpts.append({"url": it["url"], "published": it["published"], "excerpt": "", "chars": 0, "error": str(e)[:160], "raw_ref": client.last_raw_ref})
            continue
        clean = sanitize_untrusted(txt, max_chars)
        excerpts.append({"url": it["url"], "published": it["published"], "excerpt": clean, "chars": len(clean), "raw_ref": raw_ref})
    counts = {**_counts(items), "forum": sum(1 for x in items if x["kind"] == "forum"), "excerpt_candidates": len(candidates),
              "excerpts": sum(1 for x in excerpts if x["chars"]), "excerpt_errors": sum(1 for x in excerpts if not x["chars"])}
    return {"name": name, "code": code, "queries": queries, "items": items, "excerpts": excerpts, "counts": counts, "recent_days": recent_days, "limit": int(limit)}


def exa_forum_voice(code: str, num_results: int = 10, recent_days: int = 90, limit: int = 40, now: Optional[datetime] = None) -> dict:
    """雪球 / 股吧讨论(经 Exa 索引):只保留论坛域名的标题 / 作者 / 日期 / 链接;正文不可读(WAF)。items 最多 limit 条。"""
    name = _company_name(code)
    client = ExaClient().connect()
    items, queries = _collect(client, name, code, FORUM_QUERIES, num_results, recent_days, only_forum=True, now=now)
    items = items[:max(0, int(limit))]
    counts = {**_counts(items), "by_domain": {d: sum(1 for x in items if x["domain"].endswith(d)) for d in FORUM_DOMAINS}}
    return {"name": name, "code": code, "queries": queries, "items": items, "counts": counts, "recent_days": recent_days, "limit": int(limit)}
