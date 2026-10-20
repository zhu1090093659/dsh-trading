"""历史情景回放的 **JSON 入口**：stdin 进 ``{positions: [{symbol, name, value}]}``，stdout 出按币种分开的回放结果。

给「我的持仓」页用，不需要模型。按**现在的持仓比例**，把几段历史大跌期重放一遍：
组合涨跌、期间最大回撤、最差单日，和同期对照指数并排，再列每只的涨跌和贡献。

价格走回测取数层（``VibeLoader``）：A 股 baostock 前复权日线（能回到 2015 年），港美股 Yahoo 日线
（只能取到约 10 年前，更早的时期标「取不到日线」）。持仓体检用的 K 线工具只有近 5 年，回放不了这些时期。

🔴 不同币种**分别回放**，和持仓体检一样不做汇率换算。
🔴 当时还没上市、没有价格、到结束还在停牌的进缺口，**不当 0**，权重只在有价格的几只之间分；
   有价格的不到这一组市值的一半时**不给组合数字**，只列各只的涨跌 —— 样本不够就不下结论。
🔴 只是「按现在的比例回看那段行情」，不是当时的真实持仓，不预测下一次，不给任何操作提示。

用法::

    echo '{"positions":[{"symbol":"600519","name":"贵州茅台","value":125000}]}' | python -m backtest.scenario_replay
"""

from __future__ import annotations

import json
import math
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from backtest.loader import INDEX_BASIS, INDEX_BENCHMARKS, VibeLoader, yahoo_daily_earliest
from backtest.portfolio_xray import GROUPS, XrayError, _parse
from backtest.stdio_utf8 import force_utf8_stdio

#: 界面上的「来源」写看得懂的名字（端点名 → 名字）；没列的照原样
SOURCE_NAMES = {"bs_kline_qfq": "baostock 前复权日线", "tx_kline": "腾讯 K 线", "yahoo_kline": "Yahoo 日线", "eastmoney": "东方财富", "hkex": "港交所披露易", "sec": "SEC EDGAR"}


def source_names(endpoints: Any) -> List[str]:
    return sorted({SOURCE_NAMES.get(e, e) for e in endpoints if e})


#: 预设时期。窗口 = 对照指数在这段时间的**收盘最高点到最低点**，2026-10-09 用本取数层的真实数据逐段核对过：
#: 沪深300 / SPY / 盈富基金在这些日期的收盘价分别是区间最高和最低（涨跌幅写在注释里，测试不依赖联网）。
SCENARIOS: Dict[str, List[Dict[str, str]]] = {
    "a_share": [
        {"id": "cn_2015", "label": "2015 年 6–8 月大跌", "start": "2015-06-08", "end": "2015-08-26"},       # 沪深300 −43.5%
        {"id": "cn_2016", "label": "2016 年初熔断", "start": "2015-12-22", "end": "2016-01-28"},           # −26.4%
        {"id": "cn_2018", "label": "2018 年下跌", "start": "2018-01-24", "end": "2019-01-03"},             # −32.5%
        {"id": "cn_2020", "label": "2020 年 3 月全球疫情冲击", "start": "2020-03-05", "end": "2020-03-23"},  # −16.1%
        {"id": "cn_2021_24", "label": "2021–2024 年长期回撤", "start": "2021-02-10", "end": "2024-02-02"},  # −45.3%
    ],
    "us_equity": [
        {"id": "us_2018q4", "label": "2018 年第四季度下跌", "start": "2018-09-20", "end": "2018-12-24"},   # SPY −20.2%
        {"id": "us_2020", "label": "2020 年 2–3 月疫情冲击", "start": "2020-02-19", "end": "2020-03-23"},  # −34.1%
        {"id": "us_2022", "label": "2022 年加息期下跌", "start": "2022-01-03", "end": "2022-10-12"},       # −25.4%
        {"id": "us_2025", "label": "2025 年 2–4 月关税冲击", "start": "2025-02-19", "end": "2025-04-08"},  # −19.0%
    ],
    "hk_equity": [
        {"id": "hk_2018", "label": "2018 年下跌", "start": "2018-01-26", "end": "2018-10-31"},             # 盈富 −24.9%
        {"id": "hk_2020", "label": "2020 年初疫情冲击", "start": "2020-01-17", "end": "2020-03-19"},       # −24.7%
        {"id": "hk_2021_22", "label": "2021–2022 年长期下跌", "start": "2021-02-17", "end": "2022-10-31"},  # −52.6%
        {"id": "hk_2025", "label": "2025 年 3–4 月关税冲击", "start": "2025-03-19", "end": "2025-04-07"},  # −20.1%
    ],
}

