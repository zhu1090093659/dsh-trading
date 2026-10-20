"""Yahoo Finance 源(B 级:非官方接口,个人研究用):chart K 线与分红拆股事件(美股 / 港股,零 crumb)/ quoteSummary(关键指标 / 分析师预期 / 机构持仓)/ fundamentals-timeseries 财报 / 期权链(美股)/ 新闻搜索。移植自 global-stock-data §2 / §4.3-4.6 / §6.2 / §8.2。
crumb 会话与 raw 落盘见 _http.yahoo_*。"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA  # noqa: E402
from sources._http import http_json, norm_hk, record_raw, us_ticker_for, yahoo_get, yahoo_quote_summary, yahoo_session  # noqa: E402


def yahoo_symbol(symbol: str, market: str = "US") -> str:
    if market == "HK":
        return f"{int(norm_hk(symbol)):04d}.HK"
    return us_ticker_for("yahoo", symbol)   # BRK.B → BRK-B


def _raw(d: dict, key: str):
    v = (d or {}).get(key, {})
    return v.get("raw") if isinstance(v, dict) else v


def yahoo_kline(symbol: str, market: str = "US", interval: str = "1d", range_: str = "6mo") -> list[dict]:
    """chart v8(零 crumb):[{date, open, high, low, close, volume}];日期按 UTC 折算(美股 / 港股日线均落在正确交易日)。"""
    sym = yahoo_symbol(symbol, market)
    d = http_json(f"https://query2.finance.yahoo.com/v8/finance/chart/{sym}", params={"interval": interval, "range": range_}, headers={"User-Agent": UA}, timeout=15)
    res = ((d.get("chart") or {}).get("result") or [{}])[0]
    ts = res.get("timestamp") or []
    q = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    intraday = any(ch in interval for ch in ("m", "h"))
    out = []
    for i, t in enumerate(ts):
        dt = datetime.fromtimestamp(t, timezone.utc)
        row: dict[str, Any] = {"date": dt.strftime("%Y-%m-%d %H:%M") if intraday else dt.strftime("%Y-%m-%d")}
        for k in ("open", "high", "low", "close"):
            v = (q.get(k) or [None] * len(ts))[i]
            row[k] = round(v, 4) if v is not None else None
        v = (q.get("volume") or [None] * len(ts))[i]
        row["volume"] = int(v) if v is not None else None
        out.append(row)
    return out


def key_statistics(symbol: str, market: str = "US") -> dict:
    data = yahoo_quote_summary(yahoo_symbol(symbol, market), ["financialData", "defaultKeyStatistics", "summaryDetail"])
    fd, ks, sd = data.get("financialData", {}), data.get("defaultKeyStatistics", {}), data.get("summaryDetail", {})
    # 🔴 产品口径：不输出分析师目标价 / 评级（targetHigh/Low/MeanPrice、recommendationKey、numberOfAnalystOpinions）。
    #    financialData 模块里本来就带着它们，raw 落盘是原样存证，但映射后的结果与证据里一律不出现。
    return {"current_price": _raw(fd, "currentPrice"), "trailing_pe": _raw(sd, "trailingPE"), "forward_pe": _raw(ks, "forwardPE"),
            "peg_ratio": _raw(ks, "pegRatio"), "price_to_book": _raw(ks, "priceToBook"), "enterprise_value": _raw(ks, "enterpriseValue"), "ev_to_ebitda": _raw(ks, "enterpriseToEbitda"),
            "ev_to_revenue": _raw(ks, "enterpriseToRevenue"), "profit_margin": _raw(ks, "profitMargins"), "operating_margin": _raw(fd, "operatingMargins"), "gross_margin": _raw(fd, "grossMargins"),
            "return_on_equity": _raw(fd, "returnOnEquity"), "return_on_assets": _raw(fd, "returnOnAssets"), "earnings_growth": _raw(fd, "earningsGrowth"), "revenue_growth": _raw(fd, "revenueGrowth"),
            "beta": _raw(ks, "beta"), "short_ratio": _raw(ks, "shortRatio"), "dividend_yield": _raw(sd, "dividendYield"), "payout_ratio": _raw(ks, "payoutRatio"), "market_cap": _raw(sd, "marketCap"),
            "total_revenue": _raw(fd, "totalRevenue"), "total_cash": _raw(fd, "totalCash"), "total_debt": _raw(fd, "totalDebt"), "financial_currency": fd.get("financialCurrency"), "symbol": yahoo_symbol(symbol, market)}


def analyst_estimates(symbol: str, market: str = "US") -> dict:
    # 🔴 不请求 upgradeDowngradeHistory：逐家机构「上调至买入」属于个股评级赋予，产品红线不提供。
    #    recommendationTrend 是机构评级的聚合篇数，与 em_reports 的评级分布同口径，属于合法证据，保留。
    data = yahoo_quote_summary(yahoo_symbol(symbol, market), ["earningsTrend", "recommendationTrend", "earnings", "earningsHistory"])
    eps_trend = [{"period": t.get("period"), "end_date": t.get("endDate"), "eps_estimate": _raw(t.get("earningsEstimate") or {}, "avg"), "eps_high": _raw(t.get("earningsEstimate") or {}, "high"),
                  "eps_low": _raw(t.get("earningsEstimate") or {}, "low"), "revenue_estimate": _raw(t.get("revenueEstimate") or {}, "avg"), "num_analysts": _raw(t.get("earningsEstimate") or {}, "numberOfAnalysts"),
                  "growth": _raw(t, "growth")} for t in (data.get("earningsTrend") or {}).get("trend") or []]
    rating_trend = [{"period": r.get("period"), "strong_buy": r.get("strongBuy"), "buy": r.get("buy"), "hold": r.get("hold"), "sell": r.get("sell"), "strong_sell": r.get("strongSell")}
                    for r in (data.get("recommendationTrend") or {}).get("trend") or []]
    eh = [{"quarter": _raw(h, "quarter") and datetime.fromtimestamp(_raw(h, "quarter"), timezone.utc).strftime("%Y-%m-%d"), "eps_actual": _raw(h, "epsActual"), "eps_estimate": _raw(h, "epsEstimate"), "surprise_pct": _raw(h, "surprisePercent")}
          for h in (data.get("earningsHistory") or {}).get("history") or []]
    # 报告币种:港股 / 中概常以人民币列报(0700.HK 的 EPS 预期是人民币,不是港元)。earnings.financialCurrency 优先,退到 earningsHistory 行内 currency
    hist_ccy = next((h.get("currency") for h in (data.get("earningsHistory") or {}).get("history") or [] if isinstance(h, dict) and h.get("currency")), None)
    fin_ccy = (data.get("earnings") or {}).get("financialCurrency") or hist_ccy
    return {"eps_trend": eps_trend, "rating_trend": rating_trend, "earnings_history": eh, "financial_currency": fin_ccy}


def institutional_holders(symbol: str, market: str = "US") -> dict:
    data = yahoo_quote_summary(yahoo_symbol(symbol, market), ["institutionOwnership", "majorHoldersBreakdown"])
    mhb = data.get("majorHoldersBreakdown", {})
    overview = {"insiders_pct": _raw(mhb, "insidersPercentHeld"), "institutions_pct": _raw(mhb, "institutionsPercentHeld"), "institutions_float_pct": _raw(mhb, "institutionsFloatPercentHeld"),
                "institutions_count": _raw(mhb, "institutionsCount")}
    top = [{"name": h.get("organization"), "shares": _raw(h, "position"), "value": _raw(h, "value"), "pct_held": _raw(h, "pctHeld"), "report_date": (h.get("reportDate") or {}).get("fmt") if isinstance(h.get("reportDate"), dict) else None}
           for h in ((data.get("institutionOwnership") or {}).get("ownershipList") or [])[:10]]
    return {"overview": overview, "top_holders": top}


# fundamentals-timeseries 的科目键(不带 annual / quarterly / trailing 前缀);资产负债表是时点数,没有 trailing(近四季)口径。
TS_FLOW_KEYS = ("TotalRevenue", "GrossProfit", "OperatingIncome", "NetIncome", "DilutedEPS", "EBITDA", "OperatingCashFlow", "CapitalExpenditure", "FreeCashFlow")
TS_STOCK_KEYS = ("TotalAssets", "TotalLiabilitiesNetMinorityInterest", "StockholdersEquity", "CashAndCashEquivalents", "TotalDebt")
TS_PERIODS = {"annual": "全年", "quarterly": "单季", "trailing": "近四季"}


def financial_timeseries_yahoo(symbol: str, market: str = "US", period: str = "annual") -> dict:
    """Yahoo fundamentals-timeseries(替换已下线的 quoteSummary 三表模块):period = annual 全年 / quarterly 单季 / trailing 近四季合计。
    Yahoo 只回最近约 4 个年度、5 个季度;每个值自带报告期末(as_of)、口径(12M / 3M / TTM)和列报币种(港股公司常以人民币列报)。
    {period, symbol, items: {科目: [{as_of, period_type, currency, value}]}}。没有的科目不出现在 items 里(不补 0)。"""
    if period not in TS_PERIODS:
        raise ValueError("period 只能是 annual / quarterly / trailing")
    sym = yahoo_symbol(symbol, market)
    keys = TS_FLOW_KEYS + (() if period == "trailing" else TS_STOCK_KEYS)
    end = int(datetime.now(timezone.utc).timestamp()) + 86400
    d = yahoo_get(f"https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{sym}",
                  {"symbol": sym, "type": ",".join(period + k for k in keys), "period1": "1483142400", "period2": str(end)})
    items: dict = {}
    for x in ((d.get("timeseries") or {}).get("result") or []):
        for k, v in x.items():
            if k in ("meta", "timestamp") or not isinstance(v, list):
                continue
            pts = [{"as_of": str(p.get("asOfDate") or "")[:10], "period_type": p.get("periodType"), "currency": p.get("currencyCode"),
                    "value": ((p.get("reportedValue") or {}).get("raw"))} for p in v if isinstance(p, dict)]
            pts = [p for p in pts if p["as_of"] and p["value"] is not None]
            if pts:
                items[k[len(period):] if k.startswith(period) else k] = sorted(pts, key=lambda p: p["as_of"])
    return {"period": period, "symbol": sym, "items": items}


def corporate_events_yahoo(symbol: str, market: str = "US", range_: str = "10y") -> dict:
    """chart v8 带 events=div,splits,capitalGains(零 crumb):除息 / 拆合股 / 资本利得分配。日期按交易所当地时区折算成除权除息日。
    {symbol, currency, dividends:[{date, amount}], splits:[{date, numerator, denominator, ratio}], capital_gains:[{date, amount}]}"""
    sym = yahoo_symbol(symbol, market)
    d = http_json(f"https://query2.finance.yahoo.com/v8/finance/chart/{sym}", params={"interval": "1d", "range": range_, "events": "div,splits,capitalGains"}, headers={"User-Agent": UA}, timeout=15)
    res = ((d.get("chart") or {}).get("result") or [{}])[0] or {}
    meta = res.get("meta") or {}
    off = int(meta.get("gmtoffset") or 0)
    ev = res.get("events") or {}

    def _day(t) -> str:
        return datetime.fromtimestamp(int(t) + off, timezone.utc).strftime("%Y-%m-%d")

    def _rows(kind: str, fn):
        return sorted((fn(x) for x in (ev.get(kind) or {}).values() if isinstance(x, dict) and x.get("date") is not None), key=lambda r: r["date"])

    return {"symbol": sym, "currency": meta.get("currency"), "range": range_,
            "dividends": _rows("dividends", lambda x: {"date": _day(x["date"]), "amount": x.get("amount")}),
            "splits": _rows("splits", lambda x: {"date": _day(x["date"]), "numerator": x.get("numerator"), "denominator": x.get("denominator"), "ratio": x.get("splitRatio")}),
            "capital_gains": _rows("capitalGains", lambda x: {"date": _day(x["date"]), "amount": x.get("amount")})}


def _exp_date(v) -> str:
    if isinstance(v, dict):
        v = v.get("raw") or v.get("fmt")
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v, timezone.utc).strftime("%Y-%m-%d")
    return str(v or "")


def options_chain_yahoo(symbol: str, expiration: Optional[int] = None) -> dict:
    """美股期权链(后备,无希腊字母):{expiration_dates, calls, puts, underlying_price}"""
    t = us_ticker_for("yahoo", symbol)
    params = {"date": expiration} if expiration else {}
    d = yahoo_get(f"https://query2.finance.yahoo.com/v7/finance/options/{t}", params=params)
    oc = ((d.get("optionChain") or {}).get("result") or [{}])[0]
    opts = (oc.get("options") or [{}])[0] if oc.get("options") else {}

    def _parse(lst):
        return [{"strike": _raw(o, "strike"), "last_price": _raw(o, "lastPrice"), "bid": _raw(o, "bid"), "ask": _raw(o, "ask"), "volume": _raw(o, "volume"), "open_interest": _raw(o, "openInterest"),
                 "implied_volatility": _raw(o, "impliedVolatility"), "in_the_money": o.get("inTheMoney"), "expiration": _exp_date(o.get("expiration")),
                 "contract_symbol": o.get("contractSymbol")} for o in lst or []]

    return {"expiration_dates": [_exp_date(x) for x in oc.get("expirationDates") or []], "calls": _parse(opts.get("calls")), "puts": _parse(opts.get("puts")), "underlying_price": _raw(oc.get("quote") or {}, "regularMarketPrice") or (oc.get("quote") or {}).get("regularMarketPrice")}


def yahoo_news(keyword: str, count: int = 10) -> list[dict]:
    """新闻搜索:[{title, publisher, link, publish_time(ISO UTC)}]"""
    s, _ = yahoo_session()
    r = s.get("https://query2.finance.yahoo.com/v1/finance/search", params={"q": keyword, "quotesCount": 0, "newsCount": count}, timeout=10)
    r.raise_for_status()
    record_raw(r.content, "json", r.url)
    out = []
    for n in r.json().get("news") or []:
        ts = n.get("providerPublishTime")
        out.append({"title": n.get("title"), "publisher": n.get("publisher"), "link": n.get("link"), "publish_time": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M") if ts else ""})
    return out
