"""把本产品的取数层接到回测引擎上 —— 整个移植里唯一的新代码。

引擎与数据之间只有一条缝：``loader.fetch()`` 返回 ``{代码: OHLCV DataFrame}``。
上游自带 25 个 loader，我们一个都不用 —— 数据一律走本产品的注册表端点，
这样回测用的每一根 bar 都带 ``raw_ref``，与看板上的数字同源、可复算。

支持的市场（第一版）::

    A股    600519.SH / 300308.SZ / 300308   → bs_kline_qfq（baostock 前复权，含 preclose 与停牌标记）
    美股    AAPL / NVDA                      → yahoo_kline
    港股    00700.HK / 0700.HK               → yahoo_kline

🔴 **只做日线**。要 5 分钟线就明说取不到，绝不悄悄拿日线顶替 ——
   那会让一个"日内策略"的回测结果看着完全正常，而它测的根本不是日内。

对照基准（``INDEX:`` 开头的代码，只给 benchmark 那条路用）::

    A股    INDEX:sh000300   → tx_kline（腾讯日 K，不复权）  沪深300指数
    美股    INDEX:SPY        → yahoo_kline                  标普500 ETF
    港股    INDEX:02800.HK   → yahoo_kline                  盈富基金（跟踪恒生指数）

三者都是**价格**序列，不含分红再投资。港美股没有能直接取的指数行情，用跟踪指数的 ETF 收盘价代替。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import pandas as pd

from backtest.engines._market_hooks import _detect_market

# 仓库根 = 本文件的上两级（backtest/loader.py → backtest/ → 仓库根）
REPO_ROOT = Path(__file__).resolve().parent.parent
FETCH_SCRIPT = REPO_ROOT / ".agents" / "skills" / "data-access" / "scripts" / "fetch_endpoint.py"

SUPPORTED_MARKETS = ("a_share", "us_equity", "hk_equity")
#: 引擎按 bar 撮合，这一版只喂日线。上游支持的分钟级要等做 T 那一期。
SUPPORTED_INTERVALS = ("1D", "1d", "D", "day", "daily")

_A_FIELDS = "date,open,high,low,close,preclose,volume,turn,tradestatus"
#: 不复权的开盘价和前收（adjustflag=3），只给涨跌停判定用：交易所按不复权前收 ×(1±限幅) 四舍五入到分
#: 定涨跌停价，复权价上算不出这个取整。K 线、撮合、收益仍全用前复权（第四轮审计 D2）
_A_RAW_FIELDS = "date,open,preclose,tradestatus"
#: Yahoo 只认这些窗口关键字，给不了起止日期 —— 取覆盖得住的最小那个再切。
#: 🔴 没有 "max"：interval=1d 配 range=max 时 Yahoo 返回的是**月线**（meta.dataGranularity=1mo），
#:    以前起点早于 10 年就会落到 max，回测拿月线当日线跑完、结果看着正常。
_YAHOO_RANGES = (("1mo", 31), ("3mo", 92), ("6mo", 184), ("1y", 366),
                 ("2y", 731), ("5y", 1827), ("10y", 3653))
#: 港美股日线能取到的最早起点：从今天往回数的天数
YAHOO_DAILY_MAX_DAYS = _YAHOO_RANGES[-1][1]


@dataclass(frozen=True)
class IndexSpec:
    """回测对照用的指数。``ticker`` 带 ``INDEX:`` 前缀，与标的代码分开，免得混进标的的成败记录。"""

    ticker: str
    label: str
    market: str
    endpoint: str
    symbol: str


INDEX_PREFIX = "INDEX:"
INDEX_BENCHMARKS: Dict[str, IndexSpec] = {
    "a_share": IndexSpec("INDEX:sh000300", "沪深300指数", "a_share", "tx_kline", "sh000300"),
    "us_equity": IndexSpec("INDEX:SPY", "标普500 ETF（SPY）", "us_equity", "yahoo_kline", "SPY"),
    "hk_equity": IndexSpec("INDEX:02800.HK", "盈富基金（02800.HK，跟踪恒生指数）", "hk_equity", "yahoo_kline", "02800.HK"),
}
INDEX_BASIS = "对照是价格序列，不含分红再投资；港美股用跟踪指数的 ETF 收盘价代替指数。"


def index_spec(ticker: str) -> Optional[IndexSpec]:
    return next((s for s in INDEX_BENCHMARKS.values() if s.ticker == ticker), None)


class LoaderError(RuntimeError):
    """取数在**能不能开始回测**这一层就失败了 —— 不该被当成"这只票没数据"往下走。"""


def price_basis(market: str) -> str:
    """Source-specific price/accounting limits, shared by preview and runtime disclosure."""
    source = (
        "A 股取 baostock 前复权日线（adjustflag=2），不是当日未复权成交价；复权影响不等于分红现金到账。"
        "涨跌停另取不复权开盘价和前收，按交易所规则四舍五入到分判定。"
        if market == "a_share" else
        "港美股取 Yahoo chart 的 indicators.quote OHLC，不使用 adjclose；不可把它当作含分红的总回报序列。"
    )
    return source + "引擎不单独记现金分红、再投资或公司行动现金流。历史序列按本次取数版本重建，可能随公司行动或上游修订重述，并非当时可见快照；不同日期重跑可变，收益偏差方向不作保证。"


@dataclass
class SymbolProvenance:
    """一只票的数据来自哪儿 —— 回测结论要能顺着这条链查回去。"""

    code: str
    market: str
    endpoint: str
    raw_refs: List[str] = field(default_factory=list)
    rows: int = 0
    first_bar: Optional[str] = None
    last_bar: Optional[str] = None
    halted_bars: int = 0
    note: str = ""
    price_basis: str = ""


def canonical_code(code: str) -> str:
    """把代码规整成**市场判得出来**的写法。

    ``_detect_market`` 对认不出的格式一律回落 ``a_share`` —— 也就是说打错的美股代码
    会被静默当成 A 股去跑（T+1、涨跌停、整手全套上身），而结果看着完全正常。
    ⇒ 六位纯数字在这里就补上交易所后缀，让归属是**判出来的**而不是**兜底兜出来的**。
    """
    c = str(code).strip().upper()
    if not c:
        raise LoaderError("代码是空的")
    # baostock 风格 sz.300308 / sh.600519 → 300308.SZ
    m = re.fullmatch(r"(SZ|SH|BJ)\.(\d{6})", c)
    if m:
        return f"{m.group(2)}.{m.group(1)}"
    if re.fullmatch(r"\d{6}", c):
        return f"{c}.{_a_share_exchange(c)}"
    return c


def _a_share_exchange(six: str) -> str:
    """六位代码 → 交易所后缀。

    按号段前缀查表，**认不出就报错**，不猜一个 —— 猜错的后果是整只票用错市场规则
    （涨跌停带、T+1、费率全套），而回测结果看着完全正常。
    """
    return _a_lookup(six)[0]


#: 号段 → (交易所, 是不是个股)。长前缀在前，匹配到第一个即用。
#: 🔴 `is_stock=False` 的（ETF / 指数 / 可转债）在这一版取不到 —— baostock 的
#:    前复权日 K 是**个股**接口，对它们返回 0 行而**不报错**。不在这儿拦住，
#:    就会变成「回测跑完了、结果是空的」，而空的原因没人看得出来。
_A_PREFIX: tuple[tuple[str, str, bool], ...] = (
    # 上交所
    ("688", "SH", True), ("689", "SH", True),          # 科创板
    ("110", "SH", False), ("111", "SH", False), ("113", "SH", False),  # 沪市可转债
    ("6", "SH", True),                                  # 主板股票
    ("50", "SH", False), ("51", "SH", False), ("52", "SH", False),
    ("53", "SH", False), ("56", "SH", False), ("58", "SH", False),     # 沪市基金 / ETF
    # 深交所
    ("300", "SZ", True), ("301", "SZ", True), ("302", "SZ", True),     # 创业板
    ("000", "SZ", True), ("001", "SZ", True),
    ("002", "SZ", True), ("003", "SZ", True),           # 主板
    ("12", "SZ", False),                                # 深市可转债
    ("15", "SZ", False), ("16", "SZ", False), ("18", "SZ", False),     # 深市基金 / ETF
    # 北交所
    ("43", "BJ", True), ("83", "BJ", True), ("87", "BJ", True),
    ("88", "BJ", True), ("92", "BJ", True),
)


def _a_lookup(six: str) -> tuple[str, bool]:
    for prefix, ex, is_stock in _A_PREFIX:
        if six.startswith(prefix):
            return ex, is_stock
    raise LoaderError(f"认不出六位代码 {six} 属于哪个交易所，请写全后缀，如 {six}.SH / {six}.SZ")


def assert_a_share_stock(code: str) -> None:
    """A 股这一版只回测**个股**。ETF / 指数 / 可转债 明确拒掉，不让它静默跑出空结果。"""
    six = bare(code)
    if re.fullmatch(r"(?:900|200)\d{3}", six):
        # B 股按美元、港元计价，后面的费率、涨跌停、现金都按人民币 A 股算：先拒收（第四轮审计 C1）
        raise LoaderError(f"{code} 是 B 股（900、200 开头）—— 按美元、港元计价，这一版只回测人民币 A 股个股")
    try:
        _, is_stock = _a_lookup(six)
    except LoaderError:
        return          # 认不出的交给取数时报错，别在这儿抢着下结论
    if not is_stock:
        raise LoaderError(
            f"{code} 不是个股（ETF / 指数 / 可转债 号段）—— 这一版的日线取数只覆盖个股，"
            f"对它返回的是空序列而不是报错，所以在这里就拦下来"
        )


def bare(code: str) -> str:
    """去掉交易所后缀，取端点要的裸代码。"""
    return code.split(".")[0]


#: 三种支持的写法 → 市场。**由我们自己判**，不依赖上游的兜底。
_SHAPES: tuple[tuple[Any, str], ...] = (
    (re.compile(r"^\d{6}\.(SZ|SH|BJ)$", re.I), "a_share"),
    (re.compile(r"^\d{3,5}\.HK$", re.I), "hk_equity"),
    # 美股代码 1-5 位字母（NYSE / Nasdaq 的实际上限）。
    # ⚠️ 放宽到 10 位就会把 EURUSD / BTCUSDT 收进来 —— 它们随后会被上游的兜底
    #    判成 a_share 拿去查 baostock。**第一版这里就是写宽了，被测试抓出来的。**
    (re.compile(r"^[A-Z]{1,5}$"), "us_equity"),
)


def market_of(code: str) -> str:
    """判市场。**认不出就报错，不兜底；与上游判定不一致也报错。**

    🔴 上游 `_detect_market` 对认不出的格式一律回落 `a_share`。在只支持三个市场的
       这一版里，那个回落把「不支持」变成了「用错市场规则跑完，结果看着正常」。
    🔴 所以这里**自己判**，再拿上游的结论交叉核对：两边不一致说明这个写法处在
       某种灰色地带（如 BRK.B），宁可拒掉也不选一边 —— 选错那边就是上面那种静默错。
    """
    c = canonical_code(code)
    mine = next((m for pat, m in _SHAPES if pat.fullmatch(c)), None)
    if mine is None:
        raise LoaderError(
            f"认不出 {code!r} 是哪个市场的代码。这一版认这三种写法："
            "A股 600519.SH / 美股 AAPL / 港股 00700.HK"
        )
    theirs = _detect_market(c)
    if theirs != mine:
        raise LoaderError(
            f"{code!r} 的市场归属有歧义（本层判 {mine}，引擎侧判 {theirs}）—— "
            f"已拒绝。归属判错意味着整只票套错市场规则，而回测结果看不出异常"
        )
    return mine


# ── 取数 ──


SEC_CONTACT_VAR = "VRA_SEC_CONTACT"
_AUTH_ENV: Optional[Dict[str, str]] = None


def _auth_env_of(endpoint: str) -> Optional[str]:
    """端点在注册表里声明的凭据变量(没声明是 None)。注册表读不了就当谁都没声明:宁可少给,不多给。"""
    global _AUTH_ENV
    if _AUTH_ENV is None:
        try:
            eps = json.loads((REPO_ROOT / "datasources" / "registry.json").read_text(encoding="utf-8")).get("endpoints") or []
            _AUTH_ENV = {str(e.get("id")): str(e["auth_env"]) for e in eps if isinstance(e, dict) and e.get("auth_env")}
        except (OSError, ValueError, AttributeError):
            _AUTH_ENV = {}
    return _AUTH_ENV.get(endpoint)


def sec_contact() -> str:
    """设置页(或环境变量)填的 SEC 联系方式,按取数层同一口径整理:连续空白并成一个空格,只收可打印英文字符;不合格当没填。"""
    v = " ".join(os.environ.get(SEC_CONTACT_VAR, "").split())
    return v if "@" in v and all(" " <= ch <= "~" for ch in v) else ""


def _child_env(endpoint: str) -> Dict[str, str]:
    """取数子进程的环境:SEC 联系方式只给声明了它的端点(东财、Yahoo、基准指数这些不给)。"""
    env = dict(os.environ)
    if _auth_env_of(endpoint) != SEC_CONTACT_VAR:
        env.pop(SEC_CONTACT_VAR, None)
    # 子进程读写文件也按 UTF-8（中文 Windows 默认 GBK）
    env["PYTHONUTF8"], env["PYTHONIOENCODING"] = "1", "utf-8"
    return env


def _run_fetch(endpoint: str, symbol: str, args: Dict[str, Any], out_dir: Path,
               python: str, timeout: int, allow_partial: bool = False) -> Dict[str, Any]:
    """跑一次端点，返回信封。

    allow_partial：退出码 2（partial）也返回信封，由调用方自己看缺了什么。事件表这类端点
    「这只股票确实没有」和「取满 limit」都记 partial，不是失败。

    🔴 stderr **不并进 stdout**：baostock 会往 stderr 打 "login success!"，
       合进去就把 JSON 顶坏了（这个坑我自己先踩了一次）。
    """
    cmd = [python, str(FETCH_SCRIPT), "--endpoint", endpoint, "--symbol", symbol,
           "--args", json.dumps(args, ensure_ascii=False), "--out-dir", str(out_dir)]
    try:
        # 🔴 显式 UTF-8：取数脚本输出的是 UTF-8，中文 Windows 上按系统默认（GBK）解码会乱码或直接报错，
        #    真成功的取数被判失败（Codex 审计 2026-10-09 D10）。stderr 只是诊断，坏字节换成替代符
        p = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout,
                           cwd=str(REPO_ROOT), env=_child_env(endpoint))
    except subprocess.TimeoutExpired as exc:
        raise LoaderError(f"{endpoint} 取 {symbol} 超时（{timeout}s）") from exc
    if p.returncode != 0:
        # 受控取数脚本的失败原因写在 stdout 信封，stderr 可能完全为空。
        # 只取契约中的错误字符串，不把整份原始输出（可能有 raw/配置）当诊断回传。
        try:
            failed = json.loads(p.stdout)
        except json.JSONDecodeError:
            failed = None
        if allow_partial and p.returncode == 2 and isinstance(failed, dict) and failed.get("status") == "partial":
            return failed
        errors = failed.get("errors") if isinstance(failed, dict) else None
        reasons = [e["error"] for e in errors if isinstance(e, dict) and isinstance(e.get("error"), str) and e["error"].strip()] if isinstance(errors, list) else []
        tail = (p.stderr or "").strip().splitlines()[-3:]
        reason = " / ".join(reasons or tail) or "未返回可读错误原因"
        raise LoaderError(f"{endpoint} 取 {symbol} 退出码 {p.returncode}：{reason}")
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError as exc:
        raise LoaderError(f"{endpoint} 取 {symbol} 的输出不是 JSON（前 200 字：{p.stdout[:200]!r}）") from exc


def _read_raw(out_dir: Path, ref: str) -> Dict[str, Any]:
    try:
        payload = json.loads((out_dir / ref).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise LoaderError(f"raw 文件读不了（{ref}）：{exc}") from exc
    # 读得出来、顶层却不是对象（列表 / null / 字符串）：后面一律按对象取字段，
    # 不在这里拦就是 AttributeError 炸穿 —— 不进 failures，也不说是哪只票。
    if not isinstance(payload, dict):
        raise LoaderError(f"raw 文件内容不对（{ref}）：顶层应是 JSON 对象，实际是 {type(payload).__name__}")
    return payload


def _raw_rows(envelope: Dict[str, Any], out_dir: Path) -> tuple[Dict[str, Any], list[str]]:
    """从信封指到的 raw 文件里把整段序列读出来，并带回 raw_ref。

    信封里只有摘要证据（最新价、点数），完整序列在 raw —— 这正是我们要的：
    **回测吃的每一根 bar 都能指回落盘的原始响应。**
    """
    refs = list((envelope.get("extra") or {}).get("raw_files") or [])
    if not refs:
        raise LoaderError("信封里没有 raw_files —— 取不到完整序列，只有摘要")
    # 读坏了包成 LoaderError 才会进 failures 并带上端点 / 代码上下文；
    # 直接炸穿的话，一只票的 raw 损坏会让整次回测崩掉且不说是哪只。
    return _read_raw(out_dir, refs[0]), refs


def _frame_from_baostock(payload: Dict[str, Any]) -> tuple[pd.DataFrame, int]:
    rows = payload.get("rows") or []
    if not rows:
        return pd.DataFrame(), 0
    df = pd.DataFrame(rows)
    # tradestatus: "1" 正常交易，其余为停牌。停牌 bar 的价格不是可成交价，剔除；
    # 剔了多少要**说出来** —— 停牌天数本身就是"这只票能不能这么回测"的判据。
    halted = 0
    if "tradestatus" in df.columns:
        mask = df["tradestatus"].astype(str) == "1"
        halted = int((~mask).sum())
        df = df[mask]
    df = df.drop(columns=[c for c in ("tradestatus",) if c in df.columns])
    # 引擎判涨跌停时找的字段叫 `pre_close`（见 BaseEngine.base_price_fields），
    # baostock 给的是 `preclose`。名字对不上不会报错 —— 它会**静默回退**到用
    # 上一根的收盘价当前收，于是停牌 / 除权那天的涨跌停带算出来是错的。
    if "preclose" in df.columns:
        df = df.rename(columns={"preclose": "pre_close"})
    df["date"] = pd.to_datetime(df["date"])
    df = df.set_index("date").sort_index()
    return df, halted


def _frame_from_yahoo(payload: Dict[str, Any], tz: Optional[str] = None) -> tuple[pd.DataFrame, int]:
    res = ((payload.get("chart") or {}).get("result") or [{}])[0]
    ts = res.get("timestamp") or []
    q = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    if not ts:
        return pd.DataFrame(), 0
    stamps = pd.to_datetime(ts, unit="s", utc=True)
    # 日线的时间戳是开盘时刻，按 UTC 取日期与当地日期一致（回测只用日线，不传 tz）。
    # 周线 / 月线的时间戳是交易所当地 0 点 —— 港股是前一天 16:00 UTC，按 UTC 取日期会落到前一天，
    # 所以 K 线工具传交易所时区，按当地日期算。
    data = {"date": (stamps.tz_convert(tz).tz_localize(None) if tz else stamps.tz_convert(None)).normalize()}
    for k in ("open", "high", "low", "close", "volume"):
        col = q.get(k) or [None] * len(ts)
        data[k] = list(col)
    df = pd.DataFrame(data).set_index("date").sort_index()
    # Yahoo 会给出缺值的行（当天没成交 / 数据缺）。
    # 🔴 **四个价格缺一不可**，不能只看 close：撮合价取的是 open、涨跌停带要 high/low。
    #    只 dropna(close) 会留下 open=NaN 的行 —— 那一根不会报错，
    #    它会让当天的成交价变成 NaN，表现为「少成交了一笔」而不是「数据有问题」。
    before = len(df)
    df = df.dropna(subset=["open", "high", "low", "close"])
    df = df[df[["open", "high", "low", "close"]].map(lambda v: pd.notna(v) and float(v) > 0).all(axis=1)]
    return df, before - len(df)


def _yahoo_range(start: str, end: str) -> str:
    """覆盖得住请求区间的最小窗口关键字。"""
    try:
        days = (datetime.fromisoformat(end).date() - datetime.fromisoformat(start).date()).days
    except ValueError as exc:
        raise LoaderError(f"日期格式要 YYYY-MM-DD：start={start!r} end={end!r}") from exc
    if days < 0:
        raise LoaderError(f"start 晚于 end：{start} > {end}")
    # 与今天的距离才是 Yahoo 真正要覆盖的跨度（它的窗口一律从今天往回数）
    span = (date.today() - datetime.fromisoformat(start).date()).days
    for key, cover in _YAHOO_RANGES:
        if cover >= span:
            return key
    earliest = yahoo_daily_earliest().isoformat()
    raise LoaderError(
        f"港美股日线最早只能取到 {earliest}（约 10 年前），起点 {start} 太早 —— "
        "Yahoo 更长的窗口只给月线，拿月线当日线回测会算出一份看着正常的错结果。请把起点改到这之后"
    )


def yahoo_daily_earliest() -> date:
    """港美股日线能取到的最早一天（随今天往后挪）。"""
    return date.today() - timedelta(days=YAHOO_DAILY_MAX_DAYS)


def _assert_yahoo_daily(payload: Dict[str, Any]) -> None:
    """核对 Yahoo 返回的确实是日线。

    窗口关键字选对了它也可能换粒度（range=max 就会悄悄给月线）；月线当日线用，
    回测照常跑完、指标齐全。⇒ 按返回里写明的粒度再对一次，**写不明也不放行**。
    """
    res = ((payload.get("chart") or {}).get("result") or [{}])[0]
    got = (res.get("meta") or {}).get("dataGranularity")
    if got != "1d":
        raise LoaderError(f"Yahoo 返回的不是日线（数据粒度：{got or '没写'}）—— 不能当日线回测，已中止")


def _to_ns_index(df: pd.DataFrame) -> pd.DataFrame:
    """把索引统一成 ``datetime64[ns]``。

    🔴 pandas 3 会**保留**原始时间分辨率：baostock 那条路解析出来是 ``[us]``、
       Yahoo 那条是 ``[s]``；而上游 ``_align`` 里 ``pd.DatetimeIndex(index.asi8)``
       把整数一律当**纳秒**解释（pandas 2 一律压成纳秒，所以上游没这问题）。
       秒被当纳秒 → 所有 bar 掉到 1970 年 → 与信号完全对不上 → **一笔都不成交**。

    ⚠️ 这个 bug **不抛异常**：它产出的是一份"总收益 0.00%、最大回撤 0.00%"的
       完整报告，排版整齐、指标齐全。⇒ 在数据边界钉死分辨率，并在下面断言。
    """
    if not isinstance(df.index, pd.DatetimeIndex):
        raise LoaderError(f"索引不是时间索引：{type(df.index).__name__}")
    if df.index.dtype != "datetime64[ns]":
        df = df.copy()
        df.index = df.index.astype("datetime64[ns]")
    return df


def _assert_same_instrument(code: str, payload: dict) -> None:
    """核对取回来的确实是要的那一只。

    端点会用自己的规则把代码映射成 baostock 写法。我们已经传了带后缀的形式，
    但**映射规则是它的、不是我们的** —— 它哪天变了，表现是「拿到另一只票、
    回测照常跑完、数字看着完全正常」。所以这里按 raw 里落下的实际查询再对一次。
    """
    actual = str(((payload or {}).get("query") or {}).get("code") or "")
    if not actual:
        # 🔴 **核对不了 ≠ 核对通过**。上游哪天不再落 query.code，这道校验就会
        #    悄悄变成空操作，而它防的正是「拿到另一只票、回测照常跑完」。
        #    一道跑不起来的校验必须报错，不能报成功。
        raise LoaderError(
            f"raw 里没有 query.code，无法核对取回来的是不是 {code} —— 已中止"
            "（这道校验防的是「拿错票但结果看着正常」，它自己失效时不能默认通过）"
        )
    six, ex = bare(code), code.split(".")[-1]
    want = f"{ex.lower()}.{six}"
    if actual.lower() != want:
        raise LoaderError(
            f"要的是 {code}，取数层实际查的是 {actual} —— 两者不是同一只票，"
            f"已中止（继续跑下去会在错误的标的上算出一份看着正常的回测）"
        )


class VibeLoader:
    """回测引擎眼里的"数据源"。

    引擎只调 ``fetch()``；``name`` 是 benchmark 那边用 ``getattr`` 读的。
    """

    name = "vibe"

    def __init__(self, out_dir: Path, python: Optional[str] = None, timeout: int = 120,
                 limit_prices: bool = True) -> None:
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.python = python or sys.executable
        self.timeout = timeout
        #: A 股是否再取一份不复权开盘价和前收（涨跌停判定用）。只要收盘价的调用方（持仓回放）关掉，省一次取数
        self.limit_prices = limit_prices
        #: 每只票的来源，回测报告要用
        self.provenance: Dict[str, SymbolProvenance] = {}
        #: 一根 bar 都没取到的票 —— **不是空着算了**，交给上层决定是拒跑还是缩小范围
        self.failures: Dict[str, str] = {}
        #: 对照指数单独记 —— 它不是用户点名的标的，混进上面两张表会被报成「你的标的没参与回测」
        self.benchmark_provenance: Dict[str, SymbolProvenance] = {}
        self.benchmark_failures: Dict[str, str] = {}
        #: 同一个实例里同一段 (代码, 起, 止) 只取一次 —— 参数敏感度要用同一份数据重跑多次，
        #: 每次重新取数既慢，也可能因为上游刚好更新而让各格子用的不是同一份数据
        self._cache: Dict[tuple, pd.DataFrame] = {}
        #: 取不到的 (代码, 起, 止) 也记下，同一个实例里不再重取（原因已经留在 failures / benchmark_failures）——
        #: 否则敏感度网格每一格都要再等一次超时，重取成功的格子用的也和主回测不是同一份数据
        self._failed: set = set()

    # ── 引擎调的就是这一个 ──
    def fetch(self, codes: Iterable[str], start_date: str, end_date: str,
              fields: Optional[Any] = None, interval: str = "1D") -> Dict[str, pd.DataFrame]:
        if interval not in SUPPORTED_INTERVALS:
            raise LoaderError(
                f"这一版只做日线，取不到 {interval!r} 的数据。"
                "别把它当日线跑 —— 那样出来的结果测的不是你想测的东西。"
            )
        out: Dict[str, pd.DataFrame] = {}
        for raw_code in codes:
            key = (str(raw_code), str(start_date), str(end_date))
            if key in self._failed:
                continue
            hit = self._cache.get(key)
            if hit is not None:
                out[str(raw_code) if str(raw_code).startswith(INDEX_PREFIX) else canonical_code(raw_code)] = hit.copy()
                continue
            if str(raw_code).startswith(INDEX_PREFIX):
                self._fetch_index_into(out, str(raw_code), start_date, end_date)
                if str(raw_code) in out:
                    self._cache[key] = out[str(raw_code)].copy()
                else:
                    self._failed.add(key)
                continue
            code = canonical_code(raw_code)
            try:
                df, prov = self._fetch_one(code, start_date, end_date)
            except LoaderError as exc:
                self.failures[code] = str(exc)
                self.provenance.pop(code, None)     # 同一只票不能既成功又失败
                self._failed.add(key)
                continue
            except Exception as exc:                # noqa: BLE001
                # 解析层的意外（数组长度不齐、字段类型变了…）也要落到 failures，
                # 而不是炸穿整次回测 —— 那样看不出是哪只票、哪个端点出的问题。
                self.failures[code] = f"{type(exc).__name__}: {exc}"
                self.provenance.pop(code, None)
                self._failed.add(key)
                continue
            if df.empty:
                self.failures[code] = "区间内一根 bar 都没有"
                self.provenance.pop(code, None)
                self._failed.add(key)
                continue
            out[code] = df
            self.provenance[code] = prov
            self.failures.pop(code, None)           # 这次成功了，清掉上一次的失败记录
            self._cache[key] = df.copy()
        return out

    def _fetch_index_into(self, out: Dict[str, pd.DataFrame], ticker: str, start_date: str, end_date: str) -> None:
        spec = index_spec(ticker)
        try:
            if spec is None:
                raise LoaderError(f"不认识的对照指数 {ticker}（可用：{', '.join(s.ticker for s in INDEX_BENCHMARKS.values())}）")
            df, prov = self._fetch_index(spec, start_date, end_date)
            if df.empty:
                raise LoaderError("区间内一根 bar 都没有")
        except Exception as exc:                    # noqa: BLE001 —— 对照取不到不能让整次回测崩掉
            self.benchmark_failures[ticker] = str(exc) if isinstance(exc, LoaderError) else f"{type(exc).__name__}: {exc}"
            self.benchmark_provenance.pop(ticker, None)
            return
        out[ticker] = df
        self.benchmark_provenance[ticker] = prov
        self.benchmark_failures.pop(ticker, None)

    def _fetch_index(self, spec: IndexSpec, start_date: str, end_date: str):
        if spec.endpoint == "tx_kline":
            args = {"period": "day", "adjust": "", "start": start_date, "end": end_date}
        else:
            args = {"interval": "1d", "range_": _yahoo_range(start_date, end_date)}
        env = _run_fetch(spec.endpoint, spec.symbol, args, self.out_dir, self.python, self.timeout)
        if env.get("status") == "failed":
            raise LoaderError(f"{spec.endpoint} 返回 failed：{env.get('note') or '未说明原因'}")
        refs = list((env.get("extra") or {}).get("raw_files") or [])
        if spec.endpoint == "tx_kline":
            # 腾讯 K 线的 raw 是几页原始响应 + 一份抽取后的整段序列；读抽取那份，翻页已在端点里拼好。
            picked = [r for r in refs if Path(r).name.startswith("extracted_")]
            if not picked:
                raise LoaderError("腾讯 K 线信封里没有抽取后的序列文件")
            payload = _read_raw(self.out_dir, picked[-1])
            rows = payload.get("rows") or []
            got = {str(r.get("code") or "") for r in rows}
            if got != {spec.symbol}:
                raise LoaderError(f"要的是 {spec.symbol}，取回来的是 {sorted(got) or '空'} —— 不是同一个指数，已中止")
            df = pd.DataFrame(rows)
            if df.empty:
                return df, SymbolProvenance(code=spec.ticker, market=spec.market, endpoint=spec.endpoint, raw_refs=refs)
            df["date"] = pd.to_datetime(df["date"])
            df = df.set_index("date").sort_index()[["open", "high", "low", "close", "volume"]]
            before = len(df)
            df = df[pd.to_numeric(df["close"], errors="coerce") > 0]
            dropped = before - len(df)
        else:
            payload = _read_raw(self.out_dir, refs[0]) if refs else {}
            meta = (((payload.get("chart") or {}).get("result") or [{}])[0].get("meta") or {})
            want = str(int(spec.symbol.split(".")[0])).zfill(4) + ".HK" if spec.market == "hk_equity" else spec.symbol
            if str(meta.get("symbol") or "").upper() != want.upper():
                raise LoaderError(f"要的是 {want}，取回来的是 {meta.get('symbol') or '空'} —— 不是同一只 ETF，已中止")
            _assert_yahoo_daily(payload)
            df, dropped = _frame_from_yahoo(payload)
        if not df.empty:
            df = _to_ns_index(df).loc[str(start_date):str(end_date)]
        prov = SymbolProvenance(
            code=spec.ticker, market=spec.market, endpoint=spec.endpoint, raw_refs=refs, rows=len(df),
            first_bar=str(df.index[0].date()) if len(df) else None,
            last_bar=str(df.index[-1].date()) if len(df) else None,
            halted_bars=dropped, note=spec.label, price_basis=INDEX_BASIS,
        )
        return df, prov

    def _with_unadjusted(self, code: str, start_date: str, end_date: str,
                         df: pd.DataFrame) -> tuple[pd.DataFrame, list[str], str]:
        """给前复权日线补 ``raw_open`` / ``raw_pre_close`` 两列（不复权），引擎据此按交易所规则算涨跌停价。

        取不到不拦回测：这几列缺着，引擎退回复权价上的近似判定，来源说明里写明。
        """
        sub = self.out_dir / "unadjusted"
        args = {"start_date": start_date, "end_date": end_date, "fields": _A_RAW_FIELDS, "adjustflag": "3"}
        try:
            env = _run_fetch("bs_kline_qfq", code, args, sub, self.python, self.timeout)
            if env.get("status") == "failed":
                raise LoaderError(env.get("note") or "未说明原因")
            payload, refs = _raw_rows(env, sub)
            _assert_same_instrument(code, payload)
            # 端点叫 qfq：参数没传过去的话拿回来的是前复权价，按它取整会静默算错
            if str((payload.get("query") or {}).get("adjustflag")) != "3":
                raise LoaderError("取回来的不是不复权价")
            raw, _ = _frame_from_baostock(payload)
            if raw.empty or not {"open", "pre_close"} <= set(raw.columns):
                raise LoaderError("没有开盘价或前收")
            raw = _to_ns_index(raw)
            cols = raw.reindex(df.index)
            opened = pd.to_numeric(cols.get("open"), errors="coerce")
            pre = pd.to_numeric(cols.get("pre_close"), errors="coerce")
        except (LoaderError, KeyError, TypeError, ValueError) as exc:
            return df, [], f"不复权开盘价和前收没取到（{exc}），涨跌停按复权价近似判定"
        df = df.assign(raw_open=opened.to_numpy(), raw_pre_close=pre.to_numpy())
        gaps = int((opened.isna() | pre.isna()).sum())
        note = f"{gaps} 根没有不复权价，这几天的涨跌停按复权价近似判定" if gaps else ""
        return df, [f"unadjusted/{r}" for r in refs], note

    def _fetch_one(self, code: str, start_date: str, end_date: str):
        mkt = market_of(code)
        if mkt not in SUPPORTED_MARKETS:
            raise LoaderError(f"这一版只支持 A股 / 美股 / 港股，{code} 判为 {mkt}")

        if mkt == "a_share":
            assert_a_share_stock(code)
            if code.endswith(".BJ") and date.fromisoformat(start_date) < date(2021, 11, 15):
                raise LoaderError("北交所仅支持 2021-11-15 起的区间；此前精选层/新三板规则未建模")
            endpoint = "bs_kline_qfq"
            args = {"start_date": start_date, "end_date": end_date, "fields": _A_FIELDS}
            # 🔴 传**带后缀**的写法。只传六位的话端点会用自己的规则重判，
            #    而它的规则与我们的不一定一致 —— 实测 000001 被判成平安银行(sz)，
            #    要上证综指(sh)的人会拿到一只银行股，**全程不报错**。
            symbol = code
            parse = _frame_from_baostock
        else:
            endpoint = "yahoo_kline"
            args = {"interval": "1d", "range_": _yahoo_range(start_date, end_date)}
            symbol = code if mkt == "hk_equity" else bare(code)
            parse = _frame_from_yahoo

        env = _run_fetch(endpoint, symbol, args, self.out_dir, self.python, self.timeout)
        if env.get("status") == "failed":
            raise LoaderError(f"{endpoint} 返回 failed：{env.get('note') or '未说明原因'}")
        payload, refs = _raw_rows(env, self.out_dir)
        if mkt == "a_share":
            _assert_same_instrument(code, payload)
        else:
            _assert_yahoo_daily(payload)
        df, dropped = parse(payload)

        # Yahoo 拿的是整窗口，切到请求区间；baostock 已经按日期取过了，切一次也无害
        if not df.empty:
            df = _to_ns_index(df).loc[str(start_date):str(end_date)]
            # 上面那个函数的存在理由就是这道检查 —— 分辨率一旦漂回去，
            # 表现是「回测跑完但零成交」，不是报错，所以必须在这里挡住。
            # ⚠️ 不用 assert：`python -O` 会把 assert 整条删掉，而这正是最不能被
            #    关掉的一道（它防的是那个不抛异常的静默错）。
            if df.index.dtype != "datetime64[ns]":
                raise LoaderError(f"索引分辨率没钉住：{df.index.dtype}（应为 datetime64[ns]）")

        notes = ["停牌 / 无成交 %d 根已剔除" % dropped] if dropped else []
        if mkt == "a_share" and self.limit_prices and not df.empty:
            df, more_refs, limit_note = self._with_unadjusted(code, start_date, end_date, df)
            refs = refs + more_refs
            notes += [limit_note] if limit_note else []

        prov = SymbolProvenance(
            code=code, market=mkt, endpoint=endpoint, raw_refs=refs, rows=len(df),
            first_bar=str(df.index[0].date()) if len(df) else None,
            last_bar=str(df.index[-1].date()) if len(df) else None,
            halted_bars=dropped,
            note="；".join(notes),
            price_basis=price_basis(mkt),
        )
        return df, prov
