"""**Core:Exa 免 key MCP 客户端**(通用检索通道,与任何垂类无关)。

从 `sources/exa.py` 拆出来 —— 那里原本混着两件事:**通用的 MCP 客户端**(本文件)与
**金融的查询词构造 / 市场声音端点**(留在 sources/exa.py)。
Core 检索层(`core/retrieval.py`)要用客户端,却不该反向依赖行业目录。

⚠️ 实测校准(2026-08-23,别照文档改):
- 传输是 **Streamable HTTP JSON-RPC**,响应可能是 SSE,必须按事件解析;
- 必须**严格 UTF-8** 解码,否则中文标题会碎;
- 无域名过滤能力 —— 想限定来源只能靠查询词。
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA  # noqa: E402
from sources._http import http_post  # noqa: E402
from sources.textsafe import sanitize_untrusted  # noqa: E402

MCP_URL = os.environ.get("VRA_EXA_MCP_URL", "https://mcp.exa.ai/mcp")
PROTOCOL = "2025-03-26"
TIMEOUT = 45


class ExaError(RuntimeError):
    pass


def _headers(sid: Optional[str] = None) -> dict:
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": UA}
    if sid:
        h["Mcp-Session-Id"] = sid
    return h


def _decode_utf8(body: bytes) -> str:
    """content-type 不带 charset,必须按 UTF-8 解码;非法字节不悄悄 replace(会把传输损坏吞成乱码线索),直接报错。"""
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ExaError(f"MCP 响应不是合法 UTF-8(offset {e.start})") from e


def parse_sse_events(text: str) -> list[str]:
    """SSE 事件流 → 每个事件的 data 文本(多行 data: 按规范以换行拼接;空行结束一个事件;EOF 收尾)。"""
    events: list[str] = []
    cur: list[str] = []
    for line in text.splitlines():
        if line == "":
            if cur:
                events.append("\n".join(cur))
                cur = []
            continue
        if line.startswith("data:"):
            cur.append(line[5:].lstrip(" "))
    if cur:
        events.append("\n".join(cur))
    return events


def _parse_rpc(body: bytes, rpc_id, content_type: str = "") -> dict:
    """Streamable HTTP 返回 SSE(text/event-stream)或纯 JSON(可为批量数组);取 id 匹配的那条;JSON-RPC error 直接抛。"""
    text = _decode_utf8(body)
    msgs: list = []
    is_sse = "text/event-stream" in (content_type or "").lower() or text.lstrip().startswith(("data:", "event:", ":"))
    if is_sse:
        bad = 0
        for ev_data in parse_sse_events(text):
            try:
                d = json.loads(ev_data)
            except json.JSONDecodeError:
                bad += 1
                continue
            msgs.extend(d if isinstance(d, list) else [d])
        if not msgs:
            raise ExaError(f"SSE 流里没有可解析的 JSON-RPC 消息(坏事件 {bad} 个):{text[:120]!r}")
    else:
        try:
            d = json.loads(text)
        except json.JSONDecodeError as e:
            raise ExaError(f"MCP 响应既不是 SSE 也不是 JSON:{text[:120]!r}") from e
        msgs = d if isinstance(d, list) else [d]
    for d in msgs:
        if isinstance(d, dict) and d.get("jsonrpc") == "2.0" and d.get("id") == rpc_id:
            if "error" in d:
                raise ExaError(f"MCP 错误:{json.dumps(d['error'], ensure_ascii=False)[:300]}")
            return d.get("result") or {}
    raise ExaError(f"MCP 响应里没有 id={rpc_id} 的 JSON-RPC 结果(收到 {len(msgs)} 条消息)")


class ExaClient:
    """一次取数一个会话:initialize 拿 Mcp-Session-Id,之后的 tools/call 复用。每次 RPC 的响应原文经 http_post 落 raw,
    `last_raw_ref` 指向**刚才那次**请求的 raw 文件(逐请求绑定,不是整个端点共用最后一份)。"""

    def __init__(self, url: str = MCP_URL, timeout: int = TIMEOUT):
        self.url, self.timeout, self.sid, self._id, self.last_raw_ref = url, timeout, None, 0, None

    def _rpc(self, method: str, params: dict, notify: bool = False) -> dict:
        self._id += 1
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notify:
            payload["id"] = self._id
        try:
            r = http_post(self.url, json_body=payload, headers=_headers(self.sid), timeout=self.timeout, ext="txt")
        except Exception as e:  # noqa: BLE001 — 超时 / 连接错误统一成 ExaError,信封层 fail-fast 出声
            raise ExaError(f"MCP 请求失败({method}):{type(e).__name__}: {str(e)[:160]}") from e
        self.last_raw_ref = getattr(r, "_vra_raw_ref", None)
        if r.status_code >= 400:
            raise ExaError(f"MCP HTTP {r.status_code}({method}):{(r.content or b'').decode('utf-8', 'replace')[:200]}")
        if not self.sid and r.headers.get("Mcp-Session-Id"):
            self.sid = r.headers["Mcp-Session-Id"]
        return {} if notify else _parse_rpc(r.content, self._id, r.headers.get("Content-Type", ""))

    def connect(self) -> "ExaClient":
        self._rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "vibe-research-agent", "version": "0.1"}})
        self._rpc("notifications/initialized", {}, notify=True)
        return self

    def call_text(self, tool: str, arguments: dict) -> tuple[str, Optional[str]]:
        """→ (工具返回的文本, 本次响应的 raw_ref)"""
        res = self._rpc("tools/call", {"name": tool, "arguments": arguments})
        # `text` 必须是字符串:上游给 null / 对象时 join 会抛 TypeError,把**协议畸形**混同成普通通道失败
        txt = "\n".join(c["text"] for c in res.get("content", [])
                         if isinstance(c, dict) and isinstance(c.get("text"), str))
        if res.get("isError"):
            raise ExaError(f"{tool} 返回错误:{txt[:200]}")
        return txt, self.last_raw_ref


_BLOCK_RE = re.compile(r"^Title: ", re.M)
_FIELD_RE = {"title": re.compile(r"^Title: (.*)$", re.M), "url": re.compile(r"^URL: (\S+)", re.M),
             "published": re.compile(r"^Published: (.*)$", re.M), "author": re.compile(r"^Author: (.*)$", re.M)}
_NO_RESULT_RE = re.compile(r"no results|0 results|没有(找到|搜索到)|未找到", re.I)


def parse_search_text(text: str) -> list[dict]:
    """Exa 文本 → [{title, url, published(YYYY-MM-DD 或 ''), author, highlights}];highlights = 该块里 'Highlights:' 之后的全部文本。
    空文本或明确的"无结果"提示 → [];**有内容却一条都解析不出 → 抛错**(协议 / 文本格式漂移不能静默变成"没线索")。"""
    items = []
    for blk in _BLOCK_RE.split(text):
        blk = "Title: " + blk if blk and not blk.startswith("Title: ") else blk
        m_url = _FIELD_RE["url"].search(blk)
        if not m_url:
            continue
        def f(k: str) -> str:
            m = _FIELD_RE[k].search(blk)
            return (m.group(1) or "").strip() if m else ""
        pub_iso = f("published")
        pub = pub_iso[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", pub_iso) else ""
        hl = blk.split("Highlights:", 1)[1] if "Highlights:" in blk else ""
        items.append({"title": f("title"), "url": m_url.group(1).strip(), "published": pub, "published_iso": pub_iso if pub else "",
                      "author": f("author"), "highlights": hl.strip()})
    if not items and text.strip() and not _NO_RESULT_RE.search(text):
        raise ExaError(f"搜索响应有内容但解析为 0 条(文本格式可能漂移):{text.strip()[:120]!r}")
    return items


def domain_of(url: str) -> str:
    m = re.match(r"^https?://([^/]+)", url or "")
    return m.group(1).lower() if m else ""


def exa_search(query: str, num_results: int = 8, client: Optional[ExaClient] = None) -> list[dict]:
    """每条 item 带 raw_ref = 这次搜索响应的 raw 文件。"""
    c = client or ExaClient().connect()
    txt, raw_ref = c.call_text("web_search_exa", {"query": query, "numResults": int(num_results)})
    return [{**it, "raw_ref": raw_ref} for it in parse_search_text(txt)]


def exa_fetch(url: str, max_chars: int = 1200, client: Optional[ExaClient] = None) -> tuple[str, Optional[str]]:
    """→ (正文文本, raw_ref)"""
    c = client or ExaClient().connect()
    return c.call_text("web_fetch_exa", {"urls": [url], "maxCharacters": int(max_chars)})