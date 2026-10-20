"""宏观概率(注册表第 18 层):预测市场对宏观事件的**当前定价概率** —— 降息 / 衰退 / 通胀 / AI 里程碑等。

**模块分类器**移植自 simonlin1212/GlobalPercent(`market_taxonomy.py`);**取数形态按两个交易所的官方仓库
重做**(Polymarket/agent-skills 的 market-data.md、Kalshi/kalshi-starter-code-python),不沿用上游的写法。
两个源都**零鉴权、只读**:
  - Kalshi   `https://api.elections.kalshi.com/trade-api/v2/{events,series}`(CFTC 监管的事件合约交易所)
  - Polymarket `https://gamma-api.polymarket.com/{markets,tags}`

🔧 **实测校准过的四件事(照文档或照上游写都会错)**:
  1. **Kalshi 成交量字段是 `volume_24h_fp` / `volume_fp` / `open_interest_fp`**(带 `_fp` 后缀)。
     上游 GlobalPercent 用的 `volume_24h` / `volume` **全落空** → 排序恒为 0 → 选出来的是零成交的远期合约。
     ⚠️ 这几个字段**有时返回字符串**("10505.78"),直接比大小会 TypeError,必须过 `_f()`。
  2. **`category` 参数在 `/series` 上有效、在 `/events` 上被服务端忽略**(实测:给 /events 传
     `category=Economics` 返回的是天气 / 选举 / 科技)。所以宏观合约要走 `/series` → `/events?series_ticker=`。
  3. **Polymarket 排序参数是 `volume24hr`(无下划线)**。官方 agent-skills 的 market-data.md 写的是
     `volume_24hr`,**实测返回 HTTP 422「order fields are not valid」** —— 官方文档在这一处是错的。
  4. **只按成交量广度采样够不到宏观合约**:衰退 / CPI / PCE / PPI 的成交量只有几千,会被体育 / 加密 /
     政治(几十万)整个淹没 —— 实测「宏观经济」模块**整个为空**。必须再做一轮**定向取数**
     (Kalshi 按宏观系列、Polymarket 按宏观标签)。

🔴 它是什么、不是什么(护栏原样进证据 note,报告里必须与数字同段):
  - 这是**市场当前的定价预期**,不是事实、不是预测,**更不是本报告的判断**;
  - 概率随时都在变,只在 as_of 那一刻成立;引用必须带日期;
  - **低成交量的合约噪音极大**,几笔小单就能推动;因此每条都带 24h 成交量,量小的不要当信号;
  - 不得写成"会发生 / 将发生 / 预计" —— 只能写"市场给出的概率为 X%"。

为什么对个股研究有用:它给的是**前瞻假设的外部参照**。一致预期里的增长假设隐含了某种宏观情形,
而预测市场对同一情形有独立定价 —— 两者背离本身就是值得写进风险与反证的线索。
合约的结算日期还天然是"下一个数据点"(如 FOMC 会议日)。

⛔ 只收 6 个核心模块(货币政策 / 宏观经济 / 地缘政治 / 政治选举 / 股指大宗 / AI科技);
   参考类(加密 / 体育 / 娱乐 / 其他)一律丢弃 —— 与个股研究无关,只会淹没信号。
"""
from __future__ import annotations

import contextvars
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Optional

from sources._http import record_raw

KALSHI_EVENTS = "https://api.elections.kalshi.com/trade-api/v2/events"
KALSHI_SERIES = "https://api.elections.kalshi.com/trade-api/v2/series"
POLY_MARKETS = "https://gamma-api.polymarket.com/markets"
POLY_TAGS = "https://gamma-api.polymarket.com/tags"
UA = "Mozilla/5.0 (vibe-research-agent)"

