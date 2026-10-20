"""源库公共层:HTTP 取数 + 原始响应自动落盘(捕获上下文)+ 官方源限流 + 市场代码工具。

设计:
- 上游(a-stock-data / global-stock-data)代码块里的 requests.get / urlopen 一律改走这里的 http_get / http_text / http_json,
  这样每次传输层响应都按 研究宪法 §4 契约原样落到 <out_dir>/raw/,并把 raw_ref 记到当前捕获上下文,供映射层写进 evidence。
- 东财系请求仍走 common.em_get(跨进程串行锁);这里只是把它包一层以便落盘。
- 美股官方源(SEC / FINRA / CBOE / Treasury / CFTC / Nasdaq)走 official_get:按主机限流 + SEC 必须带真实联系方式 UA(环境变量 VRA_SEC_CONTACT)。
- 上下文用 contextvars,取数器在调用源函数前 with capture(...) 包住,源函数内部任何 http_* 调用都会自动记录。
"""
from __future__ import annotations

import contextvars
import json
import os
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA, em_get as _em_get, save_raw  # noqa: E402


@dataclass
class Capture:
    out_dir: Optional[str]
    source: str
    endpoint: str
    raws: list = field(default_factory=list)  # [{raw_ref, sha256, url, kind}]

    def record(self, content: bytes, ext: str, url: str = "", kind: str = "raw") -> Optional[str]:
        info = save_raw(self.out_dir, self.source, self.endpoint, content, ext, kind)
        self.raws.append({**info, "url": url[:200]})
        return info["raw_ref"]

    @property
    def last_raw_ref(self) -> Optional[str]:
        return self.raws[-1]["raw_ref"] if self.raws else None


_current: contextvars.ContextVar[Optional[Capture]] = contextvars.ContextVar("vra_capture", default=None)


class capture:
    """with capture(out_dir, source, endpoint) as cap: ... 源函数内的 http_* 调用自动落盘到 cap。"""

    def __init__(self, out_dir: Optional[str], source: str, endpoint: str):
        self.cap = Capture(out_dir, source, endpoint)

    def __enter__(self) -> Capture:
        self._token = _current.set(self.cap)
        return self.cap

    def __exit__(self, *exc):
        _current.reset(self._token)
        return False


def current_capture() -> Optional[Capture]:
    return _current.get()


def last_raw_ref() -> Optional[str]:
    """当前 capture 最近一次落盘的 raw_ref(单线程顺序请求时 = 刚才那次请求;并发场景请用 Response._vra_raw_ref)。"""
    cap = _current.get()
    return cap.last_raw_ref if cap is not None else None


def insecure_tls_allowed() -> bool:
    """证书校验失败时是否允许降级为不校验(仅研究用,默认否):环境变量 VRA_ALLOW_INSECURE_TLS=1。"""
    return os.environ.get("VRA_ALLOW_INSECURE_TLS", "") in ("1", "true", "yes")


def record_raw(content: bytes, ext: str = "json", url: str = "", kind: str = "raw") -> Optional[str]:
    """不经 http_* 取得的数据(TCP 客户端 / SDK DataFrame)由源函数显式落盘;kind=extracted 表示非传输层原文。"""
    cap = _current.get()
    return cap.record(content, ext, url, kind) if cap else None


def _guess_ext(content_type: str, url: str, content: bytes = b"") -> str:
    """按 Content-Type / URL 后缀定扩展名;text/plain 但正文以 { [ 开头(东财 datacenter / reportapi 常见)→ json。"""
    ct = (content_type or "").lower()
    if "json" in ct or url.endswith(".json"):
        return "json"
    head = content[:64].lstrip() if content else b""
    if head[:1] in (b"{", b"[") and "html" not in ct:
        return "json"
    if "html" in ct:
        return "html"
    if "xml" in ct or "rss" in ct or "atom" in ct:
        return "xml"
    if "csv" in ct or url.endswith(".csv"):
        return "csv"
    if "pdf" in ct or url.endswith(".pdf"):
        return "pdf"
    if "excel" in ct or "spreadsheet" in ct or url.endswith((".xls", ".xlsx")):
        return "xls"
    return "txt"


