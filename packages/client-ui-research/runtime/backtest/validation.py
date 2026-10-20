"""Statistical validation for backtest results.

Three independent tools:
  - Monte Carlo permutation test: is the strategy significantly better than random?
  - Bootstrap Sharpe CI: how stable is the risk-adjusted return?
  - Walk-Forward analysis: is performance consistent across time windows?

Usage: called automatically by BaseEngine.run_backtest when config[\"validation\"]
is present, or invoked directly on backtest outputs.
"""

from __future__ import annotations

import json
import math
from numbers import Integral, Real
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from backtest.metrics import net_pnl
from backtest.models import TradeRecord

# 收益标准差不超过这个值就算"没有波动"：浮点噪声除出来的夏普没有意义
_FLAT_STD = 1e-12


# ─── Monte Carlo Permutation Test ───


def monte_carlo_test(
    trades: List[TradeRecord],
    initial_capital: float,
    n_simulations: int = 1000,
    seed: int = 42,
) -> Dict[str, Any]:
    """Shuffle trade PnL order to test path significance.

    Null hypothesis: the observed Sharpe / max-drawdown is no better than
    a random ordering of the same trades.

    Args:
        trades: Completed round-trip trades from backtest.
        initial_capital: Starting capital.
        n_simulations: Number of random permutations.
        seed: Random seed for reproducibility.

    Returns:
        Dict with actual_sharpe, p_value_sharpe, actual_max_dd,
        p_value_max_dd, simulated_sharpes (percentiles).
    """
    if isinstance(n_simulations, bool) or not isinstance(n_simulations, Integral) or n_simulations < 1:
        return {
            "error": f"n_simulations must be >= 1, got {n_simulations}",
            "p_value_sharpe": None,
        }
    if isinstance(seed, bool) or not isinstance(seed, Integral) or seed < 0:
        return {"error": f"seed must be >= 0, got {seed}", "p_value_sharpe": None}
    if len(trades) < 3:
        return {"error": "need at least 3 trades", "p_value_sharpe": None}

    pnls = np.array([net_pnl(t) for t in trades])
    actual = _path_metrics(pnls, initial_capital)

    rng = np.random.default_rng(seed)
    sharpe_count = 0
    dd_count = 0
    sim_sharpes = []
    # The full path matrix feeds the fan-chart payload; skip it for
    # pathological sizes so a huge run cannot balloon memory or the JSON.
    keep_paths = n_simulations * len(pnls) <= 2_000_000
    sim_equities = np.empty((n_simulations, len(pnls))) if keep_paths else None

    for i in range(n_simulations):
        shuffled = rng.permutation(pnls)
        if sim_equities is not None:
            sim_equities[i] = initial_capital + np.cumsum(shuffled)
        sim = _path_metrics(shuffled, initial_capital)
        if sim["sharpe"] is not None:
            # 收益没有波动的路径夏普无定义：不进样本，也不参与比较
            sim_sharpes.append(sim["sharpe"])
            if actual["sharpe"] is not None and sim["sharpe"] >= actual["sharpe"]:
                sharpe_count += 1
        if sim["max_dd"] >= actual["max_dd"]:  # less negative = "better"
            dd_count += 1

    sim_arr = np.array(sim_sharpes)
    defined = len(sim_arr) > 0
    result = {
        "actual_sharpe": None if actual["sharpe"] is None else round(actual["sharpe"], 4),
        "actual_max_dd": round(actual["max_dd"], 4),
        # 实际夏普无定义（如每笔都不赚不亏）时显著性也无从谈起，给 None 而不是一个像样的 p 值
        "p_value_sharpe": (sharpe_count + 1) / (len(sim_arr) + 1) if actual["sharpe"] is not None and defined else None,
        "p_value_max_dd": (dd_count + 1) / (n_simulations + 1),
        "simulated_sharpe_mean": round(float(sim_arr.mean()), 4) if defined else None,
        "simulated_sharpe_std": round(float(sim_arr.std()), 4) if defined else None,
        "simulated_sharpe_p5": round(float(np.percentile(sim_arr, 5)), 4) if defined else None,
        "simulated_sharpe_p95": round(float(np.percentile(sim_arr, 95)), 4) if defined else None,
        "n_simulations": n_simulations,
        "n_sharpe_defined": len(sim_arr),
        "n_trades": len(trades),
        "sharpe_samples": [round(float(s), 4) for s in sim_sharpes],
    }
    if sim_equities is not None:
        idx = np.unique(np.linspace(0, len(pnls) - 1, min(len(pnls), 400)).astype(int))
        sample_rows = np.unique(
            np.linspace(0, n_simulations - 1, min(30, n_simulations)).astype(int)
        )
        result["equity_paths"] = {
            "steps": (idx + 1).tolist(),
            "initial_capital": round(float(initial_capital), 2),
            "actual": np.round((initial_capital + np.cumsum(pnls))[idx], 2).tolist(),
            "band_p5": np.round(np.percentile(sim_equities[:, idx], 5, axis=0), 2).tolist(),
            "band_p25": np.round(np.percentile(sim_equities[:, idx], 25, axis=0), 2).tolist(),
            "band_p50": np.round(np.percentile(sim_equities[:, idx], 50, axis=0), 2).tolist(),
            "band_p75": np.round(np.percentile(sim_equities[:, idx], 75, axis=0), 2).tolist(),
            "band_p95": np.round(np.percentile(sim_equities[:, idx], 95, axis=0), 2).tolist(),
            "samples": np.round(sim_equities[np.ix_(sample_rows, idx)], 2).tolist(),
        }
    return result


