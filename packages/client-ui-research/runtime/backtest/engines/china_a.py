"""A-share (China mainland) backtest engine.

Market rules:
  - T+1: cannot sell shares bought today
  - No short selling for retail investors
  - Ordinary-session limits: main board ±10%, ChiNext/STAR ±20%, Beijing ±30%
  - ChiNext before 2020-08-24: ±10%; historical ST / IPO exceptions not modelled
  - Minimum lot: 100 shares (odd lots can only be sold, not bought)
  - Commission: ¥5 minimum, 0.025% bilateral
  - Stamp tax: 0.05% sell-side only
  - Transfer fee: 0.001% bilateral
"""

from __future__ import annotations

from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Optional

import pandas as pd

from backtest.engines.base import BaseEngine


class ChinaAEngine(BaseEngine):
    """A-share market engine.

    Config keys:
      - commission_rate: default 0.00025 (万2.5)
      - commission_min: default 5.0 (RMB)
      - stamp_tax: default 0.0005 (万5, sell-only)
      - transfer_fee: default 0.00001 (万0.1)
      - slippage: default 0.001
    """

    def __init__(self, config: dict):
        config = {**config, "leverage": 1.0}  # A-shares: no leverage
        super().__init__(config)
        self.commission_rate: float = config.get("commission_rate", 0.00025)
        self.commission_min: float = config.get("commission_min", 5.0)
        self.stamp_tax: float = config.get("stamp_tax", 0.0005)
        self.transfer_fee: float = config.get("transfer_fee", 0.00001)
        self.slippage_rate: float = config.get("slippage", 0.001)

    def can_execute(self, symbol: str, direction: int, bar: pd.Series) -> bool:
        """A-share execution rules.

        Args:
            symbol: Stock code (e.g. 000001.SZ).
            direction: 1 (buy), -1 (short — always blocked), 0 (sell/close).
            bar: Current bar (needs 'close', 'pre_close' or 'pct_chg').

        Returns:
            True if the trade is allowed.
        """
        # 1. No short selling
        if direction == -1:
            return False

        # 2. T+1: can't sell shares bought today
        if direction == 0 and self._bought_today(symbol, bar):
            return False

        # 3. Price limits, tested at execution time (see _blocked_by_limit).
        if _blocked_by_limit(self, symbol, direction, bar, _price_limit(symbol, _bar_date(bar))):
            return False

        return True

    def end_settlement_block(self, symbol: str, bar: Optional[pd.Series]) -> Optional[str]:
        """期末按收盘价卖出也要守 T+1 和跌停：最后一天才买的、收盘封在跌停价的都卖不出去。"""
        reason = super().end_settlement_block(symbol, bar)
        if reason is not None or bar is None:
            return reason
        if self._bought_today(symbol, bar):
            return "最后一天才买入，按 T+1 当天不能卖"
        if _closes_at_limit_down(self, symbol, bar, _price_limit(symbol, _bar_date(bar))):
            return "最后一天收盘跌停，卖不出去"
        return None

    def end_settlement_locked_size(self, symbol: str, bar: pd.Series) -> float:
        """T+1：最后一天加仓买进的股数当天不能卖（整笔都是当天开的由 end_settlement_block 挡）。"""
        day = _bar_date(bar)
        if day is None:
            return 0.0
        locked = 0.0
        for fill in reversed(self.fill_records):   # 成交按时间追加：从后往前，过了当天就停
            fill_day = fill.timestamp.date() if hasattr(fill.timestamp, "date") else None
            if fill_day is None or fill_day < day:
                break
            if fill.symbol == symbol and fill_day == day and fill.action in ("open", "increase"):
                locked += abs(float(fill.signed_quantity))
        return locked

    def _bought_today(self, symbol: str, bar: pd.Series) -> bool:
        """T+1：持仓是这根 bar 当天买入的。"""
        pos = self.positions.get(symbol)
        if pos is None:
            return False
        bar_date = _bar_date(bar)
        entry_date = pos.entry_time.date() if hasattr(pos.entry_time, "date") else None
        return bar_date is not None and entry_date is not None and bar_date == entry_date

    def round_size(self, raw_size: float, price: float) -> float:
        """Round down to 100-share lots."""
        return max(int(raw_size / 100) * 100, 0)

    def calc_commission(self, size: float, price: float, _direction: int, is_open: bool) -> float:
        """A-share fee structure: commission + stamp tax (sell) + transfer fee.

        ``_direction`` is unused today — reserved for future asymmetric
        long/short fee schedules (margin trading, securities lending).
        """
        notional = size * price
        # Commission: 万2.5, min ¥5
        comm = max(notional * self.commission_rate, self.commission_min)
        # Transfer fee: 万0.1 bilateral
        comm += notional * self.transfer_fee
        # Stamp tax: 万5 sell-only
        if not is_open:
            comm += notional * self.stamp_tax
        return comm

    def apply_slippage(self, price: float, direction: int) -> float:
        """A-share slippage (relatively small due to tick size)."""
        return price * (1 + direction * self.slippage_rate)


