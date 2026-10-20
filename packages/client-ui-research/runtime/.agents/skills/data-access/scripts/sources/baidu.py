"""百度股市通源:港股 / 美股估值历史(市盈率 TTM / 市净率 / 总市值等)。零鉴权。"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import http_json  # noqa: E402


VALUATION_INDICATORS = ("市盈率(TTM)", "市盈率(静)", "市净率", "市现率", "总市值")
VALUATION_PERIODS = ("近一年", "近三年", "全部")


def valuation_history_global(symbol: str, market: str = "US", indicators: str = "市盈率(TTM),市净率,总市值", period: str = "近一年") -> dict:
    """百度股市通港股 / 美股估值历史(opendata resource_id=51171,零鉴权):每个指标一次请求。
    🔴 港股序列按自然日给点、周六日沿用前一个值 —— 这里去掉周六日;港股公众假期没有日历可查,仍会出现沿用前值的点(note 里写明)。
    {market, symbol, period, series: {指标: {unit, rows:[[date, value]], dropped_weekend}}, errors: {指标: 原因}}"""
    from sources._http import assert_us_ticker, norm_hk
    from datetime import date as _date
    if period not in VALUATION_PERIODS:
        raise ValueError(f"period 只能是 {' / '.join(VALUATION_PERIODS)}")
    wanted = [x.strip() for x in str(indicators).split(",") if x.strip()]
    bad = [x for x in wanted if x not in VALUATION_INDICATORS]
    if bad or not wanted:
        raise ValueError(f"indicators 只能取 {' / '.join(VALUATION_INDICATORS)}(逗号分隔),收到 {bad or indicators!r}")
    code, mkt = (norm_hk(symbol), "hk") if market == "HK" else (assert_us_ticker(symbol), "us")
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://gushitong.baidu.com/"}
    series, errors = {}, {}
    for ind in wanted:
        params = {"openapi": "1", "dspName": "iphone", "tn": "tangram", "client": "app", "query": ind, "code": code, "word": "", "resource_id": "51171", "market": mkt,
                  "tag": ind, "chart_select": period, "industry_select": "", "skip_industry": "1", "finClientType": "pc"}
        try:
            d = http_json("https://gushitong.baidu.com/opendata", params=params, headers=headers, timeout=15)
            info = ((((d.get("Result") or [{}])[0].get("DisplayData") or {}).get("resultData") or {}).get("tplData") or {}).get("result", {}).get("chartInfo") or [{}]
            body = info[0].get("body") or []
        except Exception as e:  # noqa: BLE001 — 单个指标失败记原因,其余照常
            errors[ind] = f"{type(e).__name__}: {str(e)[:120]}"
            continue
        rows, dropped = [], 0
        for pt in body:
            if not (isinstance(pt, list) and len(pt) >= 2) or pt[1] in (None, "", "-", "--"):
                continue
            day = str(pt[0])[:10]
            try:
                if _date.fromisoformat(day).weekday() >= 5:
                    dropped += 1
                    continue
                rows.append([day, float(str(pt[1]).replace(",", ""))])
            except ValueError:
                continue
        if rows:
            series[ind] = {"unit": info[0].get("unit") or "", "rows": rows, "dropped_weekend": dropped}
        else:
            errors[ind] = "源返回空序列"
    return {"market": market, "symbol": code, "period": period, "series": series, "errors": errors}