def _path_metrics(pnls: np.ndarray, initial_capital: float) -> Dict[str, Optional[float]]:
    """Compute Sharpe and max drawdown from a PnL sequence.

    路径**从初始资金起算**：以前直接从第一笔之后的净值开始，第一笔亏损既不算进收益，
    也成了回撤的起点（−2 万、+1 万、+1 万 被算成零回撤，Codex 审计第三轮 D3）。
    收益没有波动时夏普无定义，返回 None（以前除以 1e-10 得出 0，再被当成有效样本）。
    """
    equity = initial_capital + np.concatenate(([0.0], np.cumsum(pnls)))
    if len(equity) > 1:
        prev = equity[:-1]
        diff = np.diff(equity)
        returns = np.where(prev != 0, diff / np.where(prev != 0, prev, 1.0), 0.0)
    else:
        returns = np.array([0.0])
    sharpe = _sharpe(returns, 252)
    peak = np.maximum.accumulate(equity)
    dd = (equity - peak) / np.where(peak > 0, peak, 1.0)
    max_dd = float(np.min(dd))
    return {"sharpe": sharpe, "max_dd": max_dd}


# ─── Bootstrap Sharpe CI ───


def bootstrap_sharpe_ci(
    equity_curve: pd.Series,
    n_bootstrap: int = 1000,
    confidence: float = 0.95,
    bars_per_year: int = 252,
    seed: int = 42,
) -> Dict[str, Any]:
    """Resample daily returns to estimate Sharpe confidence interval.

    Args:
        equity_curve: Equity time series.
        n_bootstrap: Number of bootstrap samples.
        confidence: Confidence level (e.g. 0.95 for 95% CI).
        bars_per_year: Annualisation factor.
        seed: Random seed.

    Returns:
        Dict with observed_sharpe, ci_lower, ci_upper, median_sharpe,
        prob_positive (fraction of samples with Sharpe > 0).
    """
    if isinstance(n_bootstrap, bool) or not isinstance(n_bootstrap, Integral) or n_bootstrap < 1:
        return {"error": f"n_bootstrap must be >= 1, got {n_bootstrap}"}
    if (
        isinstance(confidence, bool)
        or not isinstance(confidence, Real)
        or not math.isfinite(float(confidence))
        or not 0.0 < confidence < 1.0
    ):
        return {"error": f"confidence must be in (0, 1), got {confidence}"}
    if isinstance(seed, bool) or not isinstance(seed, Integral) or seed < 0:
        return {"error": f"seed must be >= 0, got {seed}"}

    returns = equity_curve.pct_change().replace([np.inf, -np.inf], 0.0).dropna().values
    if len(returns) < 5:
        return {"error": "need at least 5 return observations"}

    observed = _sharpe(returns, bars_per_year)
    if observed is None:
        return {"error": "净值全程没有波动（如一直不持有），夏普无定义"}

    rng = np.random.default_rng(seed)
    boot_sharpes = []
    for _ in range(n_bootstrap):
        sample = rng.choice(returns, size=len(returns), replace=True)
        boot_sharpes.append(_sharpe(sample, bars_per_year))

    # 抽到全是同一个收益值的样本夏普无定义，不计入区间（也不当成"不为正"）
    valid = [s for s in boot_sharpes if s is not None]
    if not valid:
        return {"error": "重抽样样本的收益都没有波动，夏普区间无定义"}
    arr = np.array(valid)
    alpha = (1 - confidence) / 2
    lower = float(np.percentile(arr, alpha * 100))
    upper = float(np.percentile(arr, (1 - alpha) * 100))
    prob_pos = float(np.mean(arr > 0))

    result = {
        "observed_sharpe": round(observed, 4),
        "ci_lower": round(lower, 4),
        "ci_upper": round(upper, 4),
        "median_sharpe": round(float(np.median(arr)), 4),
        "prob_positive": round(prob_pos, 4),
        "confidence": confidence,
        "n_bootstrap": n_bootstrap,
    }
    if len(valid) < n_bootstrap:
        result["n_valid"] = len(valid)
    if n_bootstrap <= 20_000:
        result["sharpe_samples"] = [round(float(s), 4) for s in valid]
    return result