# ---------------- 普通 HTTP(requests) ----------------
_sessions: dict[str, Any] = {}
_lock = threading.Lock()


def _session(trust_env: bool = True):
    import requests

    key = f"s{int(trust_env)}"
    with _lock:
        if key not in _sessions:
            s = requests.Session()
            s.trust_env = trust_env
            s.headers.update({"User-Agent": UA})
            _sessions[key] = s
        return _sessions[key]


def http_get(url: str, params: Optional[dict] = None, headers: Optional[dict] = None, timeout: int = 15,
             encoding: Optional[str] = None, ext: Optional[str] = None, **kw):
    """GET → requests.Response;响应原文自动落盘。encoding 指定解码(如 gbk)。"""
    r = _session(True).get(url, params=params, headers=headers, timeout=timeout, **kw)
    if encoding:
        r.encoding = encoding
    cap = _current.get()
    r._vra_raw_ref = cap.record(r.content, ext or _guess_ext(r.headers.get("Content-Type", ""), r.url, r.content), r.url) if cap is not None else None  # type: ignore[attr-defined]
    return r


def http_post(url: str, data: Optional[dict] = None, json_body: Optional[Any] = None, params: Optional[dict] = None, headers: Optional[dict] = None,
              timeout: int = 15, ext: Optional[str] = None, **kw):
    """POST(表单 data 或 JSON body)→ requests.Response;响应原文自动落盘。"""
    r = _session(True).post(url, data=data, json=json_body, params=params, headers=headers, timeout=timeout, **kw)
    cap = _current.get()
    r._vra_raw_ref = cap.record(r.content, ext or _guess_ext(r.headers.get("Content-Type", ""), r.url, r.content), r.url) if cap is not None else None  # type: ignore[attr-defined]
    return r


def http_post_json(url: str, **kw) -> Any:
    r = http_post(url, **kw)
    r.raise_for_status()
    return r.json()


def http_text(url: str, **kw) -> str:
    r = http_get(url, **kw)
    r.raise_for_status()
    return r.text


def http_json(url: str, **kw) -> Any:
    r = http_get(url, **kw)
    r.raise_for_status()
    return r.json()


def em(url: str, params: Optional[dict] = None, headers: Optional[dict] = None, timeout: int = 15, ext: Optional[str] = None):
    """东财系:走 common.em_get(跨进程串行 + 代理回退),响应落盘。"""
    r = _em_get(url, params=params, headers=headers, timeout=timeout)
    cap = _current.get()
    r._vra_raw_ref = cap.record(r.content, ext or _guess_ext(r.headers.get("Content-Type", ""), r.url, r.content), r.url) if cap is not None else None  # type: ignore[attr-defined]
    return r


def em_json(url: str, **kw) -> Any:
    r = em(url, **kw)
    r.raise_for_status()
    return r.json()


