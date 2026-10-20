"""事件回看的 **JSON 入口**：stdin 进 ``{symbol, kind}``，stdout 出这只股票历史上每次同类事件前后的超额收益。

给「个股」页用，不需要模型。选一类事件，把这只股票历史上的每一次排出来，看事件前 5 个交易日到后 20 个交易日、
相对对照指数的累计超额收益（每个交易日这只股票的涨跌减去指数当天的涨跌，再累加）：

- A 股：业绩预告 / 重要股东增持 / 重要股东减持 / 回购方案 / 机构调研 / 龙虎榜上榜 / 限售解禁，对照沪深300指数；
- 港股：业绩公布（港交所披露易的末期 / 中期 / 季度业绩公告），对照盈富基金；
- 美股：业绩公布（SEC 8-K Item 2.02），对照 SPY。设置页填了 SEC 联系方式就用 SEC 官方全文检索（大银行也能取全），
  没填或 SEC 这次取不到就用东财转载的申报（大银行翻不到早年的）。

2026-10-09 实测各类事件能取到多少（5 只股票）：业绩预告最早到 2004 年、每只 1–66 条；股东增减持最早到 2009 年、
每只 7–47 条。回购方案每只 0–6 个（首次公告日和巨潮公告日逐个对过）；龙虎榜全部历史（中际旭创 2012 年起 49 条）；
限售解禁全部批次每只 0–15 批（多数是小额的股权激励，按占总股本分大小两组）；机构调研东财只留近一年左右。
这几类多数只有几次，不到 8 次只列逐次结果。港股 00700 业绩公告 2007 年起 79 次；美股 AAPL / MSFT / NVDA 的 8-K 2.02
2013 年起各 50 多次（东财）；SEC 全文检索苹果 2004 年起 94 次、摩根大通 2015 年起 47 次。港美股日线只能取约 10 年，更早的事件进缺口。
东财那条路上，美股大银行每年上千份债券申报，翻不到早年的业绩 8-K；
外国公司（ADR）用 6-K 报业绩，取不到；港美股的股东增减持这一版不做（美股内幕交易免费来源只有近两年）。

🔴 事件少于 8 次就**只列逐次结果，不给平均值** —— 几次的平均说明不了什么。
🔴 窗口里有停牌的照列，但**不进平均**（复牌那天的涨跌会被算进窗口）；最近的事件还没满 20 个交易日的，
   只进已经有的那几档。
🔴 只描述这只股票过去的情况，不预测这一次，不给买卖提示。

用法::

    echo '{"symbol":"600519","kind":"earnings_forecast"}' | python -m backtest.event_study
"""

from __future__ import annotations

import json
import math
import os
import statistics
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
from zoneinfo import ZoneInfo

from backtest.loader import INDEX_BENCHMARKS, LoaderError, _a_lookup, _run_fetch, bare, canonical_code, market_of, sec_contact, yahoo_daily_earliest
from backtest.scenario_replay import PRICE_NOTES, _benchmark, _closes, source_names
from backtest.stdio_utf8 import force_utf8_stdio

#: 窗口：事件前 PRE 个交易日到后 POST 个交易日（第 0 天是事件日）
PRE = 5
POST = 20
#: 少于这么多次就不给平均值
MIN_EVENTS = 8
#: 几档累计超额收益：(键, 起, 止, 名字)
HORIZONS: Tuple[Tuple[str, int, int, str], ...] = (
    ("pre", -PRE, -1, "事件前 5 日"),
    ("d0_1", 0, 1, "第 0–1 日"),
    ("d0_5", 0, 5, "第 0–5 日"),
    ("d0_20", 0, POST, "第 0–20 日"),
)
#: 事件明细最多取这么多条（端点上限）；取满说明更早的可能没取到，记进缺口
EVENT_LIMIT = 5000
#: 取价格时在最早的事件前多取这么多天（要凑够事件前 6 个交易日，长假也够）
LEAD_DAYS = 30

A_SHARE = ("a_share",)
HK_US = ("hk_equity", "us_equity")
KINDS: Dict[str, Dict[str, Any]] = {
    "earnings_forecast": {"label": "业绩预告", "endpoint": {"a_share": "earnings_forecast"}, "markets": A_SHARE},
    "holder_increase": {"label": "重要股东增持", "endpoint": {"a_share": "holder_trades"}, "direction": "增持", "markets": A_SHARE},
    "holder_decrease": {"label": "重要股东减持", "endpoint": {"a_share": "holder_trades"}, "direction": "减持", "markets": A_SHARE},
    "earnings_release": {"label": "业绩公布", "endpoint": {"hk_equity": "hkex_results_dates", "us_equity": "us_earnings_8k_dates"}, "markets": HK_US},
    "buyback": {"label": "回购方案", "endpoint": {"a_share": "em_buyback_history"}, "markets": A_SHARE},
    "survey": {"label": "机构调研", "endpoint": {"a_share": "institution_survey"}, "markets": A_SHARE},
    "dragon_tiger": {"label": "龙虎榜上榜", "endpoint": {"a_share": "em_dragon_tiger_history"}, "markets": A_SHARE},
    "lockup": {"label": "限售解禁", "endpoint": {"a_share": "em_lockup_history"}, "markets": A_SHARE},
}
MARKET_NAMES = {"a_share": "A 股", "hk_equity": "港股", "us_equity": "美股"}
#: 事件端点的参数和超时（秒）；没列的是 A 股事件表，按 EVENT_LIMIT 取明细
#: 美股要从新到旧逐页翻申报（东财限流约 1.4 秒一页、最多 30 页），给足时间
FETCH_PLAN: Dict[str, Tuple[Dict[str, Any], int]] = {
    "hkex_results_dates": ({}, 60),
    "us_earnings_8k_dates": ({"max_pages": 30}, 150),
    "sec_earnings_8k_dates": ({}, 60),
}
#: 美股业绩 8-K：填了 SEC 联系方式先用 SEC 官方全文检索，没填或这次没取到用东财转载
US_SEC_ENDPOINT, US_EM_ENDPOINT = "sec_earnings_8k_dates", "us_earnings_8k_dates"
SEC_HINT = "在「接入 AI」页填上 SEC 联系方式（英文姓名和邮箱），美股业绩日期会改用 SEC 官方数据，大银行这类也能取全"
#: 港股收市时间（香港时间）：这之后发布的业绩，市场反应从下一个交易日开始
HK_CLOSE = "16:00"