def _sharpe(returns: np.ndarray, bars_per_year: int = 252) -> Optional[float]:
    """不到两个观测或收益没有波动（如全程不持有）时夏普无定义，返回 None，不当成 0。"""
    if len(returns) < 2:
        return None
    std = returns.std()
    if not np.isfinite(std) or std <= _FLAT_STD:
        return None
    s = float(returns.mean() / (std + 1e-10) * np.sqrt(bars_per_year))
    return s if np.isfinite(s) else None


# ─── Walk-Forward Analysis ───


def walk_forward_analysis(
    equity_curve: pd.Series,
    trades: List[TradeRecord],
    n_windows: int = 5,
    bars_per_year: int = 252,
    initial_capital: Optional[float] = None,
) -> Dict[str, Any]:
    """Split backtest into sequential windows, check consistency.

    每段的基线是**上一段最后一天**的净值（第一段用初始资金；没给初始资金时用第一天净值），
    所以分段收益连乘能还原整段收益。以前每段从自己第一天量起，分段边界那天的涨跌
    哪一段都不算（Codex 审计 2026-10-09 D5）。

    每段的交易数、胜率只数**在这一段里平仓**的交易：按开仓日归段会把后面才知道的
    盈亏算进前面的段，改后面的行情能改掉前面一段的胜率（第四轮审计 D2）。

    Args:
        equity_curve: Equity time series.
        trades: Completed trades.
        n_windows: Number of non-overlapping windows.
        bars_per_year: Annualisation factor.

    Returns:
        Dict with per_window stats, consistency metrics.
    """
    if isinstance(n_windows, bool) or not isinstance(n_windows, Integral) or n_windows < 1:
        return {"error": f"n_windows must be >= 1, got {n_windows}"}
    if len(equity_curve) < n_windows * 2:
        return {"error": f"need at least {n_windows * 2} bars for {n_windows} windows"}

    indices = equity_curve.index
    window_size = len(indices) // n_windows
    windows = []

    for i in range(n_windows):
        start_idx = i * window_size
        end_idx = (i + 1) * window_size if i < n_windows - 1 else len(indices)
        win_eq = equity_curve.iloc[start_idx:end_idx]
        win_start = indices[start_idx]
        win_end = indices[end_idx - 1]
        if i > 0:
            path = pd.Series(np.r_[float(equity_curve.iloc[start_idx - 1]), win_eq.to_numpy(dtype=float)])
        elif initial_capital is not None:
            path = pd.Series(np.r_[float(initial_capital), win_eq.to_numpy(dtype=float)])
        else:
            path = pd.Series(win_eq.to_numpy(dtype=float))

        # Per-window trades：按平仓日归段，这一段只用段末之前已经知道的盈亏
        win_trades = [t for t in trades if win_start <= t.exit_time <= win_end]

        # Per-window metrics。算不出的比率是 None（这一段没有交易、净值没有波动），不写成 0
        ret = float(path.iloc[-1] / path.iloc[0] - 1) if path.iloc[0] > 0 else None
        win_returns = path.pct_change().replace([np.inf, -np.inf], 0.0).dropna().values
        sharpe = _sharpe(win_returns, bars_per_year)

        peak = path.cummax()
        dd = (path - peak) / peak.replace(0, 1)
        max_dd = float(dd.min())

        win_pnls = [net_pnl(t) for t in win_trades]
        win_rate = len([p for p in win_pnls if p > 0]) / len(win_pnls) if win_pnls else None

        windows.append(
            {
                "window": i + 1,
                "start": str(win_start.date()) if hasattr(win_start, "date") else str(win_start),
                "end": str(win_end.date()) if hasattr(win_end, "date") else str(win_end),
                "return": None if ret is None else round(ret, 6),
                "sharpe": None if sharpe is None else round(sharpe, 4),
                "max_dd": round(max_dd, 6),
                "trades": len(win_trades),
                "win_rate": None if win_rate is None else round(win_rate, 4),
            }
        )

    # Consistency metrics
    returns_list = [w["return"] for w in windows if w["return"] is not None]
    sharpes_list = [w["sharpe"] for w in windows if w["sharpe"] is not None]
    profitable_windows = sum(1 for r in returns_list if r > 0)

    def _stat(fn, xs, nd):
        return round(float(fn(xs)), nd) if xs else None

    return {
        "n_windows": n_windows,
        "windows": windows,
        "profitable_windows": profitable_windows,
        "consistency_rate": round(profitable_windows / n_windows, 4),
        "return_mean": _stat(np.mean, returns_list, 6),
        "return_std": _stat(np.std, returns_list, 6),
        # 只对算得出夏普的段求均值 / 标准差
        "sharpe_mean": _stat(np.mean, sharpes_list, 4),
        "sharpe_std": _stat(np.std, sharpes_list, 4),
    }


