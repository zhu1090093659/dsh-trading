"""港美股个股研究专用取数(六阶段研究的港股 / 美股入口)。零鉴权。

- global_quote_ref:腾讯一次请求取个股 + 市场基准指数(美股标普 500 / 港股恒生指数)。基准指数的报价日期就是"此刻一条新鲜报价应带的日期",
  港美股没有可查的公众假期日历,用它代替 A 股的交易日历;交易时段按交易所当地时钟推算。
- global_financials_pit:东财关键财务指标,按「公告日 ≤ 研究日」过滤(只用研究日当时已经披露的数),逐行标清是单季、年初至今累计还是全年。
- fx_rates:腾讯外汇报价(美元 / 港元兑人民币、美元兑港元),给跨币种估值做换算。
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import assert_us_ticker, http_get, norm_hk  # noqa: E402

_HDR = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}

# 交易所当地时钟:开盘 / 收盘(港股收盘竞价到 16:10;午休 12:00–13:00 仍记 trading,与 A 股日历的口径一致)
EXCHANGE: dict[str, dict[str, Any]] = {
    "US": {"tz": "America/New_York", "open": (9, 30), "close": (16, 0), "benchmark": "usINX", "benchmark_name": "标普500"},
    "HK": {"tz": "Asia/Hong_Kong", "open": (9, 30), "close": (16, 10), "benchmark": "hkHSI", "benchmark_name": "恒生指数"},
}
# 开盘后这么久基准指数还停在前一天 → 判为当地休市日(指数开盘后几秒内就会更新)
HOLIDAY_GRACE_MIN = 15


def _num(vals: list, i: int) -> Optional[float]:
    try:
        v = float(vals[i])
    except (ValueError, IndexError, TypeError):
        return None
    return v


def _quote_day(ts: str) -> str:
    """腾讯美股 '2026-10-08 11:27:40'、港股 '2026/10/08 16:08:24'(都是交易所当地时间)→ 'YYYY-MM-DD';认不出 → ''。"""
    s = str(ts or "").strip().replace("/", "-")
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        return ""


def session_phase(market: str, now: datetime, benchmark_day: str) -> str:
    """交易所当地时钟 + 基准指数报价日 → pre_open / trading / post_close / non_trading_day(与 A 股交易日历同一套取值)。
    周末 → non_trading_day;开盘前 → pre_open;开盘 HOLIDAY_GRACE_MIN 分钟后基准指数仍不是今天 → non_trading_day(当地公众假期);
    开盘后的宽限期内基准还没更新 → 仍按 pre_open(数据还没到,不急着判休市)。"""
    ex = EXCHANGE[market]
    local = now.astimezone(ZoneInfo(ex["tz"]))
    today = local.strftime("%Y-%m-%d")
    if local.weekday() >= 5:
        return "non_trading_day"
    minutes = local.hour * 60 + local.minute
    open_m, close_m = ex["open"][0] * 60 + ex["open"][1], ex["close"][0] * 60 + ex["close"][1]
    if minutes < open_m:
        return "pre_open"
    if benchmark_day != today:
        return "pre_open" if minutes < open_m + HOLIDAY_GRACE_MIN else "non_trading_day"
    return "trading" if minutes < close_m else "post_close"


def local_today(market: str, now: Optional[datetime] = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(EXCHANGE[market]["tz"])).strftime("%Y-%m-%d")


def _parse_lines(text: str) -> dict:
    lines = {}
    for line in text.strip().split(";"):
        if "=" in line and '"' in line:
            lines[line.split("=")[0].strip().replace("v_", "", 1)] = line.split('"')[1].split("~")
    return lines


def global_quote_ref(symbol: str, market: str = "US", now: Optional[datetime] = None) -> dict:
    """个股报价 + 基准指数(一条请求,两者同一时刻抓取):
    {market, symbol, security_name, name_en, quote_currency, price, prev_close, volume, pe_vendor, market_cap_yi, quote_time, quote_date,
     benchmark:{key, name, price, quote_time, quote_date}, reference_quote_day, session_phase, local_now, is_stale}
    - reference_quote_day = 基准指数的报价日;quote_date < reference_quote_day → 个股停牌 / 数据陈旧。
    - is_stale = 成交量 0 且现价 == 昨收(停牌 / 废码 / 盘前未成交)。
    - pe_vendor:腾讯给的市盈率,口径未注明(不当 TTM 用,估值阶段用财报自己算)。市值单位:美股 亿美元、港股 亿港元。
    个股取不到 → {}(代码无效 / 该源不收录)。"""
    if market not in EXCHANGE:
        raise ValueError("market 只能是 US / HK")
    key = f"us{assert_us_ticker(symbol)}" if market == "US" else f"r_hk{norm_hk(symbol)}"
    bkey = EXCHANGE[market]["benchmark"]
    r = http_get(f"https://qt.gtimg.cn/q={key},{bkey}", headers=_HDR, timeout=10, encoding="gbk", ext="txt")
    r.raise_for_status()
    lines = _parse_lines(r.text)
    v, b = lines.get(key) or [], lines.get(bkey) or []
    if len(v) < (73 if market == "US" else 76) or not v[1] or _num(v, 3) is None:
        return {}
    price, prev, volume = _num(v, 3), _num(v, 4), _num(v, 6)
    ts, bts = v[30] if len(v) > 30 else "", b[30] if len(b) > 30 else ""
    bday = _quote_day(bts)
    when = now or datetime.now(timezone.utc)
    out = {
        "market": market, "symbol": v[2] if market == "HK" else assert_us_ticker(symbol), "security_name": v[1], "name_en": v[46] if len(v) > 46 else "",
        "quote_currency": (v[35] if market == "US" else v[75]) or None,
        "price": price, "prev_close": prev, "volume": volume,
        "pe_vendor": _num(v, 39) if (_num(v, 39) or 0) > 0 else None,
        "market_cap_yi": _num(v, 45) if (_num(v, 45) or 0) > 0 else None,
        "quote_time": ts, "quote_date": _quote_day(ts),
        "benchmark": {"key": bkey, "name": b[1] if len(b) > 1 else EXCHANGE[market]["benchmark_name"], "price": _num(b, 3), "quote_time": bts, "quote_date": bday},
        "reference_quote_day": bday,
        "session_phase": session_phase(market, when, bday) if bday else "",
        "local_now": when.astimezone(ZoneInfo(EXCHANGE[market]["tz"])).strftime("%Y-%m-%d %H:%M:%S"),
        "timezone": EXCHANGE[market]["tz"],
    }
    out["is_stale"] = bool(volume == 0 and price == prev and (price or 0) > 0)
    return out


# ---------- 财务(按公告日过滤的研究日视角) ----------
# 东财 GMAININDICATOR 的 DATE_TYPE_CODE:001 全年 / 002 中期(年初至今 6 个月)/ 003 一季度 / 004 前三季度(年初至今 9 个月);
# 美股另有单季 006 第三季 / 007 第四季 / 008 第二季。实测(2026-10-08 AAPL / BABA / 00700)。
PERIOD_CODES = {"001": ("ytd", 12), "002": ("ytd", 6), "003": ("ytd", 3), "004": ("ytd", 9), "006": ("quarter", 3), "007": ("quarter", 3), "008": ("quarter", 3)}
CURRENCY_CODE = {"美元": "USD", "港元": "HKD", "人民币": "CNY"}
NET_PROFIT_KEYS = ("PARENT_HOLDER_NETPROFIT", "HOLDER_PROFIT")  # 美股 / 港股的归母净利润字段名不同


def _d(s) -> Optional[date]:
    try:
        return datetime.strptime(str(s or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def span_months(start: date, end: date) -> int:
    """期间跨几个月(按 30.44 天一个月四舍五入):AAPL 财年 371 天 → 12;中期 182–183 天 → 6;前三季度 273–280 天 → 9。"""
    return round(((end - start).days + 1) / 30.44)


def classify_row(row: dict) -> tuple[Optional[str], str]:
    """→ (kind, 原因)。kind ∈ ytd / quarter / None;代码与期间长度对不上一律不归类(不猜)。一季度(003)既是累计也是单季,归 ytd,单季由映射层另出。"""
    code = str(row.get("DATE_TYPE_CODE") or "")
    start, end = _d(row.get("START_DATE")), _d(row.get("REPORT_DATE"))
    if code not in PERIOD_CODES:
        return None, f"期间代码 {code or '缺失'} 不认识"
    if not start or not end or end < start:
        return None, "起止日期缺失或倒置"
    kind, months = PERIOD_CODES[code]
    got = span_months(start, end)
    if got != months:
        return None, f"期间代码 {code} 应为 {months} 个月,实际 {got} 个月"
    return kind, ""


def global_financials_pit(symbol: str, market: str = "US", as_of: Optional[str] = None, page_size: int = 60, years: float = 3) -> dict:
    """{market, symbol, as_of, rows:[{period, start, end, kind, months, code, date_type, notice_date, currency, revenue, net_profit_parent, eps_basic, eps_diluted}],
        dropped_after_as_of, dropped_no_notice, unclassified:[{end, code, reason}]}
    - as_of 默认 = 交易所当地今天;公告日 > as_of 或缺公告日的行丢弃并计数(研究日当时还看不到的数一律不用)。
    - 只留期末在研究日前 years 年内的行(默认 3 年:近四季合计及其同比最远要用到约 2 年 9 个月前的累计值),更早的计入 dropped_too_old。
    - 🔴 东财旧期的公告日会被后来的再次披露覆盖成更晚的日期:按它过滤只会多丢、不会多放;但留下的值可能是重述后的口径(note 写明)。
    - period 一律写 'YYYY-MM-DD..YYYY-MM-DD'(财年不按自然年,标签不统一:BABA 按起始年、AAPL 按结束年,只认起止日)。"""
    from sources.eastmoney import key_indicators_global
    if market not in EXCHANGE:
        raise ValueError("market 只能是 US / HK")
    cutoff = _d(as_of) if as_of else _d(local_today(market))
    if cutoff is None:
        raise ValueError("as_of 须为 YYYY-MM-DD")
    rows = key_indicators_global(symbol, market, page_size=int(page_size)) or []
    oldest = date.fromordinal(cutoff.toordinal() - int(float(years) * 365.25))
    kept, unclassified, late, no_notice, too_old, seen = [], [], 0, 0, 0, set()
    for r in rows:
        notice, start, end = _d(r.get("NOTICE_DATE")), _d(r.get("START_DATE")), _d(r.get("REPORT_DATE"))
        if notice is None:
            no_notice += 1
            continue
        if notice > cutoff or (end and end > cutoff):
            late += 1
            continue
        if end and end < oldest:
            too_old += 1
            continue
        kind, why = classify_row(r)
        if kind is None or start is None or end is None:   # 起止日缺失时 classify_row 已给 None，这里写明给类型检查看
            unclassified.append({"end": str(r.get("REPORT_DATE") or "")[:10], "code": r.get("DATE_TYPE_CODE"), "reason": why})
            continue
        period = f"{start.isoformat()}..{end.isoformat()}"
        if period in seen:  # 同一起止期重复出现(源端重复行):只留第一条(按报告期降序,已是最新一次披露)
            continue
        seen.add(period)
        np_ = next((r.get(k) for k in NET_PROFIT_KEYS if r.get(k) is not None), None)
        kept.append({"period": period, "start": start.isoformat(), "end": end.isoformat(), "kind": kind, "months": span_months(start, end),
                     "code": r.get("DATE_TYPE_CODE"), "date_type": r.get("DATE_TYPE"), "report_type": r.get("REPORT_TYPE"), "notice_date": notice.isoformat(),
                     "currency": CURRENCY_CODE.get(str(r.get("CURRENCY") or "").strip()), "currency_raw": r.get("CURRENCY"),
                     "revenue": r.get("OPERATE_INCOME"), "net_profit_parent": np_, "eps_basic": r.get("BASIC_EPS"), "eps_diluted": r.get("DILUTED_EPS")})
    kept.sort(key=lambda x: (x["end"], x["start"]), reverse=True)
    return {"market": market, "symbol": symbol, "as_of": cutoff.isoformat(), "rows": kept, "fetched_rows": len(rows),
            "dropped_after_as_of": late, "dropped_no_notice": no_notice, "dropped_too_old": too_old, "unclassified": unclassified}


# ---------- 汇率 ----------
FX_PAIRS = (("whUSDCNY", "USD", "CNY"), ("whHKDCNY", "HKD", "CNY"), ("whUSDHKD", "USD", "HKD"))


def fx_rates() -> dict:
    """腾讯外汇报价:{pairs:[{pair, base, quote, rate, time, date}]}。rate = 1 单位 base 兑多少 quote;time 为源给的 YYYYMMDDHHMMSS(北京时间)。"""
    keys = ",".join(k for k, _, _ in FX_PAIRS)
    r = http_get(f"https://qt.gtimg.cn/q={keys}", headers=_HDR, timeout=10, encoding="gbk", ext="txt")
    r.raise_for_status()
    lines = _parse_lines(r.text)
    pairs = []
    for k, base, quote in FX_PAIRS:
        v = lines.get(k) or []
        rate = _num(v, 3)
        pairs.append({"pair": f"{base}{quote}", "base": base, "quote": quote, "rate": rate if (rate or 0) > 0 else None,
                      "time": v[5] if len(v) > 5 else "", "date": v[21] if len(v) > 21 else ""})
    return {"pairs": pairs}