#: 业绩预告按预告类型分两组（只按东财给的类型字面分，不另判）；续盈 / 续亏 / 不确定 不归入任何一组
FORECAST_UP = ("预增", "略增", "扭亏", "减亏")
FORECAST_DOWN = ("预减", "略减", "首亏", "增亏")
#: 限售解禁按实际可流通股数占总股本分两组的线（%）
LOCKUP_LARGE_PCT = 1.0
#: 各类事件的分组（键 → 名字）；「全部」每类都有。分组规则写死、写在名字里
GROUPS: Dict[str, Dict[str, str]] = {
    "earnings_forecast": {"up": f"预告向好（{'、'.join(FORECAST_UP)}）", "down": f"预告向差（{'、'.join(FORECAST_DOWN)}）"},
    "dragon_tiger": {"buy": "龙虎榜净买入（席位合计买入多于卖出）", "sell": "龙虎榜净卖出（席位合计卖出多于买入）"},
    "lockup": {"large": f"较大的解禁（实际可流通股数占总股本 ≥ {LOCKUP_LARGE_PCT:g}%）", "small": f"较小的解禁（不到 {LOCKUP_LARGE_PCT:g}%）"},
}
GROUP_LABELS = {"all": "全部", **{k: v for g in GROUPS.values() for k, v in g.items()}}
PERIOD_NAMES = {"03-31": "一季报", "06-30": "中报", "09-30": "三季报", "12-31": "年报"}
NET_PROFIT = "归属于上市公司股东的净利润"


class EventError(ValueError):
    """整次回看做不了（入参不对、事件没取到）—— 作为 ``ok: false`` 的原因原样给界面。单次事件的问题进缺口。"""


_MARKET_TZ = {"a_share": "Asia/Shanghai", "hk_equity": "Asia/Hong_Kong", "us_equity": "America/New_York"}


def _market_today(market: str) -> date:
    """这只股票交易所那边的今天：本机时区不同时，解禁「已到 / 未到」和取价截止日不差一天。"""
    return datetime.now(ZoneInfo(_MARKET_TZ.get(market, "Asia/Shanghai"))).date()


def _r(v: Optional[float], digits: int = 6) -> Optional[float]:
    return round(float(v), digits) if v is not None and math.isfinite(float(v)) else None


def _d(ts: Any) -> str:
    return str(pd.Timestamp(ts).date())


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def _iso(v: Any) -> Optional[str]:
    if not isinstance(v, str):
        return None
    s = v.strip()[:10]
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        return None


def _code(raw: Any) -> str:
    """A 股个股（沪深）、港股、美股。A 股的 ETF / 指数 / 可转债 / 北交所直接说明做不了。"""
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 20:
        raise EventError("要给一只股票的代码，如 600519、00700.HK、AAPL")
    try:
        code = canonical_code(raw)
        market = market_of(code)
    except LoaderError as exc:
        raise EventError(f"代码认不出：{exc}") from exc
    if market != "a_share":
        return code
    ex, is_stock = _a_lookup(bare(code))
    if not is_stock:
        raise EventError(f"{code} 不是个股（ETF / 指数 / 可转债），没有这几类事件")
    if ex == "BJ":
        raise EventError("北交所的日线这一版取不到，算不了事件前后的涨跌")
    return code


# ── 事件 ──