# ─── Runner integration ───


def run_validation(
    config: Dict[str, Any],
    equity_curve: pd.Series,
    trades: List[TradeRecord],
    initial_capital: float,
    bars_per_year: int = 252,
) -> Dict[str, Any]:
    """Run configured validation checks.

    Reads from config["validation"]:
      - monte_carlo: {n_simulations, seed}
      - bootstrap: {n_bootstrap, confidence, seed}
      - walk_forward: {n_windows}

    Args:
        config: Backtest config (must contain "validation" key).
        equity_curve: Equity time series.
        trades: Completed trades.
        initial_capital: Starting capital.
        bars_per_year: Annualisation factor.

    Returns:
        Dict keyed by validation type with results.
    """
    v_cfg = config.get("validation", {})
    results: Dict[str, Any] = {}

    if "monte_carlo" in v_cfg:
        mc_cfg = v_cfg["monte_carlo"] if isinstance(v_cfg["monte_carlo"], dict) else {}
        results["monte_carlo"] = monte_carlo_test(
            trades,
            initial_capital,
            n_simulations=mc_cfg.get("n_simulations", 1000),
            seed=mc_cfg.get("seed", 42),
        )

    if "bootstrap" in v_cfg:
        bs_cfg = v_cfg["bootstrap"] if isinstance(v_cfg["bootstrap"], dict) else {}
        results["bootstrap"] = bootstrap_sharpe_ci(
            equity_curve,
            bars_per_year=bars_per_year,
            n_bootstrap=bs_cfg.get("n_bootstrap", 1000),
            confidence=bs_cfg.get("confidence", 0.95),
            seed=bs_cfg.get("seed", 42),
        )

    if "walk_forward" in v_cfg:
        wf_cfg = v_cfg["walk_forward"] if isinstance(v_cfg["walk_forward"], dict) else {}
        results["walk_forward"] = walk_forward_analysis(
            equity_curve,
            trades,
            n_windows=wf_cfg.get("n_windows", 5),
            bars_per_year=bars_per_year,
            initial_capital=initial_capital,
        )

    return results