CORE_MODULES = ("货币政策", "宏观经济", "地缘政治", "政治选举", "股指大宗", "AI科技")
REFERENCE_MODULES = ("加密", "体育", "娱乐", "其他")
#: 每个模块最多留几条(按 max(24h 成交量, 未平仓量) 排序)。比上游面板紧得多 —— 报告不是看板,
#: 每模块 3 条已足够做参照,再多只会把报告压垮(而"提示词越长章节掉得越多"是本产品实测过的)。
PER_MODULE = 3
# Sequential sources each get a cooperative budget, leaving headroom under the
# orchestrator's 180s process limit. Socket stalls are bounded separately; DNS
# resolution still relies on the outer process timeout, not this deadline.
SOURCE_BUDGET_SECONDS = 65.0
_source_deadline: contextvars.ContextVar[Optional[float]] = contextvars.ContextVar("macro_source_deadline", default=None)
#: 结算期限上限。实测 Kalshi 上有 close_time=2099 的合约,2036 年的 GDP / CPI 合约成交量为 0 ——
#: 拿它当"市场对宏观的预期"是误导。
#: ⚠️ 但**纯日期窗口会误杀真正有意义的远期合约**:实测宏观类(衰退 / CPI / GDP)在两个源上
#: 近端根本没有(Polymarket 前 500 条 0 命中;Kalshi 最早结算 2027-07),窗口卡到 400 天会让
#: **最该有的模块整个空掉**。⇒ 期限放宽,改用**流动性**当相关性筛子(见 FAR_DAYS)。
HORIZON_DAYS = 800
#: 超过这个天数就算"远期",远期合约**必须有 24h 成交量**才收 —— 有人在交易才说明这个价还有人认。
#: 近端合约允许安静(只要不是完全没量没持仓的死盘)。
FAR_DAYS = 180
#: 两个源的翻页深度。⚠️ 采样不足会让**最有用的模块直接空掉** —— 实测只翻 3 页时
#: 宏观经济(衰退 / 通胀 / GDP)与 AI科技 两个模块一条都没有,而它们恰恰是个股研究最需要的参照。
#: ⛔ Kalshi 的 `category` 查询参数**被服务端忽略**(传 Economics 返回的是天气 / 选举 / 科技 / 世界),
#:    没有服务端过滤可用,只能翻页后本地分类。
KALSHI_PAGES = 6
POLY_PAGES = 4
#: 🔴 广度采样(按成交量翻页)**够不到宏观合约** —— 衰退 / CPI / PCE / PPI 这类的成交量只有几千,
#: 会被体育 / 加密 / 政治(几十万)整个淹没。所以在广度之外**再做一轮定向取数**:
#:   - Kalshi:`/series?category=Economics|Financials` 拿系列 → `/events?series_ticker=` 拿合约。
#:     ⚠️ `category` 参数在 `/series` 上**有效**,在 `/events` 上**被服务端忽略**(实测),别搞反。
#:   - Polymarket:`/tags` 找宏观标签 → `/markets?tag_id=` 定向取。
#: 实测差别:广度采样下「宏观经济」模块**整个是空的**;定向取数能拿到核心 PCE / PPI 月度合约
#: (近端、有持仓、结算日就是数据发布日),以及"US recession by end of 2026?"。
KALSHI_MACRO_CATEGORIES = ("Economics", "Financials")
KALSHI_MACRO_SERIES_MAX = 12
_MACRO_SERIES_KW = ("cpi", "pce", "ppi", "inflation", "gdp", "recession", "unemploy", "payroll",
                    "jobless", "fed ", "fomc", "interest rate", "treasury", "yield")
_POLY_MACRO_TAG_KW = ("macro", "econom", "inflation", "recession", "fed", "interest rate")

GUARD = ("读法:预测市场概率是**市场当前的定价预期**,不是事实也不是预测,更不是本报告的判断;"
         "概率随时在变、只在 as_of 那一刻成立,引用必须带日期;低成交量合约噪音极大,量小的不要当信号;"
         "不得写成会发生 / 将发生 / 预计")

# --- 分类器(移植自 GlobalPercent market_taxonomy.py,关键词与判定顺序保持一致)---
_GEO = ["china", "taiwan", "tariff", "trade war", "xi jinping", "hormuz", "iran", "venezuela",
        "russia", "ukraine", "blockade", "north korea", "israel", "gaza", "hezbollah", "lebanon",
        "syria", "middle east", " nato", "nuclear", "missile", "ceasefire", "invade", "war ",
        "military", "peace deal", "strike on"]
_MONETARY = ["fed ", "fed decision", "fed funds", "federal reserve", "interest rate", "rate cut",
             "rate hike", "fomc", "powell", "basis point", "rate after"]
_MACRO = ["recession", " gdp", "inflation", " cpi", "unemployment", "jobs report", "jobs numbers",
          "payroll", "nonfarm", "jobless", " ppi", " pce", "gas price"]
_AI = ["nvidia", "openai", " agi", "semiconductor", "tsmc", " chip", "anthropic", "gpt", "chatgpt",
       "llm", "grok", "gemini", "claude", "deepmind", "artificial intelligence", "best ai",
       "humanoid robot", "deepseek"]
_INDEX = ["s&p", "nasdaq", "dow ", " stock", "earnings", " ipo", "market cap", "crude oil",
          "wti", "brent", "oil price", "gold price", "gold hit", "gold above", " xau",
          "commodit", " spy ", "valuation"]
_ELECTION = ["election", "president", " senate", "congress", "nominee", "potus", "white house",
             "governor", " mayor", "parliament", "prime minister", "referendum", "trump", "newsom",
             " vance", "midterm", "impeach", "attorney general", "reconciliation", "election winner"]
_CRYPTO = ["bitcoin", " btc", "ethereum", "crypto", "microstrategy", " mstr", "solana", "dogecoin",
           "coinbase", "stablecoin", "ripple", " xrp"]
