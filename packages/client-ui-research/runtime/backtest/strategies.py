"""内置策略 —— 开箱能跑的几个，同时也是"策略长什么样"的模板。

策略只有一条契约::

    generate(data_map: {代码: OHLCV DataFrame}) -> {代码: pd.Series}

返回的 Series 是**目标仓位权重**，取值 -1 ~ 1（1 = 满仓做多，0 = 空仓，-1 = 满仓做空）。
引擎会自己做三件事，策略里**不要重复做**：

1. **整体后移一根** —— 今天收盘算出来的信号，明天开盘才成交。所以策略里可以放心用
   当天的 close，不会变成未来函数。
2. **归一化** —— 各票权重绝对值之和超过 1 时按比例缩回，不会超额加杠杆。
3. **市场规则** —— 涨跌停封死、T+1、整手、做空限制，由引擎按市场拒单。

🔴 策略里**不许出现"未来"的数据**：`shift(-1)`、`iloc[-1]` 当成每天都知道的常数、
   用整段序列算出来的分位数再回头用……这类写法回测会非常好看，实盘一分钱赚不到。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

import pandas as pd

if TYPE_CHECKING:  # 只给类型检查看：运行时不必为一个标注加载整套引擎
    from backtest.run import Strategy


class BuyAndHold:
    """一直满仓拿着 —— 任何策略的及格线：跑不赢它就没有意义。"""

    name = "买入持有"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n = len(data_map) or 1
        return {c: pd.Series(1.0 / n, index=df.index) for c, df in data_map.items()}


class MaCross:
    """均线交叉：快线在慢线上方满仓，下方空仓。"""

    def __init__(self, fast: int = 20, slow: int = 60) -> None:
        if not (isinstance(fast, int) and isinstance(slow, int)) or fast < 1 or slow < 1:
            raise ValueError(f"均线窗口要是正整数，收到 fast={fast!r} slow={slow!r}")
        if fast >= slow:
            raise ValueError(f"快线要短于慢线，收到 fast={fast} slow={slow}")
        self.fast, self.slow = fast, slow
        self.name = f"均线交叉 MA{fast}/MA{slow}"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n = len(data_map) or 1
        out = {}
        for code, df in data_map.items():
            c = df["close"]
            # min_periods 用满窗口：不足窗口时是 NaN，引擎会当 0（空仓）。
            # 若用 min_periods=1，头几天会拿 3 天均线冒充 60 天均线，
            # 那是**用一个不成立的指标开仓**，而回测里看不出来。
            fast = c.rolling(self.fast, min_periods=self.fast).mean()
            slow = c.rolling(self.slow, min_periods=self.slow).mean()
            out[code] = (fast > slow).astype(float) / n
        return out


class RsiReversion:
    """RSI 均值回归：超卖买入、超买清仓（短线口径的常见形态）。"""

    def __init__(self, window: int = 14, buy_below: float = 30.0, sell_above: float = 70.0) -> None:
        if not isinstance(window, int) or window < 2:
            raise ValueError(f"RSI 窗口要是 ≥2 的整数，收到 {window!r}")
        # 阈值反了 / 超界不会报错，只会静默生成一个「永不进场」或「永不退出」的策略 ——
        # 回测跑完给出零成交或全程满仓的结果，看不出是参数配错了
        if not (0 <= buy_below < sell_above <= 100):
            raise ValueError(
                f"RSI 阈值要满足 0 ≤ 买入线 < 卖出线 ≤ 100，收到 {buy_below!r} / {sell_above!r}"
            )
        self.window, self.buy_below, self.sell_above = window, float(buy_below), float(sell_above)
        self.name = f"RSI{window} 均值回归（<{buy_below:g} 买 / >{sell_above:g} 清）"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n = len(data_map) or 1
        out = {}
        for code, df in data_map.items():
            delta = df["close"].diff()
            gain = delta.clip(lower=0).rolling(self.window, min_periods=self.window).mean()
            loss = (-delta.clip(upper=0)).rolling(self.window, min_periods=self.window).mean()
            # 全是上涨时 loss=0 → rs 无穷 → rsi=100。直接相除会得到 inf/NaN，
            # 而 NaN 会被当成 0（空仓）—— 那等于"单边上涨时反而不持仓"，方向正好反了。
            rs = gain / loss.replace(0.0, pd.NA)
            rsi = 100 - 100 / (1 + rs)
            rsi = rsi.where(loss != 0, 100.0).where(gain.notna())
            pos = pd.Series(0.0, index=df.index)
            pos[rsi < self.buy_below] = 1.0 / n
            # 中间地带保持上一状态：不写的话每天都会在满仓与空仓之间跳，换手被费用吃光
            pos = pos.where((rsi < self.buy_below) | (rsi > self.sell_above)).ffill().fillna(0.0)
            out[code] = pos
        return out


def _day(ts: Any) -> str:
    return ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)[:10]


class Rsrs:
    """RSRS 择时（阻力支撑相对强度）：光大证券 2017 年公开研报的方法，按研报公式自己写，没有搬任何仓库的代码。

    每天用最近 n 天的最高价对最低价做最小二乘回归，斜率 β 大说明支撑比阻力强；再算 β 在最近 m 个读数里的
    标准分 z：z 高于阈值目标权重为 1，低于负阈值为 0，中间保留前值。只做了研报的基础标准分，
    R² 修正版和右偏版没有做。

    🔴 研报参数（18 / 600 / ±0.7）是在沪深300 指数 2005–2017 年上定的，个股和别的年份不一定成立。
    🔴 前 n+m-1 根只用来算指标、这段时间不持有 —— 区间要比别的策略长，运行期守卫按 ``warmup_bars`` 判样本够不够。
    🔴 只用于历史回测：这里不输出「今天」的读数。
    """

    #: 平仓记录少于这个数，报告里写明结论说明不了有效还是无效
    MIN_TRADES = 10
    warmup_remedy = "把标准化窗口 m 调短（研报用 600）"

    #: 阈值上限（参数稳健性网格也按它封顶）
    MAX_THRESHOLD = 3.0

    def __init__(self, n: int = 18, m: int = 600, threshold: float = 0.7) -> None:
        if not isinstance(n, int) or n < 3:
            raise ValueError(f"RSRS 回归天数 n 要是 ≥3 的整数，收到 {n!r}")
        if not isinstance(m, int) or m < 20:
            raise ValueError(f"RSRS 标准化窗口 m 要是 ≥20 的整数，收到 {m!r}")
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not (0 < threshold <= self.MAX_THRESHOLD):
            raise ValueError(f"RSRS 阈值要在 0 到 {self.MAX_THRESHOLD:g} 之间（不含 0），收到 {threshold!r}")
        self.n, self.m, self.threshold = n, m, float(threshold)
        self.name = f"RSRS 择时（回归 {n} 日 / 标准化 {m} 日 / 阈值 ±{threshold:g}）"
        #: 第一个读数出现在第 n+m-1 根收盘；引擎后移一根成交 ⇒ 前 n+m-1 根一定不持有
        self.warmup_bars = n + m - 1
        #: 每只标的第一个读数的日期（整段没有读数是 None）；结果说明要用
        self.first_reading: Dict[str, Optional[Any]] = {}

    def slope(self, high: pd.Series, low: pd.Series) -> pd.Series:
        """β = 最近 n 天最高价对最低价的最小二乘斜率 = cov(high, low) / var(low)。"""
        n = self.n
        cov = high.rolling(n, min_periods=n).cov(low)
        var = low.rolling(n, min_periods=n).var()
        # 最低价 n 天不变时斜率无定义，是 NaN，不当 0。
        # ⚠️ 不能用 var > 0 判：滚动方差有累积的浮点误差，常数序列算出来是 1e-15 这样的数，
        #    斜率会变成 ±4.8 这种假读数（测试里抓到过）⇒ 直接看这 n 天的最低价有没有变动
        roll = low.rolling(n, min_periods=n)
        moved = (roll.max() - roll.min()) > low.abs().rolling(n, min_periods=n).max() * 1e-9
        return cov / var.where(moved)

    def zscore(self, high: pd.Series, low: pd.Series) -> pd.Series:
        """β 在最近 m 个读数里的标准分（样本标准差）。"""
        m = self.m
        beta = self.slope(high, low)
        # 标准化只数**算得出的** β：中间有一段无定义时往前多取几天凑满 m 个，
        # 否则一个 NaN 会让之后整整 m 天都没有读数
        b = beta.dropna()
        roll = b.rolling(m, min_periods=m)
        mean, std = roll.mean(), roll.std()
        # 斜率 m 个读数完全不变时标准分无定义（同上，不能用 std > 0 判）
        moved = (roll.max() - roll.min()) > b.abs().rolling(m, min_periods=m).max() * 1e-9
        return ((b - mean) / std.where(moved)).reindex(beta.index)

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n_codes = len(data_map) or 1
        out = {}
        self.first_reading = {}
        for code, df in data_map.items():
            z = self.zscore(df["high"].astype(float), df["low"].astype(float))
            t = self.threshold
            pos = pd.Series(0.0, index=df.index)
            pos[z > t] = 1.0 / n_codes
            # 阈值之间保留前值；没有读数（预热期）是 NaN → 0
            pos = pos.where((z > t) | (z < -t)).ffill().fillna(0.0)
            out[code] = pos
            valid = z.dropna()
            self.first_reading[code] = valid.index[0] if len(valid) else None
        return out

    def result_notes(self, metrics: Dict[str, Any]) -> List[str]:
        """回测跑完后要写进口径的话：方法出处、预热期、第一个读数在哪天、平仓记录太少时结论不可靠。合成一条。"""
        t = f"{self.threshold:g}"
        text = (
            f"RSRS 择时按光大证券 2017 年公开研报的公式自写：每天用最近 {self.n} 天的最高价对最低价做回归取斜率，"
            f"再算这个斜率在最近 {self.m} 个读数里的标准分，高于 {t} 时目标权重为 1、低于 -{t} 时为 0、中间保留前值；"
            "只做了基础标准分，研报里的 R² 修正版和右偏版没有做。研报参数是在沪深300 指数 2005–2017 年上定的，"
            f"用在个股或别的年份不一定成立。前 {self.warmup_bars} 根日线只用来算指标、不持有，"
            "收益、年化、夏普按整个区间算，含这段不持有的时间，而对照基准这段时间是持有的。"
        )
        got = {c: d for c, d in self.first_reading.items() if d is not None}
        never = sorted(c for c, d in self.first_reading.items() if d is None)
        if got:
            days = sorted(_day(d) for d in got.values())
            text += f"第一个读数在 {days[0]}。" if days[0] == days[-1] else f"各标的第一个读数在 {days[0]} 到 {days[-1]} 之间。"
        if never:
            text += f"{'、'.join(never)} 整段没有读数，始终不持有。"
        tc = metrics.get("trade_count")
        if isinstance(tc, int) and not isinstance(tc, bool) and tc < self.MIN_TRADES:
            text += ("本次没有一条平仓记录，" if tc == 0 else f"本次只有 {tc} 条平仓记录，少于 {self.MIN_TRADES} 条，") + \
                "结果说明不了这个方法有效还是无效。"
        return [text]


BUILTIN: Dict[str, Callable[..., Strategy]] = {
    "buy_and_hold": BuyAndHold,
    "ma_cross": MaCross,
    "rsi_reversion": RsiReversion,
    "rsrs": Rsrs,
}
