"""参数敏感度：用同一份数据，把两个参数在用户给的值附近各取几档重跑，看结果稳不稳。

🔴 它回答的是「参数稍微换一下，结论还在不在」，**不是**「哪组参数最好」。
   在同一段历史上挑出表现最好的格子，再拿那组参数说事，正是过拟合本身。
   ⇒ 输出里不排序、不标「最优」，只给整张网格和几个分布性的概括（多少格为正、区间多宽）。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from backtest.run import run
from backtest.strategies import BUILTIN, Rsrs

#: 网格每边的档数上限（7×7 = 49 次重跑，单次约 0.1 秒，数据只取一次）
SIDE = 7
#: 整张网格的时间上限；超时就停，如实标成不完整
BUDGET_SECONDS = 90.0

_MULT = (0.5, 0.67, 0.83, 1.0, 1.25, 1.5, 2.0)
_STEP = (-15, -10, -5, 0, 5, 10, 15)


def _int_axis(base: int, lo: int) -> List[int]:
    # lo 是常用下限、不是合法下限：用户给的更小的合法值（MA 1/2）要留在网格里（Codex 审计第三轮 D6）
    lo = min(lo, base)
    return sorted({max(lo, int(round(base * k))) for k in _MULT})[:SIDE]


def _num_axis(base: float, lo: float, hi: float) -> List[float]:
    # lo / hi 是常用范围，不是合法范围：用户给的值在常用范围外也合法，网格要围着它取，不能把它裁掉
    # （70 / 90 的 RSI 曾经整列买入线被压成 50，网格里根本没有原参数，Codex 审计 2026-10-09 D13）
    lo, hi = min(lo, base), max(hi, base)
    return sorted({float(min(hi, max(lo, base + d))) for d in _STEP})[:SIDE]


_THRESHOLD_STEP = (-0.3, -0.2, -0.1, 0.0, 0.1, 0.2, 0.3)


def _threshold_axis(base: float) -> List[float]:
    # 上限跟 RSRS 构造时一致：阈值 2.5 这类合法输入不能被压成一整列 2.0（E3 审查 P2-2）；
    # 下限同理：0.01 这类合法阈值原样留在网格里，不抬到 0.1（审计 D13）
    lo, hi = min(0.1, base), Rsrs.MAX_THRESHOLD
    return sorted({base if d == 0 else round(min(hi, max(lo, base + d)), 2) for d in _THRESHOLD_STEP})[:SIDE]


def _axes(key: str, params: Dict[str, Any]) -> Optional[Tuple[str, List[Any], str, List[Any], Dict[str, Any]]]:
    """(x 参数名, x 取值, y 参数名, y 取值, 固定不动的其余参数)。不支持的策略返回 None。"""
    if key == "ma_cross":
        fast, slow = int(params.get("fast", 20)), int(params.get("slow", 60))
        return "fast", _int_axis(fast, 2), "slow", _int_axis(slow, 3), {}
    if key == "rsi_reversion":
        buy, sell = float(params.get("buy_below", 30)), float(params.get("sell_above", 70))
        # 买入线不小于卖出线的格子由 run_grid 标成 invalid，不靠裁剪取值去躲
        return "buy_below", _num_axis(buy, 5, 95), "sell_above", _num_axis(sell, 5, 95), {"window": int(params.get("window", 14))}
    if key == "rsrs":
        n, t = int(params.get("n", 18)), float(params.get("threshold", 0.7))
        return "n", _int_axis(n, 3), "threshold", _threshold_axis(t), {"m": int(params.get("m", 600))}
    return None


METRICS = ("total_return", "sharpe", "max_drawdown", "trade_count")


def _round(v: Any) -> Any:
    return round(float(v), 4) if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v else None


def run_grid(plan, key: str, params: Dict[str, Any], loader, run_dir: Path,
             budget_seconds: float = BUDGET_SECONDS, clock: Callable[[], float] = time.monotonic) -> Optional[Dict[str, Any]]:
    """跑整张网格。``loader`` 必须是主回测用过的那个实例（数据已缓存，各格子用同一份）。"""
    ax = _axes(key, params)
    if ax is None:
        return None
    xname, xs, yname, ys, fixed = ax
    started = clock()
    # 每个指标一张 y × x 矩阵（行 = y 参数，列 = x 参数）；没算出来的格子是 None，原因记在 skipped
    grids: Dict[str, List[List[Any]]] = {k: [[None] * len(xs) for _ in ys] for k in METRICS}
    skipped_cells: List[List[Any]] = []
    done = invalid = 0
    complete = True
    for yi, yv in enumerate(ys):
        for xi, xv in enumerate(xs):
            if not complete or clock() - started > budget_seconds:
                complete = False
                skipped_cells.append([yi, xi, "timeout"])
                continue
            p = {**fixed, xname: xv, yname: yv}
            try:
                strategy = BUILTIN[key](**p)
            except ValueError:
                skipped_cells.append([yi, xi, "invalid"])     # 如快线不短于慢线：这一格本身不成立
                invalid += 1
                continue
            try:
                r = run(plan, strategy, run_dir=run_dir / f"{yi}_{xi}", loader=loader,
                        config_overrides={"validation": None})
            except Exception:                        # noqa: BLE001 —— 一格失败不影响其余格子
                skipped_cells.append([yi, xi, "error"])
                continue
            for k in METRICS:
                grids[k][yi][xi] = _round(r.metrics.get(k))
            done += 1

    values = [v for row in grids["total_return"] for v in row if isinstance(v, (int, float))]
    return {
        "x": {"param": xname, "values": xs},
        "y": {"param": yname, "values": ys},
        # 行列方向写进结果里：只在代码注释里写，读结果的 Agent 分不清哪一维是哪个参数（真机报告里出现过）
        "layout": f"每个指标是一张矩阵：行对应 y（{yname}），列对应 x（{xname}）；skipped 里是 [行, 列, 原因]",
        "fixed": fixed,
        "base": {xname: params.get(xname, xs[len(xs) // 2]), yname: params.get(yname, ys[len(ys) // 2])},
        **grids,
        "skipped": skipped_cells,
        "complete": complete,
        "runs": done,
        "invalid_cells": invalid,
        "summary": {
            "positive_share": (sum(v > 0 for v in values) / len(values)) if values else None,
            "return_min": min(values) if values else None,
            "return_max": max(values) if values else None,
        },
    }