PRICE_NOTES = {
    "a_share": "A 股用 baostock 前复权日线，分红送转不会被当成下跌；ETF、指数、可转债这一版取不到这么早的价格，进缺口",
    "us_equity": "美股价格只做了拆股调整、没有含分红，除息日会多出一个小跌幅",
    "hk_equity": "港股价格只做了拆股调整、没有含分红，除息日会多出一个小跌幅",
}

#: 有价格的持仓至少要占这一组市值的这么多，才给组合数字
MIN_COVERAGE = 0.5
#: 起点前多取这么多天：起点那天恰好停牌的，要能找到停牌前的收盘价
LEAD_DAYS = 30
#: 起止两头允许差几天（长假 + 周末）。超过就当「当时还没上市」或「到结束还在停牌」
EDGE_DAYS = 10
FETCH_WORKERS = 4
#: baostock 会话被挤掉时的报错特征（取数层把原因带进了 failures）
BAOSTOCK_TRANSIENT = ("10001001", "翻页失败", "登录失败")
RETRY_SLEEP = 2.0


class ReplayError(ValueError):
    """整次回放做不了（入参不对）—— 作为 ``ok: false`` 的原因原样给界面。单只的问题进缺口。"""


def _r(v: Optional[float], digits: int = 6) -> Optional[float]:
    return round(float(v), digits) if v is not None and math.isfinite(float(v)) else None


def _d(ts: Any) -> str:
    return str(pd.Timestamp(ts).date())


def _available(market: str, earliest: Optional[date] = None) -> Tuple[List[Dict[str, str]], List[Dict[str, str]]]:
    """这个市场能回放的时期 + 取不到日线的时期（港美股只能取约 10 年，随今天往后挪）。"""
    ok: List[Dict[str, str]] = []
    off: List[Dict[str, str]] = []
    earliest = earliest or yahoo_daily_earliest()
    for s in SCENARIOS[market]:
        start = date.fromisoformat(s["start"]) - timedelta(days=LEAD_DAYS)
        if market != "a_share" and start < earliest:
            off.append({**s, "reason": f"港美股日线只能取到 {earliest.isoformat()} 以后，这段时期取不到"})
        else:
            ok.append(s)
    return ok, off


def _closes(code: str, start: str, end: str, out_dir: Path) -> Tuple[Optional[pd.Series], Optional[str], Optional[str]]:
    """一只的日收盘价。返回 (序列, 取不到的原因, 端点名)。每只一个取数实例，互不干扰。

    baostock 的登录被别的会话挤掉（翻页失败 / 用户未登录）时隔两秒重取一次；再失败就进缺口。
    """
    for attempt in range(2):
        ld = VibeLoader(out_dir / f"try{attempt}", limit_prices=False)
        got = ld.fetch([code], start, end)
        if got:
            break
        why = next(iter(ld.failures.values()), "没有取到价格")
        if attempt or not any(k in why for k in BAOSTOCK_TRANSIENT):
            return None, _plain(why), None
        time.sleep(RETRY_SLEEP)
    df = next(iter(got.values()))
    prov = next(iter(ld.provenance.values()), None)
    return pd.to_numeric(df["close"], errors="coerce").dropna().astype("float64"), None, (prov.endpoint if prov else None)


def _plain(why: str) -> str:
    """取数层给回测用的拒绝原因写得很技术，换成持仓页上看得懂的话；其余原样。"""
    if "不是个股" in why:
        return "ETF、指数、可转债这一版只取得到近几年的价格，回放不了这些时期"
    if "北交所仅支持" in why:
        return "北交所 2021 年 11 月才开市，这几段时期都比它早"
    return why