_SPORTS = ["nba", "nfl", " mlb", "world series", "super bowl", "stanley cup", "tennis", " atp", " wta",
           "wimbledon", "us open", "french open", "australian open", "ufc", "boxing", "premier league",
           "la liga", "champions league", "grand prix", " pga ", "esports", " lol ", "cs2", "valorant",
           "dota", " vs.", " vs ", "world cup", "fifa", "golf", "tournament", "playoff", "champion"]
_ENT = ["movie", "oscar", "grammy", "box office", "taylor swift", "tweet", "person of the year",
        "rotten tomatoes", "billboard", "spotify", "netflix", "love island", "celebrity", "album",
        " song ", "emmy", "what will"]
_KALSHI_CAT = {"Economics": "宏观经济", "Financials": "股指大宗", "Commodities": "股指大宗",
               "Companies": "股指大宗", "Elections": "政治选举", "Politics": "政治选举",
               "World": "地缘政治", "Crypto": "加密", "Sports": "体育", "Entertainment": "娱乐"}


def classify(question: Optional[str], kalshi_category: Optional[str] = None) -> str:
    """标题(+ Kalshi 原生类别兜底)→ 模块。判定顺序照搬上游:高信号在前,重叠才解得合理
    (地缘先于选举:Iran nuclear → 地缘;加密先于股指:bitcoin → 加密;货币先于宏观:fed rate → 货币政策)。"""
    t = " " + (question or "").lower() + " "
    if "world cup" in t or "fifa" in t:      # 上游注释:含国名也仍是体育("Will Iran win the World Cup?")
        return "体育"
    for kws, mod in ((_GEO, "地缘政治"), (_MONETARY, "货币政策"), (_MACRO, "宏观经济"), (_AI, "AI科技"),
                     (_CRYPTO, "加密"), (_INDEX, "股指大宗"), (_ELECTION, "政治选举"),
                     (_SPORTS, "体育"), (_ENT, "娱乐")):
        if any(k in t for k in kws):
            return mod
    return _KALSHI_CAT.get(kalshi_category or "", "其他")


def _polymarket_module(row: dict, title: str) -> str:
    """Polymarket 行先认结构化市场类型，再退回标题分类。

    球队名可能包含别的关键词，例如 ``Borussia`` 内含 ``russia``。只看标题子串会把
    德甲比赛误归为地缘政治。sportsMarketType / gameStartTime / event.gameId 是上游给出的
    明确体育标记，优先级必须高于标题启发式。
    """
    events = row.get("events")
    has_game = isinstance(events, list) and any(
        isinstance(event, dict) and event.get("gameId") is not None for event in events
    )
    if row.get("sportsMarketType") or row.get("gameStartTime") or has_game:
        return "体育"
    return classify(title)


class ProbabilityError(RuntimeError):
    pass


def _get(url: str, params: dict, timeout: int = 25) -> bytes:
    """只取原始字节 —— 解析在调用方,坏 JSON 那份响应也要能落盘留证。"""
    deadline = _source_deadline.get()
    def remaining() -> float:
        left = deadline - time.monotonic() if deadline is not None else float(timeout)
        if left <= 0:
            raise TimeoutError("本源取数时间预算已用尽，未查完的部分保持未知")
        return left

    q = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(q, headers={"User-Agent": UA, "Accept": "application/json"})
    # read1 does at most one buffered read: a slow trickle cannot keep one read()
    # alive indefinitely without giving us a chance to check the budget again.
    with urllib.request.urlopen(req, timeout=min(float(timeout), 10.0, remaining())) as response:
        chunks: list[bytes] = []
        while True:
            remaining()
            chunk = response.read1(64 * 1024)
            remaining()
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)


