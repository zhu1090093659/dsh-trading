"""产业温度计(注册表第 13 层):不是关于某家公司,是关于它所在产业链上下游的硬数据。

按公司的行业 / 概念归属挂载(编排器在 risk 阶段前按 datasources/industry_tags.json 判定),risk 阶段当"产业温度计"
写进报告,与公司自己的事实 / 估值对照 = 印证或反证。零鉴权、纯标准库 + requests;每个数字带来源与读法护栏。

实现移植自 产业挖掘-Scan-claude_V2/tools/tw_monthly_sweep.py 与 price_signals.py(2026-08-23),含它们踩过的坑:
  - FinMind 402(配额 / 限流)时**部分失败必须出声**(V2 曾静默从 12 家变 4 家);资料期过期(> 2 个月)不能当"当前";
  - Vast:q 参数必须是 urlencode 后的 JSON;🔴 带浏览器 UA 会 403,urllib 默认 UA 才通(这里显式传 Python-urllib);
    撮合市场报价分散 → 取中位数;H100 等旧卡"无在租报价"是市场状态不是故障;offers 有内容却解析不出 dph_total 才是真故障;
  - Kalshi 阶梯市场三分:ticker 一个都认不出 = 格式变了(真故障);认得出但无报价 = 未开盘 / 无成交(真实状态);
  - $3/卡时是 **B200 设备折旧参考线不是完整经济保本线**(不含电力 / 机房 / 运维);前沿紧与商品松可以同时为真。
"""
from __future__ import annotations

import json
import math
import re
import statistics
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sources._http import http_get

FINMIND = "https://api.finmindtrade.com/api/v4/data"
TW_DEFAULT = "2383,6274,2368,3081"
TW_NAMES = {"2383": "台光电子·CCL(M8/M9;英伟达链 + AWS Trainium 独供)", "6274": "台燿·CCL(交换机料)",
            "2368": "金像电·PCB(ASIC / Trainium 侧)", "3081": "联亚光电·InP 外延(光芯片上游)"}
KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXB200MS&status=open&limit=200"
DEPRECIATION_LINE = 3.0  # B200 每卡时设备折旧参考线(父项目标定,勿随意改);不是完整经济保本线


class IndustryError(RuntimeError):
    pass


def _prev(y: int, m: int) -> tuple[int, int]:
    return (y - 1, 12) if m == 1 else (y, m - 1)


def _months_between(a: tuple[int, int], b: tuple[int, int]) -> int:
    return (b[0] - a[0]) * 12 + (b[1] - a[1])


TAIPEI = ZoneInfo("Asia/Taipei")
SHANGHAI = ZoneInfo("Asia/Shanghai")  # GPU 快照日期按产品用户所在时区(UTC+8)标,避免 UTC 日期在本地凌晨少一天


def _now_taipei(now: Optional[datetime]) -> datetime:
    """月营收按台湾时间判"当前月";传入的 now(UTC / aware)换算到台北。"""
    n = now or datetime.now(timezone.utc)
    return (n if n.tzinfo else n.replace(tzinfo=timezone.utc)).astimezone(TAIPEI)


def _finmind_months(ticker: str, start_date: str, now_tw: datetime) -> tuple[dict, Optional[str]]:
    r = http_get(FINMIND, params={"dataset": "TaiwanStockMonthRevenue", "data_id": ticker, "start_date": start_date}, timeout=25, ext="json")
    raw = getattr(r, "_vra_raw_ref", None)
    if r.status_code == 402:
        raise IndustryError(f"FinMind HTTP 402(配额 / 限流):{r.text[:120]}")
    if r.status_code >= 400:
        raise IndustryError(f"FinMind HTTP {r.status_code}:{r.text[:120]}")
    payload = r.json()
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise IndustryError(f"FinMind data 结构异常:{str(payload)[:120]}")
    months: dict[tuple[int, int], float] = {}
    for row in rows:
        try:
            y, m, v = int(row["revenue_year"]), int(row["revenue_month"]), float(row["revenue"])
        except (KeyError, TypeError, ValueError) as e:
            raise IndustryError(f"FinMind 行结构异常:{row!r}"[:160]) from e
        if not (2000 <= y <= 2100 and 1 <= m <= 12) or not math.isfinite(v) or v <= 0:
            raise IndustryError(f"月营收数值 / 期间无效:{row!r}"[:160])
        if (y, m) > (now_tw.year, now_tw.month):
            raise IndustryError(f"FinMind 返回未来月份 {y}-{m:02d}(契约 / 时钟异常)")
        if (y, m) in months and months[(y, m)] != v:
            raise IndustryError(f"FinMind 同一月份 {y}-{m:02d} 出现两个不同值:{months[(y, m)]} vs {v}")
        months[(y, m)] = v  # 完全相同的重复行去重
    return months, raw


