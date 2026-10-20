"""a-stock-data v3.10.1(8f6a6a5)新端点原样移植:v3.8.0 官方数据(指数 / 交易日历 / 两融与北交所备胎)
+ v3.9.0 / v3.10.x(腾讯 K 线与逐笔、通达信盘后包、新浪研报、ETF 份额、华尔街见闻、新闻联播、ST 名单、
上证e互动、中债曲线、回购定盘、LPR、宏观日历、期货与大宗、事件驱动、可转债)。

🔴 本文件由 datasources/port_astock.py 从上游 SKILL.md 生成,勿手改;要改先改生成脚本再重跑。
与上游代码块的差别只有联网入口(业务逻辑一字未动):
1. em_get → sources._http.em:跨进程串行锁 + 代理回退 + 响应落盘(替代上游的进程内节流);
2. _v39_http 拿到响应先落盘(与 sources._http.http_get 同一套 raw/ 契约);
3. 官方指数文件的 requests.get、两融 / 北交所备胎的会话请求同样落盘;
4. baostock 会话用 sources.baostock_src.bs_session(登录登出的打印不进 stdout,否则信封 JSON 会被污染)。
用户给的 A 股代码先经 fetch_endpoint.resolve_symbol(common.norm_ticker)校验;下面的 norm_ticker / get_prefix
是上游原版,只在函数内部再归一化一次。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import _guess_ext as _vra_guess_ext, current_capture as _vra_capture, em as _vra_em  # noqa: E402
from sources.baostock_src import bs_paging_error, bs_session  # noqa: E402,F401

UPSTREAM_VERSION = "3.10.1"
UPSTREAM_COMMIT = "8f6a6a5"
DATACENTER_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"


def _vra_rec(response):
    """响应原文落盘到当前捕获上下文(与 http_get 同契约),原样返回响应。"""
    cap = _vra_capture()
    if cap is not None:
        body = response.content
        ext = "zip" if body[:2] == b"PK" else _vra_guess_ext(response.headers.get("Content-Type", ""), response.url, body)
        response._vra_raw_ref = cap.record(body, ext, response.url)
    return response


def _vra_call(method, *args, **kwargs):
    return _vra_rec(method(*args, **kwargs))


def _vra_requests_get(*args, **kwargs):
    import requests
    return _vra_rec(requests.get(*args, **kwargs))


def em_get(url, params=None, headers=None, timeout=15, **kwargs):
    """上游 em_get 的签名;实际走产品的东财统一入口(串行锁 + 落盘)。"""
    if kwargs:
        raise TypeError(f"em_get 不支持参数 {sorted(kwargs)}")
    return _vra_em(url, params=params, headers=headers, timeout=timeout)


def _rs_to_df(rs):
    """baostock ResultData → DataFrame;错误码转异常,绝不静默返回空表(上游 §6.5 原版)。"""
    import pandas as pd
    if rs.error_code != "0":
        raise RuntimeError(f"baostock 查询失败: {rs.error_code} {rs.error_msg}")
    rows = []
    while rs.next():
        rows.append(rs.get_row_data())
    why = bs_paging_error(rs)
    if why:  # 翻页失败不抛异常（见 common.bs_paging_error），不查就拿着前 2000 行当完整序列
        raise RuntimeError(f"baostock 翻页失败: {why}（只取到 {len(rows)} 行）")
    return pd.DataFrame(rows, columns=rs.fields)


# ===== 上游前置定义:get_prefix =====
# 沪市指数白名单：与深市 000xxx 个股同段，需白名单区分（沪深300/上证50/中证500/科创50/中证1000/上证180）
SH_INDEX = {"000300", "000905", "000016", "000688", "000852", "000010"}

def get_prefix(code: str) -> str:
    """6位代码 → 市场前缀（sh/sz/bj）。支持显式前缀/后缀（sh000016 / 000016.SH）透传以解决歧义。"""
    c = code.lower().strip()
    if c.endswith((".sh", ".sz", ".bj")):    # 后缀写法与前缀等价：000016.SH ≡ sh000016。
        return c[-2:]                        # 不认后缀会让 000016.SH 落到默认深市 → 静默查成深康佳A
    if c.endswith((".xshg", ".xshe")):       # 聚宽写法（#55）：.XSHG=上交所 / .XSHE=深交所，000001.XSHG=上证指数
        return "sh" if c.endswith(".xshg") else "sz"
    if c.startswith(("sh", "sz", "bj")):     # 显式前缀透传（如 sh000001=上证指数 vs sz000001=平安银行）
        return c[:2]
    if c.startswith("92"):                   # 北交所 2024-10 起的新股号段，必须先于下面的 9x 判断
        return "bj"
    if c.startswith(("5", "6", "9")):        # 5x=沪 ETF/LOF，6/9=沪个股（900xxx=沪 B 股）
        return "sh"
    if c.startswith(("4", "8")):             # 4x/8x=北交所【老号段，多数已迁 920，见下方警告】
        return "bj"
    if c in SH_INDEX:                         # 沪深300/上证50 等沪指数（000xxx）
        return "sh"
    return "sz"                              # 深市个股/ETF（00/30/15x/16x/159 等），深指数 399xxx 亦走 sz


# ===== 上游前置定义:norm_ticker =====
import re

# 整串锚定匹配，只认下表列出的写法；市场标识前缀、后缀**二选一，不能同时出现**。
# ⚠️ 两个坑都会造成「静默拿到另一只股票的数据」，比报错危险得多：
#   ① 别用 re.search(r"\d{6}") 从任意串里"捞"6 位："6005190"/"foo600519bar" 会被截成 600519。
#   ② 别让前后缀同时可选：`SH000001.SZ` 这种自相矛盾的写法会被照单全收，
#      而 000001 恰是歧义码（sh000001=上证指数 / sz000001=平安银行），静默丢掉市场信息＝选错标的。
# 捕获组：1=前缀市场 2=前缀式代码 | 3=后缀式代码 4=后缀市场
# 市场标识要**同时**从前缀和后缀取——只认 startswith("sh") 会漏掉 `000001.SH` 这种后缀写法。
_TICKER_RE = re.compile(
    r"^(?:(sh|sz|bj)(\d{6})|(\d{6})(?:\.(sh|sz|bj|xshg|xshe))?)$", re.IGNORECASE)
_JQ_SUFFIX = {"xshg": "sh", "xshe": "sz"}    # 聚宽后缀 → 市场（#55）；聚宽未公开北交所后缀，不猜

def _natural_market(digits: str) -> str:
    """6 位码的自然归属市场。仅用于校验显式前缀是否自相矛盾。
    注意 000xxx 是沪指数/深个股共用的歧义段，由调用处单独处理，不走这里。"""
    if digits.startswith(("4", "8", "92")):
        return "bj"                      # 北交所：与 get_prefix() 同一套号段规则（92x 现行 / 4x·8x 老号段，#51）
    if digits[0] in ("5", "6", "9"):
        return "sh"                      # 5x 沪 ETF/LOF，6xx 沪个股，9xx 沪 B 股
    return "sz"                          # 00x/30x/15x/16x/39x 等

def norm_ticker(code: str, stock_only: bool = False) -> str:
    """任意受支持写法 → 纯 6 位数字代码。

    支持 600519 / SH600519 / sh600519 / 600519.SH / BJ920982 等。
    stock_only=True：个股专用接口（研报、一致预期等）传这个，会拒绝显式指数写法。
    ⚠️ 不匹配时**抛 ValueError，绝不静默返回空串或猜一个代码**——
    否则调用方会把「代码格式写错」误读成「这只票没有数据」，
    或者更糟：拿到另一只股票的数据还以为是对的。
    """
    raw = str(code).strip()
    m = _TICKER_RE.match(raw)
    if not m:
        raise ValueError(
            f"无法把 {code!r} 解析为 6 位股票代码；"
            f"支持格式：600519 / SH600519 / sh600519 / 600519.SH / 600519.XSHG（聚宽）"
            f"（前缀与后缀二选一，不能同时写）"
        )
    digits = m.group(2) or m.group(3)
    market = (m.group(1) or m.group(4) or "").lower()      # 前缀式与后缀式都要认
    market = _JQ_SUFFIX.get(market, market)                  # 600519.XSHG ≡ 600519.SH
    # 归一化会丢掉市场标识，若标识与号段矛盾就会静默落到另一只票上，必须在这里拦。
    if market:
        if digits.startswith("000"):
            # 000xxx 是**沪市指数 / 深市个股共用**的歧义段，显式标识在这里是「消歧」不是「矛盾」：
            #   sh000001=上证指数 vs sz000001=平安银行；sh000016=上证50 vs sz000016=深康佳A。
            if market == "bj":
                raise ValueError(f"{code!r} 市场标识与号段矛盾：000xxx 不属北交所。")
            # 沪市个股只有 600/601/603/605/688/689（B 股 900），**不存在 000xxx 沪市个股**，
            # 所以「显式 sh + 000 段」必然是指数。实测不拦的话：sh000001→平安银行研报 100 篇、
            # sh000016→深康佳A、sh000039→中集集团 84 篇，全是别人的数据。
            if stock_only and market == "sh":
                raise ValueError(
                    f"{code!r} 指向沪市指数而非个股（沪市无 000xxx 个股），本接口只服务个股。"
                    f"要查同号段的深市个股请显式传 sz{digits}。"
                )
        else:
            nat = _natural_market(digits)
            if market != nat:
                raise ValueError(
                    f"{code!r} 的市场标识与号段矛盾：{digits} 属 {nat} 市，而不是 {market} 市。"
                    f"（改用 {nat}{digits} 或去掉市场标识）"
                )
    return digits



def em_market_code(code: str) -> int:
    """东财 secid 的市场号：**沪=1，深/北=0**（V3.7.0 新增 · #46）。

    ⚠️ 绝不要用 `code.startswith("6")` 判市场 —— 那会把**沪市 ETF（51x）**、
    **科创板 ETF（588x）**、**沪 B 股（900x）** 全部错判成深市，接口返回 `data: null`。
    2026-08-19 实测：510300 / 588000 / 600519 / 688112 / 900901 → m=1；
    300750 / 159915 / 920982 / 832982 → m=0（北交所与深市共用 m=0）。
    """
    return 1 if get_prefix(code) == "sh" else 0


def em_secid(code: str) -> str:
    """东财 push2/push2his 的 secid，如 `1.600519` / `0.300750`。"""
    return f"{em_market_code(code)}.{norm_ticker(code)}"


def to_joinquant(code: str) -> str:
    """任意受支持写法 → 聚宽代码，如 `600519.XSHG` / `000001.XSHE`（#55）。

    000 段歧义码按 get_prefix() 的规则走：`to_joinquant("sh000001")` → `000001.XSHG`（上证指数），
    `to_joinquant("000001")` → `000001.XSHE`（平安银行）。反方向（聚宽 → 本 Skill）用
    `get_prefix(c) + norm_ticker(c)` 得到 `sh000001` 这类显式前缀写法，再传给各端点。
    北交所：聚宽公开文档与 jqdatasdk 源码（2026-09-20 查）只有 .XSHG / .XSHE，没查到北交所后缀，抛 ValueError 不猜。
    """
    digits, market = norm_ticker(code), get_prefix(code)
    if market == "bj":
        raise ValueError(f"{code!r} 是北交所证券；聚宽公开文档未给出北交所后缀，不做转换")
    return f"{digits}.{'XSHG' if market == 'sh' else 'XSHE'}"


# ===== 上游标记块:v39-helpers =====
import functools
import math
import re
from datetime import date as _date_cls, datetime, timezone

import pandas as pd
import requests

V39_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# 一次要翻几十页（§1.4 腾讯逐笔）或偶尔握手卡住（§13.7 新浪期货日 K）的请求走这个会话：复用连接，
# 连接失败、握手或等响应头超时、429 / 5xx 指数退避重试（写法同 EM_SESSION）；读响应体中途超时不重试，
# 也不按服务端给的 Retry-After 等待。
V39_RETRY_SESSION = requests.Session()
try:
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    _v39_retry_adapter = HTTPAdapter(max_retries=Retry(
        total=3, connect=3, backoff_factor=0.6, respect_retry_after_header=False,
        status_forcelist=[429, 500, 502, 503, 504], allowed_methods=["GET"]))
    V39_RETRY_SESSION.mount("https://", _v39_retry_adapter)
    V39_RETRY_SESSION.mount("http://", _v39_retry_adapter)
except Exception:
    # 老版本 urllib3（< 1.26）缺 allowed_methods：不重试，也不复用连接（复用的连接被服务端断开时没有重试兜底），同 v3.10.0
    V39_RETRY_SESSION = None


def _v39_http(url, params=None, data=None, headers=None, method="GET", timeout=(10, 40),
              allow_status=(), allow_redirects=True, session=None):
    """非东财的 HTTP 请求：带浏览器 UA。网络错误、非 2xx 一律抛 RuntimeError（不把错误页当数据）；
    allow_status 里的状态码（源用 404 表示「当天没发布」时）原样返回，由调用方判断。
    session：传 V39_RETRY_SESSION 复用连接并自动重试（哪些情况重试见它的定义）；不传每次新建连接、不重试。"""
    merged = {"User-Agent": V39_UA}
    merged.update(headers or {})
    try:
        response = (session or requests).request(method, url, params=params, data=data, headers=merged,
                                                 timeout=timeout, allow_redirects=allow_redirects)
        _vra_rec(response)  # VRA: 响应原文落盘
        if response.status_code not in allow_status:
            response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(f"请求 {url} 失败: {type(exc).__name__}: {exc}") from exc
    return response


def _v39_json(response):
    """解析 JSON；不是 JSON 抛 RuntimeError。json 的解析错误是 ValueError 的子类，
    不转换会被调用方当成「确实没有数据」。"""
    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError(f"{getattr(response, 'url', '')} 返回的不是 JSON，可能是错误页") from exc


def _v39_date(value):
    """'2026-09-18' / '20260918' / date 对象 → '2026-09-18'；其他写法抛 ValueError。"""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, _date_cls):
        return value.isoformat()
    text = str(value).strip()
    fmt = "%Y%m%d" if re.fullmatch(r"[0-9]{8}", text) else "%Y-%m-%d"
    return datetime.strptime(text, fmt).date().isoformat()


def _v39_src_date(value):
    """来源返回的日期 → 'YYYY-MM-DD'；认不出抛 RuntimeError（源格式变了，不是参数写错）。"""
    try:
        return _v39_date(value)
    except ValueError as exc:
        raise RuntimeError(f"来源返回了无法识别的日期 {value!r}") from exc


def _v39_num(value):
    """'1,234.50' → 1234.5；空串 / '-' / '--' / None → None；其他非数字抛 RuntimeError
    （来源给了认不出的值是「源的格式变了」，不能和参数错误的 ValueError 混在一起）。
    JSON 布尔值同样抛错：float(True)=1.0 会把格式错误静默写成价格 / 成交量。"""
    if value is None:
        return None
    if isinstance(value, bool):
        raise RuntimeError(f"来源在数值字段给了布尔值 {value!r}")
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return float(value)
    text = str(value).replace(",", "").strip()
    if text in ("", "-", "--", "None", "null"):
        return None
    try:
        number = float(text)
    except ValueError as exc:
        raise RuntimeError(f"来源返回了无法识别的数值 {value!r}") from exc
    return number if math.isfinite(number) else None


def _v39_rows(value, what):
    """来源里可能整段缺失的行列表：字段没有（None）按空处理，其余必须是对象列表。
    写成 `value or []` 会把 {} / '' / 0 这类结构改变也当成空表，静默丢掉整段数据。"""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        raise RuntimeError(f"{what} 应为对象列表，实际是 {type(value).__name__}: {str(value)[:120]}")
    return value


def _v39_labels(value, what):
    """来源的标签数组（频道名之类）：None 按空处理，其余必须是字符串列表。
    直接 `value or []` 再 join，来源把数组改成字符串时会被拆成单字（'ab' → 'a,b'）。"""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise RuntimeError(f"{what} 应为字符串列表，实际是 {type(value).__name__}: {str(value)[:120]}")
    return value


def _v39_req_num(value, what):
    """必填数值（价格、成交量）：在 _v39_num 之上，空值 / NaN / inf 也抛 RuntimeError，不能当缺失放过。"""
    number = _v39_num(value)
    if number is None:
        raise RuntimeError(f"来源的 {what} 为空或不是有限数值: {value!r}")
    return number


def _v39_contract(func):
    """统一异常契约：来源行缺字段时 row["X"] 会漏出 KeyError，调用方按「参数错 / 没数据」处理就会
    把「来源格式变了」当成正常情况。这里把它转成带函数名和字段名的 RuntimeError。
    （函数内所有按用户参数取字典的地方都先校验过参数，不会走到这里。）"""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except KeyError as exc:
            raise RuntimeError(f"{func.__name__}: 来源数据缺少字段 {exc}，格式可能已变") from exc
    return wrapper


def _v39_count(value, what):
    """来源自报的页数 / 条数 → 非负 int。只认 int 或纯数字串；bool 抛错（int(True)=1 会让
    「只返回 1 条」通过完整性核对），其他写法也抛 RuntimeError。"""
    text = str(value).strip() if isinstance(value, (int, str)) and not isinstance(value, bool) else ""
    if not re.fullmatch(r"[0-9]+", text):
        raise RuntimeError(f"{what} 不是非负整数: {value!r}")
    return int(text)


def _v39_frame(rows, source, url, columns=None):
    """统一出表：附 source / source_url / fetched_at。rows 为空时返回带列名的空表，
    是否允许为空由调用方判断（「确实没有」与「接口坏了」要分开处理）。"""
    frame = pd.DataFrame(rows, columns=columns)
    frame["source"] = source
    frame["source_url"] = url
    frame["fetched_at"] = datetime.now(timezone.utc).isoformat()
    return frame


def _em_datacenter_strict(report_name, filter_str="", sort_columns="", sort_types="",
                          page_size=500, max_rows=5000, columns="ALL", extra=None):
    """东财 datacenter 严格版：code=0 取数据；第 1 页就 9201(返回数据为空) → []；其他错误码直接抛。

    与旧 eastmoney_datacenter() 的区别：后者把任何失败都变成 []，调用方分不清
    「这只票确实没有」和「参数写错/被风控」。sortTypes 个数必须与 sortColumns 一致，
    否则东财返回 9501「排序字段和顺序数量不一致」。
    翻页中途失败（第 2 页起 9201、空页、非末页不满页、缺 pages / count、总页数或总条数变了、
    最终条数与 count 不符）抛 RuntimeError，不把部分结果当完整结果返回。
    payload / result 不是对象、data 不是由对象组成的列表，同样抛 RuntimeError。
    只有「第 1 页、pages=1、data 为空」才算确实没有数据。
    max_rows 只在来源自报总数 count > max_rows 时提前截断；count 不超过上限的，一律走完分页并核对总数。
    """
    n_cols = len([c for c in sort_columns.split(",") if c]) if sort_columns else 0
    n_types = len([t for t in sort_types.split(",") if t]) if sort_types else 0
    if n_cols != n_types:
        raise ValueError(f"sortColumns({n_cols}) 与 sortTypes({n_types}) 个数不一致")
    rows, page, first = [], 1, None
    while True:
        params = {"reportName": report_name, "columns": columns, "filter": filter_str,
                  "pageNumber": str(page), "pageSize": str(page_size),
                  "sortColumns": sort_columns, "sortTypes": sort_types,
                  "source": "WEB", "client": "WEB"}
        params.update(extra or {})
        try:
            response = em_get(DATACENTER_URL, params=params, timeout=20)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise RuntimeError(f"东财 {report_name} 请求失败: {type(exc).__name__}: {exc}") from exc
        payload = _v39_json(response)
        if not isinstance(payload, dict):
            raise RuntimeError(f"东财 {report_name} 返回的不是 JSON 对象: {str(payload)[:100]}")
        if payload.get("code") == 9201:
            if page == 1:
                return []
            raise RuntimeError(f"东财 {report_name} 第 {page} 页返回「数据为空」，"
                               f"前面已取 {len(rows)} 条，结果不完整")
        if payload.get("code") != 0 or not payload.get("result"):
            raise RuntimeError(f"东财 {report_name} 返回错误: "
                               f"{payload.get('code')} {payload.get('message')}")
        result = payload["result"]
        if not isinstance(result, dict):
            raise RuntimeError(f"东财 {report_name} 的 result 不是对象: {str(result)[:100]}")
        pages, count, data = result.get("pages"), result.get("count"), result.get("data")
        if data is None:
            data = []
        if not isinstance(data, list) or not all(isinstance(r, dict) for r in data):
            raise RuntimeError(f"东财 {report_name} 第 {page} 页的 data 不是由对象组成的列表，格式可能已变")
        if (any(isinstance(v, bool) or not isinstance(v, int) for v in (pages, count))
                or pages < 1 or count < 0):
            raise RuntimeError(f"东财 {report_name} 缺少分页信息（pages={pages!r}, count={count!r}）")
        if first is None:
            first = (pages, count)
        elif (pages, count) != first:
            raise RuntimeError(f"东财 {report_name} 翻页时总页数 / 总条数从 {first} 变成 {(pages, count)}，"
                               "结果可能错位，请重试")
        if not data and (page > 1 or pages > 1):
            raise RuntimeError(f"东财 {report_name} 第 {page}/{pages} 页是空的，结果不完整")
        if page < pages and len(data) != int(page_size):
            raise RuntimeError(f"东财 {report_name} 第 {page}/{pages} 页只有 {len(data)} 条"
                               f"（非末页应为 {page_size} 条），结果不完整")
        rows.extend(data)
        # 只有来源自报的总数确实超过上限才提前截断；否则（count <= max_rows 却已拿到更多行）
        # 必须走完分页并核对总数，不然「data 比 count 还多」这种格式异常会被当成正常截断放过
        if len(rows) >= max_rows and count > max_rows:
            return rows[:max_rows]
        if page >= pages:
            if len(rows) != count:
                raise RuntimeError(f"东财 {report_name} 翻页后 {len(rows)} 条，与总数 {count} 不符")
            return rows
        page += 1


def _em_day(value):
    """东财日期串 '2026-09-18 00:00:00' → '2026-09-18'；空值 → None；认不出的写法抛 RuntimeError
    （只截前 10 个字符会把 '2026/09/18' 原样放行，再拿去和日期串比较就会比错）。"""
    return _v39_src_date(str(value)[:10]) if value else None


# ===== 上游标记块:v39-tencent-kline =====
import time
from datetime import date, datetime, timedelta

# 三个入口是同一后端，但限流各自独立（#52 实测单域名约 600 次后返回空 JSON）。
TENCENT_KLINE_HOSTS = ["https://web.ifzq.gtimg.cn",
                       "https://proxy.finance.qq.com/ifzqgtimg",
                       "https://ifzq.gtimg.cn"]
_TENCENT_HOST_COOLDOWN = 120          # 某入口失败后暂停使用的秒数
_tencent_host_down_until = {}
_TENCENT_MINUTES = ("m1", "m5", "m15", "m30", "m60")
_TENCENT_SPAN_DAYS = {"day": 700, "week": 3650, "month": 18250}   # 每段 < 640 根


def _tencent_kline_call(path, param):
    """按顺序尝试三个入口；空响应或异常视为该入口被限流，冷却后换下一个。返回 (data, 实际成功的入口)。"""
    errors = []
    for host in TENCENT_KLINE_HOSTS:
        if _tencent_host_down_until.get(host, 0) > time.time():
            continue
        try:
            response = _v39_http(host + path, params={"param": param},
                                 headers={"Referer": "https://gu.qq.com/"}, timeout=(8, 20))
            payload = _v39_json(response) if response.text.strip() else {}
        except RuntimeError as exc:
            errors.append(f"{host}: {type(exc.__cause__ or exc).__name__}")
            _tencent_host_down_until[host] = time.time() + _TENCENT_HOST_COOLDOWN
            continue
        if not isinstance(payload, dict):    # 顶层变成数组 / 字符串：当作这个入口坏了，换下一个
            errors.append(f"{host}: 顶层是 {type(payload).__name__}，不是对象")
            _tencent_host_down_until[host] = time.time() + _TENCENT_HOST_COOLDOWN
            continue
        if payload.get("msg") == "param error":
            raise ValueError(f"腾讯 K 线参数错误（区间过长或代码不存在）: {param}")
        if isinstance(payload.get("data"), dict) and payload["data"]:
            return payload["data"], host
        errors.append(f"{host}: 空响应")
        _tencent_host_down_until[host] = time.time() + _TENCENT_HOST_COOLDOWN
    raise RuntimeError("腾讯 K 线三个入口均不可用（可能被限流，稍后重试）: " + "; ".join(errors))


@_v39_contract
def tencent_kline(code, period="day", adjust=None, start=None, end=None, count=320):
    """腾讯 K 线 — 日/周/月（默认前复权）与 1/5/15/30/60 分钟（不复权）。

    period: day / week / month / m1 / m5 / m15 / m30 / m60
    adjust: None=日周月默认 qfq、分钟默认不复权；可显式传 'qfq' / 'hfq' / ''（不复权）
    start/end: 仅日周月可用，'YYYY-MM-DD'；给了 start 会自动按段分页（单次最多 640 根）
    count: 不给 start 时取最近 count 根；日周月 ≤ 640，分钟 ≤ 320
    成交量单位：科创板（688/689）是股，其余是手；科创板以外，最近一个交易日的分钟量是整手、下一个交易日才回填成精确股数（见 §1.2 说明）。
    本接口**没有成交额**，需要成交额用 §1.3 通达信盘后包。
    不支持北交所：腾讯对北交所只返回最新 1 根日线，区间与分钟线为空（2026-09-20 实测），直接抛 ValueError。
    """
    period = str(period).lower()
    if get_prefix(code) == "bj":
        raise ValueError("腾讯 K 线不支持北交所（只返回最新 1 根日线、分钟线为空）；"
                         "北交所日线请用 §1.3 tdx_daily_package(date) 按交易日取")
    symbol = get_prefix(code) + norm_ticker(code)
    if period in _TENCENT_MINUTES:
        if adjust not in (None, ""):
            raise ValueError("分钟线只有不复权数据，adjust 请留空")
        if start or end:
            raise ValueError("分钟线只能取最近 count 根，不支持 start/end")
        if not 1 <= int(count) <= 320:
            raise ValueError("分钟线 count 范围 1–320")
        data, host = _tencent_kline_call("/appstock/app/kline/mkline", f"{symbol},{period},,{int(count)}")
        node = data.get(symbol)
        if not isinstance(node, dict) or not isinstance(node.get(period), list):
            raise RuntimeError(f"腾讯分钟线 {symbol} 的返回里没有 {period} 列表，格式可能已变")
        rows, seen = [], set()
        try:
            for item in node[period]:
                stamp = datetime.strptime(item[0], "%Y%m%d%H%M")
                if stamp in seen:
                    raise RuntimeError(f"腾讯分钟线 {symbol} 同一时刻 {stamp} 出现两次，结果不可信")
                seen.add(stamp)
                rows.append({"datetime": stamp.strftime("%Y-%m-%d %H:%M"),
                             "open": _v39_req_num(item[1], "open"), "high": _v39_req_num(item[3], "high"),
                             "low": _v39_req_num(item[4], "low"), "close": _v39_req_num(item[2], "close"),
                             "volume": _v39_req_num(item[5], "volume"),
                             # 第 8 个字段是换手率「基点」，÷100 才是百分数；它不是成交额。
                             "turnover_rate_pct": _v39_num(item[7]) / 100 if len(item) > 7
                             and _v39_num(item[7]) is not None else None})
        except (ValueError, TypeError, IndexError, KeyError) as exc:      # 源格式变了（行变短 / 变成对象），不是参数错
            raise RuntimeError(f"腾讯分钟线 {symbol} 行格式改变: {exc}") from exc
        if not rows:
            raise RuntimeError(f"腾讯分钟线 {symbol} {period} 返回 0 根")
        frame = _v39_frame(rows, "tencent", host + "/appstock/app/kline/mkline")
        frame.insert(0, "code", symbol)
        return frame

    if period not in _TENCENT_SPAN_DAYS:
        raise ValueError("period 只能是 day/week/month 或 m1/m5/m15/m30/m60")
    adjust = "qfq" if adjust is None else adjust
    if adjust not in ("qfq", "hfq", ""):
        raise ValueError("adjust 只能是 'qfq' / 'hfq' / ''")
    if start:
        first = datetime.strptime(_v39_date(start), "%Y-%m-%d").date()
        last = datetime.strptime(_v39_date(end), "%Y-%m-%d").date() if end else date.today()
        if first > last:
            raise ValueError("start 不能晚于 end")
        windows, cursor = [], first
        while cursor <= last:
            stop = min(cursor + timedelta(days=_TENCENT_SPAN_DAYS[period] - 1), last)
            windows.append((cursor.isoformat(), stop.isoformat(), 640))
            cursor = stop + timedelta(days=1)
    else:
        if end:
            raise ValueError("只给 end 时请同时给 start")
        if not 1 <= int(count) <= 640:
            raise ValueError("日周月 count 范围 1–640")
        windows = [("", "", int(count))]

    by_date, used_hosts = {}, []
    for s, e, n in windows:
        data, host = _tencent_kline_call("/appstock/app/fqkline/get",
                                         f"{symbol},{period},{s},{e},{n},{adjust}")
        if host not in used_hosts:
            used_hosts.append(host)
        node = data.get(symbol)
        # 有除权的标的返回 qfqday / hfqweek…；从未除权的标的（以及指数）只返回 day/week/month，
        # 此时复权价与原始价相同。只认其中一个 key 会静默丢掉另一类标的（#52 补充）。
        # 复权 key 在就只用它：它为空而 day 有数据时，拿 day 顶上就是把原始价标成复权价，直接抛错。
        # 空列表是正常的（上市前、长期停牌的区间，实测 688981 在 2019 年返回 day=[]）；
        # 连这两个 key 都没有说明返回格式变了，不能把这一段当成 0 根跳过。
        key = adjust + period
        if not isinstance(node, dict) or not isinstance(node.get(key, node.get(period)), list):
            raise RuntimeError(f"腾讯 K 线 {symbol} {s or '最近'}~{e or ''} 的返回里没有 {key} / {period}，"
                               "格式可能已变")
        items = node.get(key, node.get(period))
        if key != period and key in node and not items and node.get(period):
            raise RuntimeError(f"腾讯 K 线 {symbol} {s}~{e} 的 {key} 为空、{period} 却有数据，"
                               "不能拿原始价冒充复权价")
        try:
            for item in items:
                day = _v39_src_date(item[0])
                # 每段只接受段内日期（实测腾讯按 K 线日期过滤，周 / 月线也不越界）；
                # 越界说明拿到的是别的请求或缓存页，只按总区间过滤会把缺掉的几段静默吞掉
                if s and not s <= day <= e:
                    raise RuntimeError(f"腾讯 K 线 {symbol} 请求 {s}~{e} 却返回了 {day}，结果不可信")
                if day in by_date:          # 各段互不重叠，同一天出现两次只能是源数据有问题
                    raise RuntimeError(f"腾讯 K 线 {symbol} 日期 {day} 出现两次，结果不可信")
                # 必填数值走 _v39_req_num：float() 会把 true 读成 1.0、把 'nan' 放进结果
                by_date[day] = {"date": day, "open": _v39_req_num(item[1], "open"),
                                "high": _v39_req_num(item[3], "high"), "low": _v39_req_num(item[4], "low"),
                                "close": _v39_req_num(item[2], "close"), "volume": _v39_req_num(item[5], "volume")}
        except (ValueError, TypeError, IndexError, KeyError) as exc:      # 源格式变了（行变短 / 变成对象），不是参数错
            raise RuntimeError(f"腾讯 K 线 {symbol} 行格式改变: {exc}") from exc
    rows = [by_date[k] for k in sorted(by_date)]
    if start:
        rows = [r for r in rows if windows[0][0] <= r["date"] <= windows[-1][1]]
    if not rows:
        raise RuntimeError(f"腾讯 K 线 {symbol} {period} 在所给区间内 0 根（未上市/停牌区间/代码有误）")
    # 腾讯 qfq 是「逐次减去每股分红」的等差口径（茅台 2020-01-02：原始 1130.00，qfq 870.741，
    # 差额 259.259 正是此后累计分红），高分红股的早年价格会被减成负数（茅台 2015 年 -117.6）。
    # 负价不能拿去算收益率，直接拒绝；长区间请用 adjust='' 再按 §1.6 比例口径复权。
    if any(min(r["open"], r["high"], r["low"], r["close"]) <= 0 for r in rows):
        raise RuntimeError(f"腾讯 {adjust or '原始'} 价格出现 ≤0（等差复权口径的副作用）；"
                           "请改用 adjust='' 取不复权价，再用 §1.6 sina_adjust_factor + apply_adjust")
    # 分段请求可能落在不同入口，source_url 列出实际用到的全部入口
    frame = _v39_frame(rows, "tencent", " | ".join(h + "/appstock/app/fqkline/get" for h in used_hosts))
    frame.insert(0, "code", symbol)
    frame.insert(1, "adjust", adjust or "none")
    return frame


# ===== 上游标记块:v39-tdx-package =====
import io
import math
import re
import struct
import zipfile
import zlib

TDX_PACKAGE_URL = "https://www.tdx.com.cn/products/data/data/g4day/{ymd}.zip"
# 盘后包从这一天起带北交所文件（2026-09-20 二分实测：20220505 无、20220506 有）
TDX_BJ_FIRST_DAY = "20220506"
# 每个市场有收盘价的最少行数。2026-09-20 实测 2021-08-16 ~ 2026-09-18 共 11 个包的最小值：
# 沪 16202、深 3641（2022 年以前深市大部分代码当日无价）、京 87（2022-05-06），下限取明显低于最小值的整数
TDX_MIN_PRICED = {"sh": 10000, "sz": 3000, "bj": 50}


def _tdx_parse_package(content, ymd):
    """解析通达信每日增量包：每个市场一对 .cod（代码表，150 字节/条）+ .md1（行情块，512 字节/块）。
    布局参考 jing2uo/tdx2db（MIT）的 tdx/merge.go，已用 600519/000001/920000 与腾讯收盘价对拍。"""
    archive = zipfile.ZipFile(io.BytesIO(content))
    names = set(archive.namelist())
    rows = []
    for market in ("sh", "sz", "bj"):
        cod_name, md1_name = f"{market}{ymd[2:]}.cod", f"{market}{ymd[2:]}.md1"
        if (market == "bj" and ymd < TDX_BJ_FIRST_DAY
                and cod_name not in names and md1_name not in names):
            continue            # 这天之前的包还没有北交所文件；之后缺文件按格式改变报错
        if cod_name not in names or md1_name not in names:
            raise RuntimeError(f"通达信盘后包缺少 {cod_name}/{md1_name}，格式可能已变")
        cod, md1 = archive.read(cod_name), archive.read(md1_name)
        if len(cod) % 150 or len(md1) % 512:
            raise RuntimeError(f"{market} 代码表或行情块长度不是整块，文件可能被截断")
        if len(cod) // 150 != len(md1) // 512:
            raise RuntimeError(f"{market} 代码表 {len(cod) // 150} 条、行情块 {len(md1) // 512} 块，对不上")
        before, codes, seqs = len(rows), set(), set()
        for offset in range(0, len(cod), 150):
            record = cod[offset:offset + 150]
            # 11 个真实包（2021-08 ~ 2026-09）的代码全是 6 位 ASCII 数字；用 replace 解码会把坏字节变成 '\ufffd00000' 放行
            code = record[0:6].rstrip(b"\x00 ").decode("ascii", "replace")
            seq = struct.unpack("<H", record[32:34])[0]
            if not re.fullmatch(r"[0-9]{6}", code):
                raise RuntimeError(f"通达信盘后包 {market} 代码表出现非 6 位数字代码 {code!r}，格式可能已变")
            if code in codes or seq in seqs:
                raise RuntimeError(f"通达信盘后包 {market} 代码表有重复的代码 / 行情块序号（{code!r}, seq={seq}）")
            codes.add(code)
            seqs.add(seq)
            block = md1[seq * 512:(seq + 1) * 512]
            if len(block) != 512:
                raise RuntimeError(f"{market}{code} 行情块越界（seq={seq}）")
            prev_close = struct.unpack("<d", block[4:12])[0]
            open_, high, low, close = struct.unpack("<4d", block[12:44])
            amount = struct.unpack("<d", block[72:80])[0]
            # NaN 能绕过 close <= 0 被当成有价记录计入下限；11 个真实包里没有一个非有限值
            if not all(math.isfinite(v) for v in (prev_close, open_, high, low, close, amount)):
                raise RuntimeError(f"通达信盘后包 {market}{code} 行情块出现非有限数值，文件可能已损坏")
            if close <= 0:
                continue        # 880/881 等通达信自编板块指数当日无价，整块为 0，不是证券
            volume = struct.unpack("<Q", block[56:64])[0]
            raw_name = record[40:72].split(b"\x00")[0]
            try:                # replace 会把坏字节变成「�」当成正常名称返回（11 个真实包实测零替换字符）
                name = raw_name.decode("gbk").strip()
            except UnicodeDecodeError as exc:
                raise RuntimeError(f"通达信盘后包 {market}{code} 的名称不是 GBK，文件可能已损坏") from exc
            if not name:
                raise RuntimeError(f"通达信盘后包 {market}{code} 有价格却没有名称，文件可能已损坏")
            rows.append({"date": f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}", "market": market,
                         "code": code,
                         "name": name,
                         "prev_close": round(prev_close, 4), "open": round(open_, 4),
                         "high": round(high, 4), "low": round(low, 4),
                         "close": round(close, 4), "volume": volume,
                         "amount": round(amount, 2)})
        # 逐市场核对下限：只检查总行数会让沪深撑过门槛、北交所静默缺失
        if len(rows) - before < TDX_MIN_PRICED[market]:
            raise RuntimeError(f"通达信盘后包 {market} 市场只有 {len(rows) - before} 条有价记录"
                               f"（实测下限 {TDX_MIN_PRICED[market]}），文件可能残缺或格式已变")
    return rows


@_v39_contract
def tdx_daily_package(date):
    """通达信官网每日盘后包 — 某一交易日沪深北全部证券的日线（含成交额）。

    走 HTTP 下载（约 2.7MB），与 #52 失效的 TCP 行情命令是两条路。
    个股 volume 单位是「股」、amount 单位是「元」；指数等特殊代码的 volume 为通达信原值。
    非交易日或当日包尚未发布时官网返回 404，本函数抛 ValueError，不返回空表。
    历史包实测 2022-01-04、2023-01-03 可取，2021-01-04 已 404，未逐日验证；
    2022-05-06 之前的包没有北交所文件，只返回沪深，之后缺北交所文件会报错。
    某个市场有价记录少于 TDX_MIN_PRICED 的实测下限、代码不是 6 位数字或重复、行情块序号重复、
    代码表与行情块条数对不上、价格 / 成交额不是有限数，
    都按文件残缺抛 RuntimeError，不把部分市场当全市场返回。
    """
    ymd = _v39_date(date).replace("-", "")
    url = TDX_PACKAGE_URL.format(ymd=ymd)
    response = _v39_http(url, timeout=(10, 90), allow_status=(404,))
    if response.status_code == 404:
        raise ValueError(f"{date} 没有通达信盘后包：非交易日、当日包尚未发布（通常收盘后数小时），或早于官网保留范围（实测 2021-01-04 已没有）")
    if not response.content.startswith(b"PK"):
        raise RuntimeError("通达信盘后包不是 zip 文件，可能是错误页")
    try:
        rows = _tdx_parse_package(response.content, ymd)
    except (zipfile.BadZipFile, zlib.error, EOFError) as exc:      # 以 PK 开头但压缩包坏了 / 下载被截断
        raise RuntimeError(f"通达信盘后包 {url} 无法解压: {type(exc).__name__}: {exc}") from exc
    return _v39_frame(rows, "tdx", url)


# ===== 上游标记块:v310-tencent-ticks =====
import re
import time

TENCENT_TICK_URL = "https://stock.gtimg.cn/data/index.php"
TENCENT_QT_URL = "https://qt.gtimg.cn/q="
_TICK_MAX_PAGES = 300            # 一页 70 笔；2026-09-22 实测最活跃的票全天约 4800 笔 / 69 页
_TICK_SESSION_END = "15:00:59"   # 连续竞价 + 收盘集合竞价到此为止（科创板收盘那笔在 15:00:02），之后是盘后定价


def _tencent_qt_snapshot(symbol):
    """腾讯行情快照 → (交易日 'YYYY-MM-DD', 时刻 'HHMMSS', 当日成交额 元, 盘后定价成交额 元)。代码不存在抛 ValueError。
    盘后定价成交额是下标 58 的字段（万元、4 位小数）；字段没有或认不出时为 None，只是不做盘后核对。"""
    response = _v39_http(TENCENT_QT_URL + symbol, timeout=(5, 15), session=V39_RETRY_SESSION)
    text = response.content.decode("gbk", "replace")
    if "v_pv_none_match" in text:
        raise ValueError(f"腾讯没有 {symbol} 这个代码")
    match = re.search(rf'v_{symbol}="([^"]*)"', text)
    if not match:
        raise RuntimeError(f"腾讯行情快照 {symbol} 的返回里没有 v_{symbol} 变量，格式可能已变")
    fields = match.group(1).split("~")
    if len(fields) < 36 or not re.fullmatch(r"[0-9]{14}", fields[30]):
        raise RuntimeError(f"腾讯行情快照 {symbol} 字段数 {len(fields)} 或时间字段不对，格式可能已变")
    parts = fields[35].split("/")          # 「最新价/成交量/成交额(元)」；科创板的成交量是股、其余是手，所以只用成交额
    if len(parts) != 3:
        raise RuntimeError(f"腾讯行情快照 {symbol} 的价/量/额字段是 {fields[35]!r}，格式可能已变")
    after_hours = fields[58] if len(fields) > 58 else ""
    after_hours = round(float(after_hours) * 1e4, 2) if re.fullmatch(r"\d+(\.\d+)?", after_hours) else None
    return _v39_src_date(fields[30][:8]), fields[30][8:], _v39_req_num(parts[2], "成交额"), after_hours


def _tencent_tick_page(symbol, page):
    """第 page 页逐笔（0 起）→ 记录列表；翻过最后一页时腾讯返回空内容，返回 None。"""
    response = _v39_http(TENCENT_TICK_URL, params={"appn": "detail", "action": "data", "c": symbol, "p": page},
                         timeout=(5, 15), session=V39_RETRY_SESSION)
    text = response.content.decode("gbk", "replace").strip()
    if not text:
        return None
    match = re.fullmatch(rf'v_detail_data_{symbol}=\[(\d+),"([^"]*)"\];?', text)
    if not match or int(match.group(1)) != page:
        raise RuntimeError(f"腾讯逐笔 {symbol} 第 {page} 页不是预期格式: {text[:80]!r}")
    if not match.group(2):
        return None
    records = []
    try:
        for item in match.group(2).split("|"):
            seq, clock, price, change, volume, amount, side = item.split("/")
            if not re.fullmatch(r"\d\d:\d\d:\d\d", clock) or side not in ("B", "S", "M"):
                raise ValueError(item)
            records.append({"seq": int(seq), "time": clock, "price": _v39_req_num(price, "price"),
                            "change": _v39_req_num(change, "change"), "volume": _v39_req_num(volume, "volume"),
                            "amount": _v39_req_num(amount, "amount"), "side": side})
    except ValueError as exc:      # 字段数不对 / 序号不是整数 / 方向认不出：源格式变了，不是参数错
        raise RuntimeError(f"腾讯逐笔 {symbol} 第 {page} 页记录格式改变: {exc}") from exc
    return records


@_v39_contract
def tencent_ticks(code):
    """腾讯逐笔成交（分笔）— 最近一个交易日的全部成交明细，沪深个股与 ETF。

    一行一笔：date / code / time / seq（腾讯序号）/ price / change（较上一笔）/ volume（手）/ amount（元）/
    side（B 主动买 · S 主动卖 · M 中性）。约 3 秒一笔的分笔，不是 Level-2 逐笔。
    北交所、指数、代码不存在、当日没有成交抛 ValueError。收盘后调用会用行情快照的当日成交额核对连续竞价段，
    对不上抛 RuntimeError；盘后定价段腾讯偶尔缺几笔：中间缺的序号在 frame.attrs["missing_seq"]，
    15:31 以后再用快照的盘后成交额核对，结果在 frame.attrs["complete"]（True 对上 / False 有缺 / None 没法核对；
    低价 ETF 一两手的小额缺笔可能看不出）。
    """
    prefix, ticker = get_prefix(code), norm_ticker(code)
    if prefix == "bj":
        raise ValueError("腾讯逐笔不支持北交所（返回空）；北交所日线见 §1.3 tdx_daily_package")
    if (prefix, ticker[:3]) in (("sh", "000"), ("sz", "399")):
        raise ValueError(f"{prefix}{ticker} 是指数，没有逐笔成交")
    symbol = prefix + ticker
    day, clock, amount_before, after_hours_before = _tencent_qt_snapshot(symbol)
    if amount_before == 0:
        raise ValueError(f"{symbol} 在 {day} 没有成交（停牌、尚未开盘或集合竞价未撮合）")
    rows, missing = [], []
    for page in range(_TICK_MAX_PAGES):
        records = _tencent_tick_page(symbol, page)
        if records is None:
            break
        for r in records:
            expected = rows[-1]["seq"] + 1 if rows else 0
            if r["seq"] < expected or (rows and r["time"] < rows[-1]["time"]):
                raise RuntimeError(f"腾讯逐笔 {symbol} 序号或时间倒退（第 {page} 页 {r['seq']} {r['time']}），结果不可信")
            if r["seq"] > expected:
                if r["time"] <= _TICK_SESSION_END:
                    raise RuntimeError(f"腾讯逐笔 {symbol} 缺序号 {expected}–{r['seq'] - 1}（{r['time']} 之前，第 {page} 页），"
                                       "腾讯该页缓存不完整，稍后重试")
                missing.extend(range(expected, r["seq"]))
            rows.append(r)
        time.sleep(0.1)
    else:
        raise RuntimeError(f"腾讯逐笔 {symbol} 翻到第 {_TICK_MAX_PAGES} 页仍未结束，格式可能已变")
    if not rows:
        if clock < "092500":
            raise ValueError(f"{symbol} 集合竞价尚未撮合（{clock}），还没有逐笔")
        raise RuntimeError(f"{symbol} 在 {day} 成交 {amount_before:.0f} 元，腾讯逐笔却为空："
                           "开盘前腾讯可能已清空上一交易日的明细，否则是接口变了")
    day_after, clock_after, amount_after, after_hours_after = _tencent_qt_snapshot(symbol)
    if day_after != day:
        raise RuntimeError(f"取数期间交易日从 {day} 变成 {day_after}，请重试")
    session = sum(r["amount"] for r in rows if r["time"] <= _TICK_SESSION_END)
    # 两次快照成交额相同说明取数期间没有新成交（收盘后 / 午休 / 停牌），此时连续竞价段逐笔合计应与当日成交额相符
    if amount_after == amount_before and abs(session - amount_before) > amount_before * 0.001 + 1000:
        raise RuntimeError(f"腾讯逐笔 {symbol} 连续竞价段成交额 {session:.0f} 元，与行情快照 {amount_before:.0f} 元对不上，"
                           "逐笔可能不全")
    # 盘后定价 15:30 结束（深市最后一笔可能正好在 15:30:00）。取数前的快照已在 15:31 以后、两次快照一致时，
    # 15:00:59 以后各笔成交额合计应等于快照的盘后成交额（每笔取整到元，差不超过笔数 + 1 元）；
    # 中间缺号、末尾缺笔都会对不上，但末尾缺的金额小于容差（低价 ETF 一两手）时看不出。盘中 / 15:31 前没法核对，记 None。
    after_hours = [r["amount"] for r in rows if r["time"] > _TICK_SESSION_END]
    complete = None
    if missing:
        complete = False
    elif (amount_after == amount_before and after_hours_before is not None
          and after_hours_after == after_hours_before and clock >= "153100"):
        complete = abs(sum(after_hours) - after_hours_before) <= len(after_hours) + 1
    frame = _v39_frame(rows, "tencent", f"{TENCENT_TICK_URL}?appn=detail&action=data&c={symbol}",
                       ["time", "seq", "price", "change", "volume", "amount", "side"])
    frame.insert(0, "date", day)
    frame.insert(1, "code", symbol)
    frame.attrs["missing_seq"] = missing
    frame.attrs["complete"] = complete
    return frame


# ===== 上游标记块:v39-sina-reports =====
import re
import time
import html as _html

SINA_REPORT_URL = "https://vip.stock.finance.sina.com.cn/q/go.php/vReport_List/kind/{kind}/index.phtml"
_SINA_REPORT_ROW = re.compile(
    r"<tr>\s*<td>\d+</td>\s*<td class=\"tal f14\">\s*<a[^>]*?title=\"([^\"]*)\"[^>]*?"
    r"href=\"([^\"]*?/rptid/(\d+)/[^\"]*)\"[^>]*>.*?</a>\s*</td>\s*"
    r"<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*</tr>", re.S)


# 实测（2026-09-20）：个股研报搜索两次请求间隔 1 秒时，第二次起返回「没有找到相关内容..」
# 空页（HTTP 200，与真的没有研报长得一样）；间隔 ≥5 秒恢复正常。因此强制最小间隔，
# 并对空页等待后重试一次，仍为空才当作「该股确实没有」。
SINA_REPORT_MIN_INTERVAL = 6.0
_sina_report_last = [0.0]


def _sina_report_page(url, params):
    for attempt in range(2):
        wait = SINA_REPORT_MIN_INTERVAL - (time.time() - _sina_report_last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            response = _v39_http(url, params=params,
                                 headers={"Referer": "https://finance.sina.com.cn/"})
        finally:
            _sina_report_last[0] = time.time()
        text = response.content.decode("gbk", "replace")
        if "没有找到相关内容" not in text:
            return response, text
    return response, text


def _sina_text(fragment):
    return _html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


@_v39_contract
def sina_research_reports(code=None, page=1):
    """新浪研报列表 — 研报标题/类型/日期/机构/研究员（#53 的第二来源）。

    code=None 返回全市场最新；给代码则只看该股。每页约 40 条，page 从 1 开始。
    只给列表与详情页链接，不含评级与目标价（需要这些用 §2.1 东财）。
    新浪对连续请求会返回假的「没有找到」空页，本函数内置 6 秒最小间隔，批量翻页会比较慢。
    """
    if int(page) < 1:
        raise ValueError("page 从 1 开始")
    if code is None:
        url = SINA_REPORT_URL.format(kind="lastest")
        params = {"p": int(page)}
    else:
        url = SINA_REPORT_URL.format(kind="search")
        symbol = norm_ticker(code, stock_only=True)
        # 北交所必须带 bj 前缀：只给 6 位数字时新浪返回「没有找到」空页（2026-09-20 实测 920982）
        if get_prefix(code) == "bj":
            symbol = "bj" + symbol
        params = {"symbol": symbol, "t1": "all", "p": int(page)}
    response, text = _sina_report_page(url, params)
    if "tb_01" not in text or "研究员" not in text:
        raise RuntimeError("新浪研报页面结构改变（找不到研报表格）")
    rows = []
    for title, href, rptid, kind, day, org, author in _SINA_REPORT_ROW.findall(text):
        rows.append({"date": _v39_src_date(day.strip()), "title": _html.unescape(title).strip(),
                     "type": kind.strip(), "org": _sina_text(org), "author": _sina_text(author),
                     "report_id": rptid,
                     "url": ("https:" + href) if href.startswith("//") else href})
    # 每页序号都从 1 编起（2026-09-20 实测第 2、3 页也是 1…40）；带序号的行必须全部解析出来。
    # 0 行只有页面写着「没有找到相关内容」（翻过末页 / 该股没有研报）才算真的没有
    numbered = len(re.findall(r"<tr>\s*<td>\d+</td>", text))
    if len(rows) != numbered or (not rows and "没有找到相关内容" not in text):
        raise RuntimeError(f"新浪研报表格有 {numbered} 行带序号、解析出 {len(rows)} 条，行结构可能已变")
    return _v39_frame(rows, "sina", response.url,
                      ["date", "title", "type", "org", "author", "report_id", "url"])


# ===== 上游标记块:v39-etf-shares =====
import re
import time

SSE_ETF_SHARES_URL = "https://query.sse.com.cn/commonQuery.do"
SZSE_FUND_LIST_URL = "https://fund.szse.cn/api/report/ShowReport/data"


def _etf_shares_sse(day):
    params = {"sqlId": "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L", "STAT_DATE": day,
              "isPagination": "true", "pageHelp.pageSize": 10000, "pageHelp.pageNo": 1,
              "pageHelp.beginPage": 1, "pageHelp.cacheSize": 1, "pageHelp.endPage": 1}
    response = _v39_http(SSE_ETF_SHARES_URL, params=params,
                         headers={"Referer": "https://www.sse.com.cn/"})
    payload = _v39_json(response)
    result = payload.get("result") if isinstance(payload, dict) else None
    page_help = payload.get("pageHelp") if isinstance(payload, dict) else None
    if (not isinstance(result, list) or not all(isinstance(r, dict) for r in result)
            or not isinstance(page_help, dict)):
        raise RuntimeError("上交所 ETF 规模接口返回结构改变")
    # 服务端把每页压到 2000 条（请求 10000 也回 pageSize=2000，2026-09-20 实测当日共 912 条）；
    # 条数必须等于它自报的 total，超过一页或只回了一部分都不能当完整快照
    total = _v39_count(page_help.get("total"), "上交所 ETF 规模 pageHelp.total")
    if len(result) != total:
        raise RuntimeError(f"上交所 ETF 规模返回 {len(result)} 条，与自报总数 {total} 不符，结果不完整")
    if not result:
        raise ValueError(f"上交所 {day} 没有 ETF 份额数据：非交易日或尚未发布")
    rows = []
    for rec in result:
        if rec.get("STAT_DATE") != day:
            raise RuntimeError("上交所返回了其他日期的数据")
        try:
            rows.append({"date": day, "exchange": "SH", "code": rec["SEC_CODE"],
                         "name": rec["SEC_NAME"], "etf_type": rec.get("ETF_TYPE"),
                         "shares_10k": _v39_req_num(rec["TOT_VOL"], "上交所 ETF 份额")})
        except KeyError as exc:
            raise RuntimeError(f"上交所 ETF 规模字段缺失: {exc!r}") from exc
    return rows, response.url


def _etf_shares_szse(day):
    rows, page, first, url = [], 1, None, SZSE_FUND_LIST_URL
    while first is None or page <= first[1]:
        response = _v39_http(SZSE_FUND_LIST_URL,
                             params={"SHOWTYPE": "JSON", "CATALOGID": "1000_lf", "TABKEY": "tab1",
                                     "selectJjlb": "ETF", "PAGENO": page},
                             headers={"Referer": "https://fund.szse.cn/"})
        payload = _v39_json(response)
        table = payload[0] if isinstance(payload, list) and payload else None
        meta = table.get("metadata") if isinstance(table, dict) else None
        data = table.get("data") if isinstance(table, dict) else None
        if not isinstance(meta, dict) or not isinstance(data, list):
            raise RuntimeError(f"深交所基金列表第 {page} 页的返回结构变了（缺 metadata / data）")
        # subname 是这份快照的数据日期（实测 '2026-09-18'）。缺失或写法变了先按来源坏掉报错，
        # 否则下面会说成「快照日期是 None，不是 2026-09-18」，把结构损坏伪装成用户要了历史日期。
        snap = (_v39_src_date(meta.get("subname")),
                _v39_count(meta.get("pagecount"), "深交所基金列表 pagecount"),
                _v39_count(meta.get("recordcount"), "深交所基金列表 recordcount"))
        if snap[1] < 1:
            raise RuntimeError(f"深交所基金列表 pagecount={snap[1]}，分页信息异常")
        if first is None:
            # 深交所只提供「当前」规模快照，metadata.subname 是它的数据日期。
            if snap[0] != day:
                raise ValueError(f"深交所当前规模快照日期是 {snap[0]}，不是 {day}；"
                                 "深市只能取最新一天，历史份额请自行按日留存")
            first = snap
        elif snap != first:     # 翻页途中快照换了日期或总数：拼出来的是两份快照的混合
            raise RuntimeError(f"深交所 ETF 列表翻页时快照从 {first} 变成 {snap}，请重试")
        if not data:        # 预期内的页是空的：返回前几页会被当成完整快照
            raise RuntimeError(f"深交所 ETF 列表第 {page}/{first[1]} 页是空的，结果不完整")
        for rec in data:
            try:
                code = re.search(r"<u>(\d{6})</u>", rec["sys_key"])
                name = re.search(r"<u>(.*?)</u>", rec["jjjcurl"])
                shares = re.search(r">([\d,\.]+)</a>", rec["dqgm"])
            except (KeyError, TypeError) as exc:
                raise RuntimeError(f"深交所基金列表字段缺失: {exc!r}") from exc
            if not (code and name and shares):
                raise RuntimeError("深交所基金列表字段格式改变")
            rows.append({"date": day, "exchange": "SZ", "code": code.group(1),
                         "name": name.group(1), "fund_category": rec.get("tzlb"),
                         "shares_10k": _v39_req_num(shares.group(1), "深交所 ETF 份额"),
                         "manager": rec.get("glrmc"), "listing_date": rec.get("ssrq")})
        url = response.url
        page += 1
        time.sleep(0.3)
    if len(rows) != first[2]:
        raise RuntimeError(f"深交所 ETF 列表取到 {len(rows)} 条，与它自报的总数 {first[2]} 不符")
    return rows, url


@_v39_contract
def etf_shares(date, exchange="SH"):
    """ETF 份额（万份）— 上交所按日归档，深交所只有当前快照。

    date: 'YYYY-MM-DD'。上交所可查历史日期（实测 2023-01-03 仍有 446 只）；
    深交所只返回最新一天，date 与快照日期不符直接抛错（深交所注明 T 日晚为预估、T+1 早为确认值）。
    exchange: 'SH' 或 'SZ'。两所单位都是万份。上交所的 etf_type 是单市/跨市/跨境等，
    深交所给的是 fund_category（股票基金/债券基金…），两者口径不同，没有混成一列。
    """
    day = _v39_date(date)
    exchange = str(exchange).upper()
    if exchange == "SH":
        rows, url = _etf_shares_sse(day)
    elif exchange == "SZ":
        rows, url = _etf_shares_szse(day)
    else:
        raise ValueError("exchange 只能是 'SH' 或 'SZ'")
    frame = _v39_frame(rows, exchange.lower() + "se", url)
    if frame.duplicated(["code"]).any():
        raise RuntimeError("ETF 份额数据代码重复，不能当成完整快照")
    return frame


# ===== 上游标记块:v39-wscn-lives =====
import re
from datetime import datetime, timedelta, timezone

WSCN_LIVES_URL = "https://api-one-wscn.awtmt.com/apiv1/content/lives"
_CN_TZ = timezone(timedelta(hours=8))


@_v39_contract
def wallstreetcn_lives(channel="global-channel", limit=50, cursor=None):
    """华尔街见闻 7×24 快讯（新闻层第三来源，与 §5.2 财联社 / §5.3 东财互备）。

    channel: global-channel（要闻，默认）/ a-stock-channel（A 股）等频道名。
    limit ≤ 100。翻页：把返回表的 attrs['next_cursor'] 传给下一次的 cursor。
    importance 取见闻的 score 字段：实测只有 1 / 2，100 条里约 6 条为 2（头条级快讯）。时间为北京时间。
    """
    if not re.fullmatch(r"[a-z0-9-]+-channel", str(channel)):
        raise ValueError("channel 形如 'global-channel' / 'a-stock-channel'")
    if not 1 <= int(limit) <= 100:
        raise ValueError("limit 范围 1–100")
    params = {"channel": channel, "limit": int(limit)}
    if cursor:
        params["cursor"] = cursor
    response = _v39_http(WSCN_LIVES_URL, params=params)
    payload = _v39_json(response)
    if not isinstance(payload, dict) or payload.get("code") != 20000 or not isinstance(payload.get("data"), dict):
        raise RuntimeError(f"华尔街见闻返回错误: {str(payload)[:200]}")
    items = _v39_rows(payload["data"].get("items"), "华尔街见闻快讯的 items")
    rows = []
    try:
        for item in items:
            stamp = item["display_time"]
            if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
                raise TypeError(f"display_time={stamp!r}")
            rows.append({"id": item["id"],
                         "time": datetime.fromtimestamp(stamp, _CN_TZ).strftime("%Y-%m-%d %H:%M:%S"),
                         "title": item.get("title") or "",
                         "content": (item.get("content_text") or "").strip(),
                         "importance": item.get("score"),
                         "channels": ",".join(_v39_labels(item.get("channels"), "快讯 channels")),
                         "url": item.get("uri") or ""})
    except (KeyError, TypeError, AttributeError, ValueError, OverflowError, OSError) as exc:
        raise RuntimeError(f"华尔街见闻快讯条目格式改变: {type(exc).__name__}: {exc}") from exc
    if not rows:
        raise RuntimeError(f"华尔街见闻 {channel} 返回 0 条（频道名可能不存在）")
    frame = _v39_frame(rows, "wallstreetcn", response.url)
    frame.attrs["next_cursor"] = payload["data"].get("next_cursor")
    return frame


# ===== 上游标记块:v39-cctv-news =====
import html as _html
import re
import time

CCTV_DAY_URL = "https://tv.cctv.com/lm/xwlb/day/{ymd}.shtml"


def _cctv_body(url):
    text = _v39_http(url).content.decode("utf-8", "replace")
    if len(text) < 1000 and "error.html" in text:
        return None                         # 单条视频已被央视下架（页面只剩跳错误页的脚本）
    match = (re.search(r'<div class="content_area"[^>]*>(.*?)</div>', text, re.S)
             or re.search(r'<div class="cnt_bd"[^>]*>(.*?)</div>', text, re.S))
    if not match:
        raise RuntimeError(f"新闻联播正文页结构改变: {url}")
    body = re.sub(r"</p>|<br\s*/?>", "\n", match.group(1))
    body = _html.unescape(re.sub(r"<[^>]+>", "", body))
    body = "\n".join(line.strip() for line in body.splitlines() if line.strip())
    return re.sub(r"^央视网消息\s*[（(]新闻联播[)）]\s*[：:]", "", body)


@_v39_contract
def cctv_news(date, with_content=True):
    """央视《新闻联播》当日条目（央视网官方页面）— 标题 + 文字稿。

    with_content=True 会逐条打开详情页取正文（约 15 次请求）；False 只要标题和链接。
    个别老视频已被下架，其 content 为 None（标题仍在）。
    内容以时政为主：可用于政策信号研究，**做短视频文案时不要引用**。
    """
    ymd = _v39_date(date).replace("-", "")
    url = CCTV_DAY_URL.format(ymd=ymd)
    response = _v39_http(url, allow_status=(404,))
    if response.status_code == 404:
        raise ValueError(f"{date} 没有新闻联播页面（日期过早或尚未发布，当晚约 20:00 后更新）")
    text = response.content.decode("utf-8", "replace")
    rows = []
    # 央视网改版过三次：2016 标题是 <a> 的文本，2019–2020 在 <div class="title">，
    # 2021 起在 <a title="">。逐个 <li> 按这三种位置依次找。
    for chunk in text.split("<li")[1:]:
        link = re.search(r'href="([^"]*/VIDE[^"]+)"', chunk)
        if not link:
            continue
        href = link.group(1)
        title = (re.search(r'title="([^"]+)"', chunk) or re.search(r'class="title">(.*?)</div>', chunk, re.S)
                 or re.search(r"<a[^>]*>(.*?)</a>", chunk, re.S))
        title = _html.unescape(re.sub(r"<[^>]+>", "", title.group(1))).strip() if title else ""
        if not title or re.match(r"《新闻联播》\s*\d{8}|新闻联播完整版", title):
            continue                        # 第一条是整期节目视频，不是单条新闻
        title = re.sub(r"^\[视频\]", "", title).strip()
        rows.append({"date": _v39_date(ymd), "title": title,
                     "url": ("https:" + href) if href.startswith("//") else href})
    if not rows:
        raise RuntimeError(f"新闻联播 {ymd} 页面没有解析出条目，结构可能已变")
    if with_content:
        for row in rows:
            row["content"] = _cctv_body(row["url"])
            time.sleep(0.2)
    return _v39_frame(rows, "cctv", url)


# ===== 上游标记块:v39-st-list =====
import requests

EM_CLIST_HOSTS = ["https://push2.eastmoney.com", "https://push2delay.eastmoney.com"]


def _em_clist_all(fs, fields, page_size=100):
    """东财 clist 全量翻页。主域网络失败时换 push2delay（同一接口，行情延迟约 15 分钟）。
    网络层全部失败抛 requests.ConnectionError；服务端返回异常内容（含非 JSON 的错误页）抛 RuntimeError，
    不换域重试，也不会让 st_stock_list 退到只有沪深的备胎。"""
    errors = []
    for host in EM_CLIST_HOSTS:
        url = host + "/api/qt/clist/get"
        rows, page, total = [], 1, None
        try:
            while True:
                response = em_get(url, params={"pn": page, "pz": page_size, "po": 1, "np": 1,
                                               "fltt": 2, "invt": 2, "fid": "f12",
                                               "fs": fs, "fields": fields}, timeout=15)
                response.raise_for_status()
                payload = _v39_json(response)
                data = payload.get("data") if isinstance(payload, dict) else None
                if not isinstance(data, dict) or payload.get("rc") != 0 or not data:
                    raise RuntimeError(f"东财 clist 返回异常或无数据（fs={fs}）: {str(payload)[:100]}")
                page_total = _v39_count(data.get("total"), f"东财 clist total（fs={fs}）")
                diff = _v39_rows(data.get("diff"), f"东财 clist 的 diff（fs={fs}）")
                if total is None:
                    total = page_total
                elif page_total != total:   # 翻页途中名单变了：拼出来的是两份名单的混合
                    raise RuntimeError(f"东财 clist 翻页时 total 从 {total} 变成 {page_total}，请重试")
                rows.extend(diff)
                if not diff or len(rows) >= total:
                    break
                page += 1
        except requests.RequestException as exc:
            errors.append(f"{host}: {type(exc).__name__}")
            continue
        if len(rows) != total:
            raise RuntimeError(f"东财 clist 翻页后 {len(rows)} 条，与 total={total} 不符")
        return rows, url
    raise requests.ConnectionError("东财 push2 / push2delay 均不可达: " + "; ".join(errors))


@_v39_contract
def st_stock_list():
    """全市场 ST / *ST 名单（风险警示）— 当日快照。

    沪深：东财「风险警示板」过滤（含 B 股）；北交所：东财不纳入该过滤，改为拉北交所全表按名称筛。
    东财两个域名都连不上时退到 baostock 证券列表按名称筛（**只有沪深、没有价格**，attrs 里注明）。
    price / pct_change 在走 push2delay 时约有 15 分钟延迟（source_url 可看出走的是哪个域）。
    """
    fields = "f12,f13,f14,f2,f3"
    try:
        shsz, url = _em_clist_all("m:0+f:4,m:1+f:4", fields)
        bj, bj_url = _em_clist_all("m:0+t:81+s:2048", fields)
    except requests.ConnectionError as exc:
        return _st_list_baostock(str(exc))
    # 两边原始集合都不该为空：北交所全表空了还标「沪深京」，会把缺失说成「北交所没有 ST」
    if not shsz or not bj:
        raise RuntimeError(f"东财风险警示板 {len(shsz)} 条、北交所全表 {len(bj)} 条，"
                           "有一边为空，不能当成沪深京完整名单")
    if bj_url != url:
        url = url + " | " + bj_url      # 两次调用可能落在不同域名（push2 / push2delay）
    rows = []
    for rec, is_bj in [(r, False) for r in shsz] + [(r, True) for r in bj]:
        # 代码 / 市场号 / 名称都是身份字段：f13 缺失或变样按「深市」处理会给出错误市场，
        # 名称为空则北交所那半边会被静默筛掉，结果却仍标「沪深京」。
        # 2026-09-20 实测两张表共 562 行：f12 全是 6 位、f13 只有 int 0/1、f14 无空值。
        code, market_id, name = rec["f12"], rec["f13"], str(rec["f14"]).strip()
        if (not re.fullmatch(r"[0-9]{6}", str(code)) or isinstance(market_id, bool)
                or market_id not in (0, 1)):
            raise RuntimeError(f"东财 clist 返回了认不出的代码 / 市场号: f12={code!r} f13={market_id!r}")
        if not name:
            raise RuntimeError(f"东财 clist 里 {code} 没有名称，ST 判定要靠名称，不能当成完整名单")
        if is_bj and "ST" not in name.upper():
            continue
        rows.append({"code": code,
                     "market": "bj" if is_bj else ("sh" if market_id == 1 else "sz"),
                     "name": name, "st_type": "*ST" if name.startswith("*") else "ST",
                     "price": _v39_num(rec.get("f2")), "pct_change": _v39_num(rec.get("f3"))})
    frame = _v39_frame(rows, "eastmoney", url)
    if frame.empty or frame.duplicated(["code"]).any():
        raise RuntimeError("ST 名单为空或代码重复，不能当成完整快照")
    frame.attrs["coverage"] = "沪深京"
    return frame


def _st_list_baostock(reason):
    import baostock as bs
    # 用名称模糊查询（约 300 条、2 秒）；不带参数的全量查询实测会在服务端卡住
    with bs_session():
        basic = _rs_to_df(bs.query_stock_basic(code_name="ST"))
    # type 1 = 股票，status 1 = 上市
    picked = basic[(basic["type"] == "1") & (basic["status"] == "1")
                   & basic["code_name"].str.upper().str.contains("ST")]
    rows = [{"code": c.split(".")[1], "market": c.split(".")[0], "name": n,
             "st_type": "*ST" if n.startswith("*") else "ST", "price": None, "pct_change": None}
            for c, n in zip(picked["code"], picked["code_name"])]
    frame = _v39_frame(rows, "baostock", "baostock.query_stock_basic")
    if frame.empty:
        raise RuntimeError("baostock 证券列表里没有筛出 ST，结果不可信")
    frame.attrs["coverage"] = "沪深（东财不可达，baostock 不含北交所）"
    frame.attrs["fallback_reason"] = reason
    return frame


# ===== 上游标记块:v39-sse-e =====
import html as _html
import re

SSE_E_BASE = "https://sns.sseinfo.com"
_sse_uid_cache = {}                 # 证券代码 → 上证e互动公司 uid
_sse_company_pages = {}             # 页码 → [(code, uid)]，二分查找时复用
_SSE_COMPANY_END = "没有任何上市公司的信息"
# 没有问答时的提示：公司维度「近1个月暂无回复 / 暂无提问」，全市场翻过末页「暂时没有问答内容」（2026-09-20 实测）
_SSE_EMPTY_NOTE = re.compile(r'class="m_feed_note"[^>]*>[^<]*(暂无|暂时没有)[^<]*<')


def _sse_company_page(page):
    if page not in _sse_company_pages:
        response = _v39_http(SSE_E_BASE + "/allcompany.do", method="POST",
                             data={"code": "0", "order": "2", "areaId": "0", "page": page},
                             headers={"Referer": SSE_E_BASE + "/"})
        payload = _v39_json(response)
        content = payload.get("content") if isinstance(payload, dict) else None
        if not isinstance(content, str):    # 末页之后也返回字符串（2026-09-20 实测），缺 content 是格式变了
            raise RuntimeError(f"上证e互动公司列表第 {page} 页的返回结构变了（没有 content 字符串）")
        pairs = [(code, uid) for uid, code in
                 re.findall(r"uid=['\"]?(\d+)['\"]?[^>]*>\s*<img[^>]*company/(\d{6})\.png", content)]
        # 末页之后固定返回「没有任何上市公司的信息」（2026-09-20 实测第 74 页起）。
        # 第 1 页为空、或者别的页既解析不出公司又没有这句话，只能是页面格式变了，不能说成「公司不存在」
        if not pairs and (page == 1 or _SSE_COMPANY_END not in content):
            raise RuntimeError(f"上证e互动公司列表第 {page} 页解析出 0 家公司，页面格式可能已变")
        _sse_company_pages[page] = pairs
        for code, uid in pairs:
            _sse_uid_cache[code] = uid
    return _sse_company_pages[page]


def _sse_company_uid(code):
    """上证e互动按公司 uid 查询；公司列表按代码升序分页（每页 32 家），倍增 + 二分定位。"""
    if code in _sse_uid_cache:
        return _sse_uid_cache[code]
    low, high = 1, 1
    while _sse_company_page(high):      # 先倍增找到末页之后的空页
        if _sse_company_page(high)[-1][0] >= code:
            break
        low, high = high, high * 2
    while low <= high:
        mid = (low + high) // 2
        pairs = _sse_company_page(mid)
        if not pairs or code < pairs[0][0]:
            high = mid - 1
        elif code > pairs[-1][0]:
            low = mid + 1
        else:
            break
    if code not in _sse_uid_cache:
        raise ValueError(f"上证e互动没有 {code}（公司不在上交所，或已退市）")
    return _sse_uid_cache[code]


def _sse_text(fragment):
    return _html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def _sse_time(text):
    match = re.search(r"(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}:\d{2})", text)
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)} {match.group(4)}" if match else None


def _sse_required_time(item_id, text):
    """问答时间必须解析出来：认不出还照常返回，就是把「时间格式变了」变成了一列 None。"""
    when = _sse_time(text)
    if when is None:
        raise RuntimeError(f"上证e互动第 {item_id} 条的提问时间认不出: {text!r}")
    return when


def _sse_parse_feed(text):
    """「最新回复」与「最新提问」两种列表的标记不同（问题框有没有 id），
    所以不靠 id 区分问答，而是以回复块 class="m_feed_detail m_qa" 为界切成问题段和回复段。"""
    rows = []
    for chunk in re.split(r'<div class="m_feed_item[^"]*" id="item-', text)[1:]:
        numbered = re.match(r"(\d+)", chunk)
        if not numbered:
            raise RuntimeError(f"上证e互动条目 id 不是数字，页面结构可能已变: {chunk[:60]}")
        item_id = numbered.group(1)
        # 注意全市场列表的问题块 class 是 "m_feed_detail m_qa_detail"，只能按完整 class 值切
        ask_part, _, answer_part = chunk.partition('class="m_feed_detail m_qa"')
        question = re.search(r'<div class="m_feed_txt"[^>]*>\s*<a[^>]*>:(.*?)\((\d{6})\)</a>(.*?)</div>',
                             ask_part, re.S)
        asker = re.search(r'rel="face"[^>]*?title="([^"]*)"', ask_part, re.S)
        ask_time = re.search(r'<div class="m_feed_from"[^>]*>\s*<span>([^<]+)</span>', ask_part)
        if not question or not ask_time:
            raise RuntimeError(f"上证e互动第 {item_id} 条结构改变，无法解析问题或时间")
        answer = answer_time = None
        if answer_part:
            body = re.search(r'<div class="m_feed_txt"[^>]*>(.*?)</div>', answer_part, re.S)
            when = re.search(r'<div class="m_feed_from"[^>]*>\s*<span>([^<]+)</span>', answer_part)
            if not body or not when:
                raise RuntimeError(f"上证e互动第 {item_id} 条有回复块但解析不出回复内容或回复时间")
            answer, answer_time = _sse_text(body.group(1)), _sse_time(when.group(1))
            if answer_time is None:     # 实测 500 条问答（含 250 条回复）时间字段无一缺失
                raise RuntimeError(f"上证e互动第 {item_id} 条的回复时间认不出: {when.group(1)!r}")
        rows.append({"id": item_id, "code": question.group(2), "name": _sse_text(question.group(1)),
                     "asker": asker.group(1) if asker else None,
                     "question": _sse_text(question.group(3)),
                     "question_time": _sse_required_time(item_id, ask_time.group(1)),
                     "answer": answer, "answer_time": answer_time})
    return rows


_SSE_KIND = {"answered": 11, "questions": 10}


@_v39_contract
def sse_e_interaction(code=None, kind="answered", page=1, page_size=10):
    """上证e互动 — 投资者提问与沪市上市公司回复（上交所官方平台）。

    code=None 看全市场，给沪市代码（60/68/900 开头）只看该公司。
    kind='answered'：最新已回复问答；kind='questions'：最新提问（含未回复，answer 为 None）。
    平台只开放近期问答：公司维度实测约近 1 个月，更早的翻页为空。
    §10.1 巨潮互动易实测对沪市返回 0 条（2026-09-20，600519/600000/688981），沪市问答只能走本函数。
    首次查某家公司要先在公司列表里定位 uid（倍增 + 二分，约 10–13 次请求），之后走缓存。
    """
    if kind not in _SSE_KIND:
        raise ValueError("kind 只能是 'answered' 或 'questions'")
    if int(page) < 1 or not 1 <= int(page_size) <= 50:
        raise ValueError("page 从 1 开始，page_size 范围 1–50")
    if code is None:
        response = _v39_http(SSE_E_BASE + "/ajax/feeds.do",
                             params={"type": _SSE_KIND[kind], "pageSize": int(page_size), "lastid": -1,
                                     "show": 1, "page": int(page)},
                             headers={"Referer": SSE_E_BASE + "/"})
    else:
        digits = norm_ticker(code, stock_only=True)
        if get_prefix(code) != "sh":
            raise ValueError(f"{code} 不是沪市证券；深市互动问答请用 §10.1 cninfo_irm")  # 北交所两处都没有
        response = _v39_http(SSE_E_BASE + "/ajax/userfeeds.do", method="POST",
                             data={"typeCode": "company", "type": _SSE_KIND[kind], "pageSize": int(page_size),
                                   "uid": _sse_company_uid(digits), "page": int(page)},
                             headers={"Referer": SSE_E_BASE + "/"})
    text = response.content.decode("utf-8", "replace")
    rows = _sse_parse_feed(text)
    # 只有带明确的「暂无 / 暂时没有」提示才算真没有问答；解析出 0 条又没有这句提示，是页面结构变了
    if not rows and not _SSE_EMPTY_NOTE.search(text):
        raise RuntimeError("上证e互动返回的页面既没有问答也没有「暂无」提示，结构可能已变")
    if code is not None and any(r["code"] != digits for r in rows):
        raise RuntimeError("上证e互动返回了其他公司的问答，uid 映射可能已变")
    return _v39_frame(rows, "sse_e", response.url,
                      ["id", "code", "name", "asker", "question", "question_time",
                       "answer", "answer_time"])


# ===== 上游标记块:v39-chinabond =====
import re
from datetime import date, datetime, timedelta

CHINABOND_HISTORY_URL = "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery"
CHINABOND_CURVES = {"all": "ycqx", "treasury": "hzsylqx", "bank_aaa": "syyhsylqx", "mtn_aaa": "zdqpjsylqx"}
_CHINABOND_HEADER = ["曲线名称", "日期", "3月", "6月", "1年", "3年", "5年", "7年", "10年", "30年"]
_CHINABOND_TENORS = ["3m", "6m", "1y", "3y", "5y", "7y", "10y", "30y"]
CHINABOND_CURVE_NAMES = {"treasury": "中债国债收益率曲线", "bank_aaa": "中债商业银行普通债收益率曲线(AAA)",
                         "mtn_aaa": "中债中短期票据收益率曲线(AAA)"}
# 官网上各曲线的第一天（2026-09-20 实测）；all 模式按日期核对当天应有的曲线是否齐全
CHINABOND_FIRST_DAY = {"treasury": "2006-03-01", "mtn_aaa": "2006-12-25", "bank_aaa": "2009-12-24"}


@_v39_contract
def chinabond_yield_curve(start, end=None, curve="all"):
    """中债收益率曲线（中央结算公司官方）— 国债 / 商业银行普通债 AAA / 中短期票据 AAA。

    curve: 'all' / 'treasury'（国债）/ 'bank_aaa' / 'mtn_aaa'。收益率单位为 %。
    期限 3 月到 30 年共 8 档；中短期票据曲线没有 30 年，该列为 None。
    官网单次查询超过 1 年会静默返回 0 行，本函数按 360 天切片。
    各曲线起点：国债 2006-03-01、中短期票据 2006-12-25、商业银行 2009-12-24；
    start 早于起点时从起点开始取。all 模式下 2006-03-01 至 2006-12-24 每天只有国债一条，
    2006-12-25 至 2009-12-23 每天两条（国债 + 中短期票据），2009-12-24 起三条；
    返回的每一天都按这个规则核对曲线是否齐全，缺一条抛 RuntimeError。
    中债不公布债券市场交易日历，页面也没有总条数，所以整天缺失（某个交易日一条都没返回）
    无法判定，只有整段切片 7 天以上 0 行才报错；需要严格逐日核对请自备交易日历比对 date 列。
    """
    if curve not in CHINABOND_CURVES:
        raise ValueError("curve 只能是 " + " / ".join(CHINABOND_CURVES))
    first = datetime.strptime(_v39_date(start), "%Y-%m-%d").date()
    last = datetime.strptime(_v39_date(end), "%Y-%m-%d").date() if end else date.today()
    if first > last:
        raise ValueError("start 不能晚于 end")
    wanted = [k for k in CHINABOND_CURVE_NAMES if curve in ("all", k)]
    begin = datetime.strptime(min(CHINABOND_FIRST_DAY[k] for k in wanted), "%Y-%m-%d").date()
    if last < begin:
        raise ValueError(f"中债 {curve} 曲线从 {begin} 起才有数据")
    first = max(first, begin)
    by_name = {CHINABOND_CURVE_NAMES[k]: k for k in wanted}
    rows, cursor, url, seen = [], first, CHINABOND_HISTORY_URL, {}
    while cursor <= last:
        stop = min(cursor + timedelta(days=359), last)
        response = _v39_http(CHINABOND_HISTORY_URL,
                             params={"startDate": cursor.isoformat(), "endDate": stop.isoformat(),
                                     "gjqx": 0, "qxId": CHINABOND_CURVES[curve], "locale": "cn_ZH"})
        text = re.sub(r"<!--.*?-->", "", response.content.decode("utf-8", "replace"), flags=re.S)
        tables = text.split("<table")
        table_rows = re.findall(r"<tr[^>]*>(.*?)</tr>", tables[-1], re.S) if len(tables) > 2 else []
        cells = [[re.sub(r"<[^>]+>|\s+", "", c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S)]
                 for r in table_rows]
        if not cells or cells[0] != _CHINABOND_HEADER:
            raise RuntimeError("中债收益率页面表头改变，不能按原列序解析")
        chunk = 0
        for rec in cells[1:]:
            if len(rec) != len(_CHINABOND_HEADER):
                raise RuntimeError(f"中债收益率行列数不对: {rec}")
            day = _v39_src_date(rec[1])
            if not cursor.isoformat() <= day <= stop.isoformat():
                raise RuntimeError(f"中债 请求 {cursor}~{stop} 却返回了 {day} 的曲线，结果不可信")
            if rec[0] not in by_name:
                raise RuntimeError(f"中债 返回了未请求的曲线「{rec[0]}」（请求的是 {curve}）")
            seen.setdefault(day, set()).add(by_name[rec[0]])
            row = {"date": day, "curve": rec[0]}
            row.update({k: _v39_num(v) for k, v in zip(_CHINABOND_TENORS, rec[2:])})
            rows.append(row)
            chunk += 1
        if chunk == 0 and (stop - cursor).days >= 6:
            raise RuntimeError(f"中债 {cursor}~{stop} 一周以上却 0 行，接口口径可能变了")
        url = response.url
        cursor = stop + timedelta(days=1)
    if not rows:
        raise ValueError(f"{first}~{last} 没有中债收益率（区间内无交易日）")
    for day, keys in seen.items():
        expected = {k for k in wanted if CHINABOND_FIRST_DAY[k] <= day}
        if keys != expected:
            raise RuntimeError(f"中债 {day} 缺少曲线 {sorted(expected - keys)}，结果不完整")
    frame = _v39_frame(rows, "chinabond", url)
    frame = frame.sort_values(["date", "curve"]).reset_index(drop=True)
    if frame.duplicated(["date", "curve"]).any():
        raise RuntimeError("中债收益率出现重复的 日期+曲线")
    return frame


# ===== 上游标记块:v39-repo-fixing =====
CHINAMONEY_FIXING_URL = "https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/currency/{name}-chrt.csv"


@_v39_contract
def repo_fixing_rates(kind="FR"):
    """银行间回购定盘利率（中国货币网 / 外汇交易中心官方）。

    kind='FR'：全市场回购定盘利率 FR001/FR007/FR014（约近 3 年）；
    kind='FDR'：银银间回购定盘利率 FDR001/FDR007/FDR014（约近 1 年）。单位 %。
    """
    names = {"FR": "frr", "FDR": "fdr"}
    kind = str(kind).upper()
    if kind not in names:
        raise ValueError("kind 只能是 'FR' 或 'FDR'")
    url = CHINAMONEY_FIXING_URL.format(name=names[kind])
    response = _v39_http(url, headers={"Referer": "https://www.chinamoney.com.cn/chinese/bkfrr/"})
    rows = []
    for line in response.content.decode("utf-8-sig").splitlines():
        if not line.strip():
            continue
        parts = line.split(",")
        # 每行是「日期,,,,,,隔夜,7天,14天」：中间 5 列恒为空，不为空说明格式改了
        if len(parts) != 9 or any(p.strip() for p in parts[1:6]):
            raise RuntimeError(f"货币网定盘利率 CSV 格式改变: {line[:60]}")
        # 三个期限都是核心指标：整行为空（'2026-09-18,,,,,,,,'）列数照样是 9，
        # 用 _v39_num 会返回日期有效、利率全 None 的行。实测 FR 748 行 / FDR 249 行零空值。
        rows.append({"date": _v39_src_date(parts[0]),
                     kind + "001": _v39_req_num(parts[6], f"{kind}001"),
                     kind + "007": _v39_req_num(parts[7], f"{kind}007"),
                     kind + "014": _v39_req_num(parts[8], f"{kind}014")})
    if not rows:
        raise RuntimeError(f"货币网 {kind} 定盘利率为空")
    frame = _v39_frame(rows, "chinamoney", url).sort_values("date").reset_index(drop=True)
    if frame.duplicated(["date"]).any():
        raise RuntimeError("定盘利率日期重复")
    return frame


# ===== 上游标记块:v39-lpr =====
@_v39_contract
def lpr_history():
    """贷款市场报价利率 LPR 全历史。单位 %。
    2013-10 至 2019-08 为旧机制的逐日 1 年期 LPR（lpr_5y 为 None，5 年期品种 2019-08-20 才设立）；
    2019-08 改革后每月 20 日报价。东财同一报表里还混着旧贷款基准利率调整行（实测最早 1991-04-21、最晚 2015-10-24，共 38 行），
    LPR 字段为空，已剔除；不为空却认不出的值会报错，不会返回空的 lpr_1y。"""
    rows = _em_datacenter_strict("RPTA_WEB_RATE", sort_columns="TRADE_DATE", sort_types="1",
                                 columns="TRADE_DATE,LPR1Y,LPR5Y")
    out = [{"date": _v39_src_date(str(r["TRADE_DATE"])[:10]), "lpr_1y": _v39_req_num(r["LPR1Y"], "LPR 1 年期"),
            "lpr_5y": _v39_num(r.get("LPR5Y"))}
           for r in rows if r.get("LPR1Y") is not None]
    if not out:
        raise RuntimeError("东财 LPR 报表里没有 LPR 数据")
    return _v39_frame(out, "eastmoney", DATACENTER_URL + "?reportName=RPTA_WEB_RATE")


# ===== 上游标记块:v39-macro-calendar =====
from datetime import datetime, timedelta, timezone

WSCN_MACRO_URL = "https://api-one-wscn.awtmt.com/apiv1/finance/macrodatas"
_CN_TZ = timezone(timedelta(hours=8))


def _blank_none(value):
    """空串 → None；数值 0 与字符串 '0' 原样保留（`value or None` 会把数值 0 变成缺失）。"""
    return None if value is None or value == "" else value


@_v39_contract
def macro_calendar(start, end=None, country=None, min_importance=1):
    """全球宏观日历（华尔街见闻）— 经济数据公布值/预期/前值 + 重要事件。

    start/end: 'YYYY-MM-DD'（北京时间，含两端）；end 默认 start 后 6 天；区间含两端最多 92 天。
    接口单次只允许一周，本函数按 7 天切片。country 例: '中国' / '美国'；
    importance 1–4，数字越大越重要（实测 4 = 工业增加值、社零这类头条数据），min_importance 按它过滤。
    kind: data=经济数据，event=事件。
    满 7 天且已开始的窗口 0 条抛 RuntimeError（实测过去任一周都有 150 条以上）；
    单日、周末或三周以后的日期可能确实为空（2026-09-19 周六 0 条），整个区间都没有条目时抛 ValueError；
    min_importance 只收 1–4，区间有条目但按 country / min_importance 筛完为空也抛 ValueError（不返回空表）。
    """
    first = datetime.strptime(_v39_date(start), "%Y-%m-%d").date()
    last = datetime.strptime(_v39_date(end), "%Y-%m-%d").date() if end else first + timedelta(days=6)
    if first > last or (last - first).days > 91:
        raise ValueError("区间需满足 start ≤ end 且含两端不超过 92 天")
    if isinstance(min_importance, bool) or str(min_importance) not in ("1", "2", "3", "4"):
        raise ValueError("min_importance 只能是 1–4（数字越大越重要）")
    rows, cursor, url = {}, first, WSCN_MACRO_URL
    today = datetime.now(_CN_TZ).date()
    while cursor <= last:
        stop = min(cursor + timedelta(days=6), last)
        begin = int(datetime(cursor.year, cursor.month, cursor.day, tzinfo=_CN_TZ).timestamp())
        finish = int(datetime(stop.year, stop.month, stop.day, 23, 59, 59, tzinfo=_CN_TZ).timestamp())
        response = _v39_http(WSCN_MACRO_URL, params={"start": begin, "end": finish})
        payload = _v39_json(response)
        if not isinstance(payload, dict) or payload.get("code") != 20000:
            raise RuntimeError(f"华尔街见闻宏观日历返回错误: {str(payload)[:200]}")
        items = payload.get("data").get("items") if isinstance(payload.get("data"), dict) else None
        if items is None:
            items = []
        if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
            raise RuntimeError("华尔街见闻宏观日历的 items 不是由对象组成的列表，格式可能已变")
        if not items and stop - cursor == timedelta(days=6) and cursor <= today:
            raise RuntimeError(f"华尔街见闻 {cursor}~{stop} 宏观日历 0 条（整周不该为空），接口可能改了")
        for item in items:
            stamp = item.get("public_date")
            if "id" not in item or isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
                raise RuntimeError(f"华尔街见闻宏观日历条目缺 id 或 public_date 格式改变: "
                                   f"id={item.get('id')!r} public_date={stamp!r}")
            try:
                when = datetime.fromtimestamp(stamp, _CN_TZ)
            except (ValueError, OverflowError, OSError) as exc:
                raise RuntimeError(f"华尔街见闻宏观日历时间戳无效: {stamp!r}") from exc
            # 每段只接受段内日期：接口若回了别的时间段（缓存 / 忽略参数），按 id 去重会把缺掉的几段静默吞掉
            if not cursor <= when.date() <= stop:
                raise RuntimeError(f"华尔街见闻 请求 {cursor}~{stop} 却返回了 {when:%Y-%m-%d} 的条目，结果不可信")
            # 各段互不重叠，2026-09-20 实测 31 周 5976 条没有重复 id；重复了按 id 存会静默丢掉一条
            level = item.get("importance")
            if isinstance(level, bool) or not isinstance(level, int) or level not in (1, 2, 3, 4):
                # 不校验的话 importance=True/99 会照常出表，"2" 还会让下面的筛选漏出原生 TypeError
                raise RuntimeError(f"华尔街见闻宏观日历 importance 超出 1–4: {level!r}")
            if item["id"] in rows:
                raise RuntimeError(f"华尔街见闻宏观日历 id {item['id']!r} 出现两次，结果不可信")
            rows[item["id"]] = {
                "time": when.strftime("%Y-%m-%d %H:%M"),
                "country": item.get("country"), "title": item.get("title"),
                "kind": {"FD": "data", "FE": "event"}.get(item.get("calendar_type"), item.get("calendar_type")),
                "importance": level, "actual": _blank_none(item.get("actual")),
                "forecast": _blank_none(item.get("forecast")), "previous": _blank_none(item.get("previous")),
                "revised": _blank_none(item.get("revised")), "unit": item.get("unit") or None,
                "period": item.get("period") or None}
        url = response.url
        cursor = stop + timedelta(days=1)
    if not rows:
        raise ValueError(f"{first}~{last} 没有宏观日历条目（单日、周末或较远的未来日期可能确实没有）")
    frame = _v39_frame(sorted(rows.values(), key=lambda r: r["time"]), "wallstreetcn", url)
    if country:
        frame = frame[frame["country"] == country]
    frame = frame[frame["importance"].fillna(0) >= int(min_importance)].reset_index(drop=True)
    if frame.empty:     # 整个区间是有条目的，筛完没了：country 写错 / 重要度门槛太高
        raise ValueError(f"{first}~{last} 有条目，但 country={country!r} / min_importance={min_importance} "
                         "筛完是空的（country 例: '中国' / '美国'）")
    return frame


# ===== 上游标记块:official-data-core =====
import calendar
import math
import re
from datetime import datetime, timezone
from io import BytesIO

import pandas as pd
import requests


def _official_code(value):
    value = str(value).strip()
    if not re.fullmatch(r"[0-9]{6}", value):
        raise ValueError("代码必须是 6 位纯数字；指数 provider 与证券交易所不是同一概念")
    return value


def _official_date(value):
    value = str(value).strip()
    fmt = "%Y%m%d" if re.fullmatch(r"[0-9]{8}", value) else "%Y-%m-%d"
    return datetime.strptime(value, fmt).date().isoformat()


def _official_number(value, required=False):
    if pd.isna(value) or str(value).strip() in ("", "-", "--"):
        if required:
            raise RuntimeError("官方源缺少必需数值")
        return None
    number = float(str(value).replace(",", ""))
    if not math.isfinite(number):
        raise RuntimeError("官方源返回非有限数值")
    return number


def _official_get(url, params=None, referer=None):
    response = _vra_requests_get(
        url, params=params,
        headers={"User-Agent": "Mozilla/5.0", "Referer": referer or url},
        timeout=(10, 40),
    )
    response.raise_for_status()
    return response


def _official_excel(response):
    try:
        frame = pd.read_excel(BytesIO(response.content), dtype=str)
    except (ValueError, OSError) as exc:
        raise RuntimeError("官方源未返回可解析的 Excel；可能未发布或响应结构改变") from exc
    # 两种中证文件的表头空格略有差异，按完整列名去空白后匹配。
    frame.columns = [re.sub(r"\s+", "", str(c)) for c in frame.columns]
    return frame


def _official_columns(frame, names):
    missing = set(names) - set(frame.columns)
    if missing:
        raise RuntimeError("官方数据列缺失: " + ", ".join(sorted(missing)))


def _official_frame(rows, keys, source, url):
    frame = pd.DataFrame(rows)
    if frame.empty or frame.duplicated(keys).any():
        raise RuntimeError("官方数据为空或主键重复，不能当成完整快照")
    frame["source"] = source
    frame["source_url"] = url
    frame["fetched_at"] = datetime.now(timezone.utc).isoformat()
    return frame.sort_values(keys).reset_index(drop=True)


def _official_index_members(index_code, provider, weights):
    index_code = _official_code(index_code)
    if provider not in ("csi", "cni"):
        raise ValueError("provider 必须是 csi（中证）或 cni（国证）")
    if provider == "csi":
        kind = "closeweight" if weights else "cons"
        url = ("https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/"
               f"autofile/{kind}/{index_code}{kind}.xls")
        response = _official_get(url)
        data = _official_excel(response)
        cols = ["日期Date", "指数代码IndexCode", "成份券代码ConstituentCode",
                "成份券名称ConstituentName", "交易所Exchange"]
        if weights:
            cols.append("权重(%)weight")
    else:
        url = "https://www.cnindex.com.cn/sample-detail/download-history"
        response = _official_get(url, {"indexcode": index_code})
        data = _official_excel(response)
        cols = ["日期", "样本代码", "样本简称", "权重（%）"]
    _official_columns(data, cols)
    rows = []
    for rec in data.to_dict("records"):
        if provider == "csi":
            if str(rec["指数代码IndexCode"]).zfill(6) != index_code:
                raise RuntimeError("中证返回了不同指数的数据")
            code = str(rec["成份券代码ConstituentCode"]).zfill(6)
            exchanges = {"上海证券交易所": "SH", "深圳证券交易所": "SZ", "北京证券交易所": "BJ"}
            exchange = exchanges.get(rec["交易所Exchange"])
            if exchange is None:
                raise ValueError("本端点仅支持沪深北成分，请使用相应市场的数据工具")
            row = {"date": _official_date(rec["日期Date"]), "index_code": index_code,
                   "code": _official_code(code), "name": rec["成份券名称ConstituentName"],
                   "exchange": exchange}
            weight = rec.get("权重(%)weight")
        else:
            # 国证没有交易所列；A 股文件保留六位文本。港股 00700 不能补成 000700/SZ。
            code = _official_code(rec["样本代码"])
            exchange = ("SH" if code.startswith("6") else "SZ" if code.startswith(("0", "3"))
                        else "BJ" if code.startswith(("4", "8", "92")) else None)
            if exchange is None:
                raise ValueError("国证该指数包含本端点不支持的证券类型")
            row = {"date": _official_date(rec["日期"]), "index_code": index_code,
                   "code": code, "name": rec["样本简称"], "exchange": exchange}
            weight = rec["权重（%）"]
        if weights:
            row["weight_percent"] = _official_number(weight, required=True)
        rows.append(row)
    frame = _official_frame(rows, ["date", "code", "exchange"], provider, response.url)
    if frame["date"].nunique() != 1:
        raise RuntimeError("成分文件混有多个日期，不能当作单日快照")
    if weights and (not frame.weight_percent.between(0, 100).all()
                    or not 99 <= frame.weight_percent.sum() <= 101):
        raise RuntimeError("权重范围或合计异常；可能文件残缺或不是百分数口径")
    return frame


def index_constituents(index_code, provider="csi"):
    """最近公布的沪深北成分；date 是源文件日期，不是抓取日。"""
    return _official_index_members(index_code, provider, weights=False)


def index_weights(index_code, provider="csi"):
    """最近公布的指数权重，weight_percent 单位为百分数。"""
    return _official_index_members(index_code, provider, weights=True)


def index_valuation(index_code):
    """中证近期 PE/股息率文件；不含 PB，两种股本口径不混用。"""
    index_code = _official_code(index_code)
    url = ("https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/"
           f"autofile/indicator/{index_code}indicator.xls")
    response = _official_get(url)
    data = _official_excel(response)
    mapping = {"市盈率1（总股本）P/E1": "pe_total",
               "市盈率2（计算用股本）P/E2": "pe_calculation",
               "股息率1（总股本）D/P1": "dividend_yield_total_percent",
               "股息率2（计算用股本）D/P2": "dividend_yield_calculation_percent"}
    _official_columns(data, ["日期Date", "指数代码IndexCode", *mapping])
    rows = []
    for rec in data.to_dict("records"):
        if str(rec["指数代码IndexCode"]).zfill(6) != index_code:
            raise RuntimeError("中证估值文件返回了不同指数")
        rows.append({"date": _official_date(rec["日期Date"]), "index_code": index_code,
                     **{dest: _official_number(rec[src]) for src, dest in mapping.items()}})
    return _official_frame(rows, ["date", "index_code"], "csi", response.url)


def trading_calendar(year, month):
    """深交所完整自然月日历。未发布或缺日抛错，周末调休不视为交易日。"""
    if type(year) is not int or type(month) is not int or not 1 <= month <= 12:
        raise ValueError("year/month 必须为整数，month 在 1–12 之间")
    last = calendar.monthrange(year, month)[1]
    expected = {datetime(year, month, day).date().isoformat() for day in range(1, last + 1)}
    url = "https://www.szse.cn/api/report/exchange/onepersistenthour/monthList"
    response = _official_get(url, {"month": f"{year}-{month}"})
    data = response.json().get("data")
    if not isinstance(data, list) or not data:
        raise RuntimeError("深交所尚未返回该月日历；不能推断全月休市")
    rows = []
    for rec in data:
        if str(rec.get("jybz")) not in ("0", "1") or not rec.get("jyrq"):
            raise RuntimeError("深交所日历字段异常")
        rows.append({"date": _official_date(rec["jyrq"]), "is_open": str(rec["jybz"]) == "1"})
    frame = _official_frame(rows, ["date"], "szse", response.url)
    if set(frame.date) != expected:
        raise RuntimeError("日历月份错位或日期不完整，不能继续调度")
    return frame


# ===== 上游标记块:v39-futures =====
import csv
import io
import json
import re
from xml.etree import ElementTree

FUTURES_EXCHANGES = ("SHFE", "INE", "CZCE", "CFFEX", "GFEX")
_SHFE_HOSTS = {"SHFE": "https://www.shfe.com.cn", "INE": "https://www.ine.cn"}
CZCE_FILE_URL = "https://www.czce.com.cn/cn/DFSStaticFiles/{kind}/{year}/{ymd}/{name}.txt"
CZCE_FIRST_DAY = "20150921"      # 郑商所现行文件路径的第一天；更早是另一套无表头 CSV，未接入
CFFEX_DAILY_URL = "http://www.cffex.com.cn/fzjy/mrhq/{ym}/{dd}/{ymd}_1.csv"
CFFEX_DAILY_XML = "http://www.cffex.com.cn/fzjy/mrhq/{ym}/{dd}/index.xml"
CFFEX_RANK_URL = "http://www.cffex.com.cn/sj/ccpm/{ym}/{dd}/{product}_1.csv"
# 各品种持仓排名文件的第一天（2026-09-20 逐个二分实测，前一交易日都是 302 缺文件）
CFFEX_RANK_FIRST_DAY = {"IF": "20100416", "IH": "20150416", "IC": "20150416", "IM": "20220722",
                        "TS": "20180817", "TF": "20130906", "T": "20150320", "TL": "20230421"}
GFEX_DAILY_URL = "http://www.gfex.com.cn/u/interfacesWebTiDayQuotes/loadList"
SINA_HQ_URL = "https://hq.sinajs.cn/list="
SINA_FUT_KLINE_URL = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_{code}="
                      "/InnerFuturesNewService.getDailyKLine")
SGE_DAILY_URL = "https://www.sge.com.cn/graph/Dailyhq"
_CFFEX_SINA_PRODUCTS = ("IF", "IH", "IC", "IM", "TS", "TF", "T", "TL")
_DCE_HINT = ("大商所官网有 JS 反爬（纯 HTTP 返回 412），不提供官方日行情；大商所品种（豆粕 M、铁矿 I、塑料 L…）"
             "请用 futures_kline('M0') 取逐日 K 线（新浪），futures_realtime('M0') 取实时/收盘快照")
_FUT_COLUMNS = ["date", "exchange", "symbol", "product", "open", "high", "low", "close", "settle",
                "pre_settle", "volume", "open_interest", "oi_change", "turnover_10k"]
_OPT_COLUMNS = ["date", "exchange", "symbol", "series", "option_type", "strike", "open", "high",
                "low", "close", "settle", "pre_settle", "volume", "open_interest", "oi_change",
                "turnover_10k", "delta", "iv_pct", "series_iv_pct"]
_RANK_COLUMNS = ["date", "exchange", "level", "symbol", "rank", "volume_member", "volume",
                 "volume_chg", "long_member", "long_oi", "long_chg", "short_member", "short_oi",
                 "short_chg"]


def _fut_price(value):
    """期货/期权价格：0 不是有效价格（无成交时交易所填 0 或空），统一成 None。"""
    number = _v39_num(value)
    return None if number == 0 else number


def _fut_product(code):
    """合约代码的品种字母（rb2610 -> rb、IF2609 -> IF）；不是字母开头说明来源格式变了。"""
    match = re.match(r"[A-Za-z]+", str(code))
    if not match:
        raise RuntimeError(f"合约代码 {code!r} 不是字母开头，格式可能已变")
    return match.group(0)


def _fut_exchange(exchange):
    exchange = str(exchange).upper()
    if exchange == "DCE":
        raise ValueError(_DCE_HINT)
    if exchange not in FUTURES_EXCHANGES:
        raise ValueError("exchange 只能是 " + " / ".join(FUTURES_EXCHANGES) + "（大商所见 futures_kline / futures_realtime）")
    return exchange


def _shfe_json(exchange, path, ymd, key, allow_missing=False):
    """上期所 / 上期能源的 .dat（实为 JSON）。非交易日官网 404；allow_missing 时返回 (None, url)。
    key 是调用方要读的行列表字段（o_curinstrument / o_cursor）；顶层不是对象、它不是由对象组成的列表，抛 RuntimeError。"""
    url = f"{_SHFE_HOSTS[exchange]}/data/tradedata/{path}{ymd}.dat"
    first = _INE_FIRST_DAY.get(path) if exchange == "INE" else None
    if first and ymd < first:
        # 能源中心首日前有些日子也发文件，但里面没有该类合约；按「当时还没有」处理，不能报成格式改变
        if allow_missing:
            return None, url
        raise ValueError(f"上期能源该类数据从 {first} 起才有（{ymd} 早于首日）")
    response = _v39_http(url, timeout=(10, 60), allow_status=(404,))
    payload = None
    if response.status_code != 404:
        try:
            payload = json.loads(response.content.decode("utf-8"))
        except ValueError as exc:       # 含 UnicodeDecodeError：错误页不是「没有数据」
            raise RuntimeError(f"{exchange} {url} 返回的不是 JSON，可能是错误页") from exc
        rows = payload.get(key) if isinstance(payload, dict) else None
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise RuntimeError(f"{exchange} {url} 的 {key} 不是由对象组成的列表，格式可能已变")
        reported = payload.get("report_date")
        if reported is not None and str(reported) != ymd:
            raise RuntimeError(f"{exchange} 返回的 report_date={reported}，不是 {ymd}")
        # 早年文件没有 report_date（上期所 2015 年的排名文件），只能以文件名里的日期为准；
        # 能源中心 2019 年的排名文件则是「没有 report_date + 列表为空」的空壳，按没有数据处理
        if reported is None and not any(v for v in payload.values() if isinstance(v, list)):
            payload = None
    if payload is None:
        if allow_missing:
            return None, url
        raise ValueError(f"{exchange} {ymd} 没有数据：非交易日、尚未发布或该品种当时未上市")
    return payload, url


def _czce_text(kind, name, ymd):
    if ymd < CZCE_FIRST_DAY:
        raise ValueError(f"郑商所数据从 {CZCE_FIRST_DAY} 起接入（更早的文件是另一套格式）")
    url = CZCE_FILE_URL.format(kind=kind, year=ymd[:4], ymd=ymd, name=name)
    response = _v39_http(url, timeout=(10, 60), allow_status=(404,))
    if response.status_code == 404:
        raise ValueError(f"郑商所 {ymd} 没有 {name}：非交易日或尚未发布")
    try:
        text = response.content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = response.content.decode("gbk")   # 2017 年及以前的文件是 GBK
    if f"({ymd[:4]}-{ymd[4:6]}-{ymd[6:]})" not in text.split("\n", 1)[0] + text[:200]:
        raise RuntimeError(f"郑商所 {name} 标题里的日期不是 {ymd}")
    return text, url


# 郑商所 2021 年前的表头叫「品种月份 / 品种代码」「空盘量」，与现在的「合约代码」「持仓量」是同一列
_CZCE_HEADER_ALIAS = {"品种月份": "合约代码", "品种代码": "合约代码", "空盘量": "持仓量"}


def _czce_table(text, header_prefix):
    """郑商所竖线分隔表：返回 (表头, 数据行)，千分位逗号已去掉，小计/总计已剔除。"""
    lines = [line for line in text.splitlines() if "|" in line]
    header = [_CZCE_HEADER_ALIAS.get(c.strip(), c.strip()) for c in lines[0].split("|")] if lines else []
    if not header or header[0] != header_prefix:
        raise RuntimeError("郑商所文件表头改变")
    rows = []
    for line in lines[1:]:
        cells = [c.strip().replace(",", "") for c in line.split("|")]
        if not cells[0] or cells[0].endswith(("小计", "总计", "合计")):
            continue                            # 期权文件还有「AP合计」这类品种合计行
        rows.append(dict(zip(header, cells)))
    return header, rows


def _cffex_csv(url, allow_missing=False):
    response = _v39_http(url, timeout=(10, 60), allow_status=(302, 404), allow_redirects=False)
    # 中金所缺文件时 302 跳到 error_404 页面
    if response.status_code in (302, 404):
        if allow_missing:
            return None
        raise ValueError(f"中金所没有该文件（非交易日或尚未发布）: {url}")
    return list(csv.reader(io.StringIO(response.content.decode("gbk"))))


def _cffex_daily_table(ymd):
    """中金所日行情 CSV（期货 + 期权同一个文件）。CSV 里没有交易日列，同目录的 index.xml 每行都带
    tradingday；用它核对交易日，并逐合约核对成交量 / 收盘价 / 持仓量，对不上就抛 RuntimeError，
    不把别的交易日的文件标成这一天（2010–2026 抽 5 天实测两者逐合约一致）。"""
    url = CFFEX_DAILY_URL.format(ym=ymd[:6], dd=ymd[6:], ymd=ymd)
    table = _cffex_csv(url)
    if not table or table[0][:3] != ["合约代码", "今开盘", "最高价"]:
        raise RuntimeError("中金所日行情表头改变")
    xml_url = CFFEX_DAILY_XML.format(ym=ymd[:6], dd=ymd[6:])
    response = _v39_http(xml_url, timeout=(10, 60), allow_status=(302, 404), allow_redirects=False)
    if response.status_code in (302, 404):
        raise RuntimeError(f"中金所 {ymd} 有行情 CSV 却没有 index.xml，无法核对交易日: {xml_url}")
    if b"<!DOCTYPE" in response.content or b"<!ENTITY" in response.content:
        raise RuntimeError(f"中金所 index.xml 含 DOCTYPE / ENTITY，拒绝解析: {xml_url}")
    try:
        nodes = ElementTree.fromstring(response.content).findall("dailydata")
    except ElementTree.ParseError as exc:
        raise RuntimeError(f"中金所 index.xml 无法解析: {exc}") from exc
    witness = {}
    for node in nodes:
        values = {k: (node.findtext(k) or "").strip() for k in
                  ("instrumentid", "tradingday", "volume", "closeprice", "openinterest")}
        if values["tradingday"] != ymd:
            raise RuntimeError(f"中金所 index.xml 的交易日是 {values['tradingday']}，不是 {ymd}")
        witness[values["instrumentid"]] = tuple(_v39_num(values[k]) for k in ("volume", "closeprice", "openinterest"))
    header = [c.strip() for c in table[0]]
    csv_rows = {}
    for rec in table[1:]:
        code = rec[0].strip() if rec else ""
        if not code or code in ("小计", "合计", "总计"):
            continue
        r = dict(zip(header, rec))
        csv_rows[code] = tuple(_v39_num(r.get(k)) for k in ("成交量", "今收盘", "持仓量"))
    if not witness or len(witness) != len(nodes) or csv_rows != witness:
        diff = sorted(set(csv_rows) ^ set(witness)) or sorted(k for k in csv_rows if csv_rows[k] != witness.get(k))
        raise RuntimeError(f"中金所 {ymd} 行情 CSV 与 index.xml 对不上（{len(csv_rows)} / {len(witness)} 个合约，"
                           f"例如 {diff[:3]}），不能确认 CSV 属于这一天")
    return table, url


_CFFEX_RANK_SUB = ["会员简称", "成交量", "比上一交易日增减", "会员简称", "持买单量", "比上一交易日增减",
                   "会员简称", "持卖单量", "比上一交易日增减"]


def _cffex_rank_rows(table, product, ymd):
    """中金所持仓排名 CSV → 行。只在核对过两行表头的「排名」段里取数，列顺序不对就抛错。
    2015 年前后的旧文件在排名段前面还有一段「会员类别」合计（表头同样以 交易日,合约 开头），跳过。"""
    out, in_rank, i = [], False, 0
    while i < len(table):
        cells = [c.strip() for c in table[i]]
        if cells[:2] == ["交易日", "合约"]:
            in_rank = cells[2:3] == ["排名"]
            if in_rank:
                sub = [c.strip() for c in table[i + 1][3:12]] if i + 1 < len(table) else []
                if cells[3:12:3] != ["成交量排名", "持买单量排名", "持卖单量排名"] or sub != _CFFEX_RANK_SUB:
                    raise RuntimeError(f"中金所 {product} 持仓排名表头变了: {cells} / {sub}")
                i += 1
        elif cells[2:3] and cells[2].isdigit():
            if not in_rank:
                raise RuntimeError(f"中金所 {product} 持仓排名在排名表头之前出现数据行: {cells}")
            if len(cells) < 12:
                raise RuntimeError(f"中金所 {product} 持仓排名行缺列: {cells}")
            if cells[0] != ymd:
                raise RuntimeError(f"中金所 {product} 持仓排名交易日是 {cells[0]}，不是 {ymd}")
            out.append({"level": "contract", "symbol": cells[1], "rank": int(cells[2]),
                        "volume_member": _rank_member(cells[3]), "volume": _v39_num(cells[4]),
                        "volume_chg": _v39_num(cells[5]),
                        "long_member": _rank_member(cells[6]), "long_oi": _v39_num(cells[7]),
                        "long_chg": _v39_num(cells[8]),
                        "short_member": _rank_member(cells[9]), "short_oi": _v39_num(cells[10]),
                        "short_chg": _v39_num(cells[11])})
        i += 1
    return out


def _gfex_rows(ymd, trade_type):
    response = _v39_http(GFEX_DAILY_URL, method="POST", data={"trade_date": ymd, "trade_type": trade_type},
                         headers={"Referer": "http://www.gfex.com.cn/gfex/rihq/hqsj_tjsj.shtml"})
    payload = _v39_json(response)
    if not isinstance(payload, dict) or str(payload.get("code")) != "0":
        raise RuntimeError(f"广期所返回错误: {str(payload)[:200]}")
    # 广期所的行里没有交易日字段，只在 param 里回显请求参数；回显不符说明拿到的不是这次请求的结果。
    # 非交易日它返回空表（只剩合计行），不会回退到最近交易日（2026-09-19 周六实测）。
    param = payload.get("param")
    if not isinstance(param, dict):
        raise RuntimeError(f"广期所没有回显请求参数（param 应为对象）: {str(payload)[:200]}")
    data = _v39_rows(payload.get("data"), "广期所 data")
    if param.get("trade_date") not in ([ymd], ymd) or param.get("trade_type") not in ([str(trade_type)], str(trade_type)):
        raise RuntimeError(f"广期所回显的请求参数 {param} 与请求的 {ymd}/{trade_type} 不符")
    rows = []
    for r in data:
        if str(r.get("variety", "")).endswith(("小计", "总计")):
            continue
        # 实测（2022-12-22、2026-09-18/19）只有小计 / 总计行没有 delivMonth；字段改名时不能把合约行全部滤掉、报成非交易日
        if not r.get("delivMonth"):
            raise RuntimeError(f"广期所合约行缺 delivMonth，格式可能已变: {str(r)[:120]}")
        rows.append(r)
    if not rows:
        raise ValueError(f"广期所 {ymd} 没有行情：非交易日或尚未发布")
    return rows, response.url


# 能源中心各文件的第一天（2026-09-20 二分实测）：日行情 2018-03-26 开业即有；持仓排名 2020-07-03 起
# （07-02 仍是空壳，当时上期所排名里也没有能源品种）；期权日行情 2021-06-21 原油期权上市起
# （06-15~18 已发文件但里面没有期权合约，2026-09-22 复测）
_INE_FIRST_DAY = {"future/dailydata/kx": "20180326", "future/dailydata/pm": "20200703",
                  "option/dailydata/kx": "20210621"}


def _shfe_ine_ids(path, ymd, key, field):
    """上期所文件里混有上期能源的品种；取能源中心同一天的 ID 集合用来剔除。
    能源中心该文件第一天之前没有文件（或是空壳），上期所文件里也没有能源品种，返回空集合；
    第一天起缺文件不能当成「没有能源品种」，否则 sc 等合约会被标成上期所，直接抛 RuntimeError。"""
    payload, url = _shfe_json("INE", path, ymd, key, allow_missing=True)
    ids = {str(r[field]).strip() for r in payload[key]} if payload else set()
    if not ids and ymd >= _INE_FIRST_DAY[path]:
        raise RuntimeError(f"上期能源 {ymd} 的对照文件缺失或为空（{url}），无法从上期所数据里剔除能源品种；"
                           "可能尚未发布，稍后重试")
    return ids


@_v39_contract
def futures_daily(date, exchange):
    """期货日行情（交易所官方收盘数据）— 上期所 / 上期能源 / 郑商所 / 中金所 / 广期所。

    exchange: 'SHFE' / 'INE' / 'CZCE' / 'CFFEX' / 'GFEX'；大商所（DCE）官网有反爬，见 futures_kline / futures_realtime。
    一行一个合约（不含小计），settle 为当日结算价，turnover_10k 单位万元，价格为 0 的统一成 None。
    上期所的官方文件里也包含上期能源的品种（原油、20号胶等），这里按能源中心同日文件剔除，
    所以 SHFE 与 INE 两次调用不会重复。非交易日抛 ValueError。
    实测可用起点：上期所 2002-01-07 起（2021 年及以前没有成交额，turnover_10k 为 None）；
    上期能源 2018-03 开业；郑商所 2015-09-21 起（更早是另一套格式，未接入）；中金所 2010-04-16 开业即有；广期所 2022-12 开业。
    """
    exchange = _fut_exchange(exchange)
    day = _v39_date(date)
    ymd = day.replace("-", "")
    rows = []
    if exchange in ("SHFE", "INE"):
        payload, url = _shfe_json(exchange, "future/dailydata/kx", ymd, "o_curinstrument")
        skip = (_shfe_ine_ids("future/dailydata/kx", ymd, "o_curinstrument", "PRODUCTID")
                if exchange == "SHFE" else set())
        for r in payload["o_curinstrument"]:
            month = str(r.get("DELIVERYMONTH", "")).strip()
            product_id = r["PRODUCTID"].strip()
            # 期货品种 ID 以 _f 结尾（cu_f）；sc_tas 是原油 TAS 指令，价格恒为 0，不是独立合约。
            # 不用 PRODUCTCLASS 判断：这个字段 2023 年才出现
            if not product_id.endswith("_f") or not month.isdigit() or product_id in skip:
                continue
            rows.append({"symbol": product_id[:-2] + month,
                         "product": r["PRODUCTNAME"].strip(),
                         "open": _fut_price(r["OPENPRICE"]), "high": _fut_price(r["HIGHESTPRICE"]),
                         "low": _fut_price(r["LOWESTPRICE"]), "close": _fut_price(r["CLOSEPRICE"]),
                         "settle": _fut_price(r["SETTLEMENTPRICE"]),
                         "pre_settle": _fut_price(r["PRESETTLEMENTPRICE"]),
                         "volume": _v39_num(r["VOLUME"]), "open_interest": _v39_num(r["OPENINTEREST"]),
                         "oi_change": _v39_num(r["OPENINTERESTCHG"]),
                         "turnover_10k": _v39_num(r.get("TURNOVER"))})   # 2021 年及以前的文件没有成交额，为 None
    elif exchange == "CZCE":
        text, url = _czce_text("Future", "FutureDataDaily", ymd)
        _, table = _czce_table(text, "合约代码")
        for r in table:
            rows.append({"symbol": r["合约代码"], "product": _fut_product(r["合约代码"]),
                         "open": _fut_price(r["今开盘"]), "high": _fut_price(r["最高价"]),
                         "low": _fut_price(r["最低价"]), "close": _fut_price(r["今收盘"]),
                         "settle": _fut_price(r["今结算"]), "pre_settle": _fut_price(r["昨结算"]),
                         "volume": _v39_num(r["成交量(手)"]), "open_interest": _v39_num(r["持仓量"]),
                         "oi_change": _v39_num(r["增减量"]), "turnover_10k": _v39_num(r["成交额(万元)"])})
    elif exchange == "CFFEX":
        table, url = _cffex_daily_table(ymd)
        for rec in table[1:]:
            code = rec[0].strip()
            if not code or code in ("小计", "合计", "总计") or "-C-" in code or "-P-" in code:
                continue
            r = dict(zip(table[0], rec))
            rows.append({"symbol": code, "product": _fut_product(code),
                         "open": _fut_price(r["今开盘"]), "high": _fut_price(r["最高价"]),
                         "low": _fut_price(r["最低价"]), "close": _fut_price(r["今收盘"]),
                         "settle": _fut_price(r["今结算"]), "pre_settle": _fut_price(r["前结算"]),
                         "volume": _v39_num(r["成交量"]), "open_interest": _v39_num(r["持仓量"]),
                         "oi_change": _v39_num(r["持仓变化"]), "turnover_10k": _v39_num(r["成交金额"])})
    else:
        data, url = _gfex_rows(ymd, 0)
        for r in data:
            rows.append({"symbol": r["varietyOrder"] + r["delivMonth"], "product": r["variety"],
                         "open": _fut_price(r["open"]), "high": _fut_price(r["high"]),
                         "low": _fut_price(r["low"]), "close": _fut_price(r["close"]),
                         "settle": _fut_price(r["clearPrice"]), "pre_settle": _fut_price(r["lastClear"]),
                         "volume": _v39_num(r["volumn"]), "open_interest": _v39_num(r["openInterest"]),
                         "oi_change": _v39_num(r["diffI"]), "turnover_10k": _v39_num(r["turnover"])})
    if not rows:
        raise RuntimeError(f"{exchange} {day} 解析出 0 个期货合约，格式可能已变")
    for row in rows:
        row["date"], row["exchange"] = day, exchange
    frame = _v39_frame(rows, exchange.lower(), url, _FUT_COLUMNS)
    if frame.duplicated(["symbol"]).any():
        raise RuntimeError(f"{exchange} {day} 期货合约代码重复")
    return frame


# 郑商所 CF/RM/OI/SR 另有带两位字母后缀的系列（如 CF701MSC14400），后缀并入 series 原样保留
_OPTION_CODE = re.compile(r"^([A-Za-z]+\d{3,4}(?:[A-Z]{2})?)-?([CP])-?(\d+(?:\.\d+)?)$")


@_v39_contract
def options_daily(date, exchange):
    """商品期权 / 股指期权日行情（交易所官方）— 上期所 / 上期能源 / 郑商所 / 中金所 / 广期所。

    series：期权系列（商品期权 = 标的期货合约，如 cu2610；中金所 = HO/IO/MO + 月份；
    郑商所部分品种另有 CF701MS 这类带后缀的系列，按官方代码原样保留，与 CF701 分开）。
    delta：交易所公布值（中金所不公布，为 None）。
    iv_pct：逐合约隐含波动率 %（郑商所、广期所公布）；series_iv_pct：上期所/能源中心按系列公布的
    隐含波动率（官方 SIGMA × 100）。ETF 期权不在这里，见 Layer 9。非交易日抛 ValueError。
    各所期权上市时间不同（上期所铜期权 2018-09、郑商所白糖期权 2017-04），之前的日期抛 ValueError。
    """
    exchange = _fut_exchange(exchange)
    day = _v39_date(date)
    ymd = day.replace("-", "")
    rows = []
    if exchange in ("SHFE", "INE"):
        payload, url = _shfe_json(exchange, "option/dailydata/kx", ymd, "o_curinstrument")
        skip = (_shfe_ine_ids("option/dailydata/kx", ymd, "o_curinstrument", "PRODUCTID")
                if exchange == "SHFE" else set())
        sigma_rows = _v39_rows(payload.get("o_cursigma"), f"{exchange} {url} 的 o_cursigma")
        if not all("INSTRUMENTID" in r for r in sigma_rows):
            raise RuntimeError(f"{exchange} {url} 的 o_cursigma 行没有 INSTRUMENTID")
        # 字典推导会让重复的 INSTRUMENTID 静默相互覆盖，返回错误的隐含波动率。
        # 2026-09-20 抽查 10 个交易日（2018-09-21 期权首日起）：只有按品种汇总的「小计」行
        # 重复且 SIGMA 恒为空，真实系列 ID 不重复、SIGMA 无空值。
        sigma = {}
        for r in sigma_rows:
            series_id = str(r["INSTRUMENTID"]).strip()
            if series_id in ("小计", "合计", "总计"):
                continue
            if not series_id:
                raise RuntimeError(f"{exchange} {url} 的 o_cursigma 有空的 INSTRUMENTID")
            if series_id in sigma:
                raise RuntimeError(f"{exchange} {url} 的 o_cursigma 里 {series_id} 出现两次，"
                                   "隐含波动率会互相覆盖")
            sigma[series_id] = _v39_req_num(r.get("SIGMA"), f"{exchange} {series_id} 的 SIGMA")
        for r in payload["o_curinstrument"]:
            code = str(r.get("INSTRUMENTID", "")).strip()
            kind = {"1": "C", "2": "P"}.get(str(r.get("OPTIONSTYPE")))
            if kind is None or r["PRODUCTID"].strip() in skip:
                continue                        # 小计 / 总计 行 OPTIONSTYPE 为空
            parsed = _OPTION_CODE.match(code)
            if not parsed or parsed.group(2) != kind:
                raise RuntimeError(f"{exchange} 期权 {code} 的代码与 OPTIONSTYPE={r.get('OPTIONSTYPE')} 不一致")
            series = str(r["UNDERLYINGINSTRID"]).strip()
            if series not in sigma:     # 实测 10 个交易日里主表每个系列都有 sigma 行
                raise RuntimeError(f"{exchange} {url} 的 o_cursigma 里没有系列 {series}，结果不完整")
            iv = sigma[series]
            rows.append({"symbol": code, "series": series, "option_type": kind,
                         "strike": _v39_num(r["STRIKEPRICE"]),
                         "open": _fut_price(r["OPENPRICE"]), "high": _fut_price(r["HIGHESTPRICE"]),
                         "low": _fut_price(r["LOWESTPRICE"]), "close": _fut_price(r["CLOSEPRICE"]),
                         "settle": _fut_price(r["SETTLEMENTPRICE"]),
                         "pre_settle": _fut_price(r["PRESETTLEMENTPRICE"]),
                         "volume": _v39_num(r["VOLUME"]), "open_interest": _v39_num(r["OPENINTEREST"]),
                         "oi_change": _v39_num(r["OPENINTERESTCHG"]), "turnover_10k": _v39_num(r["TURNOVER"]),
                         "delta": _v39_num(r.get("DELTA")), "iv_pct": None,
                         "series_iv_pct": round(iv * 100, 4) if iv is not None else None})
    elif exchange == "CZCE":
        text, url = _czce_text("Option", "OptionDataDaily", ymd)
        if "无交易记录" in text:
            raise ValueError(f"郑商所 {ymd} 没有期权成交记录（郑商所期权 2017-04-19 起上市）")
        _, table = _czce_table(text, "合约代码")
        for r in table:
            parsed = _OPTION_CODE.match(r["合约代码"])
            if not parsed:
                raise RuntimeError(f"郑商所期权代码无法解析: {r['合约代码']}")
            rows.append({"symbol": r["合约代码"], "series": parsed.group(1), "option_type": parsed.group(2),
                         "strike": _v39_num(parsed.group(3)),
                         "open": _fut_price(r["今开盘"]), "high": _fut_price(r["最高价"]),
                         "low": _fut_price(r["最低价"]), "close": _fut_price(r["今收盘"]),
                         "settle": _fut_price(r["今结算"]), "pre_settle": _fut_price(r["昨结算"]),
                         "volume": _v39_num(r["成交量(手)"]), "open_interest": _v39_num(r["持仓量"]),
                         "oi_change": _v39_num(r["增减量"]), "turnover_10k": _v39_num(r["成交额(万元)"]),
                         "delta": _v39_num(r["DELTA"]), "iv_pct": _v39_num(r["隐含波动率"]),
                         "series_iv_pct": None})
    elif exchange == "CFFEX":
        table, url = _cffex_daily_table(ymd)
        for rec in table[1:]:
            code = rec[0].strip()
            if "-C-" not in code and "-P-" not in code:
                continue
            parsed = _OPTION_CODE.match(code)
            if not parsed:
                raise RuntimeError(f"中金所期权代码无法解析: {code}")
            r = dict(zip(table[0], rec))
            rows.append({"symbol": code, "series": parsed.group(1), "option_type": parsed.group(2),
                         "strike": _v39_num(parsed.group(3)),
                         "open": _fut_price(r["今开盘"]), "high": _fut_price(r["最高价"]),
                         "low": _fut_price(r["最低价"]), "close": _fut_price(r["今收盘"]),
                         "settle": _fut_price(r["今结算"]), "pre_settle": _fut_price(r["前结算"]),
                         "volume": _v39_num(r["成交量"]), "open_interest": _v39_num(r["持仓量"]),
                         "oi_change": _v39_num(r["持仓变化"]), "turnover_10k": _v39_num(r["成交金额"]),
                         "delta": None, "iv_pct": None, "series_iv_pct": None})
    else:
        data, url = _gfex_rows(ymd, 1)
        for r in data:
            parsed = _OPTION_CODE.match(r["delivMonth"])
            if not parsed:
                raise RuntimeError(f"广期所期权代码无法解析: {r['delivMonth']}")
            rows.append({"symbol": r["delivMonth"], "series": parsed.group(1), "option_type": parsed.group(2),
                         "strike": _v39_num(parsed.group(3)),
                         "open": _fut_price(r["open"]), "high": _fut_price(r["high"]),
                         "low": _fut_price(r["low"]), "close": _fut_price(r["close"]),
                         "settle": _fut_price(r["clearPrice"]), "pre_settle": _fut_price(r["lastClear"]),
                         "volume": _v39_num(r["volumn"]), "open_interest": _v39_num(r["openInterest"]),
                         "oi_change": _v39_num(r["diffI"]), "turnover_10k": _v39_num(r["turnover"]),
                         "delta": _v39_num(r["delta"]), "iv_pct": _v39_num(r["impliedVolatility"]),
                         "series_iv_pct": None})
    if not rows:
        raise RuntimeError(f"{exchange} {day} 解析出 0 个期权合约，格式可能已变")
    for row in rows:
        row["date"], row["exchange"] = day, exchange
    frame = _v39_frame(rows, exchange.lower(), url, _OPT_COLUMNS)
    if frame.duplicated(["symbol"]).any():
        raise RuntimeError(f"{exchange} {day} 期权合约代码重复")
    return frame


def _rank_member(value):
    value = str(value or "").strip()
    return value if value and value != "-" else None


@_v39_contract
def futures_position_rank(date, exchange, symbol=None):
    """期货会员成交量 / 持买单 / 持卖单前 20 名（交易所官方持仓排名）。

    exchange: 'SHFE' / 'INE' / 'CZCE' / 'CFFEX'（广期所、大商所未接入）。
    level='contract' 为单个合约；level='product' 为品种合计，只有郑商所公布（symbol 为品种字母，如 AP）。
    上期所 / 能源中心文件里的 cuall 行是按会员类型的汇总、没有名次，已剔除。
    symbol 可选，按合约或品种过滤（不区分大小写）。中金所按 IF/IH/IC/IM/TS/TF/T/TL 各取一个文件，
    当天已上市的品种缺任何一个都抛 RuntimeError（不返回部分品种）；source_url 列出实际读取的文件。
    上期能源 2019 年的排名文件是空的（抛 ValueError），实测 2021 年起有数据。
    """
    exchange = _fut_exchange(exchange)
    if exchange == "GFEX":
        raise ValueError("广期所持仓排名未接入")
    day = _v39_date(date)
    ymd = day.replace("-", "")
    rows = []
    if exchange in ("SHFE", "INE"):
        payload, url = _shfe_json(exchange, "future/dailydata/pm", ymd, "o_cursor")
        skip = (_shfe_ine_ids("future/dailydata/pm", ymd, "o_cursor", "INSTRUMENTID")
                if exchange == "SHFE" else set())
        for r in payload["o_cursor"]:
            code = str(r["INSTRUMENTID"]).strip()
            rank = _v39_num(r["RANK"])
            if rank is None:
                raise RuntimeError(f"{exchange} {code} 持仓排名缺名次字段")
            # RANK 1–20 为会员名次；999 = 该合约合计，-1 / 0 = 按会员类型汇总
            if not 1 <= rank <= 20 or code in skip:
                continue
            rows.append({"level": "contract", "symbol": code,
                         "rank": int(rank),
                         "volume_member": _rank_member(r["PARTICIPANTABBR1"]), "volume": _v39_num(r["CJ1"]),
                         "volume_chg": _v39_num(r["CJ1_CHG"]),
                         "long_member": _rank_member(r["PARTICIPANTABBR2"]), "long_oi": _v39_num(r["CJ2"]),
                         "long_chg": _v39_num(r["CJ2_CHG"]),
                         "short_member": _rank_member(r["PARTICIPANTABBR3"]), "short_oi": _v39_num(r["CJ3"]),
                         "short_chg": _v39_num(r["CJ3_CHG"])})
    elif exchange == "CZCE":
        text, url = _czce_text("Future", "FutureDataHolding", ymd)
        level = code = None
        for line in text.splitlines():
            head = re.match(r"^(品种|合约)：\s*(\S+)\s+日期：", line)
            if head:
                level = "product" if head.group(1) == "品种" else "contract"
                found = re.search(r"[A-Za-z]+\d*$", head.group(2))
                if not found:
                    raise RuntimeError(f"郑商所持仓排名表头认不出品种 / 合约: {line[:60]}")
                code = found.group(0)
                continue
            cells = [c.strip().replace(",", "") for c in line.split("|")]
            if len(cells) < 10 or not cells[0].isdigit():
                continue                        # 表头、合计行
            if code is None:
                raise RuntimeError("郑商所持仓排名在品种/合约标题之前出现数据行")
            rows.append({"level": level, "symbol": code, "rank": int(cells[0]),
                         "volume_member": _rank_member(cells[1]), "volume": _v39_num(cells[2]),
                         "volume_chg": _v39_num(cells[3]),
                         "long_member": _rank_member(cells[4]), "long_oi": _v39_num(cells[5]),
                         "long_chg": _v39_num(cells[6]),
                         "short_member": _rank_member(cells[7]), "short_oi": _v39_num(cells[8]),
                         "short_chg": _v39_num(cells[9])})
    else:
        expected = [p for p, first in CFFEX_RANK_FIRST_DAY.items() if ymd >= first]
        if not expected:
            raise ValueError("中金所持仓排名从 2010-04-16（沪深300 期货上市）起才有")
        urls, missing = [], []
        for product in expected:                # 当时还没上市的品种（如 2022 年前的 IM）不请求
            file_url = CFFEX_RANK_URL.format(ym=ymd[:6], dd=ymd[6:], product=product)
            table = _cffex_csv(file_url, allow_missing=True)
            if table is None:
                missing.append(product)
                continue
            urls.append(file_url)
            parsed = _cffex_rank_rows(table, product, ymd)
            rows.extend(parsed)
            if not parsed:
                raise RuntimeError(f"中金所 {product} {day} 持仓排名文件解析出 0 行，格式可能已变")
        if len(missing) == len(expected):
            raise ValueError(f"中金所 {day} 没有持仓排名：非交易日或尚未发布")
        if missing:
            raise RuntimeError(f"中金所 {day} 缺少已上市品种 {'/'.join(missing)} 的持仓排名，结果不完整"
                               "（可能尚未全部发布，稍后重试）")
        url = " | ".join(urls)
    if not rows:
        raise RuntimeError(f"{exchange} {day} 持仓排名解析出 0 行，格式可能已变")
    for row in rows:
        row["date"], row["exchange"] = day, exchange
    frame = _v39_frame(rows, exchange.lower(), url, _RANK_COLUMNS)
    if frame.duplicated(["level", "symbol", "rank"]).any():
        raise RuntimeError(f"{exchange} {day} 持仓排名 合约+名次 重复")
    if symbol:
        frame = frame[frame["symbol"].str.upper() == str(symbol).upper()].reset_index(drop=True)
    return frame


def _sina_hq(codes):
    response = _v39_http(SINA_HQ_URL + ",".join(codes), headers={"Referer": "https://finance.sina.com.cn/"})
    out = {}
    for key, body in re.findall(r'var hq_str_([^=]+)="([^"]*)"', response.content.decode("gbk", "replace")):
        out[key] = body.split(",") if body else []
    # 代码不存在时新浪照样回一个空内容的变量（实测 nf_ZZ9999）；一个变量都没有说明页面变了，
    # 否则会把格式改变报成「代码不存在或已摘牌」
    if not out:
        raise RuntimeError(f"新浪行情页没有 hq_str 变量（{response.url}），格式可能已变")
    return out, response.url


@_v39_contract
def futures_realtime(symbols):
    """国内期货实时行情（新浪）— 覆盖全部六家交易所，大商所品种只能走这里。

    symbols: 'RB0'（主力连续）/ 'CU2610' / 'IF2609' / 'M0' 等，可传列表；带不带 'nf_' 前缀都行。
    中金所品种（IF/IH/IC/IM/TS/TF/T/TL）另有 pre_close / 涨跌停价。无效代码抛 ValueError。
    盘中是实时价；收盘后是当日收盘快照，结算价以 futures_daily 为准。
    """
    if isinstance(symbols, str):
        symbols = [symbols]
    if not isinstance(symbols, (list, tuple, set)) or not symbols:
        raise ValueError("symbols 需为非空的代码或代码列表（例 'RB0' / ['RB0', 'IF2609']）")
    codes = []
    for raw in symbols:
        code = str(raw).strip()
        code = code[3:] if code.lower().startswith("nf_") else code
        if not re.fullmatch(r"[A-Za-z]{1,2}\d{1,4}", code):
            raise ValueError(f"期货代码格式不对: {raw}（例 RB0 / CU2610 / IF2609）")
        codes.append(code.upper())
    data, url = _sina_hq(["nf_" + c for c in codes])
    rows = []
    for code in codes:
        fields = data.get("nf_" + code)
        if not fields:
            raise ValueError(f"新浪没有期货 {code} 的行情（代码不存在或已摘牌）")
        product = _fut_product(code)
        if product in _CFFEX_SINA_PRODUCTS:
            if len(fields) < 50:
                raise RuntimeError(f"新浪中金所期货 {code} 字段数 {len(fields)}，格式可能已变")
            rows.append({"symbol": code, "name": fields[49], "datetime": f"{fields[36]} {fields[37]}",
                         "open": _fut_price(fields[0]), "high": _fut_price(fields[1]),
                         "low": _fut_price(fields[2]), "last": _fut_price(fields[3]),
                         "bid": _fut_price(fields[16]), "ask": _fut_price(fields[26]),
                         "bid_vol": _v39_num(fields[17]), "ask_vol": _v39_num(fields[27]),
                         "volume": _v39_num(fields[4]), "open_interest": _v39_num(fields[6]),
                         "pre_settle": _fut_price(fields[14]), "pre_close": _fut_price(fields[13]),
                         "upper_limit": _fut_price(fields[9]), "lower_limit": _fut_price(fields[10]),
                         "avg_price": _fut_price(fields[48])})
        else:
            if len(fields) < 28:
                raise RuntimeError(f"新浪商品期货 {code} 字段数 {len(fields)}，格式可能已变")
            clock = fields[1].zfill(6)
            rows.append({"symbol": code, "name": fields[0],
                         "datetime": f"{fields[17]} {clock[:2]}:{clock[2:4]}:{clock[4:]}",
                         "open": _fut_price(fields[2]), "high": _fut_price(fields[3]),
                         "low": _fut_price(fields[4]), "last": _fut_price(fields[8]),
                         "bid": _fut_price(fields[6]), "ask": _fut_price(fields[7]),
                         "bid_vol": _v39_num(fields[11]), "ask_vol": _v39_num(fields[12]),
                         "volume": _v39_num(fields[14]), "open_interest": _v39_num(fields[13]),
                         "pre_settle": _fut_price(fields[10]), "pre_close": None,
                         "upper_limit": None, "lower_limit": None, "avg_price": _fut_price(fields[27])})
    return _v39_frame(rows, "sina", url)


@_v39_contract
def futures_kline(symbol, start=None, end=None):
    """国内期货日 K 线（新浪）— 单个合约或主力连续的逐日序列，覆盖全部六家交易所（含大商所）。

    symbol: 'RB0' / 'M0'（主力连续）或 'RB2601' / 'M2601' / 'IF2612'；郑商所也写 4 位年月（'MA2601'），带不带 'nf_' 前缀都行。
    start/end: 'YYYY-MM-DD'，可只给一端。主力连续换月当天会跳空，未做复权。
    实测（2026-09-22）价格与交易所官方 futures_daily 逐日一致，成交量 / 持仓偶有 ≤0.1% 的出入，精确值以 futures_daily 为准。
    结算价新浪给得不全（给 0 的统一成 None）：中金所品种基本没有；主力连续早年缺得多（CU0 5285 根缺 1364 根，
    最晚缺到 2024-09-25），需要结算价用 futures_daily。具体合约只能取到约 2022 年起到期的，更早的新浪返回空；
    中金所主力连续（IF0 / IC0 / IH0 / T0 / TF0）只从 2017-01-17 起，更早的用 futures_daily。
    新浪每次都返回该代码的全部历史（RB0 约 0.5 MB），start / end 是取回后本地筛选。
    代码不存在 / 太老、区间内没有 K 线抛 ValueError；返回格式改变抛 RuntimeError。
    """
    code = str(symbol).strip()
    code = code[3:] if code.lower().startswith("nf_") else code
    if not re.fullmatch(r"[A-Za-z]{1,2}\d{1,4}", code):
        raise ValueError(f"期货代码格式不对: {symbol}（例 RB0 / RB2601 / MA2601）")
    code = code.upper()
    lo = _v39_date(start) if start else None
    hi = _v39_date(end) if end else None
    if lo and hi and lo > hi:
        raise ValueError(f"start {lo} 晚于 end {hi}")
    response = _v39_http(SINA_FUT_KLINE_URL.format(code=code), params={"symbol": code}, timeout=(5, 20),
                         headers={"Referer": "https://finance.sina.com.cn/"}, session=V39_RETRY_SESSION)
    text = response.content.decode("gbk", "replace")
    match = re.search(rf"var _{re.escape(code)}=\((.*)\);?\s*$", text, re.S)
    if not match:
        raise RuntimeError(f"新浪期货日 K {code} 的返回不是预期的 JSONP（{response.url}），格式可能已变")
    body = match.group(1).strip()
    if body == "null":
        raise ValueError(f"新浪没有期货 {code} 的日 K：代码不存在，或是约 2022 年以前到期的老合约"
                         "（郑商所也要写 4 位年月，如 MA2601）")
    try:
        items = json.loads(body)
    except ValueError as exc:
        raise RuntimeError(f"新浪期货日 K {code} 的返回不是 JSON，格式可能已变") from exc
    rows, seen = [], set()
    for r in _v39_rows(items, f"新浪期货日 K {code}"):
        day = _v39_src_date(r["d"])
        if day in seen:
            raise RuntimeError(f"新浪期货日 K {code} 同一天 {day} 出现两次，结果不可信")
        seen.add(day)
        if (lo and day < lo) or (hi and day > hi):
            continue
        rows.append({"date": day, "symbol": code,
                     "open": _fut_price(r["o"]), "high": _fut_price(r["h"]),
                     "low": _fut_price(r["l"]), "close": _fut_price(r["c"]),
                     "settle": _fut_price(r["s"]),       # 新浪没有结算价时给 0 → None
                     "volume": _v39_num(r["v"]), "open_interest": _v39_num(r["p"])})
    if not rows:
        raise ValueError(f"新浪期货 {code} 在所给区间内没有日 K（合约当时未上市或已到期）")
    rows.sort(key=lambda row: row["date"])
    return _v39_frame(rows, "sina", response.url,
                      ["date", "symbol", "open", "high", "low", "close", "settle", "volume", "open_interest"])


@_v39_contract
def a50_futures():
    """富时中国 A50 期指（新浪 hf_CHA50CFD，连续合约报价）— 盘前/夜盘看 A 股外资情绪。"""
    data, url = _sina_hq(["hf_CHA50CFD"])
    fields = data.get("hf_CHA50CFD")
    if not fields or len(fields) < 14:
        raise RuntimeError("新浪 A50 期指行情为空或字段数不对")
    row = {"name": fields[13], "datetime": f"{fields[12]} {fields[6]}",
           "last": _fut_price(fields[0]), "open": _fut_price(fields[8]),
           "high": _fut_price(fields[4]), "low": _fut_price(fields[5]),
           "bid": _fut_price(fields[2]), "ask": _fut_price(fields[3]),
           "pre_settle": _fut_price(fields[7])}
    if row["last"] is None:
        raise RuntimeError("新浪 A50 期指最新价为空")
    return _v39_frame([row], "sina", url)


@_v39_contract
def sge_spot(instrument="Au99.99"):
    """上海黄金交易所现货日线（官方）— 2016-12 至今。

    instrument 例: 'Au99.99' / 'Au(T+D)' / 'mAu(T+D)' / 'Ag(T+D)' / 'Ag99.99' / 'Pt99.95'。
    黄金单位 元/克，白银 元/千克。无成交日交易所填 0，这里剔除；代码不存在时上金所返回全 0，抛 ValueError。
    少数日子收盘价略超出高低区间是原始数据如此，日期列在 attrs['ohlc_anomaly_dates']。
    """
    response = _v39_http(SGE_DAILY_URL, method="POST", data={"instid": instrument},
                         headers={"Referer": "https://www.sge.com.cn/"})
    payload = _v39_json(response)
    series = payload.get("time") if isinstance(payload, dict) else None
    if not isinstance(series, list):
        raise RuntimeError("上金所日线返回结构改变")
    rows = []
    for rec in series:
        if not isinstance(rec, list) or len(rec) != 5:
            raise RuntimeError(f"上金所日线字段数不对: {rec}")
        prices = [_v39_num(v) for v in rec[1:]]
        # 实测 7 个品种约 1.5 万条全是数字，无成交填 0；空值 / NaN 说明格式变了，不能当无成交跳过
        if None in prices:
            raise RuntimeError(f"上金所日线出现空值或非有限数值: {rec}")
        if not all(prices):
            continue
        open_, close, low, high = prices
        rows.append({"date": _v39_src_date(rec[0]), "instrument": instrument, "open": open_,
                     "high": high, "low": low, "close": close})
    if not rows:
        raise ValueError(f"上金所没有 {instrument} 的有效行情（代码不存在时返回全 0）")
    # 实测 Au99.99 在 2017–2018 年有 17 天收盘价略超出当日高低区间（上金所原始数据如此，
    # 不是高低列颠倒）。个别日子保留原值、记在 attrs；大面积不成立才说明字段顺序变了。
    bad = [r["date"] for r in rows if not r["low"] <= min(r["open"], r["close"]) <= max(r["open"], r["close"]) <= r["high"]]
    if len(bad) > 0.05 * len(rows):
        raise RuntimeError(f"上金所日线 {len(bad)}/{len(rows)} 天高低开收关系不成立，字段顺序可能已变")
    frame = _v39_frame(rows, "sge", response.url)
    frame.attrs["ohlc_anomaly_dates"] = bad
    return frame


# ===== 上游标记块:v39-events =====
import json


def _v39_limit(limit, upper=5000):
    limit = int(limit)
    if not 1 <= limit <= upper:
        raise ValueError(f"limit 范围 1–{upper}")
    return limit


def _em_event_filter(code=None, date_field=None, start=None, end=None, extra=""):
    """拼东财 datacenter filter：个股代码 + 公告日期区间 + 额外条件。start 晚于 end 在请求前抛 ValueError。"""
    if start and end and _v39_date(start) > _v39_date(end):
        raise ValueError("start 不能晚于 end")
    parts = [extra] if extra else []
    if code is not None:
        parts.append(f'(SECURITY_CODE="{norm_ticker(code, stock_only=True)}")')
    if start:
        parts.append(f"({date_field}>='{_v39_date(start)}')")
    if end:
        parts.append(f"({date_field}<='{_v39_date(end)}')")
    return "".join(parts)


def _em_event_rows(report, filter_str, sort_columns, sort_types, limit, narrowed, extra=None,
                   equal=None, dates=None):
    """narrowed=False（全市场、不带任何条件）时 0 行说明接口坏了，直接抛错；
    带了个股 / 日期条件时 0 行是「确实没有」，返回空表。

    排序字段必须能唯一确定一行：东财按页切片，排序有并列时翻页会重复一行、同时漏掉另一行
    （实测质押表只按质押比例排序时 2212 行里重复 1 行、漏 1 行）。出现完全相同的行就直接抛错。

    服务端筛选只是请求：equal={字段: 值}、dates={日期字段: (起, 止)} 逐行核对返回的行，
    接口忽略筛选或回了别的缓存页时抛 RuntimeError，不把别的标的 / 报告期 / 日期当结果返回。"""
    rows = _em_datacenter_strict(report, filter_str, sort_columns, sort_types,
                                 page_size=min(limit, 500), max_rows=limit, extra=extra)
    if not rows and not narrowed:
        raise RuntimeError(f"东财 {report} 全市场返回 0 行，接口可能改了")
    if len({json.dumps(r, sort_keys=True, ensure_ascii=False) for r in rows}) != len(rows):
        raise RuntimeError(f"东财 {report} 翻页返回了重复行（排序不唯一），结果不完整")
    for r in rows:
        for field, value in (equal or {}).items():
            if r.get(field) != value:
                raise RuntimeError(f"东财 {report} 请求 {field}={value}，却返回了 {r.get(field)!r}，结果不可信")
        for field, (lo, hi) in (dates or {}).items():
            day = _v39_src_date(str(r.get(field) or "")[:10])
            if (lo and day < lo) or (hi and day > hi):
                raise RuntimeError(f"东财 {report} 请求 {field} 在 {lo or ''}~{hi or ''}，却返回了 {day}，结果不可信")
    return rows


_FORECAST_COLUMNS = ["code", "name", "notice_date", "report_date", "indicator", "forecast_type",
                     "amount_lower", "amount_upper", "change_pct_lower", "change_pct_upper",
                     "prior_year_amount", "content", "reason"]


@_v39_contract
def earnings_forecast(code=None, report_date=None, limit=500):
    """业绩预告（东财数据中心，沪深京全市场）。

    code 不给 = 全市场最新 limit 条（按公告日倒序）；report_date 为报告期，如 '2026-09-30'。
    一次预告会拆成多行：indicator 是预告指标（归母净利润 / 扣非净利润 / 营业收入…）。
    金额单位 元，change_pct 为同比变动 %。
    """
    limit = _v39_limit(limit)
    period = _v39_date(report_date) if report_date else None
    extra = f"(REPORT_DATE='{period}')" if period else ""
    filter_str = _em_event_filter(code, extra=extra)
    rows = _em_event_rows("RPT_PUBLIC_OP_NEWPREDICT", filter_str,
                          "NOTICE_DATE,SECURITY_CODE,REPORT_DATE,PREDICT_FINANCE_CODE", "-1,1,-1,1",
                          limit, narrowed=bool(code or report_date),
                          equal={} if code is None else {"SECURITY_CODE": norm_ticker(code, stock_only=True)},
                          dates={"REPORT_DATE": (period, period)} if period else None)
    out = [{"code": r["SECURITY_CODE"], "name": r.get("SECURITY_NAME_ABBR"),
            "notice_date": _em_day(r.get("NOTICE_DATE")), "report_date": _em_day(r.get("REPORT_DATE")),
            "indicator": r.get("PREDICT_FINANCE"), "forecast_type": r.get("PREDICT_TYPE"),
            "amount_lower": _v39_num(r.get("PREDICT_AMT_LOWER")),
            "amount_upper": _v39_num(r.get("PREDICT_AMT_UPPER")),
            "change_pct_lower": _v39_num(r.get("ADD_AMP_LOWER")),
            "change_pct_upper": _v39_num(r.get("ADD_AMP_UPPER")),
            "prior_year_amount": _v39_num(r.get("PREYEAR_SAME_PERIOD")),
            "content": r.get("PREDICT_CONTENT"), "reason": r.get("CHANGE_REASON_EXPLAIN")}
           for r in rows]
    return _v39_frame(out, "eastmoney", DATACENTER_URL + "?reportName=RPT_PUBLIC_OP_NEWPREDICT",
                      _FORECAST_COLUMNS)


_SURVEY_COLUMNS = ["code", "name", "notice_date", "survey_date", "survey_end", "org_count",
                   "survey_way", "place", "receptionist"]


@_v39_contract
def institution_survey(code=None, start=None, end=None, detail=False, limit=500):
    """机构调研（东财数据中心，汇总自上市公司投资者关系活动记录表）。

    detail=False：一次调研一行，org_count 为参与机构家数；
    detail=True：一家机构一行，多出 org_name / org_type / investigators（很多记录表不写机构类型和人名，为 None）。
    start / end 按公告日（notice_date）筛选；survey_date 是实际接待日，通常早于公告日几天。
    """
    limit = _v39_limit(limit)
    extra = '(IS_SOURCE="1")' + ("" if detail else '(NUMBERNEW="1")')
    filter_str = _em_event_filter(code, "NOTICE_DATE", start, end, extra)
    sort = (("NOTICE_DATE,SECURITY_CODE,RECEIVE_START_DATE,NUMBERNEW", "-1,1,-1,1") if detail
            else ("NOTICE_DATE,SECURITY_CODE,RECEIVE_START_DATE", "-1,1,-1"))
    equal = {"IS_SOURCE": "1"} if detail else {"IS_SOURCE": "1", "NUMBERNEW": "1"}
    if code is not None:
        equal["SECURITY_CODE"] = norm_ticker(code, stock_only=True)
    rows = _em_event_rows("RPT_ORG_SURVEYNEW", filter_str, sort[0], sort[1], limit,
                          narrowed=bool(code or start or end), equal=equal,
                          dates={"NOTICE_DATE": (start and _v39_date(start), end and _v39_date(end))}
                          if start or end else None)
    out = []
    for r in rows:
        row = {"code": r["SECURITY_CODE"], "name": r.get("SECURITY_NAME_ABBR"),
               "notice_date": _em_day(r.get("NOTICE_DATE")), "survey_date": _em_day(r.get("RECEIVE_START_DATE")),
               "survey_end": _em_day(r.get("RECEIVE_END_DATE")), "org_count": _v39_num(r.get("SUM")),
               "survey_way": r.get("RECEIVE_WAY_EXPLAIN"), "place": r.get("RECEIVE_PLACE"),
               "receptionist": r.get("RECEPTIONIST")}
        if detail:
            row.update({"org_name": r.get("RECEIVE_OBJECT"), "org_type": r.get("ORG_TYPE"),
                        "investigators": r.get("INVESTIGATORS")})
        out.append(row)
    columns = _SURVEY_COLUMNS + (["org_name", "org_type", "investigators"] if detail else [])
    return _v39_frame(out, "eastmoney", DATACENTER_URL + "?reportName=RPT_ORG_SURVEYNEW", columns)


_HOLDER_COLUMNS = ["code", "name", "holder", "direction", "change_shares_10k", "change_pct_total",
                   "change_pct_float", "after_shares_10k", "after_pct_total", "after_float_shares_10k",
                   "after_pct_float", "avg_price", "channel", "start_date", "end_date", "notice_date"]


@_v39_contract
def holder_trades(code=None, direction=None, start=None, end=None, limit=500):
    """股东增减持（东财数据中心，重要股东二级市场 / 大宗交易等变动公告）。

    direction: None / '增持' / '减持'。start / end 按公告日筛选。
    股数单位 万股；change_shares_10k 带符号（减持为负）；*_pct_total 占总股本 %，*_pct_float 占流通股 %。
    avg_price 为公告披露的成交均价，很多公告不披露，为 None。channel 为变动方式（二级市场 / 大宗交易 / 协议转让…）。
    """
    limit = _v39_limit(limit)
    if direction not in (None, "增持", "减持"):
        raise ValueError("direction 只能是 None / '增持' / '减持'")
    extra = f'(DIRECTION="{direction}")' if direction else ""
    filter_str = _em_event_filter(code, "NOTICE_DATE", start, end, extra)
    equal = {"DIRECTION": direction} if direction else {}
    if code is not None:
        equal["SECURITY_CODE"] = norm_ticker(code, stock_only=True)
    rows = _em_event_rows("RPT_SHARE_HOLDER_INCREASE", filter_str,
                          "NOTICE_DATE,SECURITY_CODE,HOLDER_NAME,START_DATE,END_DATE", "-1,1,1,1,1",
                          limit, narrowed=bool(code or start or end), equal=equal,
                          dates={"NOTICE_DATE": (start and _v39_date(start), end and _v39_date(end))}
                          if start or end else None)
    out = []
    for r in rows:
        signed = _v39_num(r.get("CHANGE_NUM_SYMBOL"))
        if signed is not None and r.get("DIRECTION") in ("增持", "减持") and (signed < 0) != (r["DIRECTION"] == "减持"):
            raise RuntimeError(f"东财增减持方向与变动股数符号不一致: {r['SECURITY_CODE']} {r['HOLDER_NAME']}")
        out.append({"code": r["SECURITY_CODE"], "name": r.get("SECURITY_NAME_ABBR"),
                    "holder": r.get("HOLDER_NAME"), "direction": r.get("DIRECTION"),
                    "change_shares_10k": signed,
                    # 东财字段名 AFTER_CHANGE_RATE 实为「本次变动占总股本比例」（与变动股数 / 总股本对得上）
                    "change_pct_total": _v39_num(r.get("AFTER_CHANGE_RATE")),
                    "change_pct_float": _v39_num(r.get("CHANGE_FREE_RATIO")),
                    "after_shares_10k": _v39_num(r.get("AFTER_HOLDER_NUM")),
                    "after_pct_total": _v39_num(r.get("HOLD_RATIO")),
                    "after_float_shares_10k": _v39_num(r.get("FREE_SHARES")),
                    "after_pct_float": _v39_num(r.get("FREE_SHARES_RATIO")),
                    "avg_price": _v39_num(r.get("TRADE_AVERAGE_PRICE")), "channel": r.get("MARKET"),
                    "start_date": _em_day(r.get("START_DATE")), "end_date": _em_day(r.get("END_DATE")),
                    "notice_date": _em_day(r.get("NOTICE_DATE"))})
    return _v39_frame(out, "eastmoney", DATACENTER_URL + "?reportName=RPT_SHARE_HOLDER_INCREASE",
                      _HOLDER_COLUMNS)


_BUYBACK_PROGRESS = {"001": "董事会预案", "002": "股东大会通过", "003": "股东大会否决",
                     "004": "实施中", "005": "停止实施", "006": "完成实施"}
_BUYBACK_COLUMNS = ["code", "name", "progress", "progress_code", "plan_start", "plan_end", "price_cap",
                    "shares_lower", "shares_upper", "amount_lower", "amount_upper",
                    "pct_total_lower", "pct_total_upper", "done_shares", "done_amount",
                    "done_price_low", "done_price_high", "latest_notice", "objective"]


@_v39_contract
def share_buyback(code=None, progress=None, limit=500):
    """股票回购（东财数据中心）— 回购方案与实施进度，一个方案一行、按最新公告日倒序。

    progress: None 或 '董事会预案' / '股东大会通过' / '股东大会否决' / '实施中' / '停止实施' / '完成实施'。
    股数单位 股，金额单位 元，pct_total_* 为占公告前一日总股本 %。done_* 为已回购部分（未开始实施为 None）。
    东财另有 007 / 008 两个进度码（2026-09-20 实测 5516 条里共 13 条），它自己的页面也不显示名称，
    这里 progress 为 None、progress_code 保留原码。
    """
    limit = _v39_limit(limit)
    codes = {v: k for k, v in _BUYBACK_PROGRESS.items()}
    if progress is not None and progress not in codes:
        raise ValueError("progress 只能是 " + " / ".join(codes))
    equal = {}
    if code is not None:
        equal["DIM_SCODE"] = norm_ticker(code, stock_only=True)     # 这张表的代码字段叫 DIM_SCODE
    if progress:
        equal["REPURPROGRESS"] = codes[progress]
    filter_str = "".join(f'({field}="{value}")' for field, value in equal.items())
    rows = _em_event_rows("RPTA_WEB_GETHGLIST_NEW", filter_str, "UPD,DIM_SCODE,REPURCODE", "-1,1,1",
                          limit, narrowed=bool(equal), equal=equal)
    out = []
    for r in rows:
        out.append({"code": r["DIM_SCODE"], "name": r.get("SECURITYSHORTNAME"),
                    "progress": _BUYBACK_PROGRESS.get(r.get("REPURPROGRESS")),
                    "progress_code": r.get("REPURPROGRESS"),
                    "plan_start": _em_day(r.get("REPURSTARTDATE")), "plan_end": _em_day(r.get("REPURENDDATE")),
                    "price_cap": _v39_num(r.get("REPURPRICECAP")),
                    "shares_lower": _v39_num(r.get("REPURNUMLOWER")), "shares_upper": _v39_num(r.get("REPURNUMCAP")),
                    "amount_lower": _v39_num(r.get("REPURAMOUNTLOWER")),
                    "amount_upper": _v39_num(r.get("REPURAMOUNTLIMIT")),
                    "pct_total_lower": _v39_num(r.get("ZSZXX")), "pct_total_upper": _v39_num(r.get("ZSZSX")),
                    "done_shares": _v39_num(r.get("REPURNUM")), "done_amount": _v39_num(r.get("REPURAMOUNT")),
                    "done_price_low": _v39_num(r.get("REPURPRICELOWER1")),
                    "done_price_high": _v39_num(r.get("REPURPRICECAP1")),
                    "latest_notice": _em_day(r.get("UPDATEDATE")), "objective": r.get("REPUROBJECTIVE")})
    return _v39_frame(out, "eastmoney", DATACENTER_URL + "?reportName=RPTA_WEB_GETHGLIST_NEW", _BUYBACK_COLUMNS)


_PLEDGE_COLUMNS = ["date", "code", "name", "industry", "pledge_ratio_pct", "pledged_shares_10k",
                   "pledged_mktcap_10k", "pledge_count", "unrestricted_pledged_10k", "restricted_pledged_10k"]


@_v39_contract
def equity_pledge(code=None, date=None, limit=5000):
    """股权质押比例（中国结算每周统计，经东财数据中心）。

    code 给了：该股历次统计（按日期倒序）；date 给了：该统计日全市场；都不给：最近一个统计日全市场；
    两个都给抛 ValueError（不会静默丢掉其中一个）。
    中国结算按周发布（通常为周五），date 不是统计日会得到 ValueError。
    pledge_ratio_pct 为质押股数占总股本 %；股数单位 万股，市值单位 万元。
    只覆盖沪深（2026-09-20 实测全市场 2212 条没有北交所），北交所代码直接抛 ValueError，不返回空表。
    """
    limit = _v39_limit(limit)
    if code is not None and date is not None:
        raise ValueError("code 与 date 只能给一个：code 取该股历次统计，date 取该统计日全市场")
    if code is not None and get_prefix(code) == "bj":
        raise ValueError(f"{code} 是北交所证券；中国结算质押统计只覆盖沪深，没有北交所数据")
    report = "RPT_CSDC_LIST"
    url = DATACENTER_URL + "?reportName=" + report
    if code is not None:
        rows = _em_event_rows(report, _em_event_filter(code), "TRADE_DATE", "-1", limit, narrowed=True,
                              equal={"SECURITY_CODE": norm_ticker(code, stock_only=True)})
    else:
        if date is None:
            latest = _em_event_rows(report, "", "TRADE_DATE", "-1", 1, narrowed=False)
            date = latest[0]["TRADE_DATE"]
        day = _v39_date(str(date)[:10])
        rows = _em_event_rows(report, f"(TRADE_DATE='{day}')", "PLEDGE_RATIO,SECURITY_CODE", "-1,1",
                              limit, narrowed=True, dates={"TRADE_DATE": (day, day)})
        if not rows:
            raise ValueError(f"{day} 不是中国结算质押统计日（按周发布，通常为周五）")
    out = []
    for r in rows:
        total = _v39_num(r.get("REPURCHASE_BALANCE"))
        free, locked = _v39_num(r.get("REPURCHASE_UNLIMITED_BALANCE")), _v39_num(r.get("REPURCHASE_LIMITED_BALANCE"))
        if None not in (total, free, locked) and abs(free + locked - total) > max(1.0, total * 0.001):
            raise RuntimeError(f"东财质押数据 无限售 + 限售 ≠ 合计: {r['SECURITY_CODE']} {r['TRADE_DATE']}")
        out.append({"date": _em_day(r.get("TRADE_DATE")), "code": r["SECURITY_CODE"],
                    "name": r.get("SECURITY_NAME_ABBR"), "industry": r.get("INDUSTRY"),
                    "pledge_ratio_pct": _v39_num(r.get("PLEDGE_RATIO")), "pledged_shares_10k": total,
                    "pledged_mktcap_10k": _v39_num(r.get("PLEDGE_MARKET_CAP")),
                    "pledge_count": _v39_num(r.get("PLEDGE_DEAL_NUM")),
                    "unrestricted_pledged_10k": free, "restricted_pledged_10k": locked})
    frame = _v39_frame(out, "eastmoney", url, _PLEDGE_COLUMNS)
    if frame.duplicated(["date", "code"]).any():
        raise RuntimeError("东财质押数据 日期+代码 重复")
    return frame


_IPO_COLUMNS = ["code", "name", "apply_code", "exchange", "board", "apply_date", "ballot_date", "pay_date",
                "listing_date", "issue_price", "issue_pe", "industry_pe", "issue_shares_10k",
                "online_shares", "apply_upper_shares", "top_apply_mktcap_10k", "win_rate_pct",
                "first_close", "first_close_chg_pct"]


@_v39_contract
def ipo_calendar(limit=100):
    """新股申购日历（东财数据中心，沪深京）— 按申购日倒序，包含尚未申购的排期。

    issue_price 在定价前为 None。issue_shares_10k 单位万股；online_shares / apply_upper_shares 单位股；
    top_apply_mktcap_10k 为顶格申购需配市值（万元）；win_rate_pct 为网上中签率 %；
    first_close_chg_pct 为上市首日收盘涨幅 %（未上市为 None）。
    """
    limit = _v39_limit(limit)
    rows = _em_event_rows("RPTA_APP_IPOAPPLY", "", "APPLY_DATE,SECURITY_CODE", "-1,-1", limit, narrowed=False)
    out = [{"code": r["SECURITY_CODE"], "name": r.get("SECURITY_NAME"), "apply_code": r.get("APPLY_CODE"),
            "exchange": r.get("TRADE_MARKET"),
            # MARKET 是「深交所主板 / 深交所创业板」这类准确板块；MARKET_TYPE_NEW 会把未上市的标成「深交所其他」，
            # 但北交所新股只有后者
            "board": r.get("MARKET") or r.get("MARKET_TYPE_NEW"),
            "apply_date": _em_day(r.get("APPLY_DATE")), "ballot_date": _em_day(r.get("BALLOT_NUM_DATE")),
            "pay_date": _em_day(r.get("BALLOT_PAY_DATE")), "listing_date": _em_day(r.get("LISTING_DATE")),
            "issue_price": _v39_num(r.get("ISSUE_PRICE")) or None,     # 定价前东财填 null 或 0
            "issue_pe": _v39_num(r.get("AFTER_ISSUE_PE")), "industry_pe": _v39_num(r.get("INDUSTRY_PE")),
            "issue_shares_10k": _v39_num(r.get("ISSUE_NUM")), "online_shares": _v39_num(r.get("ONLINE_ISSUE_NUM")),
            "apply_upper_shares": _v39_num(r.get("ONLINE_APPLY_UPPER")),
            "top_apply_mktcap_10k": _v39_num(r.get("TOP_APPLY_MARKETCAP")),
            "win_rate_pct": _v39_num(r.get("ONLINE_ISSUE_LWR")),
            "first_close": _v39_num(r.get("CLOSE_PRICE")),
            "first_close_chg_pct": _v39_num(r.get("LD_CLOSE_CHANGE"))}
           for r in rows]
    frame = _v39_frame(out, "eastmoney", DATACENTER_URL + "?reportName=RPTA_APP_IPOAPPLY", _IPO_COLUMNS)
    if frame.duplicated(["code"]).any():
        raise RuntimeError("东财新股日历代码重复")
    return frame


# ===== 上游标记块:v39-cb =====
from datetime import datetime, timedelta, timezone

_CB_QUOTES = ("f2~01~CONVERT_STOCK_CODE~CONVERT_STOCK_PRICE,f235~10~SECURITY_CODE~TRANSFER_PRICE,"
              "f236~10~SECURITY_CODE~TRANSFER_VALUE,f2~10~SECURITY_CODE~CURRENT_BOND_PRICE,"
              "f237~10~SECURITY_CODE~TRANSFER_PREMIUM_RATIO")
_CB_COLUMNS = ["code", "name", "status", "stock_code", "stock_name", "rating", "issue_size_100m",
               "apply_date", "apply_code", "listing_date", "delist_date", "expire_date", "convert_start",
               "initial_convert_price", "convert_price", "bond_price", "stock_price", "convert_value",
               "premium_pct"]


@_v39_contract
def convertible_bonds(include_delisted=False):
    """可转债全表（东财数据中心）— 基本条款 + 最新转股价 / 债价 / 正股价 / 转股价值 / 溢价率。

    status: 'upcoming'（已发行未上市）/ 'listed'（交易中）/ 'delisted'（已摘牌，include_delisted=True 才返回）/
    'unknown'（交易市场不认识，或既没有上市日也没有申购日，不猜）。
    退市板块的转债（代码 404xxx、TRADE_MARKET=STAS00，如 404005 普利退债）东财不填上市日和摘牌日，按 delisted 处理。
    行情类字段由东财服务端按最新报价填入：盘中为实时价，停牌或未上市为 None。
    转股价值 = 100 / 转股价 × 正股价；premium_pct = 债价 / 转股价值 − 1（%）。issue_size_100m 单位亿元。
    """
    rows = _em_datacenter_strict("RPT_BOND_CB_LIST", "", "PUBLIC_START_DATE,SECURITY_CODE", "-1,1",
                                 page_size=500, max_rows=20000,
                                 extra={"quoteColumns": _CB_QUOTES, "quoteType": "0"})
    if not rows:
        raise RuntimeError("东财可转债列表为空，接口可能改了")
    today = datetime.now(timezone(timedelta(hours=8))).date().isoformat()   # 按北京时间，不看本机时区
    out = []
    for r in rows:
        listing, delist = _em_day(r.get("LISTING_DATE")), _em_day(r.get("DELIST_DATE"))
        market = r.get("TRADE_MARKET")
        # 东财在发布赎回/到期公告后就会填上未来的摘牌日，摘牌日之前仍在交易；
        # 上市日同理可能提前填上，上市日之前算 upcoming
        if (delist and delist <= today) or market == "STAS00":     # STAS00 = 退市板块，已从沪深摘牌
            status = "delisted"
        elif market not in ("CNSESH", "CNSESZ"):
            status = "unknown"
        elif listing and listing <= today:
            status = "listed"
        elif listing or r.get("PUBLIC_START_DATE"):
            status = "upcoming"
        else:
            status = "unknown"
        if status == "delisted" and not include_delisted:
            continue
        out.append({"code": r["SECURITY_CODE"], "name": r.get("SECURITY_NAME_ABBR"), "status": status,
                    "stock_code": r.get("CONVERT_STOCK_CODE"), "stock_name": r.get("SECURITY_SHORT_NAME"),
                    "rating": r.get("RATING"), "issue_size_100m": _v39_num(r.get("ACTUAL_ISSUE_SCALE")),
                    "apply_date": _em_day(r.get("PUBLIC_START_DATE")), "apply_code": r.get("CORRECODE"),
                    "listing_date": listing, "delist_date": delist, "expire_date": _em_day(r.get("EXPIRE_DATE")),
                    "convert_start": _em_day(r.get("TRANSFER_START_DATE")),
                    "initial_convert_price": _v39_num(r.get("INITIAL_TRANSFER_PRICE")),
                    "convert_price": _v39_num(r.get("TRANSFER_PRICE")),
                    "bond_price": _v39_num(r.get("CURRENT_BOND_PRICE")),
                    "stock_price": _v39_num(r.get("CONVERT_STOCK_PRICE")),
                    "convert_value": _v39_num(r.get("TRANSFER_VALUE")),
                    "premium_pct": _v39_num(r.get("TRANSFER_PREMIUM_RATIO"))})
    frame = _v39_frame(out, "eastmoney", DATACENTER_URL + "?reportName=RPT_BOND_CB_LIST", _CB_COLUMNS)
    if frame.duplicated(["code"]).any():
        raise RuntimeError("东财可转债列表代码重复")
    return frame


# ===== 上游标记块:official-data-backups =====
import json
import time


def _official_total(value):
    if not re.fullmatch(r"[0-9]+", str(value)):
        raise RuntimeError("官方分页总数必须为非负整数")
    return int(value)


def _official_margin_code(value, exchange):
    code = _official_code(value)
    prefixes = ("5", "6", "900") if exchange == "SH" else ("0", "1", "2", "3")
    if not code.startswith(prefixes):
        raise ValueError("两融证券代码与请求的交易所不符")
    return code


def margin_trading_backup(trade_date, exchange, code=None):
    """一次只取一个交易所。未发布抛错；完整源中筛不到 code 才返回空表。"""
    trade_date = _official_date(trade_date)
    exchange = str(exchange).upper()
    if exchange not in ("SH", "SZ"):
        raise ValueError("exchange 必须为 SH 或 SZ；本函数不覆盖北交所两融")
    if code is not None:
        code = _official_margin_code(code, exchange)
    if exchange == "SH":
        url = "https://query.sse.com.cn/marketdata/tradedata/queryMargin.do"
        response = _official_get(url, {
            "isPagination": "true", "tabType": "mxtype", "detailsDate": trade_date.replace("-", ""),
            "pageHelp.pageSize": 5000, "pageHelp.pageNo": 1, "pageHelp.beginPage": 1,
            "pageHelp.cacheSize": 1, "pageHelp.endPage": 1,
        }, "https://www.sse.com.cn/")
        page = response.json().get("pageHelp") or {}
        data = page.get("data")
        if not isinstance(data, list) or not data or len(data) != _official_total(page.get("total")):
            raise RuntimeError("上交所该日数据未发布或分页不完整")
        fields = {"rzye": "margin_balance", "rzmre": "margin_buy", "rqylje": "short_balance",
                  "rqyl": "short_volume", "rqmcl": "short_sell_volume"}
        rows = []
        for rec in data:
            if _official_date(rec.get("opDate")) != trade_date:
                raise RuntimeError("上交所两融数据日期不符")
            if not set(fields).issubset(rec):
                raise RuntimeError("上交所两融字段发生变化")
            rows.append({"date": trade_date, "code": _official_margin_code(rec["stockCode"], exchange),
                         "name": rec.get("securityAbbr"), "exchange": exchange,
                         **{dest: _official_number(rec[src], required=(src != "rqylje"))
                            for src, dest in fields.items()}})
    else:
        url = "https://www.szse.cn/api/report/ShowReport"
        response = _official_get(url, {"SHOWTYPE": "xlsx", "CATALOGID": "1837_xxpl",
                                      "TABKEY": "tab2", "txtDate": trade_date}, "https://www.szse.cn/")
        data = _official_excel(response)
        fields = {"融资余额(元)": "margin_balance", "融资买入额(元)": "margin_buy",
                  "融券余额(元)": "short_balance", "融券余量(股/份)": "short_volume",
                  "融券卖出量(股/份)": "short_sell_volume"}
        _official_columns(data, ["证券代码", "证券简称", *fields])
        rows = [{"date": trade_date, "code": _official_margin_code(str(rec["证券代码"]).zfill(6), exchange),
                 "name": rec["证券简称"], "exchange": exchange,
                 **{dest: _official_number(rec[src], required=True) for src, dest in fields.items()}}
                for rec in data.to_dict("records")]
    frame = _official_frame(rows, ["date", "code"], "sse" if exchange == "SH" else "szse", response.url)
    return frame if code is None else frame.loc[frame.code == code].reset_index(drop=True)


def bse_quote_backup(trade_date, code=None):
    """北交所当前全板/单票快照；拒绝用当前数据回填其他交易日。"""
    trade_date = _official_date(trade_date)
    if code is not None:
        code = _official_code(code)
        if not code.startswith(("4", "8", "92")):
            raise ValueError("请输入北交所代码（4/8/92 开头）")
    page_url = "https://www.bse.cn/nq/quotation.html"
    url = "https://www.bse.cn/nqhqController/nqhq_en.do"
    raw_rows = []
    total = None
    with requests.Session() as session:
        session.headers.update({"User-Agent": "Mozilla/5.0", "Referer": page_url,
                                "Accept": "application/json, text/javascript, */*; q=0.01"})
        # 官网有时设置匿名 Cookie 后 302 回自己；不跟随重定向，避免循环。
        _vra_call(session.get, page_url, timeout=(10, 40), allow_redirects=False).raise_for_status()
        for page_number in range(100):
            form = {"page": page_number, "type_en": '["B"]', "sortfield": "hqzqdm",
                    "sorttype": "asc", "xxfcbj_en": "[2]", "zqdm": code or ""}
            response = _vra_call(session.post, url, data=form, timeout=(10, 40), allow_redirects=False)
            if 300 <= response.status_code < 400:
                _vra_call(session.get, page_url, timeout=(10, 40), allow_redirects=False).raise_for_status()
                response = _vra_call(session.post, url, data=form, timeout=(10, 40), allow_redirects=False)
            response.raise_for_status()
            if response.status_code != 200:
                raise RuntimeError("北交所匿名会话尚未建立")
            payload = response.text.strip()
            match = re.fullmatch(r"[A-Za-z_$][\w$]*\((.*)\);?", payload, re.S)
            data = json.loads(match.group(1) if match else payload)
            if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0].get("content"), list):
                raise RuntimeError("北交所行情响应结构异常")
            current_total = _official_total(data[0].get("totalElements"))
            if total is not None and total != current_total:
                raise RuntimeError("分页期间北交所记录总数变化，请重试")
            total = current_total
            batch = data[0]["content"]
            if total < 0 or not batch:
                raise RuntimeError("北交所未返回目标行情或分页提前结束")
            raw_rows.extend(batch)
            if len(raw_rows) >= total:
                break
            time.sleep(0.2)
        if len(raw_rows) != total:
            raise RuntimeError("北交所分页不完整，不能标记全板成功")
    fields = {"hqjrkp": "open", "hqzgcj": "high", "hqzdcj": "low", "hqzjcj": "close",
              "hqzrsp": "previous_close", "hqcjsl": "volume", "hqcjje": "amount"}
    rows = []
    for rec in raw_rows:
        if _official_date(rec.get("hqjsrq")) != trade_date:
            raise RuntimeError("北交所快照不是请求的交易日；本接口不提供历史回填")
        ticker = _official_code(rec.get("hqzqdm"))
        if not ticker.startswith(("4", "8", "92")) or (code is not None and ticker != code):
            raise RuntimeError("北交所返回了请求范围之外的标的")
        row = {"date": trade_date, "code": ticker, "name": rec.get("hqzqjc"), "exchange": "BJ",
               "quote_time": str(rec.get("hqgxsj", "")), "pe_source": _official_number(rec.get("hqsyl1")),
               **{dest: _official_number(rec.get(src), required=True) for src, dest in fields.items()}}
        for level in range(1, 6):
            for src, dest in (("hqbjw", "bid_price"), ("hqbsl", "bid_volume"),
                              ("hqsjw", "ask_price"), ("hqssl", "ask_volume")):
                row[f"{dest}_{level}"] = _official_number(rec.get(f"{src}{level}"), required=True)
        rows.append(row)
    return _official_frame(rows, ["date", "code"], "bse", url)