def _benchmark(market: str, start: str, end: str, out_dir: Path) -> Tuple[Optional[pd.Series], Optional[str]]:
    spec = INDEX_BENCHMARKS[market]
    ld = VibeLoader(out_dir)
    got = ld.fetch([spec.ticker], start, end)
    if spec.ticker not in got:
        return None, ld.benchmark_failures.get(spec.ticker) or "对照指数没取到"
    return pd.to_numeric(got[spec.ticker]["close"], errors="coerce").dropna().astype("float64"), None


def _anchor(full: pd.Series, start: pd.Timestamp, end: pd.Timestamp) -> Tuple[Optional[Tuple[pd.Timestamp, float, pd.Timestamp, float]], Optional[str]]:
    """一只在这段时期的起点价和终点价。取不到就给原因（进缺口）。

    起点：起点当天或之前最后一个收盘价（起点那天停牌就用停牌前的价）。终点：结束当天或之前最后一个收盘价，
    离结束太远就算不准。

    🔴 起点之前没有价格的（开始后几天才上市）**进缺口**，不拿后来的第一个价格往前补：补的话那几天是编出来的
    「持平」，组合起点却仍算在起点、覆盖率也把它算进来（审计第二轮 D8；第一轮只补了说明，理由不成立）。
    """
    before = full.loc[:start]
    if not before.empty:
        b_date, b_px = before.index[-1], float(before.iloc[-1])
    else:
        first = f"（最早的价格在 {_d(full.index[0])}）" if len(full) else ""
        return None, f"这段时期开始时还没有价格{first}，可能当时还没上市，没算进组合"
    last = full.loc[:end]
    e_date, e_px = last.index[-1], float(last.iloc[-1])
    if e_date < end - pd.Timedelta(days=EDGE_DAYS):
        return None, f"最后一个价格在 {_d(e_date)}，到这段时期结束都没有新价格（可能停牌或退市），涨跌算不准"
    if b_px <= 0 or e_px <= 0:
        return None, "价格不是正数，算不了涨跌"
    return (b_date, b_px, e_date, e_px), None


def _path_stats(v: pd.Series) -> Dict[str, Any]:
    """一条从 1 起步的净值路径 → 期间最大回撤（含起点）、最差单日。"""
    dd = v / v.cummax() - 1
    trough = dd.idxmin()
    peak = v.loc[:trough].idxmax()
    daily = v.pct_change().dropna()
    worst = daily.idxmin() if len(daily) else None
    return {
        "max_drawdown": _r(float(dd.min())),
        "max_drawdown_peak": _d(peak), "max_drawdown_trough": _d(trough),
        "worst_day": _r(float(daily.min())) if worst is not None else None,
        "worst_day_date": _d(worst) if worst is not None else None,
    }


