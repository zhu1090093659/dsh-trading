"""回测报告的补充指标、月度 / 年度表、回撤段和画图序列。

两条纪律：

🔴 **只从引擎自己的产物算**。补充指标吃的是引擎的净值序列与成交记录；表格和画图序列读的是
   引擎写出的 ``artifacts/equity.csv``。不另起一套撮合或复算，免得报告里同一个数有两个版本。
🔴 **没有定义就是 None，不是 0**。没有交易就没有期望收益，样本太短就没有偏度 ——
   显示成 0 会被读成「算过了，结果是零」。
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from backtest.metrics import net_pnl, net_pnl_pct

#: 历史 VaR / CVaR 至少要这么多个日收益才算（再少，5% 分位就只是一两个点）
MIN_VAR_SAMPLE = 20
#: 表格里的收益保留到万分之一（0.01%）。表格会同时交给 Agent 和界面，两边用的是同一份取整后的数；
#: 不取整的话，二十年的月度表就能把 Agent 的上下文撑爆。汇总指标不在这里取整。
TABLE_DECIMALS = 4
#: 一年里第一个交易日最晚在 1 月 4 日前后、最后一个交易日最早在 12 月 29 日（元旦假期 / 年末逢周末）。
#: 起点晚于 1 月 5 日、终点早于 12 月 29 日，这一年就算不完整（年中开始或结束的回测不只看月份）
YEAR_HEAD_LATEST = (1, 5)
YEAR_TAIL_EARLIEST = (12, 29)


def _r(x: Any) -> Optional[float]:
    v = _f(x)
    return None if v is None else round(v, TABLE_DECIMALS)


def _f(x: Any) -> Optional[float]:
    """有限浮点或 None。"""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def underwater(equity: pd.Series, initial_cash: float) -> pd.Series:
    """回撤序列（≤ 0 的小数）。高水位从初始资金起算，与 ``calc_metrics`` 的最大回撤同口径。"""
    peak = equity.cummax().clip(lower=float(initial_cash))
    return (equity - peak) / peak.replace(0, 1)


def drawdown_episodes(equity: pd.Series, initial_cash: float) -> List[Dict[str, Any]]:
    """所有回撤段：从离开高水位到重新回到高水位（没回去的 ``end`` 为 None）。按深度从深到浅。"""
    dd = underwater(equity, initial_cash)
    idx = list(equity.index)
    out: List[Dict[str, Any]] = []
    start = None
    for i, v in enumerate(dd.to_numpy(dtype=float)):
        if v < 0 and start is None:
            start = i
        elif v >= 0 and start is not None:
            out.append(_episode(dd, idx, start, i))
            start = None
    if start is not None:
        out.append(_episode(dd, idx, start, None))
    out.sort(key=lambda e: e["depth"])
    return out


def _episode(dd: pd.Series, idx: list, start: int, end: Optional[int]) -> Dict[str, Any]:
    seg = dd.iloc[start:end] if end is not None else dd.iloc[start:]
    trough_pos = start + int(np.argmin(seg.to_numpy(dtype=float)))
    # 「开始」记为离开高水位前的最后一个高点那天（第一根就在水下时记第一根）
    peak_pos = max(start - 1, 0)
    return {
        "start": str(pd.Timestamp(idx[peak_pos]).date()),
        "trough": str(pd.Timestamp(idx[trough_pos]).date()),
        "end": str(pd.Timestamp(idx[end]).date()) if end is not None else None,
        "depth": float(dd.iloc[trough_pos]),
        "bars_to_trough": trough_pos - peak_pos,
        "bars_to_recover": (end - trough_pos) if end is not None else None,
        "bars": ((end if end is not None else len(idx) - 1) - peak_pos),
    }


def period_returns(equity: pd.Series, initial_cash: float, freq: str) -> pd.Series:
    """按月（``"M"``）或按年（``"Y"``）切的收益。第一段相对初始资金，之后相对上一段期末。"""
    if equity.empty:
        return pd.Series(dtype=float)
    key = equity.index.to_period(freq)
    last = equity.groupby(key).last()
    prev = last.shift(1)
    prev.iloc[0] = float(initial_cash)
    return last / prev - 1.0


def extended_metrics(
    equity: pd.Series,
    initial_cash: float,
    trades: Sequence[Any],
    positions: Optional[pd.DataFrame],
    execution_fees: Optional[float],
    bars_per_year: int,
) -> Dict[str, Optional[float]]:
    """``calc_metrics`` 之外的补充指标。日收益口径与 ``calc_metrics`` 一致（``pct_change``）。"""
    out: Dict[str, Optional[float]] = {}
    if equity is None or len(equity) == 0:
        return out
    ret = equity.pct_change().fillna(0.0)
    finite = bool(np.isfinite(ret.to_numpy(dtype=float)).all())
    n = len(ret)

    out["annual_volatility"] = _f(ret.std() * math.sqrt(bars_per_year)) if finite and n > 1 else None
    out["best_day"] = _f(ret.max()) if finite else None
    out["worst_day"] = _f(ret.min()) if finite else None
    sd = float(ret.std()) if n > 1 else 0.0
    out["skew"] = _f(ret.skew()) if finite and n >= 3 and sd > 0 else None
    out["kurtosis"] = _f(ret.kurt()) if finite and n >= 4 and sd > 0 else None   # 超额峰度
    if finite and n >= MIN_VAR_SAMPLE:
        var = float(np.quantile(ret.to_numpy(dtype=float), 0.05))
        out["var_95"] = var
        out["cvar_95"] = _f(ret[ret <= var].mean())
    else:
        out["var_95"] = out["cvar_95"] = None

    dd = underwater(equity, initial_cash)
    out["ulcer_index"] = _f(math.sqrt(float((dd ** 2).mean())))
    eps = drawdown_episodes(equity, initial_cash)
    out["longest_drawdown_bars"] = max((e["bars"] for e in eps), default=0)

    months = period_returns(equity, initial_cash, "M")
    out["best_month"] = _f(months.max()) if len(months) else None
    out["worst_month"] = _f(months.min()) if len(months) else None
    out["positive_month_ratio"] = _f((months > 0).mean()) if len(months) else None
    years = period_returns(equity, initial_cash, "Y")
    out["best_year"] = _f(years.max()) if len(years) else None
    out["worst_year"] = _f(years.min()) if len(years) else None

    if positions is not None and len(positions):
        gross = positions.fillna(0.0).abs().sum(axis=1)
        out["exposure_time"] = _f((gross > 1e-9).mean())
        out["avg_gross_exposure"] = _f(gross.mean())
    else:
        out["exposure_time"] = out["avg_gross_exposure"] = None

    # 单笔盈亏一律扣过手续费（净值本来就扣了；只看价差会把扣费后亏钱的交易算成赚钱，审计 D4）
    pnls = [net_pnl(t) for t in trades if _f(getattr(t, "pnl", None)) is not None]
    # 引擎的 pnl_pct 是百分数（×100）；这里统一成小数，与其余收益类指标同单位
    raw_pcts = (net_pnl_pct(t) for t in trades if _f(getattr(t, "pnl_pct", None)) is not None)
    pcts = [v / 100.0 for v in (_f(p) for p in raw_pcts) if v is not None]
    out["expectancy"] = _f(np.mean(pnls)) if pnls else None
    out["expectancy_pct"] = _f(np.mean(pcts)) if pcts else None
    out["largest_win"] = _f(max(pnls)) if pnls and max(pnls) > 0 else None
    out["largest_loss"] = _f(min(pnls)) if pnls and min(pnls) < 0 else None
    if len(pnls) >= 2 and float(np.std(pnls, ddof=1)) > 0:
        out["sqn"] = _f(math.sqrt(len(pnls)) * np.mean(pnls) / np.std(pnls, ddof=1))
    else:
        out["sqn"] = None
    fees = _f(execution_fees)
    out["fees_pct_of_initial"] = fees / float(initial_cash) if fees is not None and initial_cash else None
    return out


def report_tables(equity_csv: Path, initial_cash: float, *, top_drawdowns: int = 5) -> Dict[str, Any]:
    """读引擎写出的 ``equity.csv``，产出报告表格（交给 Agent 也交给界面）和画图序列（只给界面）。"""
    df = pd.read_csv(equity_csv, index_col="timestamp", parse_dates=["timestamp"])
    eq = df["equity"].astype(float)
    bench = df["benchmark_equity"].astype(float) if "benchmark_equity" in df.columns else None
    has_bench = bench is not None and bool(bench.notna().all())

    m = period_returns(eq, initial_cash, "M")
    bm = period_returns(bench, initial_cash, "M") if has_bench else None
    # 月度表用「年 × 12 个月」矩阵：比逐月对象列表小得多；区间外的月份是 None
    years_list = sorted({p.year for p in m.index})
    grid: Dict[int, List[Optional[float]]] = {yy: [None] * 12 for yy in years_list}
    bgrid: Optional[Dict[int, List[Optional[float]]]] = {yy: [None] * 12 for yy in years_list} if bm is not None else None
    for p, v in m.items():
        grid[p.year][p.month - 1] = _r(v)
        if bgrid is not None and bm is not None:
            bgrid[p.year][p.month - 1] = _r(bm[p])
    monthly = {"years": years_list, "ret": [grid[yy] for yy in years_list],
               "bench": [bgrid[yy] for yy in years_list] if bgrid is not None else None}

    y = period_returns(eq, initial_cash, "Y")
    by = period_returns(bench, initial_cash, "Y") if has_bench else None
    first, last = eq.index[0], eq.index[-1]
    yearly = []
    for p, v in y.items():
        b = _f(by[p]) if by is not None else None
        fv = _f(v)
        bars = int((eq.index.to_period("Y") == p).sum())
        # 首尾两年可能不完整：标出来，免得把四个月的收益和整年比
        partial = ((p == first.to_period("Y") and (first.month, first.day) > YEAR_HEAD_LATEST)
                   or (p == last.to_period("Y") and (last.month, last.day) < YEAR_TAIL_EARLIEST))
        yearly.append({"year": int(p.year), "ret": _r(v), "bench": _r(b),
                       "excess": _r(fv - b) if b is not None and fv is not None else None,
                       "bars": bars, "partial": bool(partial)})

    episodes = [{**e, "depth": _r(e["depth"])} for e in drawdown_episodes(eq, initial_cash)[:top_drawdowns]]
    # 回撤直接用引擎写出的那一列（与 max_drawdown 同口径），不在这里重算一遍
    dd = df["drawdown"].astype(float)
    charts = {
        "initial": float(initial_cash),     # 界面把净值换成累计收益时用，不靠猜第一根
        "dates": [str(t.date()) for t in eq.index],
        "equity": [float(v) for v in eq],
        "drawdown": [float(v) for v in dd],
        "benchmark": [float(v) for v in bench] if bench is not None and has_bench else None,
    }
    return {"monthly": monthly, "yearly": yearly, "drawdowns": episodes, "charts": charts}