def _build_company(ticker: str, months: dict, now: datetime) -> dict:
    """now 已是台北时间。缺前月 / 去年同月 / 累计基数不抛,但写进 missing(mapper 据此标 partial)。"""
    if not months:
        raise IndustryError("无月营收数据")
    y, m = max(months)
    current = months[(y, m)]
    previous = months.get(_prev(y, m))
    prior_year = months.get((y - 1, m))
    missing = []
    if previous is None:
        missing.append("前月(环比基数)")
    if prior_year is None:
        missing.append("去年同月(同比基数)")
    seq = []
    cur = (y, m)
    periods = []
    for _ in range(4):
        periods.append(cur)
        cur = _prev(*cur)
    for p in reversed(periods):
        v, b = months.get(p), months.get(_prev(*p))
        if v and b:
            seq.append(round((v / b - 1) * 100, 1))
    cum_ok = all((y, i) in months and (y - 1, i) in months for i in range(1, m + 1))
    if not cum_ok:
        missing.append("年初至今累计基数(缺月)")
    cum = sum(months[(y, i)] for i in range(1, m + 1)) if cum_ok else None
    cum_prior = sum(months[(y - 1, i)] for i in range(1, m + 1)) if cum_ok else None
    lag = _months_between((y, m), (now.year, now.month))
    return {"ticker": ticker, "name": TW_NAMES.get(ticker, ticker), "latest_period": f"{y}-{m:02d}", "lag_months": lag, "missing": missing,
            "stale": lag > 2, "revenue_twd": current, "revenue_e8twd": round(current / 1e8, 2),
            "mom_pct": round((current / previous - 1) * 100, 1) if previous else None,
            "yoy_pct": round((current / prior_year - 1) * 100, 1) if prior_year else None,
            "cum_yoy_pct": round((cum / cum_prior - 1) * 100, 1) if cum is not None and cum_prior else None,
            "mom_seq_pct": seq, "months_available": len(months)}


def _differential(companies: list) -> Optional[dict]:
    """R6.6 读法:台光(2383)同时供英伟达链与 AWS Trainium,不能单独归因 → 与金像电(2368,ASIC / Trainium 侧 PCB)差分。"""
    by = {c["ticker"]: c for c in companies}
    a, b = by.get("2383"), by.get("2368")
    if not a or not b or a.get("mom_pct") is None or b.get("mom_pct") is None:
        return None
    if a.get("latest_period") != b.get("latest_period"):
        # 🔴 两家最新月份不同(一家已公布九月、一家还停在八月):环比不是同一个月,不能放在一起归因(第四轮审计 B6)
        return {"reading": None, "period_2383": a.get("latest_period"), "period_2368": b.get("latest_period")}
    ccl, pcb = a["mom_pct"], b["mom_pct"]
    if ccl > 0 and pcb > 0:
        reading = "台光与金像电环比同增:更可能是 Trainium / ASIC 链在拉,不能单独归因英伟达链"
    elif ccl > 0 and pcb <= 0:
        reading = "台光环比增而金像电平 / 负:更像英伟达链在拉"
    elif ccl <= 0 and pcb <= 0:
        reading = "台光与金像电环比同弱:真降温信号(第一警讯)"
    else:
        reading = "台光环比转负而金像电增:ASIC 侧独强,英伟达链排产需警惕"
    return {"ccl_2383_mom_pct": ccl, "pcb_2368_mom_pct": pcb, "reading": reading, "raw_ref_2383": a.get("raw_ref"), "raw_ref_2368": b.get("raw_ref"),
            "period_2383": a.get("latest_period"), "period_2368": b.get("latest_period")}