def _replay_one(scn: Dict[str, str], positions: List[Dict[str, Any]], series: Dict[str, pd.Series],
                fetch_gaps: Dict[str, str], bench: Optional[pd.Series], bench_error: Optional[str]) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    start, end = pd.Timestamp(scn["start"]), pd.Timestamp(scn["end"])
    total = sum(p["value"] for p in positions)
    gaps: List[Dict[str, str]] = []
    anchors: Dict[str, Tuple[pd.Timestamp, float, pd.Timestamp, float]] = {}
    for p in positions:
        sym = p["symbol"]
        if sym in fetch_gaps:
            gaps.append({"symbol": sym, "name": p["name"], "reason": f"历史价格没取到：{fetch_gaps[sym]}"})
            continue
        a, why = _anchor(series[sym], start, end)
        if a is None:
            gaps.append({"symbol": sym, "name": p["name"], "reason": why or "算不了"})
            continue
        anchors[sym] = a

    out: Dict[str, Any] = {
        "id": scn["id"], "label": scn["label"], "start": scn["start"], "end": scn["end"],
        "unavailable": None, "benchmark": None, "benchmark_error": bench_error,
        "portfolio": None, "portfolio_note": None, "holdings": [], "gaps": gaps,
        "coverage": None, "positions_included": len(anchors),
    }

    path_bench: Optional[pd.Series] = None
    if bench is not None:
        ba, why = _anchor(bench, start, end)
        if ba is None:
            out["benchmark_error"] = f"对照指数{why}"
        else:
            seg = pd.concat([pd.Series([ba[1]], index=[start]), bench.loc[start + pd.Timedelta(days=1):end]]) if ba[0] < start else bench.loc[start:end]
            path_bench = seg / ba[1]
            out["benchmark"] = {"return": _r(ba[3] / ba[1] - 1), "first_date": _d(ba[0]), "last_date": _d(ba[2]), **_path_stats(path_bench)}

    if not anchors:
        out["portfolio_note"] = "这段时期没有一只持仓有可用的价格"
        return out, None

    inc_total = sum(p["value"] for p in positions if p["symbol"] in anchors)
    coverage = inc_total / total
    out["coverage"] = _r(coverage, 4)
    weights = {p["symbol"]: p["value"] / inc_total for p in positions if p["symbol"] in anchors}

    # 共同日历：对照指数和有价格的这些持仓在这段时期的交易日（加上起点）；停牌那几天按停牌前收盘价计。
    # 带上指数的日历，是为了几只同一天都停牌时那一天不会从日历里消失（停牌天数会少算）
    bench_days = list(bench.loc[start:end].index) if bench is not None else []
    days = sorted({start, *bench_days, *[d for sym in anchors for d in series[sym].loc[start:end].index]})
    cal = pd.DatetimeIndex(days)
    norm: Dict[str, pd.Series] = {}
    rows: List[Dict[str, Any]] = []
    for p in positions:
        sym = p["symbol"]
        if sym not in anchors:
            continue
        b_date, b_px, e_date, e_px = anchors[sym]
        full = series[sym]
        own = set(full.loc[start:end].index)
        s = full.reindex(full.index.union(cal)).ffill().reindex(cal)   # 起点之前一定有价格（见 _anchor），ffill 后没有空
        s.iloc[0] = b_px
        norm[sym] = s / b_px
        # 有了第一个价格之后、却没有价格的交易日（多半是停牌）；开始后才上市的，上市前那几天不算
        halted = sum(1 for d in cal if d >= b_date and d not in own)
        ret = e_px / b_px - 1
        rows.append({
            "symbol": sym, "name": p["name"], "weight": _r(weights[sym]), "return": _r(ret),
            "contribution": _r(weights[sym] * ret), "first_date": _d(b_date), "last_date": _d(e_date),
            "halted_days": halted,
        })
    out["holdings"] = sorted(rows, key=lambda r: (r["contribution"] if r["contribution"] is not None else 0))

    path = sum(weights[sym] * norm[sym] for sym in norm)
    if coverage < MIN_COVERAGE:
        out["portfolio_note"] = (f"这段时期有价格的持仓只占这一组市值的 {coverage:.0%}（不到一半），"
                                 "组合数字没有代表性，不给，只列各只的涨跌")
        return out, {"dates": [_d(d) for d in cal], "portfolio": None,
                     "benchmark": _aligned(path_bench, cal)}
    ret = sum(weights[sym] * (anchors[sym][3] / anchors[sym][1] - 1) for sym in anchors)
    out["portfolio"] = {
        "return": _r(ret), "value_change": _r(inc_total * ret, 2), "included_value": _r(inc_total, 2),
        "first_date": _d(cal[0]), "last_date": _d(cal[-1]), "days": len(cal), **_path_stats(path),
    }
    if coverage < 1:
        out["portfolio_note"] = f"权重只在这段时期有价格的 {len(anchors)} 只之间分配（占这一组市值的 {coverage:.0%}）"
    return out, {"dates": [_d(d) for d in cal], "portfolio": [_r(float(x)) for x in path],
                 "benchmark": _aligned(path_bench, cal)}


def _aligned(path_bench: Optional[pd.Series], cal: pd.DatetimeIndex) -> Optional[List[Optional[float]]]:
    if path_bench is None:
        return None
    s = path_bench.reindex(path_bench.index.union(cal)).ffill().reindex(cal)
    return [_r(float(x)) if pd.notna(x) else None for x in s]