def _event_rows(endpoint: str, code: str, out_dir: Path) -> Tuple[List[Dict[str, Any]], str, Optional[str]]:
    """跑一次事件端点，读落盘的整份明细。返回 (行, 来源, 明细没取全的说明)。端点失败 → EventError（整次做不了）。

    🔴 这只股票没有这类事件、或取满 limit / 翻页到上限，端点都记 partial（退出码 2），这几种都不是失败。
    A 股事件表取满 limit 由调用方按行数判断；港美股的业绩发布日在明细里写明有没有取全（truncated）。"""
    args, timeout = FETCH_PLAN.get(endpoint, ({"limit": EVENT_LIMIT}, 60))
    try:
        env = _run_fetch(endpoint, bare(code), args, out_dir, sys.executable, timeout, allow_partial=True)
    except LoaderError as exc:
        raise EventError(f"事件没取到：{exc}") from exc
    if env.get("status") == "failed":
        errs = [str(e["error"]) for e in (env.get("errors") or []) if isinstance(e, dict) and isinstance(e.get("error"), str)]
        raise EventError(f"事件没取到：{'；'.join(errs) or '来源没有说明原因'}")
    refs = [r for r in ((env.get("extra") or {}).get("raw_files") or []) if Path(str(r)).name.startswith("extracted_")]
    if not refs:
        return [], str(env.get("primary_source") or ""), None     # 端点说没有这类事件时不落明细
    try:
        payload = json.loads((out_dir / refs[0]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise EventError(f"事件明细读不了：{exc}") from exc
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise EventError("事件明细的格式看不懂（没有 rows）")
    cut = payload.get("truncated")
    if cut is True and payload.get("endpoint") == US_SEC_ENDPOINT:
        cut_note: Optional[str] = f"SEC 全文检索命中 {payload.get('total')} 条（含附件和更正版），只取了前 {payload.get('pages')} 页（每页 100 条），其余的没取到"
    elif cut is True:
        cut_note = f"只取到最近 {payload.get('pages')} 页申报（每页 100 份），更早的业绩申报没取到"
    elif isinstance(cut, list) and cut:
        cut_note = f"{'、'.join(str(c) for c in cut)}超过一次能取的条数，更早的没取到"
    else:
        cut_note = None
    return [r for r in rows if isinstance(r, dict)], str(env.get("primary_source") or ""), cut_note


def _sec_contact_set() -> bool:
    """设置页（或环境变量）填了 SEC 联系方式：后台会把它作为 VRA_SEC_CONTACT 交给取数进程。格式不对的当没填。"""
    return bool(sec_contact())


def _us_release_rows(code: str, out_dir: Path) -> Tuple[List[Dict[str, Any]], str, Optional[str], Optional[str]]:
    """美股业绩 8-K：返回 (行, 来源, 没取全的说明, 来源说明)。来源说明进结果的说明，告诉人这次用的是哪条路。

    🔴 SEC 失败只退回东财，不算整次失败；退回时原因照写（错误消息在取数进程里已经脱敏，不含填的姓名邮箱）。"""
    if _sec_contact_set():
        try:
            rows, src, cut = _event_rows(US_SEC_ENDPOINT, code, out_dir)
            return rows, src, cut, None
        except EventError as exc:
            why = str(exc).split("：")[-1].strip()[:160] or "没有说明原因"
            rows, src, cut = _event_rows(US_EM_ENDPOINT, code, out_dir / "fallback")
            return rows, src, cut, f"SEC 这次没取到（{why}），改用东财转载的申报"
    rows, src, cut = _event_rows(US_EM_ENDPOINT, code, out_dir)
    # 只在东财翻不完时提示：东财翻完了还没有的（多是 ADR，用 6-K 报业绩），换 SEC 也查不到
    return rows, src, cut, (SEC_HINT if cut else None)


def _pct_range(lo: Optional[float], hi: Optional[float]) -> str:
    sign = lambda v: f"{v:+.2f}%"  # noqa: E731
    if lo is None and hi is None:
        return ""
    if lo is None or hi is None or lo == hi:
        return f"同比 {sign(lo if hi is None else hi)}"
    return f"同比 {sign(lo)} ~ {sign(hi)}"


def _forecast_events(rows: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """业绩预告 → 每个公告日一次事件（同一天的净利润、扣非等几条算一次）。返回 (事件, 没有公告日的条数)。"""
    by_day: Dict[str, List[Dict[str, Any]]] = {}
    bad = 0
    for r in rows:
        d = _iso(r.get("notice_date"))
        if d is None:
            bad += 1
            continue
        by_day.setdefault(d, []).append(r)
    out = []
    for d, rs in by_day.items():
        net = [r for r in rs if r.get("indicator") == NET_PROFIT]
        main = net or rs           # 有归母净利润那条就按它定类型，没有才看全部几条
        types = sorted({str(r.get("forecast_type") or "").strip() for r in main} - {""})
        dirs = {"up" if t in FORECAST_UP else "down" if t in FORECAST_DOWN else "other" for t in types}
        period = _iso(main[0].get("report_date"))
        label = f"{period[:4]} 年{PERIOD_NAMES.get(period[5:], period)}预告" if period else "业绩预告"
        detail = "、".join(types) or "类型没写"
        change = _pct_range(_num(net[0].get("change_pct_lower")), _num(net[0].get("change_pct_upper"))) if net else ""
        if change:
            detail += f"，归母净利润{change}"
        out.append({"date": d, "label": label, "detail": detail, "direction": dirs.pop() if len(dirs) == 1 else "other"})
    return out, bad


def _holder_events(rows: List[Dict[str, Any]], direction: str) -> Tuple[List[Dict[str, Any]], int]:
    """股东增减持 → 这个方向每个公告日一次事件（同一天公告的几位股东合并）。"""
    by_day: Dict[str, List[Dict[str, Any]]] = {}
    bad = 0
    for r in rows:
        if r.get("direction") != direction:
            continue
        d = _iso(r.get("notice_date"))
        if d is None:
            bad += 1
            continue
        by_day.setdefault(d, []).append(r)
    out = []
    for d, rs in by_day.items():
        holders = list(dict.fromkeys(str(r.get("holder") or "").strip() for r in rs if r.get("holder")))
        who = holders[0][:24] if len(holders) == 1 else f"{len(holders) or len(rs)} 位股东"
        shares = [_num(r.get("change_shares_10k")) for r in rs]
        pcts = [_num(r.get("change_pct_total")) for r in rs]
        parts = [who]
        if shares and all(v is not None for v in shares):
            parts.append(f"合计 {abs(sum(shares)):,.2f} 万股")   # type: ignore[arg-type]
        if pcts and all(v is not None for v in pcts):
            parts.append(f"占总股本 {abs(sum(pcts)):.2f}%")      # type: ignore[arg-type]
        channels = sorted({str(r.get("channel") or "").strip() for r in rs} - {""})
        if channels:
            parts.append("、".join(channels))
        out.append({"date": d, "label": direction, "detail": "，".join(parts), "direction": None})
    return out, bad


def _yi(v: float) -> str:
    """元 → 「x.xx 亿元」"""
    return f"{v / 1e8:,.2f} 亿元"


def _by_day(rows: List[Dict[str, Any]], key: str) -> Tuple[Dict[str, List[Dict[str, Any]]], int]:
    """按日期列归并；没有日期的数一下（进缺口）。"""
    by: Dict[str, List[Dict[str, Any]]] = {}
    bad = 0
    for r in rows:
        d = _iso(r.get(key))
        if d is None:
            bad += 1
            continue
        by.setdefault(d, []).append(r)
    return by, bad


def _buyback_events(rows: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """回购方案 → 每个首次公告日一次事件（同一天公告的几个方案合并）。金额写方案的上下限和已回购的，不写目的原文。"""
    by, bad = _by_day(rows, "first_notice")
    out = []
    for d, rs in by.items():
        parts = []
        for r in rs:
            lo, hi, done = _num(r.get("amount_lower")), _num(r.get("amount_upper")), _num(r.get("done_amount"))
            amt = (f"金额 {lo / 1e8:,.2f}–{_yi(hi)}" if lo is not None and hi is not None and lo != hi
                   else f"金额上限 {_yi(hi)}" if hi is not None else "方案没写金额")
            prog = str(r.get("progress") or "").strip()
            parts.append("，".join(x for x in (amt, prog, f"已回购 {_yi(done)}" if done is not None and done > 0 else "") if x))
        out.append({"date": d, "label": "回购方案首次公告", "detail": "；".join(parts), "direction": None})
    return out, bad


def _survey_events(rows: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """机构调研 → 每个公告日一次事件（同一天公告的几次调研合并）。按公告日算：接待日通常早几天，那几天外界还不知道。"""
    by, bad = _by_day(rows, "notice_date")
    out = []
    for d, rs in by.items():
        counts = [_num(r.get("org_count")) for r in rs]
        orgs = f"{int(sum(counts)):,} 家机构" if counts and all(c is not None for c in counts) else "机构家数没写全"   # type: ignore[arg-type]
        if len(rs) == 1:
            r = rs[0]
            seen = _iso(r.get("survey_date"))
            way = str(r.get("survey_way") or "").strip()[:20]
            detail = "，".join(x for x in (f"接待日 {seen}" if seen else "", orgs, way) if x)
        else:
            detail = f"{len(rs)} 次调研，合计 {orgs}"
        out.append({"date": d, "label": "机构调研记录公告", "detail": detail, "direction": None})
    return out, bad


def _dragon_events(rows: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """龙虎榜 → 每个上榜日一次事件（同一天因几条理由上榜算一次）。龙虎榜收盘后才公布，第 0 天从下一个交易日起算（day0_from）。

    按席位净额分组：这一天每条理由的净额都为正 → 净买入，都为负 → 净卖出，有正有负或没写 → 不归组。
    「3 日累计偏离」这类理由的净额是那几天的合计，和当天那条不是同一个口径，所以几条不相加、分别写。"""
    by, bad = _by_day(rows, "date")
    out = []
    for d, rs in by.items():
        reasons = list(dict.fromkeys(str(r.get("reason") or "").strip() for r in rs if r.get("reason")))   # 交易所原文，不截断
        all_nets = [_num(r.get("net_buy")) for r in rs]
        nets = [n for n in all_nets if n is not None]
        unknown = len(all_nets) - len(nets)
        chg = next((c for c in (_num(r.get("change_pct")) for r in rs) if c is not None), None)
        # 有一条没写净额就不归组：只看写了的那几条，会把部分信息当成全部（Codex 审计 2026-10-09 D11）
        direction = ("other" if unknown or not nets else "buy" if all(n > 0 for n in nets)
                     else "sell" if all(n < 0 for n in nets) else "other")
        uniq = list(dict.fromkeys(nets))
        net_txt = (f"席位净额 {uniq[0] / 1e8:+,.2f} 亿元" if len(uniq) == 1
                   else f"各条理由的席位净额 {' / '.join(f'{n / 1e8:+,.2f}' for n in uniq)} 亿元" if uniq else "席位净额没写")
        if uniq and unknown:
            net_txt += f"（另有 {unknown} 条理由没写净额，不归组）"
        detail = "；".join(x for x in (f"当天 {chg:+.2f}%" if chg is not None else "", "、".join(reasons), net_txt) if x)
        out.append({"date": d, "label": "上榜", "detail": detail, "direction": direction,
                    "day0_from": (date.fromisoformat(d) + timedelta(days=1)).isoformat()})
    return out, bad


def _lockup_events(rows: List[Dict[str, Any]], today: date) -> Tuple[List[Dict[str, Any]], int, List[Dict[str, Any]]]:
    """限售解禁 → 每个解禁日一次事件（同一天的几批合并）。返回 (已经到了的事件, 没有日期的条数, 已经排期还没到的)。

    按实际可流通股数占总股本分大小两组（LOCKUP_LARGE_PCT）；占比没写的不归组。"""
    by, bad = _by_day(rows, "date")
    past: List[Dict[str, Any]] = []
    upcoming: List[Dict[str, Any]] = []
    for d, rs in by.items():
        types = list(dict.fromkeys(str(r.get("type") or "").strip() for r in rs if r.get("type")))
        shares = [_num(r.get("able_shares_10k")) for r in rs]
        ratios = [_num(r.get("total_ratio_pct")) for r in rs]
        parts = ["、".join(types) or "类型没写"]
        if shares and all(s is not None for s in shares):
            tot = sum(shares)                                                    # type: ignore[arg-type]
            parts.append(f"实际可流通 {tot / 1e4:,.2f} 亿股" if tot >= 1e4 else f"实际可流通 {tot:,.0f} 万股")
        ratio = sum(ratios) if ratios and all(x is not None for x in ratios) else None   # type: ignore[arg-type]
        if ratio is not None:
            parts.append(f"占总股本 {ratio:.2f}%")
        ev = {"date": d, "label": "解禁", "detail": "，".join(parts),
              "direction": "other" if ratio is None else "large" if ratio >= LOCKUP_LARGE_PCT else "small"}
        (past if date.fromisoformat(d) <= today else upcoming).append(ev)
    upcoming.sort(key=lambda e: e["date"])
    return past, bad, [{k: e[k] for k in ("date", "label", "detail")} for e in upcoming]


def _release_events(rows: List[Dict[str, Any]], market: str) -> Tuple[List[Dict[str, Any]], int]:
    """业绩公布 → 每个发布日一次事件（同一天的几份合并）。返回 (事件, 没有日期的条数)。

    港股按港交所给的发布时间定第 0 天：当天最早一份在收市（16:00）之后才发布的，从下一个交易日算起（day0_from）。
    美股只有 8-K 的美东提交日、没有可靠的提交时刻，按提交日算。
    🔴 公告标题是源原文，不往结果里带（结果可能交给 AI），只写分类和时间。"""
    by_day: Dict[str, List[Dict[str, Any]]] = {}
    bad = 0
    for r in rows:
        d = _iso(r.get("date"))
        if d is None:
            bad += 1
            continue
        by_day.setdefault(d, []).append(r)
    out = []
    for d, rs in by_day.items():
        if market == "hk_equity":
            times = sorted(t for t in (r.get("time") for r in rs) if isinstance(t, str) and len(t) == 5 and t[2] == ":")
            cats = list(dict.fromkeys(str(r.get("category") or "").strip() for r in rs if r.get("category")))
            after = bool(times) and times[0] >= HK_CLOSE
            label = "、".join(cats) or "业绩公告"
            detail = (f"港交所 {times[0]} 发布" if times else "发布时间不详") + ("，收市后发布，从下一个交易日算起" if after else "")
            ev: Dict[str, Any] = {"date": d, "label": label, "detail": detail, "direction": None}
            if after:
                ev["day0_from"] = (date.fromisoformat(d) + timedelta(days=1)).isoformat()
        else:
            ev = {"date": d, "label": "业绩 8-K", "detail": f"SEC 8-K Item 2.02，美东 {d} 提交" + (f"（同一天 {len(rs)} 份）" if len(rs) > 1 else ""),
                  "direction": None}
        out.append(ev)
    return out, bad


# ── 超额收益 ──

def _window(day: pd.Timestamp, cal: pd.DatetimeIndex, stock: pd.Series, index: pd.Series, bench_label: str = INDEX_BENCHMARKS["a_share"].label
            ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """一次事件的逐日超额收益。cal 是对照指数的交易日。算不了就给原因（进缺口）。"""
    k = int(cal.searchsorted(day))      # 第 0 天：事件日当天或之后的第一个交易日
    if k >= len(cal):
        return None, "事件之后还没有交易日的价格"
    base = k - PRE - 1
    if base < 0:
        return None, f"对照指数在事件前不够 {PRE + 1} 个交易日（{bench_label}从 {_d(cal[0])} 才有）"
    days = cal[base:min(k + POST, len(cal) - 1) + 1]
    if stock.loc[:days[0]].empty:
        first = f"（最早的价格在 {_d(stock.index[0])}）" if len(stock) else ""
        return None, f"事件前第 {PRE + 1} 个交易日还没有价格{first}，可能当时还没上市"
    s = stock.reindex(stock.index.union(days)).ffill().reindex(days)
    own = set(stock.index)
    halted = sum(1 for d in days if d not in own)      # 没有价格的交易日（多半停牌），含起算那天
    # 指数的交易日就是 cal，股票起算那天之前有价格、之后前向填充 ⇒ 这里不会有空值
    ar = (s.pct_change() - index.reindex(days).pct_change()).iloc[1:]
    offs = list(range(-PRE, -PRE + len(ar)))
    car = dict(zip(offs, ar.cumsum().tolist()))
    vals = dict(zip(offs, ar.tolist()))

    def span(a: int, b: int) -> Optional[float]:
        return _r(sum(vals[o] for o in range(a, b + 1))) if b in vals else None

    return {
        "day0": _d(cal[k]),
        **{key: span(a, b) for key, a, b, _ in HORIZONS},
        "halted_days": halted,
        "days_after": len(ar) - PRE - 1,           # 第 0 天之后已经有几个交易日
        "path": [_r(car[o]) for o in offs],         # 从事件前第 5 日起累计
    }, None


def _stats(vals: List[float]) -> Dict[str, Any]:
    return {
        "n": len(vals), "mean": _r(statistics.fmean(vals)), "median": _r(statistics.median(vals)),
        "positive_share": _r(sum(1 for v in vals if v > 0) / len(vals), 4),
    }


def _summary(events: List[Dict[str, Any]], keys: List[str], labels: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    """每组每档：停牌的不算、没满那一档的不算；少于 MIN_EVENTS 次不给平均。"""
    out = []
    for g in keys:
        members = [e for e in events if g == "all" or e.get("direction") == g]
        if g != "all" and not members:
            continue            # 没有这类预告就不列这一组
        clean = [e for e in members if e["halted_days"] == 0]
        hz: Dict[str, Any] = {}
        for key, _, _, _ in HORIZONS:
            vals = [e[key] for e in clean if e[key] is not None]
            hz[key] = _stats(vals) if len(vals) >= MIN_EVENTS else {"n": len(vals), "mean": None, "median": None, "positive_share": None}
        n_max = max(h["n"] for h in hz.values()) if hz else 0
        note = None
        if n_max < MIN_EVENTS:
            note = f"能算的只有 {n_max} 次（不到 {MIN_EVENTS} 次），不给平均，只看上面逐次的结果"
        elif len(clean) < len(members):
            note = f"窗口里有停牌的 {len(members) - len(clean)} 次没算进来"
        out.append({"key": g, "label": (labels or GROUP_LABELS).get(g, g), "events": len(members), "horizons": hz, "note": note})
    return out


def _mean_path(events: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """窗口完整、没停牌的事件的平均 / 中位累计超额收益路径；不到 MIN_EVENTS 次不给。"""
    full = [e["path"] for e in events if e["halted_days"] == 0 and len(e["path"]) == PRE + 1 + POST]
    if len(full) < MIN_EVENTS:
        return None
    cols = list(zip(*full))
    return {"offsets": list(range(-PRE, POST + 1)), "n": len(full),
            "mean": [_r(statistics.fmean(c)) for c in cols], "median": [_r(statistics.median(c)) for c in cols]}


def build(req: Dict[str, Any], out_dir: Path) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """返回 (结果, 平均路径)。平均路径只给界面画图。"""
    code = _code(req.get("symbol"))
    market = market_of(code)
    mname = MARKET_NAMES[market]
    kind = req.get("kind")
    if kind not in KINDS:
        names = "、".join(f"{k}（{v['label']}）" for k, v in KINDS.items() if market in v["markets"])
        raise EventError(f"{mname}的事件类型只认这几种：{names}")
    spec = KINDS[kind]
    if market not in spec["markets"]:
        if market == "a_share":
            raise EventError(f"{spec['label']}这一版只做港股和美股；A 股可以看业绩预告（earnings_forecast）")
        raise EventError(f"{spec['label']}只做 A 股（只有 A 股的来源）；{mname}这一版做业绩公布（earnings_release）")
    bm = INDEX_BENCHMARKS[market]
    src_note: Optional[str] = None
    if market == "us_equity" and kind == "earnings_release":
        rows, ev_source, cut_note, src_note = _us_release_rows(code, out_dir / "events")
    else:
        rows, ev_source, cut_note = _event_rows(spec["endpoint"][market], code, out_dir / "events")
    upcoming: List[Dict[str, Any]] = []
    if kind == "earnings_forecast":
        raw_events, bad = _forecast_events(rows)
    elif kind == "earnings_release":
        raw_events, bad = _release_events(rows, market)
    elif kind == "buyback":
        raw_events, bad = _buyback_events(rows)
    elif kind == "survey":
        raw_events, bad = _survey_events(rows)
    elif kind == "dragon_tiger":
        raw_events, bad = _dragon_events(rows)
    elif kind == "lockup":
        raw_events, bad, upcoming = _lockup_events(rows, _market_today(market))
    else:
        raw_events, bad = _holder_events(rows, spec["direction"])
    raw_events.sort(key=lambda e: e["date"])

    result: Dict[str, Any] = {
        "symbol": code, "market": market, "kind": kind, "kind_label": spec["label"], "benchmark_label": bm.label,
        "window": {"pre": PRE, "post": POST}, "min_events": MIN_EVENTS,
        "horizons": [{"key": k, "from": a, "to": b, "label": lab} for k, a, b, lab in HORIZONS],
        "events": [], "gaps": [], "summary": [], "notes": [], "sources": source_names([ev_source]),
    }
    if kind == "lockup":
        result["upcoming"] = upcoming          # 已经排期、还没到的解禁：只列出来，不算涨跌
    if bad:
        what = {"dragon_tiger": "上榜日", "lockup": "解禁日"}.get(kind, "公告日")
        result["gaps"].append({"date": None, "label": spec["label"], "reason": f"有 {bad} 条没有{what}，没算进来"})
    if market == "a_share" and len(rows) >= EVENT_LIMIT:
        result["gaps"].append({"date": None, "label": spec["label"],
                               "reason": f"明细取到上限 {EVENT_LIMIT} 条，更早的{spec['label']}可能没取到"})
    if cut_note:
        result["gaps"].append({"date": None, "label": spec["label"], "reason": cut_note})
    if market != "a_share" and raw_events:
        # 港美股日线只能取约 10 年（Yahoo 更长的窗口只给月线）：更早的事件凑不出窗口，合成一条缺口
        first_ok = yahoo_daily_earliest() + timedelta(days=LEAD_DAYS + 1)
        early = [e for e in raw_events if date.fromisoformat(e["date"]) < first_ok]
        if early:
            result["gaps"].append({"date": None, "label": spec["label"],
                                   "reason": f"{mname}日线只能取到约 10 年前（{first_ok.isoformat()} 之前的事件凑不齐事件前的价格），更早的 {len(early)} 次没算"})
            raw_events = raw_events[len(early):]
    if not raw_events:
        none = f"这只股票没查到{spec['label']}" + ("（只算有日期的）" if bad else "")
        if upcoming:
            none = f"这只股票过去没有{spec['label']}，只有已经排期、还没到的"
        if market == "us_equity" and not rows and not cut_note:
            none += "：美股按 SEC 8-K 的 Item 2.02 找，外国公司（ADR）用 6-K 报业绩，这一版取不到"
        if result["gaps"] and rows:
            none = f"能算的{spec['label']}一次也没有，原因见缺口"
        result["notes"] = [none] + ([src_note] if src_note else [])
        return result, None

    lo = (date.fromisoformat(raw_events[0]["date"]) - timedelta(days=LEAD_DAYS)).isoformat()
    hi = _market_today(market).isoformat()
    stock, why, endpoint = _closes(code, lo, hi, out_dir / "stock")
    if stock is None or stock.empty:
        raise EventError(f"这只股票的日线没取到：{why or '没有价格'}")
    bench, bench_error = _benchmark(market, lo, hi, out_dir / "benchmark")
    if bench is None or bench.empty:
        raise EventError(f"{bm.label}没取到：{bench_error or '没有价格'}")
    result["sources"] = source_names([ev_source, endpoint, bm.endpoint])
    cal = pd.DatetimeIndex(bench.index)
    # 🔴 交易日历截到这只股票最后一个有价格的日子：盘中指数已有今天这根、baostock 收盘后才更新，
    #    不截的话今天会被当成停牌（前向填充、超额收益 = −指数涨跌）。末尾真停牌也一样说不清后面的涨跌，一并截掉。
    cut = int((cal > stock.index[-1]).sum())
    if cut:
        cal = cal[cal <= stock.index[-1]]

    computed: Dict[str, Dict[str, Any]] = {}       # 按第 0 天合并：公告日落在同一个交易日的算一次
    for ev in raw_events:
        w, why = _window(pd.Timestamp(ev.get("day0_from") or ev["date"]), cal, stock, bench, bm.label)
        if w is None:
            result["gaps"].append({"date": ev["date"], "label": ev["label"], "reason": why})
            continue
        prev = computed.get(w["day0"])
        if prev:
            prev["label"] = f"{prev['label']}；{ev['label']}"
            prev["detail"] = f"{prev['detail']}；{ev['detail']}"
            if prev["direction"] != ev["direction"]:
                prev["direction"] = "other"
            continue
        computed[w["day0"]] = {**ev, **w}
    events = sorted(computed.values(), key=lambda e: e["day0"])
    # 两次的窗口（前 PRE 到后 POST 个交易日）共用了交易日：同一段行情会被算进两次
    for prev, cur in zip(events, events[1:]):
        gap = int(cal.searchsorted(pd.Timestamp(cur["day0"]))) - int(cal.searchsorted(pd.Timestamp(prev["day0"])))
        cur["overlaps_prev"] = gap <= PRE + POST
    if events:
        events[0]["overlaps_prev"] = False

    groups = GROUPS.get(kind, {})
    result["summary"] = _summary(events, ["all", *groups], {"all": "全部", **groups})
    path = _mean_path(events)
    result["events"] = [{k: v for k, v in e.items() if k not in ("path", "day0_from")} for e in reversed(events)]   # 新的在前
    day0 = {
        "a_share": {"dragon_tiger": "第 0 天是上榜日之后的第一个交易日（龙虎榜收盘后才公布）；上榜当天本身的大涨大跌落在「事件前 5 日」那一档（前 1 日）",
                    "lockup": "第 0 天是解禁股份上市流通那天（不是交易日的，取之后第一个交易日）",
                    }.get(kind, "第 0 天是公告日（公告日不是交易日的，取之后第一个交易日）"),
        "hk_equity": f"第 0 天是港交所发布业绩公告后的第一个交易日：{HK_CLOSE} 收市后发布的算下一个交易日，盘前、午休发布的算当天；"
                     "平安夜、除夕这类半日市 12:00 就收市，当天午后发的这里仍算当天（这几天很少发业绩）",
        "us_equity": "第 0 天是 8-K 的美东提交日（不是交易日的取之后第一个交易日）；取不到可靠的提交时刻，收盘后才发布的公司反应落在第 1 天，看「第 0–1 日」那一档",
    }[market]
    if kind == "earnings_forecast":
        how = "按公告日算；同一天的几条预告（净利润、扣非等）算一次"
    elif kind == "earnings_release" and market == "hk_equity":
        how = "按港交所「末期 / 中期 / 季度业绩」分类找公告；同一天的几份算一次"
    elif kind == "buyback":
        how = "按回购方案第一次公告的日子算（东财「首次公告日」，和巨潮公告日核对过），不是实际买入的日子；同一天公告的几个方案算一次；回购多数公司只做过几次"
    elif kind == "survey":
        how = "按调研记录的公告日算（接待日通常早几天，那几天外界还不知道）；同一天公告的几次调研合并；东财的机构调研只保留近一年左右"
    elif kind == "dragon_tiger":
        how = ("同一天因几条理由上榜算一次；按这一天每条理由的席位净额分组：都为正算净买入、都为负算净卖出，有正有负的不归组；"
               "龙虎榜只列买卖最多的几个席位，席位合计不等于全部资金的买卖")
    elif kind == "lockup":
        how = (f"按实际可上市流通的股数占总股本分组：≥ {LOCKUP_LARGE_PCT:g}% 算较大、不到算较小；同一天解禁的几批合并；"
               "解禁的股份不一定当天卖出，这里只看那段时间的涨跌")
    elif kind == "earnings_release":
        how = ("按 SEC 8-K 的 Item 2.02（经营业绩）找，" + ("来自 SEC 官方全文检索，更正版 8-K/A 不算" if ev_source == "sec" else "来自东财转载的申报")
               + "；有的公司把季度交付量这类经营数据也按 2.02 报，会一起算进来；外国公司（ADR）用 6-K 报业绩，取不到")
    else:
        how = "按公告日算，不是股东实际买卖的那几天；同一天公告的几位股东合并成一次"
    price = ("股票用 baostock 前复权日线，分红送转不会被当成下跌；沪深300指数是价格指数，不含分红" if market == "a_share"
             else f"{PRICE_NOTES[market]}；对照用的{bm.label}也是收盘价，不含分红")
    notes = [
        f"超额收益 = 每个交易日这只股票的涨跌减去{bm.label}当天的涨跌，再累加；{day0}",
        f"窗口里有停牌的照列，不进平均；最近的事件还没满 {POST} 个交易日的，只进已经有的那几档；少于 {MIN_EVENTS} 次不给平均",
        how,
        price,
        "只是这只股票过去的情况，次数少、行情环境也不同，不代表下一次会怎样，也不是买卖提示",
    ]
    if src_note:
        notes.insert(3, src_note)
    if cut:
        notes.insert(2, f"这只股票最后一个价格在 {_d(stock.index[-1])}，{bm.label}之后的 {cut} 个交易日没算"
                        "（当天的收盘价可能还没出，或者在停牌）")
    if any(e.get("overlaps_prev") for e in events):
        notes.insert(2, f"有的两次事件相隔不到 {PRE + POST + 1} 个交易日，前后窗口重叠，同一段行情被算进了两次")
    result["notes"] = notes
    return result, path


def run(req: Dict[str, Any], out_dir: Path) -> Dict[str, Any]:
    result, path = build(req, out_dir)
    if req.get("charts") is True:
        # 平均路径只给界面画图；Agent 那条路不带
        result["ui_only"] = {"path": path}
    return result


CATALOG = {
    "description": "事件回看：选一类事件——A 股 earnings_forecast 业绩预告 / holder_increase 重要股东增持 / holder_decrease 重要股东减持 / "
                   "buyback 回购方案 / survey 机构调研 / dragon_tiger 龙虎榜上榜 / lockup 限售解禁（另列已排期还没到的解禁），"
                   "港股和美股 earnings_release 业绩公布（港交所业绩公告 / SEC 8-K Item 2.02）——"
                   "列这只股票历史上每一次事件前 5 到后 20 个交易日相对对照指数（沪深300 / 盈富基金 / SPY）的累计超额收益，再按档给平均、中位数、上涨占比；"
                   "少于 8 次只列逐次结果、不给平均；窗口里停牌的不进平均；港美股日线只能取约 10 年。只描述过去，不预测，不给买卖提示。",
    "parameters": {
        "symbol": "股票代码：A 股如 600519（沪深；北交所、ETF 不支持）、港股如 00700.HK、美股如 AAPL",
        "kind": "A 股 earnings_forecast / holder_increase / holder_decrease / buyback / survey / dragon_tiger / lockup；港股、美股 earnings_release",
        "charts": "true 时附平均路径（界面画图用）",
    },
}


def main() -> None:
    force_utf8_stdio()
    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"入参不是合法 JSON：{exc}"}, ensure_ascii=False))
        return
    if not isinstance(req, dict):
        print(json.dumps({"ok": False, "error": "入参必须是对象"}, ensure_ascii=False))
        return
    if req.get("action") == "catalog":
        print(json.dumps({"ok": True, "catalog": CATALOG}, ensure_ascii=False))
        return
    try:
        with tempfile.TemporaryDirectory(prefix="vra-events-") as scratch:
            result = run(req, Path(scratch))
    except EventError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