def _f(v) -> Optional[float]:
    try:
        x = float(v)
        return x if x == x and x not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _valid_day(v: str) -> bool:
    """必须是真正的 YYYY-MM-DD。非空但格式非法的字符串同样不许进 `period` ——
    结构化字段里放一个解析不了的"日期"和造一个日期一样糟(Codex prob-r9)。"""
    if len(v) != 10:
        return False
    try:
        datetime.strptime(v, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def _days_out(close_day: str, today: str) -> Optional[int]:
    """结算日距今天数;缺日期或不可解析返回 None(缺日期不等于远期)。"""
    if not close_day or len(close_day) != 10:
        return None
    try:
        return (datetime.strptime(close_day, "%Y-%m-%d") - datetime.strptime(today, "%Y-%m-%d")).days
    except ValueError:
        return None


def keep_contract(close_day: str, today: str, vol24: float, vol_total: float, open_interest: float = 0.0) -> Optional[str]:
    """收不收这条合约。返回 None = 收;返回字符串 = 丢弃原因(供计数,不静默)。

    判据分两段:**近端允许安静,远期必须有人在交易**。纯日期窗口会误杀有意义的远期宏观合约
    (实测"Recession in 2027?"有真实成交却结算在 500 多天后),纯流动性又留不住 2099 年的僵尸盘。
    """
    # ⚠️ 缺结算日的合约在 shaper 里**已经被丢掉**(不造日期),所以生产路径上 d 不会因缺日期为 None;
    #    这里仍保留对 None 的处理,是为了不可解析格式这种情形。
    d = _days_out(close_day, today)
    if d is not None and d < 0:
        return "expired"
    if d is not None and d > HORIZON_DAYS:
        return "far_dated"
    if vol24 <= 0 and vol_total <= 0 and open_interest <= 0:
        return "dead"
    if d is not None and d > FAR_DAYS and vol24 <= 0:
        return "far_illiquid"
    return None


def _pick_leg(markets: list) -> Optional[dict]:
    """多腿事件(阈值 / 区间型)取**最接近 50% 的那条腿** —— 它是市场隐含的水平,
    也是唯一有信息量的数字。上游注释:事件级裸概率对这类事件毫无意义("汽油价格:2%" —— 2% 的什么?)。"""
    best, bestd = None, 9.9
    for m in markets:
        if not isinstance(m, dict):
            continue
        # 🔴 ask 与 last 是**两种口径**,不能混成一个没有标识的"市场定价概率":
        #    价差大或久未成交时,同一字段时而是卖方报价、时而是最后成交价,跨合约不可比
        #    (Codex prob-r1 P1)。⇒ 回退照旧(否则久未成交的合约全丢),但**把口径记下来**并一路带到证据。
        p, kind = _f(m.get("yes_ask_dollars")), "ask"
        if p is None:
            p, kind = _f(m.get("last_price_dollars")), "last"
        if p is None:
            cents = _f(m.get("yes_ask"))
            p, kind = (cents / 100 if cents is not None else None), "ask"
        if p is None:
            cents = _f(m.get("last_price"))
            p, kind = (cents / 100 if cents is not None else None), "last"
        if p is None or not 0 < p < 1:
            continue
        d = abs(p - 0.5)
        if d < bestd:
            best, bestd = {**m, "_prob": p, "_price_type": kind}, d
    return best


def _stamp() -> str:
    """当下的 UTC 时刻(ISO,秒级)。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _get_stamped(url: str, params: dict) -> tuple[bytes, str]:
    """取一次 + **在响应回来的那一刻**打时间戳。

    🔴 时间戳必须跟着**请求**走,不能在遍历时逐条 `_stamp()`:同一份响应的条目会拿到不同时刻,
    跨午夜时甚至分属两天,而注释还写着"它那次请求的时刻" —— 声称与代码不符(Codex prob-r4)。
    """
    body = _get(url, params)
    return body, _stamp()


def _kalshi_shape(evs: list, today: str, dropped: dict, out: list, raw_ref: Optional[str],
                  fetched_at: str) -> None:
    """事件 → 条目(共用于广度翻页与定向系列两条路径)。

    🔴 `raw_ref` 必须是**装着这条合约的那一次响应**。原先每个场所只留第一次广度请求的 ref
    却挂到全部证据上 —— 第 2 页、定向系列拿到的合约,其证据指向的 raw 里根本没有它,
    "每个数字都能追到 raw"这条产品命题就是假的(Codex prob-r1 P1)。
    """
    for ev in evs:
        if not isinstance(ev, dict):
            continue
        title = str(ev.get("title") or "")
        mod = classify(title, str(ev.get("category") or ""))
        if mod not in CORE_MODULES:
            continue
        leg = _pick_leg(ev.get("markets") or [])
        if not leg:
            continue
        close = str(leg.get("close_time") or ev.get("close_time") or "")[:10]
        if not _valid_day(close):
            # 🔴 缺 / 非法结算日就丢弃,**不许拿取数日顶替**:证据的 `period` 是结构化字段,
            #    裁决点直接拿它当"下一个数据点";填成今天就是**造了一个日期**,
            #    而 note 里那句"结算日不详"救不回来(结构化字段才是下游真正用的)(Codex prob-r8)。
            #    这一层的价值本来就在结算日,没有它这条合约也没什么可用的。
            dropped["missing_close"] = dropped.get("missing_close", 0) + 1
            continue
        # 🔴 字段名是 *_fp(取 volume_24h / volume 全落空,排序全为 0 → 选出来的是零成交的远期合约);
        #    ⚠️ 这几个 *_fp 字段**有时返回字符串**("10505.78"),直接比大小会 TypeError,必须过 _f()。
        v24 = _f(leg.get("volume_24h_fp")) or 0.0
        vtot = _f(leg.get("volume_fp")) or 0.0
        oi = _f(leg.get("open_interest_fp")) or 0.0
        why = keep_contract(close, today, v24, vtot, oi)
        if why:
            dropped[why] = dropped.get(why, 0) + 1
            continue
        out.append({"module": mod, "venue": "kalshi", "title": title,
                    "leg": str(leg.get("yes_sub_title") or leg.get("subtitle") or leg.get("ticker") or ""),
                    "prob": leg["_prob"], "price_type": leg.get("_price_type") or "unknown",
                    "volume": v24, "volume_total": vtot, "open_interest": oi,
                    "volume_missing": _f(leg.get("volume_24h_fp")) is None,   # 缺字段 ≠ 真的零
                    "ticker": str(leg.get("ticker") or ev.get("event_ticker") or ""),
                    "close": close, "as_of": fetched_at, "raw_ref": raw_ref})


def _kalshi_macro_series(warns: Optional[list] = None) -> tuple[list, Optional[str], bool]:
    """宏观系列 ticker。`category` 在 /series 上**有效**(实测 721/752 命中),与 /events 相反。

    🔴 结构漂移**不许静默变成"没有匹配项"**:那样定向循环一次都不跑、一个 warning 也没有,
    宏观经济模块整块消失而 status 还是 ok(Codex prob-r2 P1)。⇒ 顶层形状正向校验,不符就抛。
    """
    tickers: list = []
    raw_ref = None
    page_truncated = False
    for cat in KALSHI_MACRO_CATEGORIES:
        body = _get(KALSHI_SERIES, {"limit": "1000", "category": cat})
        page_ref = record_raw(body, "json", KALSHI_SERIES)
        raw_ref = raw_ref or page_ref
        data = json.loads(body)
        if not isinstance(data, dict) or not isinstance(data.get("series"), list):
            raise ProbabilityError(f"Kalshi /series({cat}) 响应缺 series 数组(结构变了)")
        rows = data["series"]
        if len(rows) >= 1000:
            page_truncated = True
            if warns is not None:
                warns.append(f"Kalshi /series({cat}) 返回满 1000 条,可能还有更多系列未纳入(抽样不是全量)")
        for sr in rows:
            if not isinstance(sr, dict):
                continue
            t = f" {str(sr.get('title') or '').lower()} "
            if any(k in t for k in _MACRO_SERIES_KW) and sr.get("ticker"):
                tickers.append(str(sr["ticker"]))
    uniq = list(dict.fromkeys(tickers))   # 去重、保留先后顺序
    over_cap = len(uniq) > KALSHI_MACRO_SERIES_MAX
    truncated = page_truncated or over_cap
    if warns is not None and over_cap:
        # 只在**真的截掉了**匹配结果时才这么说:满 1000 条但只匹配出 5 个时,5 个全取了,
        # 写"只取前 12 个"是假描述(上面那条"满 1000 条"的告警才是对的)(Codex prob-r7)
        warns.append(f"匹配到 {len(uniq)} 个 Kalshi 宏观系列,只取前 {KALSHI_MACRO_SERIES_MAX} 个")
    # 第三个返回值 = 发现阶段是否被截断。少查了一个系列,这个源就没资格说"当前没有符合条件的合约"
    return uniq[:KALSHI_MACRO_SERIES_MAX], raw_ref, truncated


def _kalshi(today: str, dropped: dict) -> tuple[list, list, Optional[str], bool]:
    """广度(开放事件翻页)+ 定向(宏观系列逐个取)。定向那一半是「宏观经济」模块唯一的来源。

    第四个返回值 = **覆盖是否完整**。"没抛异常"不等于"该查的都查完了":定向失败被降成 warning、
    或翻页被截断时,这个源就没资格支撑"当前没有符合条件的合约"这种断言(Codex prob-r5)。
    """
    out: list = []
    warns: list = []
    complete = True
    cursor, raw_ref = "", None
    for _page in range(KALSHI_PAGES):
        params = {"limit": "200", "status": "open", "with_nested_markets": "true"}
        if cursor:
            params["cursor"] = cursor
        try:
            body, fetched = _get_stamped(KALSHI_EVENTS, params)
            page_ref = record_raw(body, "json", KALSHI_EVENTS)
            raw_ref = raw_ref or page_ref
            data = json.loads(body)
            evs = data.get("events") if isinstance(data, dict) else None
            if not isinstance(evs, list):
                raise ProbabilityError("Kalshi 响应缺 events 数组(结构变了)")
        except Exception as e:  # preserve earlier parsed pages, never claim full coverage
            if _page == 0:
                raise
            warns.append(f"Kalshi 广度取数失败，保留已取得页面，后续范围未知:{type(e).__name__}: {str(e)[:100]}")
            complete = False
            break
        _kalshi_shape(evs, today, dropped, out, page_ref, fetched)
        cursor = str(data.get("cursor") or "") if isinstance(data, dict) else ""
        if not cursor:
            break
    else:
        # 翻满上限还有 cursor = **被我们截断了**。静默截断会让"没有符合条件的合约"看起来像事实
        if cursor:
            warns.append(f"Kalshi 广度采样翻满 {KALSHI_PAGES} 页仍有下一页,后续合约未纳入(结果是抽样不是全量)")
            complete = False
    try:
        series, sref, series_truncated = _kalshi_macro_series(warns)
        raw_ref = raw_ref or sref
        complete = complete and not series_truncated
        for tk in series:
            body, fetched = _get_stamped(KALSHI_EVENTS, {"status": "open", "with_nested_markets": "true",
                                                          "series_ticker": tk, "limit": "50"})
            sub_ref = record_raw(body, "json", KALSHI_EVENTS)
            data = json.loads(body)
            evs = data.get("events") if isinstance(data, dict) else None
            if not isinstance(evs, list):
                # 定向路径也不许"字段没了就当空数组" —— 那是结构漂移,不是没数据
                raise ProbabilityError(f"Kalshi 系列 {tk} 响应缺 events 数组(结构变了)")
            if len(evs) >= 50:
                warns.append(f"Kalshi 系列 {tk} 返回满 50 条事件,可能还有更多未纳入")
                complete = False
            _kalshi_shape(evs, today, dropped, out, sub_ref, fetched)
    except Exception as e:  # noqa: BLE001 — 定向失败不该拖垮广度已拿到的部分,但必须出声
        warns.append(f"Kalshi 宏观系列定向取数失败(广度采样仍在,但宏观经济模块可能因此空缺):{type(e).__name__}: {str(e)[:100]}")
        complete = False
    if not out and complete:
        # 这条是**结论**不是覆盖受限,不熄灭 complete
        warns.append("Kalshi 开放事件里没有落入 6 个核心模块的合约(不是故障)")
    return out, warns, raw_ref, complete


def _as_list(v):
    """`outcomes` / `outcomePrices` 上游有时是 JSON 字符串、有时是数组。解不出返回空表(由调用方计数)。"""
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return []
    return v if isinstance(v, list) else []


def _poly_shape(rows: list, today: str, dropped: dict, out: list, raw_ref: Optional[str],
                fetched_at: str) -> None:
    for m in rows:
        if not isinstance(m, dict):
            continue
        title = str(m.get("question") or "")
        mod = _polymarket_module(m, title)
        if mod not in CORE_MODULES:
            continue
        # 🔴 不能直接拿 `outcomePrices[0]` 当"该事件的概率":`outcomes` 顺序**不保证**是 ["Yes","No"],
        #    第一项可能是 "No" 或多结果选项之一 —— 那样报出去的是**反向概率**,一个静默的错误数字
        #    (Codex prob-r1 P1)。⇒ 必须把两个数组配对,只认 Yes 腿;认不出就丢弃并计数。
        prices, outcomes = _as_list(m.get("outcomePrices")), _as_list(m.get("outcomes"))
        p, leg_label, price_type = None, "", "outcome_price"
        if prices and outcomes and len(prices) == len(outcomes):
            for name, px in zip(outcomes, prices):
                if str(name).strip().lower() == "yes":
                    p, leg_label = _f(px), "Yes"
                    break
            if p is None:
                # 找到了 Yes 腿但价格解析不出 → 是 no_price 不是 no_yes_leg(诊断计数要对得上原因)
                key = "no_price" if leg_label == "Yes" else "no_yes_leg"
                dropped[key] = dropped.get(key, 0) + 1
                continue
        elif prices or outcomes:
            # 有一个有、另一个没有 / 长度对不上 = 结构漂移,**不许猜**
            dropped["outcome_shape_drift"] = dropped.get("outcome_shape_drift", 0) + 1
            continue
        else:
            # 两个数组**都**缺失时同样不许猜:`lastTradePrice` 无法证明属于 Yes 腿,
            # 报出去就是一个方向不明的概率。我自己定了"认不出 Yes 就不猜",这里曾没贯彻到底
            # (Codex prob-r2 P1)。
            dropped["outcome_shape_drift"] = dropped.get("outcome_shape_drift", 0) + 1
            continue
        if p is None or not 0 < p < 1:
            dropped["no_price"] = dropped.get("no_price", 0) + 1
            continue
        close = str(m.get("endDate") or "")[:10]
        if not _valid_day(close):
            dropped["missing_close"] = dropped.get("missing_close", 0) + 1   # 同上:不造日期
            continue
        v24 = _f(m.get("volume24hr")) or 0.0
        vtot = _f(m.get("volume")) or 0.0
        why = keep_contract(close, today, v24, vtot)
        if why:
            dropped[why] = dropped.get(why, 0) + 1
            continue
        out.append({"module": mod, "venue": "polymarket", "title": title, "leg": leg_label,
                    "prob": p, "price_type": price_type,
                    "volume": v24, "volume_total": vtot, "open_interest": 0.0,
                    "volume_missing": _f(m.get("volume24hr")) is None,
                    "ticker": str(m.get("slug") or m.get("conditionId") or ""),
                    "close": close, "as_of": fetched_at, "raw_ref": raw_ref})


def _poly_macro_tags(warns: Optional[list] = None) -> tuple[list, bool]:
    """宏观标签 id。**按 slug / label 现查,不硬编码 id** —— id 会变,写死迟早静默失效。

    🔴 同上:顶层不是数组 = 结构漂移,不是"没有标签"(prob-r2 P1)。
    """
    body = _get(POLY_TAGS, {"limit": "500"})
    record_raw(body, "json", POLY_TAGS)
    data = json.loads(body)
    if not isinstance(data, list):
        raise ProbabilityError("Polymarket /tags 响应不是数组(结构变了)")
    truncated = len(data) >= 500
    if warns is not None and truncated:
        warns.append("Polymarket /tags 返回满 500 条,可能还有更多标签未纳入(抽样不是全量)")
    ids = []
    for t in data:
        if not isinstance(t, dict):
            continue
        txt = f"{str(t.get('label') or '').lower()} {str(t.get('slug') or '').lower()}"
        if any(k in txt for k in _POLY_MACRO_TAG_KW) and t.get("id") is not None:
            ids.append(str(t["id"]))
    if len(ids) > 8:
        truncated = True
        if warns is not None:
            warns.append(f"匹配到 {len(ids)} 个 Polymarket 宏观标签,只取前 8 个")
    return ids[:8], truncated


def _polymarket(today: str, dropped: dict) -> tuple[list, list, Optional[str], bool]:
    """广度(按 24h 成交量翻页)+ 定向(宏观标签)。
    ⚠️ 排序参数是 **`volume24hr`**(无下划线)。官方 agent-skills 的 market-data.md 写的是
    `volume_24hr`,**实测返回 HTTP 422「order fields are not valid」** —— 官方文档在这一处是错的,
    照它改反而会把端点改坏。"""
    out: list = []
    warns: list = []
    complete = True          # 🔴 必须在这里初始化:曾只在"翻满页"分支里赋值,正常路径直接 UnboundLocalError
    raw_ref = None
    full_pages = 0
    for page in range(POLY_PAGES):
        params = {"active": "true", "closed": "false", "limit": "100",
                  "offset": str(page * 100), "order": "volume24hr", "ascending": "false"}
        try:
            body, fetched = _get_stamped(POLY_MARKETS, params)
            page_ref = record_raw(body, "json", POLY_MARKETS)
            raw_ref = raw_ref or page_ref
            data = json.loads(body)
            if not isinstance(data, list):
                raise ProbabilityError("Polymarket 响应不是数组(结构变了)")
        except Exception as e:  # preserve earlier parsed pages, never claim full coverage
            if page == 0:
                raise
            warns.append(f"Polymarket 广度取数失败，保留已取得页面，后续范围未知:{type(e).__name__}: {str(e)[:100]}")
            complete = False
            break
        if not data:
            break
        full_pages = page + 1 if len(data) >= 100 else full_pages
        _poly_shape(data, today, dropped, out, page_ref, fetched)
    if full_pages >= POLY_PAGES:
        warns.append(f"Polymarket 广度采样翻满 {POLY_PAGES} 页且末页仍是满的,后续市场未纳入(抽样不是全量)")
        complete = False
    try:
        tag_ids, tags_truncated = _poly_macro_tags(warns)
        complete = complete and not tags_truncated
        for tid in tag_ids:
            body, fetched = _get_stamped(POLY_MARKETS, {"tag_id": tid, "active": "true", "closed": "false",
                                                        "limit": "50", "order": "volume24hr", "ascending": "false"})
            sub_ref = record_raw(body, "json", POLY_MARKETS)
            data = json.loads(body)
            if not isinstance(data, list):
                raise ProbabilityError(f"Polymarket 标签 {tid} 响应不是数组(结构变了)")
            if len(data) >= 50:
                warns.append(f"Polymarket 标签 {tid} 返回满 50 条,可能还有更多未纳入")
                complete = False
            _poly_shape(data, today, dropped, out, sub_ref, fetched)
    except Exception as e:  # noqa: BLE001
        warns.append(f"Polymarket 宏观标签定向取数失败(广度采样仍在):{type(e).__name__}: {str(e)[:100]}")
        complete = False
    if not out and complete:
        warns.append("Polymarket 活跃市场里没有落入 6 个核心模块的合约(不是故障)")
    return out, warns, raw_ref, complete


def macro_probability(now: Optional[datetime] = None) -> dict:
    """两个预测市场 → 6 个核心模块,每模块取前 PER_MODULE 条。
    ⚠️ 排序键是 **max(24h 成交量, 未平仓量)** 不是单看 24h 成交量(理由见下方注释)——
    这里的措辞曾与代码不符,别再写成"按 24h 成交量取前 N"。
    单源失败不致命(另一源仍有值),两源都失败才抛。"""
    # 先转 UTC 再格式化:传入带偏移的时间(如 +08:00)时,直接追加 Z 会标出一个错误的时刻
    _now = (now or datetime.now(timezone.utc))
    _now = _now.astimezone(timezone.utc) if _now.tzinfo else _now.replace(tzinfo=timezone.utc)
    today = _now.strftime("%Y-%m-%d")
    # `today` 只用于合约到期 / 远期判定(日粒度足够);**概率成立的时刻另算** ——
    # 见 `_stamp()`:每条 item 记它那次请求的 UTC 时刻,运行级 as_of 记取数完成时刻。
    fetch_started = _now.strftime("%Y-%m-%dT%H:%M:%SZ")
    items: list = []
    warns: list = []
    errors: list = []
    refs: dict = {}
    dropped: dict = {}
    ok_sources = 0
    ok_names: list = []
    partial_names: list = []
    for name, fn in (("kalshi", _kalshi), ("polymarket", _polymarket)):
        budget_token = _source_deadline.set(time.monotonic() + SOURCE_BUDGET_SECONDS)
        try:
            got, w, ref, complete = fn(today, dropped)
            items.extend(got)
            warns.extend(w)
            refs[name] = ref
            ok_sources += 1
            # 🔴 `sources_ok` 的语义是「**完整查完**」不是「没抛异常」:定向失败或翻页被截断时,
            #    这个源不足以支撑"当前没有符合条件的合约"这种断言(Codex prob-r5)。
            (ok_names if complete else partial_names).append(name)           # 🔴 "成功但没有符合条件的合约" 也是成功
        except Exception as e:  # noqa: BLE001 — 逐源隔离
            errors.append(f"{name}: {type(e).__name__}: {str(e)[:140]}")
        finally:
            _source_deadline.reset(budget_token)
    if ok_sources == 0:
        # 判据是**成功的源数**,不是"有没有 item"。原先写 `not items and errors`:
        # 一个源报错、另一个源成功但当前没有符合条件的合约,会报"两个源都失败" —— 那是个假事实
        # (Codex prob-r3 P1)。
        raise ProbabilityError("两个预测市场源都失败:" + "; ".join(errors))
    # 每模块按 max(24h 成交量, 未平仓量) 取前 N;同一 venue 的重复标题去重
    picked: list = []
    seen: set = set()
    for mod in CORE_MODULES:
        # 🔴 排序键 = max(24h 成交量, 未平仓量),**不是**单看 24h 成交量:
        #    月度宏观合约(核心 PCE / PPI)典型是**持仓大、当日安静**,只看当日量会被
        #    "Kentucky 煤炭产量"这种同类别的冷门合约挤掉(实测就是如此)。持仓代表有真金留在场内。
        rows = sorted([x for x in items if x["module"] == mod],
                      key=lambda x: (-max(x["volume"], x.get("open_interest", 0.0)), -x.get("volume_total", 0.0)))
        n = 0
        for r in rows:
            key = (r["venue"], r["title"][:80])   # 广度与定向会取到同一条,这里去重
            if key in seen:
                continue
            seen.add(key)
            picked.append(r)
            n += 1
            if n >= PER_MODULE:
                break
    # 空模块**不进报告也不进 agent 上下文** —— 报告里并没有"这里应该有 6 个模块"的清单,
    # 某个模块整块不出现,读者不会误读成"市场对这件事没有分歧",专门写一句解释是自说自话。
    # (与招聘信号的"未接入 ≠ 零岗位"不同:那里报告**列着**一串锚点公司,缺一家是会被误读的。)
    # 这个字段只作**诊断**用:分类器哪天被改坏导致某模块静默清零,只看报告是发现不了的。
    empty = [m for m in CORE_MODULES if not any(x["module"] == m for x in picked)]
    # 运行级 as_of 用**取数完成时刻**,并把起止都留下:每条 item 另有自己那次请求的 as_of,
    # 运行级只是没有 item 级信息时的兜底(别再用"开工时刻"冒充"这个数字成立的时刻")。
    return {"today": today, "as_of": _stamp(), "fetch_started": fetch_started, "items": picked, "sources_ok": ok_names, "sources_partial": partial_names, "modules": list(CORE_MODULES), "empty_modules_diagnostic": empty,
            "dropped_reference_modules": list(REFERENCE_MODULES), "per_module_cap": PER_MODULE,
            "raw_refs": refs, "warnings": warns, "errors": errors, "guard": GUARD,
            "horizon_days": HORIZON_DAYS, "dropped": dropped}