def tw_monthly_revenue(tickers: str = TW_DEFAULT, years: int = 2, now: Optional[datetime] = None) -> dict:
    """台股法定月营收(每月 10 日前披露,滞后 ~10 天):英伟达链排产最快的硬数据。返回 {companies, errors, differential, checked_at}。
    全部失败 → 抛(信封 failed);部分失败 / 资料期过期 → 由 mapper 标 partial 出声。"""
    now_tw = _now_taipei(now)
    start = f"{now_tw.year - int(years)}-01-01"
    companies: list[dict] = []
    errors: list[dict] = []
    for t in [x.strip() for x in str(tickers).split(",") if x.strip()]:
        try:
            months, raw = _finmind_months(t, start, now_tw)
            c = _build_company(t, months, now_tw)
            c["raw_ref"] = raw
            companies.append(c)
        except Exception as e:  # noqa: BLE001 — 每家单独记错,最后再判全灭
            errors.append({"ticker": t, "error": f"{type(e).__name__}: {str(e)[:160]}"})
    if not companies:
        raise IndustryError("台系月营收全部失败:" + "; ".join(e["error"] for e in errors)[:300])
    return {"companies": companies, "errors": errors, "differential": _differential(companies),
            "checked_at": now_tw.strftime("%Y-%m-%d"), "checked_tz": "Asia/Taipei", "source": "FinMind TaiwanStockMonthRevenue(零鉴权)"}


# ——— 近一年逐日中位（500.farm 的 Prometheus 查询代理，匿名可读；exporter 开源：
# github.com/500farm/prometheus-vastai）。查询表达式与其官方面板同源。
# 🔴 `rented="no"` = 当前**可租**的挂单；`quantile(0.5, …)` 是跨机型切片（机房 / 卡数段 / 认证）
#    等权聚合 —— 这是「切片中位的中位」，**不是逐张挂单的精确中位**，文案一律称
#    「分组统计后聚合的中位」，别写成「全市场挂单中位价」。
FARM_BASE = "https://500.farm/vastai/grafana.v2/api/datasources/proxy/uid/EdgV2xcnz/api/v1"
FARM_QUERY = 'quantile(0.5, vastai_v2_ondemand_price_median_dollars{gpu_name="%s", rented="no"})'
FARM_DAYS = 365
# 🔴 这里的型号名是 **500.farm 的 label 原文**，与 Vast 现货那边的参数不是一回事
#    （那边 "H100"，这里 "H100 SXM"）。写错不会报错，只会安静地返回空序列。
FARM_GPUS = ("B200", "H100 SXM", "A100 SXM4")
FARM_SOURCE = ("500.farm 对 Vast.ai 可租挂单的逐日中位统计(按机型档位分组统计后聚合,含平台费;"
               "每日一个采样点)")
SPOT_SOURCE = "现货 = 走势曲线的最新采样点(与曲线同源同算法,两处数字严格一致);另附当前市场挂单卡数做规模读数"


def _farm_history(gpu: str) -> dict:
    """单卡近一年逐日中位价。points = [[unix**秒**, 美元价], ...] 升序。

    🔴 单位是**秒**。前端图表按秒收（它自己 ×1000）——给毫秒的话时间轴会被推到公元 5 万多年，
       表现是横轴刻度变成 58612 这种数字、曲线拉成一条直线，看着像"图坏了"。
    ⚠️ 一张卡失败不拖垮整个端点：收敛成 error 项，由 mapper 决定降级到什么程度。
    """
    now = int(time.time())
    url = FARM_BASE + "/query_range?" + urllib.parse.urlencode(
        {"query": FARM_QUERY % gpu, "start": now - FARM_DAYS * 86400, "end": now, "step": 86400})
    try:
        r = http_get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60, ext="json")
    except Exception as e:  # noqa: BLE001
        return {"gpu": gpu, "error": f"500.farm 请求失败:{type(e).__name__}: {str(e)[:120]}"}
    raw = getattr(r, "_vra_raw_ref", None)
    if r.status_code >= 400:
        return {"gpu": gpu, "error": f"500.farm HTTP {r.status_code}", "raw_ref": raw}
    try:
        body = r.json()
    except Exception as e:  # noqa: BLE001
        return {"gpu": gpu, "error": f"500.farm 响应不是 JSON:{type(e).__name__}", "raw_ref": raw}
    result = ((body or {}).get("data") or {}).get("result") or []
    if not result:
        # 统计站没有这个型号的序列 = 市场状态 / 型号名变更，不是故障
        return {"gpu": gpu, "unavailable": True, "raw_ref": raw,
                "note": "统计站暂无该型号的历史序列(市场状态或型号名变更)"}
    points, bad = [], 0
    for pair in result[0].get("values") or []:
        try:
            ts, val = pair[0], pair[1]
            price = float(val)
        except (IndexError, TypeError, ValueError):
            bad += 1
            continue
        # Prometheus 在切片空窗时会给 "NaN" / "Inf"。非有限值一旦进 JSON，
        # 下游序列化会整个失败 —— 那是"整条端点挂掉"，比少几个点糟得多。
        if not math.isfinite(price):
            bad += 1
            continue
        points.append([int(ts), round(price, 2)])
    if not points:
        return {"gpu": gpu, "error": f"返回了序列但无一个点可解析(上游契约可能已变;丢弃 {bad} 个)", "raw_ref": raw}
    return {"gpu": gpu, "n_points": len(points), "points": points, "latest": points[-1][1],
            "dropped": bad, "raw_ref": raw}


