"""Benchmark ticker resolution and fetch for backtest comparison.

Provides a lightweight, zero-dependency way to fetch benchmark reference
data given a set of strategy codes and a data source.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import Any, Optional

import pandas as pd

logger = logging.getLogger(__name__)

# 上游在这里 import yfinance loader 当万能兜底。本产品的数据一律走自己的取数层，
# 那一路**没有搬过来** —— 传进来的 loader 拿不到就是拿不到，不另开一条网络通道。
from backtest.metrics import bar_returns, buy_and_hold_return


# -------------------------------------------------------------------
# Benchmark map: market type → default ticker
# -------------------------------------------------------------------

MARKET_BENCHMARKS: dict[str, Optional[str]] = {
    "us_equity":  "SPY",
    "hk_equity":  "HK.03100",   # Hang Seng China Enterprises ETF
    "ca_equity":  "XIC.TO",     # S&P/TSX Capped Composite ETF
    "a_share":    "000300.SH",  # CSI 300 (China A-share core index)
    "crypto":     "BTC-USDT",
    "futures":    "ES.CME",      # E-mini S&P 500 futures
    "forex":      None,         # no universal benchmark
}


@dataclass
class BenchmarkResult:
    ticker:     str
    ret_series: pd.Series       # per-bar returns, index = timestamps
    total_ret: float          # total return over the period
    close: Optional[pd.Series] = None   # 原始收盘价；对齐到策略日期要用它，不能用收益率序列


#: 对照的最后一根报价最多可以比回测末日早几天（长假）；再早就是数据断了，沿用前值会把尾巴拉平。
MAX_TAIL_GAP_DAYS = 7


def align_benchmark_close(close: pd.Series, dates: Any) -> tuple[Optional[pd.Series], dict]:
    """把对照收盘价对齐到策略的日期，返回从 1 起算的净值曲线。

    🔴 不能拿收益率序列 ``reindex(dates).fillna(0)``：策略那边剔掉的停牌日上，
       指数当天的涨跌会被整段丢掉，对照收益就少算了。按**收盘价**对齐：
       每个策略日期取「当天或之前最近一根」对照收盘（只往前看，不用未来数据）。
    🔴 对照在回测首日之前没有报价，或最后一根比末日早太多，就**不出对照**并说明原因，
       不悄悄从中途起算、也不把断掉的尾巴拉平。
    """
    idx = pd.DatetimeIndex(dates)
    c = pd.to_numeric(close, errors="coerce").dropna().sort_index() if close is not None else pd.Series(dtype=float)
    c = c[c > 0]
    if len(idx) == 0 or c.empty:
        return None, {"gap": "对照没有可用的收盘价"}
    if c.index[0] > idx[0]:
        return None, {"gap": f"对照的首个报价 {c.index[0].date()} 晚于回测首日 {idx[0].date()}，无法从同一天起算；把回测起点改到 {c.index[0].date()} 或之后就能对照"}
    if c.index[-1] < idx[-1] - pd.Timedelta(days=MAX_TAIL_GAP_DAYS):
        return None, {"gap": f"对照的最后报价 {c.index[-1].date()} 比回测末日 {idx[-1].date()} 早 {MAX_TAIL_GAP_DAYS} 天以上"}
    aligned = c.reindex(c.index.union(idx)).ffill().reindex(idx)
    curve = aligned / aligned.iloc[0]
    return curve, {"filled_bars": int((~idx.isin(c.index)).sum())}


def resolve_benchmark(
    strategy_codes: list[str],
    source:       str,
    start_date:   str,
    end_date:     str,
    interval:     str = "1D",
    explicit:     Optional[str] = None,
    loader:       Optional[Any] = None,
) -> Optional[BenchmarkResult]:
    """Resolve the appropriate benchmark ticker and fetch its return series.

    Args:
        strategy_codes: Instruments being backtested (used for market inference).
        source:         Data source name (tushare / yfinance / okx / akshare / ccxt).
        start_date:     Backtest start date.
        end_date:       Backtest end date.
        interval:       Bar interval (1m / 5m / 15m / 30m / 1H / 4H / 1D).
        explicit:       Override ticker (e.g. "SPY" passed via config).
        loader:         Loader of the configured data source. When given, the
                        benchmark is fetched through it first, falling back to
                        yfinance if it yields no data — except ``local``,
                        which fails closed to keep offline runs offline.

    Returns:
        BenchmarkResult with return series and total return, or None if no
        benchmark applies (forex, or fetch failure).
    """
    ticker = _resolve_ticker(strategy_codes, source, explicit)
    if ticker is None:
        return None

    offline = source == "local"
    if offline and getattr(loader, "name", None) != source:
        # The runtime fallback chain in fetch_data_map() may have swapped in a
        # network loader while config["source"] still says local — never fetch
        # the benchmark through it. Fail closed instead.
        loader = None

    try:
        bench_df = _fetch_benchmark(
            ticker, start_date, end_date, interval,
            loader=loader,
            allow_fallback=not offline,
        )
    except Exception:
        return None

    if bench_df.empty or "close" not in bench_df.columns:
        return None

    close = bench_df["close"].dropna()
    if len(close) < 2:
        return None

    ret_series = bar_returns(close, label=f"benchmark {ticker}")
    # Price relative, not the compounded product: identical while prices are
    # positive, and it is the only one of the two that stays honest once they
    # are not (#872).
    total = buy_and_hold_return(close)
    if total is None:
        return None

    return BenchmarkResult(ticker=ticker, ret_series=ret_series, total_ret=total, close=close)


# -------------------------------------------------------------------
# Internal helpers
# -------------------------------------------------------------------

def _resolve_ticker(
    codes:     list[str],
    source:    str,
    explicit:  Optional[str],
) -> Optional[str]:
    """Pick the benchmark ticker to use."""

    if explicit:
        return explicit

    # Infer market from source + first code pattern
    market = _infer_market(codes, source)
    ticker = MARKET_BENCHMARKS.get(market)

    # yfinance is the universal fallback for benchmark fetch
    # but it only works for global-equity market types
    if ticker and market not in {"us_equity", "hk_equity", "ca_equity"}:
        # Only use benchmark if we can actually fetch it
        pass

    return ticker


def _infer_market(codes: list[str], source: str) -> str:
    """Rough market inference from symbol patterns and source."""
    if not codes:
        return "us_equity"

    first = codes[0].upper()

    if first.endswith(".US"):
        return "us_equity"
    if first.endswith(".HK"):
        return "hk_equity"
    if first.endswith((".TO", ".V")):
        return "ca_equity"
    if first.endswith((".NS", ".BO")):
        return "india_equity"
    if first.endswith((".KS", ".KQ")):
        return "kr_equity"
    crypto_quotes = ("-USDT", "-USDC", "-USD", "-BTC", "-ETH")
    if source in ("okx", "ccxt", "binance") or "/" in first or first.endswith(crypto_quotes):
        return "crypto"
    if source in ("tushare", "akshare"):
        if first.isdigit() and len(first) == 6:
            return "a_share"
        if first.startswith(("IF", "IC", "IH", "IM", "T", "TF")):
            return "futures"
        return "a_share"

    return "us_equity"


def _fetch_benchmark(
    ticker:    str,
    start_date: str,
    end_date:   str,
    interval:   str,
    loader:    Optional[Any] = None,
    allow_fallback: bool = True,
) -> pd.DataFrame:
    """Fetch benchmark OHLCV data.

    Tries the configured source's loader first (when given). Falls back to
    yfinance (single symbol, no auth) when no loader is given or it yields
    no data — unless ``allow_fallback`` is False (offline sources fail
    closed instead of making a network request).
    """
    if loader is None:
        logger.warning("基准 %s 没有可用的数据源（本产品未搬 yfinance 兜底），本次不做基准对比", ticker)
        return pd.DataFrame()
    try:
        df = _extract_frame(
            loader.fetch([ticker], start_date, end_date, interval=interval),
            ticker,
        )
    except Exception as exc:
        # 🔴 吞掉异常但**要出声**：兜底那条路已经没了，静默返回空
        #    等于「报告里悄悄没有基准对比」，而读的人不会知道少了什么。
        logger.warning("基准 %s 取数失败，本次不做基准对比：%s", ticker, exc)
        return pd.DataFrame()
    if df.empty:
        logger.warning("基准 %s 在区间内没有数据，本次不做基准对比", ticker)
    return df


def _extract_frame(result: Any, ticker: str) -> pd.DataFrame:
    """Normalise a loader fetch result to a single DataFrame."""
    if isinstance(result, dict):
        df = result.get(ticker)
    elif isinstance(result, pd.DataFrame):
        df = result
    else:
        return pd.DataFrame()

    if df is None or (isinstance(df, pd.DataFrame) and df.empty):
        return pd.DataFrame()

    return df