def _group(market: str, positions: List[Dict[str, Any]], out_dir: Path) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    currency, label = GROUPS[market]
    scns, off = _available(market)
    result: Dict[str, Any] = {
        "market": market, "currency": currency, "label": label,
        "total_value": _r(sum(p["value"] for p in positions), 2), "positions_input": len(positions),
        "benchmark_label": INDEX_BENCHMARKS[market].label, "scenarios": [], "notes": [], "sources": [],
    }
    paths: Dict[str, Any] = {}
    if scns:
        lo = (min(date.fromisoformat(s["start"]) for s in scns) - timedelta(days=LEAD_DAYS)).isoformat()
        hi = max(s["end"] for s in scns)
        def job(ip: Tuple[int, Dict[str, Any]]) -> Tuple[Optional[pd.Series], Optional[str], Optional[str]]:
            return _closes(ip[1]["symbol"], lo, hi, out_dir / f"p{ip[0]}")
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
            fb = pool.submit(_benchmark, market, lo, hi, out_dir / "benchmark")   # A 股对照走腾讯，不占 baostock
            # 🔴 A 股逐只取：同时开几个 baostock 会话会互相挤掉登录，2026-10-09 实测有的只回前 2000 行
            fetched = [job(ip) for ip in enumerate(positions)] if market == "a_share" else list(pool.map(job, enumerate(positions)))
            bench, bench_error = fb.result()
        series: Dict[str, pd.Series] = {}
        fetch_gaps: Dict[str, str] = {}
        sources = set()
        for p, (ser, why, endpoint) in zip(positions, fetched):
            if ser is None or ser.empty:
                fetch_gaps[p["symbol"]] = why or "没有取到价格"
            else:
                series[p["symbol"]] = ser
                sources.add(endpoint or "")
        if bench is not None:
            sources.add(INDEX_BENCHMARKS[market].endpoint)
        result["sources"] = source_names(sources)
        for s in scns:
            one, path = _replay_one(s, positions, series, fetch_gaps, bench, bench_error)
            result["scenarios"].append(one)
            if path:
                paths[s["id"]] = path
    for s in off:
        result["scenarios"].append({"id": s["id"], "label": s["label"], "start": s["start"], "end": s["end"],
                                    "unavailable": s["reason"], "benchmark": None, "benchmark_error": None,
                                    "portfolio": None, "portfolio_note": None, "holdings": [], "gaps": [],
                                    "coverage": None, "positions_included": 0})
    # 取不到的时期也按时间顺序排在原位，不挪到最后
    result["scenarios"].sort(key=lambda s: s["start"])
    result["notes"] = [
        "按现在的持仓比例回看这几段历史行情，不是你当时的真实持仓，也不预测下一次会怎样",
        f"时期的起止取{INDEX_BENCHMARKS[market].label}这段时间收盘价的最高点和最低点",
        PRICE_NOTES[market],
        INDEX_BASIS,
    ]
    return result, paths


def build(req: Dict[str, Any], out_dir: Path) -> Dict[str, Any]:
    try:
        groups, gaps = _parse(req, what="回放")
    except XrayError as exc:
        raise ReplayError(str(exc)) from exc
    out: List[Dict[str, Any]] = []
    paths: Dict[str, Any] = {}
    for m in GROUPS:
        if m in groups:
            g, p = _group(m, groups[m], out_dir / m)
            out.append(g)
            paths[g["currency"]] = p
    result: Dict[str, Any] = {"groups": out, "gaps": gaps, "min_coverage": MIN_COVERAGE}
    if req.get("charts") is True:
        # 逐日路径只给界面画图；Agent 那条路不带
        result["ui_only"] = {"paths": paths}
    return result


CATALOG = {
    "description": "历史情景回放：按现在的持仓比例，回放几段历史大跌期（A 股 2015、2016 熔断、2018、2020、2021–2024；"
                   "美股 2018 四季度、2020、2022、2025；港股 2018、2020、2021–2022、2025），按币种分别给组合涨跌、"
                   "期间最大回撤、最差单日、同期对照指数，以及每只的涨跌和贡献。当时没有价格的进缺口；"
                   "有价格的不到一半市值时不给组合数字。不是当时的真实持仓，不预测，不提供任何操作建议。",
    "parameters": {
        "positions": "[{symbol: 600519 / AAPL / 00700.HK, name: 可选, value: 当前市值（原币种）}]，最多 60 只",
        "charts": "true 时附逐日路径（界面画图用）",
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
        with tempfile.TemporaryDirectory(prefix="vra-replay-") as scratch:
            result = build(req, Path(scratch))
    except ReplayError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
