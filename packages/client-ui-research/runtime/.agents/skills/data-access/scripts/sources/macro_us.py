"""美国宏观 / 日历(global-stock-data Layer 12):美债收益率曲线(财政部,S)/ CFTC 持仓报告 COT(S)/ Nasdaq 财报日历(B);
另有产品自己接的 FRED 宏观历史序列(免 key 的 fredgraph.csv,不用要 key 的 API)。经 _http.official_get。"""
from __future__ import annotations

import csv
import io
import os
import sys
from datetime import datetime
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import official_get  # noqa: E402


def treasury_yield_curve(year: Optional[int] = None) -> list[dict]:
    """每日收益率曲线(1M~30Y,百分数):[{Date, '1 Mo', ..., '30 Yr'}],[0] 为最新一日"""
    year = year or datetime.utcnow().year
    url = (f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
    return list(csv.DictReader(io.StringIO(official_get(url))))


def cftc_cot(limit: int = 20, market_contains: Optional[str] = None) -> list[dict]:
    """CFTC COT(Socrata 6dca-aqww,按报告日倒序):原始行(contract_market_name / report_date_as_yyyy_mm_dd / open_interest_all / noncomm_positions_long_all / ...)"""
    q: dict = {"$limit": limit, "$order": "report_date_as_yyyy_mm_dd DESC"}
    if market_contains:
        q["$where"] = f"upper(contract_market_name) like upper('%{market_contains}%')"
    return official_get("https://publicreporting.cftc.gov/resource/6dca-aqww.json", params=q, as_json=True)


def earnings_calendar(date: Optional[str] = None) -> dict:
    """Nasdaq 财报日历:{date, count, rows:[{symbol, name, time, eps_forecast, market_cap}]};date=YYYY-MM-DD 默认今天(UTC)"""
    date = date or datetime.utcnow().strftime("%Y-%m-%d")
    j = official_get("https://api.nasdaq.com/api/calendar/earnings", params={"date": date}, headers={"Accept": "application/json"}, as_json=True)
    rows = ((j.get("data") or {}).get("rows")) or []
    return {"date": date, "count": len(rows), "rows": [{"symbol": r.get("symbol"), "name": r.get("name"), "time": r.get("time"), "eps_forecast": r.get("epsForecast"), "market_cap": r.get("marketCap")} for r in rows]}


# FRED 系列白名单:单位按 FRED 系列页「Units」原文(2026-10-08 逐个核对)译成中文;不在名单里的系列不接(没有核对过单位)。
# 版权受限的系列(如密歇根大学消费者信心 UMCSENT)不收。(field, 中文名, 单位, 频率)
FRED_SERIES = {
    "CPIAUCSL": ("us_cpi", "CPI 全部项目(季调)", "指数(1982-1984=100)", "月"),
    "CPILFESL": ("us_core_cpi", "核心 CPI(剔除食品与能源,季调)", "指数(1982-1984=100)", "月"),
    "PCEPILFE": ("us_core_pce_index", "核心 PCE 物价指数(季调)", "指数(2017=100)", "月"),
    "UNRATE": ("us_unemployment_rate", "失业率(季调)", "%", "月"),
    "PAYEMS": ("us_nonfarm_payrolls", "非农就业总人数(季调)", "千人", "月"),
    "FEDFUNDS": ("us_fed_funds_rate", "联邦基金有效利率(月均,未季调)", "%", "月"),
    "GDP": ("us_gdp_nominal", "名义 GDP(季调年化)", "十亿美元", "季"),
    "GDPC1": ("us_gdp_real", "实际 GDP(2017 年链式美元,季调年化)", "十亿美元(2017 年链式)", "季"),
    "M2SL": ("us_m2", "M2 货币供应(季调)", "十亿美元", "月"),
    "INDPRO": ("us_industrial_production", "工业生产指数(季调)", "指数(2017=100)", "月"),
    "ICSA": ("us_initial_claims", "首次申领失业金人数(季调,周末为周六)", "人", "周"),
    "T10Y2Y": ("us_term_spread_10y2y", "10 年减 2 年美债利差", "百分点", "日"),
}
FRED_DEFAULT = "CPIAUCSL,CPILFESL,PCEPILFE,UNRATE,PAYEMS,FEDFUNDS,GDPC1"


def fred_series(series: str = FRED_DEFAULT, start: Optional[str] = None) -> dict:
    """FRED 宏观历史序列(fredgraph.csv,免 key):每个系列一次请求,单个失败记 errors 不拖垮其余。
    返回 {start, series:{ID:{rows:[[date, value_str]], blank}}, errors:{ID: 原因}};值保持源字符串,空值 / "." 跳过并计数。"""
    import re
    ids = [s.strip().upper() for s in str(series or "").split(",") if s.strip()]
    bad = [s for s in ids if s not in FRED_SERIES]
    if not ids or bad:
        raise ValueError(f"只支持这些 FRED 系列:{','.join(FRED_SERIES)};收到 {','.join(bad) or '空'}")
    start = start or f"{datetime.utcnow().year - 10}-01-01"
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(start)):
        raise ValueError(f"start 要写成 YYYY-MM-DD,收到 {start}")
    out: dict = {"start": start, "series": {}, "errors": {}}
    for sid in dict.fromkeys(ids):
        try:
            text = official_get("https://fred.stlouisfed.org/graph/fredgraph.csv", params={"id": sid, "cosd": start}, ext="csv")
            rows = list(csv.reader(io.StringIO(text)))
            if not rows or rows[0][:2] != ["observation_date", sid]:
                raise RuntimeError("FRED 返回的不是这个系列的 CSV(可能是错误页或系列已停更)")
            body = [r for r in rows[1:] if r]
            pts = [[r[0], r[1]] for r in body if len(r) >= 2 and r[1].strip() not in ("", ".")]
            out["series"][sid] = {"rows": pts, "blank": len(body) - len(pts)}
        except ValueError:
            raise
        except Exception as e:  # noqa: BLE001 —— 单个系列失败只记原因
            out["errors"][sid] = str(e)[:200]
    if not out["series"]:
        raise RuntimeError("FRED 系列全部没取到:" + "; ".join(f"{k}:{v}" for k, v in out["errors"].items()))
    return out