def _farm_count(gpu: str) -> Optional[dict]:
    """当前市场挂单卡数：{available: 可租, total: 全市场}。

    ⚠️ 这是**装饰性规模读数**，不是信号本体：拿不到就返回 None，界面上那一行自然缺席，
       不进 errors（为一个配角把整个温度计标成 partial，会淹掉真正的失败）。
    """
    url = FARM_BASE + "/query?" + urllib.parse.urlencode(
        {"query": 'sum by (rented) (vastai_v2_gpu_count{gpu_name="%s"})' % gpu})
    try:
        r = http_get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30, ext="json")
        if r.status_code >= 400:
            return None
        result = ((r.json() or {}).get("data") or {}).get("result") or []
    except Exception:  # noqa: BLE001
        return None
    by_rented = {}
    for item in result:
        try:
            by_rented[(item.get("metric") or {}).get("rented")] = int(float(item["value"][1]))
        except (KeyError, TypeError, ValueError):
            continue
    if "no" not in by_rented and "any" not in by_rented:
        return None
    return {"available": by_rented.get("no"), "total": by_rented.get("any")}


def _spot_from_history(hist_row: dict, count: Optional[dict]) -> dict:
    """现货 = 走势曲线的**最后一个点**。

    🔴 与曲线同源同算法 ⇒ 卡片上的数字与曲线末端**严格一致**。
       之前现货走的是另一条路（Vast bundles 当下报价），于是"卡片说 5.75、曲线末端 6.4"
       这种对不上的事既解释不清、也没法查 —— 而且那条路只覆盖两张卡，界面上就只有一张。
    ⚠️ 曲线那一行的失败 / 缺席状态**原样传染**给现货：它们本来就是同一份数据。
    """
    base = {"gpu": hist_row.get("gpu")}
    if hist_row.get("error"):
        return {**base, "error": hist_row["error"], "raw_ref": hist_row.get("raw_ref")}
    if hist_row.get("unavailable") or not hist_row.get("points"):
        return {**base, "unavailable": True, "raw_ref": hist_row.get("raw_ref"),
                "note": hist_row.get("note") or "暂无统计序列(市场状态,非故障)"}
    ts, price = hist_row["points"][-1]
    return {**base, "median_usd_per_gpu_hr": price, "asof_ts": int(ts), "raw_ref": hist_row.get("raw_ref"),
            "available_gpus": (count or {}).get("available"), "total_gpus": (count or {}).get("total"),
            "below_depreciation_line": price < DEPRECIATION_LINE}


_MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6, "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}


def _contract_month(token: str) -> Optional[str]:
    """Kalshi ticker 的合约月记号 '26SEP' → '2026-09';认不出 → None。"""
    mm = re.fullmatch(r"(\d{2})([A-Z]{3})", token or "")  # 严格整体匹配:'26SEPT' / '26SEPXYZ' 不算合约月(格式变了要出声)
    if not mm or mm.group(2) not in _MONTHS:
        return None
    return f"20{mm.group(1)}-{_MONTHS[mm.group(2)]:02d}"