def urlopen_bytes(url: str, headers: Optional[dict] = None, timeout: int = 15, ext: str = "txt") -> bytes:
    """标准库取原文(上游若干脚本用 urllib),同样落盘。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    cap = _current.get()
    if cap is not None:
        cap.record(data, ext, url)
    return data


# ---------------- 美股官方源统一出口(移植自 global-stock-data V2.0) ----------------
class DataNotAvailable(RuntimeError):
    """该日 / 该标的确实没有数据(非交易日、文件未发布)——可安全回退;与配置 / 网络错误区分。"""


class ResourceUnavailable(RuntimeError):
    """资源未取得，不能据此推断业务无数据。日期/形式回退仅由对应源函数决定。"""


class _RateLimiter:
    def __init__(self, max_per_sec: float):
        self._interval = 1.0 / float(max_per_sec)
        self._last = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            gap = self._interval - (time.monotonic() - self._last)
            if gap > 0:
                time.sleep(gap)
            self._last = time.monotonic()


_LIMITS = {"sec.gov": _RateLimiter(8), "finra.org": _RateLimiter(4), "cboe.com": _RateLimiter(4), "nasdaq.com": _RateLimiter(2),
           "_default": _RateLimiter(5)}


def _limiter_for(url: str) -> _RateLimiter:
    for host, lim in _LIMITS.items():
        if host != "_default" and host in url:
            return lim
    return _LIMITS["_default"]


def sec_contact() -> str:
    """SEC 要求 UA 含真实联系方式:'Name email@domain';从环境变量 VRA_SEC_CONTACT 读,不进配置文件。

    整理口径与设置页一致:中间连续空白(含换行、制表符)并成一个空格,只收可打印英文字符,不合格当没填。
    🔴 不整理的话,夹着换行的值会被 requests 拒绝,而它的报错里带着整串原值 —— 姓名就跟着错误信息进了信封。
    """
    v = " ".join(os.environ.get("VRA_SEC_CONTACT", "").split())
    return v if v and all(" " <= ch <= "~" for ch in v) else ""


def _may_be_unavailable_object(resp) -> bool:
    # S3 缺少 ListBucket 权限时，不存在的对象也可能返回 AccessDenied；
    # 反过来 AccessDenied 不能证明对象不存在。
    if resp.status_code == 404:
        return True
    if resp.status_code != 403:
        return False
    ctype = (resp.headers.get("Content-Type") or "").lower()
    head = (resp.text or "")[:500]
    return "xml" in ctype and "<Code>AccessDenied</Code>" in head


def official_get(url: str, params: Optional[dict] = None, headers: Optional[dict] = None, timeout: int = 30,
                 as_json: bool = False, ext: Optional[str] = None):
    """SEC / FINRA / CBOE / Treasury / CFTC / Nasdaq:按主机限流 + SEC UA 声明 + 友好错误;响应落盘。
    raw 绑定:响应原文经 capture 落盘;因返回值为 json/str(非 Response),调用方若需本次 raw_ref 请在调用后立即用 last_raw_ref()(顺序调用场景)。
    """
    import requests

    if "sec.gov" in url:
        c = sec_contact()
        if not c or "@" not in c:
            if os.environ.get("VRA_SEC_CONTACT", "").strip():   # 填了但格式不对:不把填的内容拼进来
                raise RuntimeError("SEC 联系方式格式不对:只能用英文姓名和邮箱(英文字符),例如 'Zhang San zhangsan@example.com'")
            raise RuntimeError("SEC 要求声明 User-Agent(真实姓名与邮箱):请在「接入 AI」页填 SEC 联系方式,或设置环境变量 VRA_SEC_CONTACT='Name email@domain'")
        h = {"User-Agent": c, "Accept-Encoding": "gzip, deflate"}
    else:
        h = {"User-Agent": UA}
    h.update(headers or {})
    _limiter_for(url).wait()
    try:
        r = _session(True).get(url, params=params, headers=h, timeout=timeout)
        cap = _current.get()
        if cap is not None:
            cap.record(r.content, ext or _guess_ext(r.headers.get("Content-Type", ""), r.url, r.content), r.url)
        r.raise_for_status()
    except requests.HTTPError as e:
        resp = e.response
        if resp is None:  # raise_for_status 一定带响应；别处构造的 HTTPError 不带，原样抛出
            raise
        code = resp.status_code
        low = (resp.text or "")[:4000].lower()
        if code == 403 and "undeclared" in low:
            # 不把填的姓名邮箱拼进来:错误消息会进信封、经 API / MCP 回传
            raise RuntimeError("SEC 拒绝:User-Agent 未被识别为已声明(检查填的 SEC 联系方式是不是「英文姓名 邮箱」)") from e
        if _may_be_unavailable_object(resp):
            raise ResourceUnavailable(f"HTTP {code} {url[:80]} — 资源未取得，无法确认数据是否存在；可能未发布、路径变更或访问受限") from e
        hint = {403: "被拒绝:限流 / 封禁 / 权限，原因未核实", 429: "请求过快"}.get(code, "")
        raise RuntimeError(f"HTTP {code} {url[:80]} — {hint}") from e
    except requests.RequestException as e:
        raise RuntimeError(f"请求失败 {url[:80]} — {type(e).__name__}: {e}") from e
    return r.json() if as_json else r.text


# ---------------- Yahoo crumb 会话(移植) ----------------
# 设计说明:fc.yahoo.com(取 cookie)与 getcrumb(取 crumb)两次握手属**鉴权辅助流**,不是数据响应:不落 raw、crumb 不会出现在任何 evidence.raw_ref;
# 只有随后 yahoo_get 的业务响应落盘。这样避免会话令牌进入运行目录,同时保持"数据响应全量落盘"。
_yahoo: dict[str, Any] = {"session": None, "crumb": None}


def yahoo_session():
    import requests

    if _yahoo["session"] is not None and _yahoo["crumb"]:
        return _yahoo["session"], _yahoo["crumb"]
    s = requests.Session()
    s.headers["User-Agent"] = UA
    s.get("https://fc.yahoo.com", timeout=10)
    r = s.get("https://query2.finance.yahoo.com/v1/test/getcrumb", timeout=10)
    r.raise_for_status()
    _yahoo["session"], _yahoo["crumb"] = s, r.text
    return s, r.text


def yahoo_get(url: str, params: Optional[dict] = None, timeout: int = 15) -> Any:
    s, crumb = yahoo_session()
    r = s.get(url, params={**(params or {}), "crumb": crumb}, timeout=timeout)
    cap = _current.get()
    r._vra_raw_ref = cap.record(r.content, "json", r.url) if cap is not None else None  # type: ignore[attr-defined]
    r.raise_for_status()
    return r.json()


def yahoo_quote_summary(symbol: str, modules: list[str]) -> dict:
    data = yahoo_get(f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}", {"modules": ",".join(modules)})
    results = (data.get("quoteSummary") or {}).get("result") or [{}]
    return results[0] if results else {}


# ---------------- 市场代码工具(移植 + 扩展 US / HK) ----------------
def assert_us_ticker(ticker: str) -> str:
    t = str(ticker).upper().strip()
    if t.endswith(".HK") or (t.isdigit() and len(t) in (4, 5)):
        raise ValueError(f"{ticker!r} 看起来是港股代码;该端点仅支持美股")
    if not t.replace(".", "").replace("-", "").isalnum():
        raise ValueError(f"无效的美股 ticker: {ticker!r}")
    return t


def norm_hk(code: str) -> str:
    """港股代码 → 5 位数字(00700);接受 700 / 0700 / 00700 / 0700.HK / hk00700。"""
    c = str(code).strip().upper().replace("HK", "").replace(".", "").strip()
    if not c.isdigit() or len(c) > 5:
        raise ValueError(f"无法解析港股代码 {code!r}")
    return c.zfill(5)


def us_ticker_for(source: str, ticker: str) -> str:
    """带股份类别的美股代码按源改写（2026-10-09 逐源实测伯克希尔 B）：腾讯 / 新浪 / 百度认 BRK.B；
    Yahoo 认 BRK-B（BRK.B 回 404）；东财认 BRK_B（BRK.B 搜不到，公告接口静默回 0 条）；
    FINRA 空头日文件写 BRK/B。普通代码原样返回。"""
    t = assert_us_ticker(ticker)
    if source == "yahoo":
        return t.replace(".", "-")
    if source == "eastmoney":
        return t.replace(".", "_").replace("-", "_")
    if source == "finra":
        return t.replace(".", "/").replace("-", "/")
    return t


def em_secid_global(symbol: str, market: str) -> str:
    """东财 push2 secid:美股 105/106/107 前缀(按交易所,先试 105 NASDAQ / 106 NYSE / 107 AMEX),港股 116。"""
    if market == "HK":
        return f"116.{norm_hk(symbol)}"
    return f"105.{assert_us_ticker(symbol)}"


def dump_json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