# ─── Standalone CLI ───


def _load_equity(run_dir: Path) -> pd.Series:
    """Load equity curve from artifacts/equity.csv."""
    path = run_dir / "artifacts" / "equity.csv"
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    for col in ("equity", "nav", "value"):
        if col in df.columns:
            return df[col]
    raise ValueError(
        f"equity.csv must contain an equity/nav/value column; got {list(df.columns)}"
    )


class TradesWithoutFees(ValueError):
    """trades.csv 是旧版写的、没有手续费列：费用未知，不能当 0（审计第二轮 D4）。"""


def _load_trades(run_dir: Path) -> List[TradeRecord]:
    """Load trades from artifacts/trades.csv and convert to TradeRecord list."""
    path = run_dir / "artifacts" / "trades.csv"
    df = pd.read_csv(path)
    if df.empty:
        return []
    # 🔴 费用未知 ≠ 0：按 0 读的话，价差赚一点、扣完费亏钱的交易又被算成赢，和已扣费的净值对不上
    if "commission" not in df.columns:
        raise TradesWithoutFees(
            "trades.csv 是旧版本写的，没有手续费列：胜率、蒙特卡洛、分段的交易统计需要扣费后的盈亏，"
            "按 0 费用算会把扣完费亏钱的交易算成赚钱。请重新跑一次这个回测")

    # The engine writes adjacent entry/exit pairs, including zero-PnL exits.
    # A malformed/foreign layout must not silently lose trades.
    if len(df) % 2:
        raise ValueError("trades.csv must contain adjacent entry/exit pairs")
    trades = []
    for index in range(0, len(df), 2):
        entry, row = df.iloc[index], df.iloc[index + 1]
        if (entry["code"] != row["code"] or
                (entry["side"], row["side"]) not in (("buy", "sell"), ("sell", "buy")) or
                entry["qty"] != row["qty"] or float(entry["pnl"]) != 0):
            raise ValueError("trades.csv contains an invalid entry/exit pair")
        hold = pd.to_numeric(row.get("holding_bars"), errors="coerce")
        if pd.isna(hold):
            hold = pd.to_numeric(row.get("holding_days", 0), errors="coerce")
        holding_bars = 0.0 if pd.isna(hold) else float(hold)
        trades.append(
            TradeRecord(
                symbol=str(row.get("code", "")),
                direction=1 if row.get("side") == "sell" else -1,
                entry_price=float(entry["price"]),
                exit_price=float(row.get("price", 0)),
                entry_time=pd.Timestamp(entry["timestamp"]),
                exit_time=pd.Timestamp(row["timestamp"]),
                size=float(row.get("qty", 0)),
                leverage=1.0,
                pnl=float(row.get("pnl", 0)),
                pnl_pct=float(row.get("return_pct", 0)),
                exit_reason=str(row.get("reason", "signal")),
                holding_bars=holding_bars,
                commission=_fee(row, index + 2),
            )
        )
    return trades


def _fee(row: pd.Series, line: int) -> float:
    """平仓那一行的手续费：空的、不是数字、负数都是文件数据错，不当 0。line 是 CSV 里的行号（含表头）。"""
    fee = pd.to_numeric(row.get("commission"), errors="coerce")
    if pd.isna(fee) or not np.isfinite(fee) or fee < 0:
        raise ValueError(f"trades.csv 第 {line + 1} 行的手续费不对（{row.get('commission')!r}）：要是不小于 0 的数字")
    return float(fee)


def _parse_run_dir(argv: List[str]) -> Path:
    """Validate CLI input and return a usable run directory path."""
    if len(argv) < 2:
        raise SystemExit("Usage: python -m backtest.validation <run_dir>")

    raw_run_dir = argv[1]
    if not raw_run_dir.strip():
        raise SystemExit("run_dir must be a non-empty path")
    if "\0" in raw_run_dir:
        raise SystemExit("Invalid run_dir path: embedded NUL byte")

    try:
        run_dir = Path(raw_run_dir).expanduser()
        exists = run_dir.exists()
        is_dir = run_dir.is_dir() if exists else False
    except (OSError, RuntimeError, ValueError) as exc:
        raise SystemExit(f"Invalid run_dir path: {exc}") from exc

    if not exists:
        raise SystemExit(f"run_dir does not exist: {run_dir}")
    if not is_dir:
        raise SystemExit(f"run_dir is not a directory: {run_dir}")
    return run_dir