def _kalshi_forward() -> dict:
    """同一 series 下可能同时有多个合约月:按合约月分组,只用**最近的一个月**(不跨月混排),并把该月写进结果。"""
    try:
        r = http_get(KALSHI_API, timeout=40, ext="json")
    except Exception as e:  # noqa: BLE001
        return {"error": f"Kalshi 请求失败:{type(e).__name__}: {str(e)[:120]}"}
    raw = getattr(r, "_vra_raw_ref", None)
    if r.status_code >= 400:
        return {"error": f"Kalshi HTTP {r.status_code}", "raw_ref": raw}
    try:
        body = r.json()
    except Exception as e:  # noqa: BLE001
        return {"error": f"Kalshi 响应不是 JSON:{type(e).__name__}", "raw_ref": raw}
    ms = body.get("markets") if isinstance(body, dict) else None
    if not isinstance(ms, list):
        return {"error": "Kalshi 响应缺少 markets 列表(契约可能已变)", "raw_ref": raw}
    by_month: dict[str, list] = {}
    parseable = 0
    for m in ms:
        if not isinstance(m, dict):
            continue
        t = str(m.get("ticker", ""))
        mm = re.search(r"-(\d+\.?\d*)$", t)
        parts = t.split("-")
        month = _contract_month(parts[1]) if len(parts) >= 3 else None
        if not mm or not month:
            continue
        parseable += 1
        bid, ask = m.get("yes_bid"), m.get("yes_ask")
        px = (bid + ask) / 2 if isinstance(bid, (int, float)) and isinstance(ask, (int, float)) else m.get("last_price")
        if not isinstance(px, (int, float)):
            continue
        by_month.setdefault(month, []).append({"strike": float(mm.group(1)), "p_above": px / 100})
    if not by_month:
        if ms and not parseable:
            return {"error": f"返回 {len(ms)} 个市场但无一可解析为档位 / 合约月(ticker 格式可能已变)", "raw_ref": raw}
        return {"unavailable": True, "n_rungs": 0, "note": "阶梯市场无有效报价(未开盘或无成交)", "raw_ref": raw}
    month = min(by_month)  # 最近的合约月
    rungs = sorted(by_month[month], key=lambda x: x["strike"])
    low = rungs[0]
    return {"contract_month": month, "n_rungs": len(rungs), "lowest_strike": low["strike"], "p_below_lowest": round(1 - low["p_above"], 3),
            "ladder": [{"strike": x["strike"], "p_above": round(x["p_above"], 3)} for x in rungs[:6]], "other_months": sorted(k for k in by_month if k != month), "raw_ref": raw}


def gpu_rent_thermometer(gpus: str = "", now: Optional[datetime] = None) -> dict:  # noqa: ARG001
    """GPU 租金温度计:近一年逐日曲线 + 现货(= 曲线最新点)+ 远期(Kalshi KXB200MS → P(月均 < 最低档))。

    ⚠️ `gpus` 参数**已不再起作用**:型号由 `FARM_GPUS` 定(它们是统计站的 label 原文,
       写错不会报错、只会安静地返回空序列)。保留形参只为注册表里旧的 args 不至于报未知参数。
    现货与远期都拿不到 → 抛;单边失败由 mapper 标 partial。
    """
    n = now or datetime.now(timezone.utc)
    now = (n if n.tzinfo else n.replace(tzinfo=timezone.utc)).astimezone(SHANGHAI)
    # 曲线先取，现货由它派生 —— 两处数字必须严格一致（见 _spot_from_history）
    history = [_farm_history(g) for g in FARM_GPUS]
    spot = [_spot_from_history(h, _farm_count(h["gpu"])) for h in history]
    forward = _kalshi_forward()
    # 只有"现货每张卡都是 error 且远期也 error"才算全部失败;"无在租报价"是市场状态(有效响应),不算失败
    spot_all_failed = bool(spot) and all("error" in s for s in spot)
    if spot_all_failed and "error" in forward:
        raise IndustryError("GPU 租金现货与远期全部失败:" + "; ".join(str(s.get("error")) for s in spot) + "; " + str(forward.get("error")))
    return {"spot": spot, "forward": forward, "history": history, "history_days": FARM_DAYS, "history_source": FARM_SOURCE,
            "spot_source": SPOT_SOURCE,
            "depreciation_line_usd": DEPRECIATION_LINE, "checked_at": now.strftime("%Y-%m-%d"), "checked_tz": "Asia/Shanghai",
            "source": "500.farm 统计站(零鉴权)+ Kalshi trade-api v2(零鉴权)"}