# ── Helpers ──


def _bar_date(bar: pd.Series):
    """Extract date from bar, handling various column names."""
    for col in ("trade_date", "date"):
        if col in bar.index:
            val = bar[col]
            if hasattr(val, "date"):
                return val.date()
            try:
                return pd.Timestamp(val).date()
            except Exception:
                pass
    # Fall back to bar name (index timestamp)
    if hasattr(bar, "name") and hasattr(bar.name, "date"):
        return bar.name.date()
    return None


def _blocked_by_limit(
    engine,
    symbol: str,
    direction: int,
    bar: pd.Series,
    limit: float,
    position_direction: int | None = None,
) -> bool:
    """Whether a price-limit band blocks a fill on this bar.

    Shared by every engine with a daily band (A-share, India, China futures,
    global futures). The band comes from a base price the market knew before
    the order — ``pre_close``, else the prior bar's close — and is compared
    against the price the engine would actually fill at, which is this bar's
    open plus slippage.

    The earlier implementation derived the day's move from the CURRENT bar's
    close, which is lookahead and wrong in both directions: a name that opened
    locked but drifted back by the close was allowed to trade at the locked
    open, and a name that opened freely but closed limit-up was refused a fill
    it would have got.

    Args:
        engine: Engine instance (needs the BaseEngine band helpers).
        symbol: Symbol being traded.
        direction: 1 (buy / open long), -1 (sell short), 0 (close).
        bar: Current bar.
        limit: Band half-width as a fraction (0.1 for +/-10%).
        position_direction: For ``direction == 0``, the direction of the
            position being closed: 1 closes a long (a sell, blocked at the
            lower band), -1 closes a short (a buy, blocked at the upper band).
            Defaults to a long close, which is the cash-equity case.

    Returns:
        True when the band blocks the fill. False when it does not, and also
        when no historical base price is reachable — an unknown band must not
        fabricate a block.
    """
    fill_direction = -(position_direction or 1) if direction == 0 else direction
    buying = direction == 1 or (direction == 0 and position_direction == -1)
    exact = _exchange_band(bar, limit)
    if exact is not None:
        raw_open, lower, upper = exact
        fill = engine.prospective_fill_price(bar, fill_direction)
        opening = bar.get("open")
        # The fill is booked on the adjusted scale; carry its slippage over to the
        # unadjusted open so it can be compared with the exchange's cent prices.
        raw_fill = raw_open * float(fill) / float(opening) if fill is not None and opening and float(opening) > 0 else raw_open
        eps = 1e-6
        # Opening at the limit price means the board is locked: no fill at any
        # slippage. Otherwise refuse only a fill that would book outside the band.
        if buying:
            return raw_open >= upper - eps or raw_fill > upper + eps
        return raw_open <= lower + eps or raw_fill < lower - eps

    band = engine.limit_band(symbol, bar, limit)
    if band is None:
        return False
    lower, upper = band
    # BaseEngine books a close with the OPPOSITE of the position's direction,
    # so slippage moves the price the other way. Checking the raw open here
    # would approve a fill that is then booked outside the band.
    fill = engine.prospective_fill_price(bar, fill_direction)
    if fill is None:
        return False

    # Fallback when the bar carries no unadjusted prices: the band is computed
    # on the adjusted scale without the exchange's cent rounding, so it is only
    # approximate (the run's limits say so). The tolerance absorbs float noise.
    tol = 1e-9 * max(abs(lower), abs(upper), 1.0)
    if buying:
        return fill >= upper - tol
    return fill <= lower + tol


