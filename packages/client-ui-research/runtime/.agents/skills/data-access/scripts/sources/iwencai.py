"""同花顺 iwencai(问财)源:NL 语义搜索研报 / 公告 / 新闻 + NL 数据查询。需要环境变量 IWENCAI_API_KEY(可选 IWENCAI_BASE_URL)。移植自 a-stock-data SKILL.md §2.3。"""
from __future__ import annotations

import os
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import http_post  # noqa: E402


def _base() -> str:
    return os.environ.get("IWENCAI_BASE_URL", "https://openapi.iwencai.com")


def _headers() -> dict:
    key = os.environ.get("IWENCAI_API_KEY", "")
    if not key:
        raise RuntimeError("需要环境变量 IWENCAI_API_KEY")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "X-Claw-Call-Type": "normal", "X-Claw-Skill-Id": "report-search", "X-Claw-Skill-Version": "2.0.0",
            "X-Claw-Plugin-Id": "none", "X-Claw-Plugin-Version": "none", "X-Claw-Trace-Id": secrets.token_hex(32)}


def _post(path: str, payload: dict, key: str) -> list:
    r = http_post(f"{_base()}{path}", json_body=payload, headers=_headers(), timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"iwencai HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    if data.get("status_code", 0) != 0:
        raise RuntimeError(f"iwencai error: {data.get('status_msg', '')}")
    return data.get(key) or []


def iwencai_search(query: str, channel: str = "report", size: int = 50) -> list[dict]:
    """channel: report / announcement / news;同一 uid 仅保留 score 最高段落,按 publish_date 倒序。"""
    arts = _post("/v1/comprehensive/search", {"channels": [channel], "app_id": "AIME_SKILL", "query": query, "size": size}, "data")
    best: dict = {}
    for a in arts:
        uid = a.get("uid", "") or f"{a.get('title', '')}|{a.get('publish_date', '')}"
        if uid not in best or float(a.get("score", 0)) > float(best[uid].get("score", 0)):
            best[uid] = a
    return sorted(best.values(), key=lambda x: x.get("publish_date", ""), reverse=True)


def iwencai_query(query: str, page: int = 1, limit: int = 50) -> list[dict]:
    """NL 数据查询(结构化行)"""
    return _post("/v1/query2data", {"query": query, "page": str(page), "limit": str(limit), "is_cache": "1", "expand_index": "true"}, "datas")
