"""JSON stdin adapter for public web retrieval; reuses the existing source clients."""
import json
import sys
from urllib.parse import parse_qsl, urlsplit

from core.cdp import assert_fetchable_url
from core.retrieval import SENSITIVE_QUERY_KEY, fetch_page, search
from core.stdio_utf8 import force_utf8_stdio


def retrieve(request):
    """Only two public read operations, with no file paths or caller-selected proxy."""
    if not isinstance(request, dict):
        raise ValueError("invalid request")
    if request.get("action") == "search":
        if set(request) - {"action", "query", "limit"}:
            raise ValueError("unexpected fields")
        query = request.get("query")
        limit = request.get("limit", 5)
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 500:
            raise ValueError("invalid query")
        if type(limit) is not int or not 1 <= limit <= 10:
            raise ValueError("invalid limit")
        return {"results": search(query, limit, provider="exa_free"), "untrusted": True}
    if request.get("action") == "read":
        if set(request) != {"action", "url"}:
            raise ValueError("unexpected fields")
        url = request["url"]
        if not isinstance(url, str):
            raise ValueError("invalid url")
        parsed = urlsplit(url)
        if parsed.username or parsed.password or any(SENSITIVE_QUERY_KEY.search(k) for k, _ in parse_qsl(parsed.query)):
            raise ValueError("credential-bearing url")
        assert_fetchable_url(url)
        result = fetch_page(url, max_chars=24_000, provider="jina")
        return {**result, "untrusted": True}
    raise ValueError("unknown action")


if __name__ == "__main__":
    force_utf8_stdio()
    try:
        payload = sys.stdin.read(64_001)
        if len(payload) > 64_000:
            raise ValueError("oversized request")
        print(json.dumps(retrieve(json.loads(payload)), ensure_ascii=False))
    except Exception:
        # Provider errors may contain URLs or credentials. Never echo them to the model.
        print(json.dumps({"error": "web_retrieval_failed", "message": "网页或搜索暂时不可用，或输入不合法；这不代表没有结果。"}, ensure_ascii=False))
        sys.exit(1)