def _closes_at_limit_down(engine, symbol: str, bar: pd.Series, limit: float) -> bool:
    """期末按收盘价卖出多头时，跌停是否拦住这笔成交。

    与 ``_blocked_by_limit`` 同一口径，只是看收盘而不是开盘：收盘就在跌停价＝封板，
    按滑点成交会落到跌停价以下也不算成交。有不复权价时按交易所规则取整到分比较；
    没有时退回复权尺度的近似涨跌停带；两样都没有时不拦（不能凭空编出一个封板）。
    """
    close = bar.get("close")
    if close is None or pd.isna(close) or float(close) <= 0:
        return False
    fill = engine.apply_slippage(float(close), -1)
    exact = _exchange_band(bar, limit)
    opening = bar.get("open")
    if exact is not None and opening is not None and pd.notna(opening) and float(opening) > 0:
        raw_open, lower, _upper = exact
        # 同一天的复权因子相同：用开盘的比例把收盘换回不复权价，再取整到分
        raw_close = _cent(Decimal(str(float(close) * raw_open / float(opening))))
        raw_fill = raw_close * fill / float(close)
        eps = 1e-6
        return raw_close <= lower + eps or raw_fill < lower - eps

    band = engine.limit_band(symbol, bar, limit)
    if band is None:
        return False
    lower, _upper = band
    tol = 1e-9 * max(abs(lower), 1.0)
    return fill <= lower + tol


def _cent(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _exchange_band(bar: pd.Series, limit: float) -> Optional[tuple[float, float, float]]:
    """Return (unadjusted open, limit-down, limit-up) by the exchange rule.

    SSE / SZSE / BSE price the band as the unadjusted previous close times
    (1 ± limit), rounded half-up to the 0.01 tick. The loader adds
    ``raw_open`` / ``raw_pre_close`` (baostock adjustflag=3) next to the
    adjusted bar; without them this returns None and the caller falls back to
    the approximate adjusted-scale band.

    Decimal arithmetic matters here: in float, 1.15 * 1.1 is 1.2649999...,
    which rounds to 1.26 instead of the exchange's 1.27.
    """
    try:
        raw_open = float(bar["raw_open"])
        pre = Decimal(str(float(bar["raw_pre_close"])))
        step = Decimal(str(float(limit)))
    except (KeyError, TypeError, ValueError, InvalidOperation):
        return None
    if not (raw_open > 0) or not pre.is_finite() or pre <= 0 or not step.is_finite() or step <= 0:
        return None
    return raw_open, _cent(pre * (1 - step)), _cent(pre * (1 + step))


def _price_limit(symbol: str, trading_day: date | None = None) -> float:
    """Determine price limit based on board.

    Args:
        symbol: Stock code (e.g. 300001.SZ, 688001.SH, 000001.SZ).

    Returns:
        Ordinary-session limit. Missing date uses current ordinary-board rules;
        production bars carry dates. ST and IPO exceptions are disclosed, not inferred.
    """
    code = symbol.split(".")[0] if "." in symbol else symbol
    # SZSE code table: 300000–309799 shares. Match all accepted ChiNext prefixes.
    if code.startswith("30"):
        return 0.10 if trading_day is not None and trading_day < date(2020, 8, 24) else 0.20
    if code.startswith(("688", "689")):
        return 0.20
    # Old and new BSE stock codes; pre-BSE history is rejected by the loader.
    if code.startswith(("43", "83", "87", "88", "92")) and len(code) == 6:
        if trading_day is not None and trading_day < date(2021, 11, 15):
            raise ValueError("北交所 2021-11-15 之前的精选层/新三板交易规则未建模")
        return 0.30
    # Main board: ±10%
    return 0.10