def _json_safe(value: Any) -> Any:
    """Return a JSON-strict copy of validation results."""
    if isinstance(value, np.ndarray):
        return [_json_safe(item) for item in value.tolist()]
    if isinstance(value, np.generic):
        return _json_safe(value.item())
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def write_validation_json(path: Path, results: Dict[str, Any]) -> Dict[str, Any]:
    """Write validation results to ``path`` as strict, RFC-8259 JSON.

    A validation metric can be non-finite (e.g. a Sharpe computed from a path
    whose equity touches zero), and ``json.dumps`` emits bare ``NaN`` /
    ``Infinity`` tokens for those by default (``allow_nan=True``) — tokens that
    strict parsers reject. Sanitize with :func:`_json_safe` (non-finite → null)
    and serialize with ``allow_nan=False`` so every writer of
    ``artifacts/validation.json`` produces the same valid JSON. Returns the
    sanitized payload that was written.
    """
    safe_results = _json_safe(results)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(safe_results, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    return safe_results


def _initial_capital(run_dir: Path) -> tuple[Optional[float], str]:
    """这次回测的初始资金：先看 config.json（引擎读的就是它，没写时引擎同样按 100 万），
    没有 config.json 再看 run_card.json 里记下的。都没有、或不是正数 → (None, 原因)。

    🔴 不能没有记录就按 100 万猜：``run()`` 只写 run_card.json，不写 config.json，
       10 万本金的回测会被当成 100 万，第一段收益和回撤都算成 −90%，还覆盖掉原来对的结果
       （Codex 审计第三轮 D1）。
    """
    config_path = run_dir / "config.json"
    card_path = run_dir / "run_card.json"
    if config_path.exists():
        value = json.loads(config_path.read_text(encoding="utf-8")).get("initial_cash", 1_000_000)
    elif card_path.exists():
        backtest = json.loads(card_path.read_text(encoding="utf-8")).get("backtest")
        value = backtest.get("initial_cash") if isinstance(backtest, dict) else None
    else:
        value = None
    if value is None:
        return None, "找不到这次回测的初始资金（没有 config.json，run_card.json 里也没记），交易检验和分段检验没法算，不按默认值猜"
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value) or value <= 0:
        return None, f"这次回测记下的初始资金不是正数（{value!r}），交易检验和分段检验没法算"
    return float(value), ""


def main(run_dir: Path) -> Dict[str, Any]:
    """Run all three validations on existing backtest artifacts.

    Reads equity.csv, trades.csv, and the run's initial cash (see ``_initial_capital``) from run_dir.

    Args:
        run_dir: Directory with artifacts/ subdirectory.

    Returns:
        Validation results dict.
    """
    initial_capital, why = _initial_capital(run_dir)
    equity = _load_equity(run_dir)
    try:
        trades: Optional[List[TradeRecord]] = _load_trades(run_dir)
    except TradesWithoutFees as exc:
        trades, why = None, str(exc)
    if trades is None or initial_capital is None:
        # 只看净值的那项（夏普区间）照算；要用逐笔盈亏或本金的两项拒绝并说明原因
        results = {
            "monte_carlo": {"error": why, "p_value_sharpe": None},
            "bootstrap": bootstrap_sharpe_ci(equity),
            "walk_forward": {"error": why},
        }
    else:
        results = {
            "monte_carlo": monte_carlo_test(trades, initial_capital),
            "bootstrap": bootstrap_sharpe_ci(equity),
            "walk_forward": walk_forward_analysis(equity, trades, initial_capital=initial_capital),
        }

    out = run_dir / "artifacts" / "validation.json"
    safe_results = write_validation_json(out, results)

    print(json.dumps(safe_results, indent=2, allow_nan=False))
    return safe_results


if __name__ == "__main__":
    import sys

    main(_parse_run_dir(sys.argv))
