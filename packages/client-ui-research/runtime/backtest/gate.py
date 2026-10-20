"""回测闸口 —— 在跑之前先判「这个回测成不成立」。

三问，缺一不可::

    ① 要回测什么？   代码 → 市场 → 引擎与市场规则
    ② 需要什么？     口径（长线 / 短线 / 做T）→ bar 粒度、最少多少根、时间范围
    ③ 限制是什么？   这个市场 + 这个口径下，哪些事根本做不了

🔴 **闸口的价值在「拦住」，不在「放行」。**
   一个不成立的回测照样能算出夏普和最大回撤，数字排版整齐、看不出任何异常 ——
   而它测的东西压根不存在（拿日线测日内、用 240 根 bar 说十年胜率、
   在 A 股回测做空）。**能算出数字不等于这个数字有意义**，这一层就是拦这个的。

⇒ 闸口只输出两种东西：一个能跑的 :class:`Plan`，或者一句说得清的 :class:`Refusal`。
  不输出「带着一堆警告勉强跑」的第三种 —— 警告没人看，数字人人看。
"""

from __future__ import annotations
import re

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Sequence

from backtest.loader import INDEX_BENCHMARKS, LoaderError, assert_a_share_stock, canonical_code, market_of, price_basis

# ── 市场规则表：这是「限制是什么」的事实来源 ──

@dataclass(frozen=True)
class MarketRules:
    key: str
    label: str
    engine: str
    can_short: bool
    same_day_roundtrip: bool     # T+0？
    price_limit: Optional[str]   # 涨跌停带
    lot: str
    fees: str
    currency: str


MARKETS: Dict[str, MarketRules] = {
    "a_share": MarketRules(
        key="a_share", label="A股", engine="ChinaAEngine",
        can_short=False, same_day_roundtrip=False,
        price_limit="主板 ±10% / 创业板科创板 ±20% / 北交所 ±30%",
        lot="100 股整手（不足一手只能卖不能买）",
        fees="佣金万2.5(最低 5 元) + 过户费万0.1 双边 + 印花税万5 卖出单边",
        currency="CNY",
    ),
    "hk_equity": MarketRules(
        key="hk_equity", label="港股", engine="GlobalEquityEngine",
        can_short=True, same_day_roundtrip=True, price_limit=None,
        lot="按 100 股简化（真实每只票每手股数不同）",
        fees="印花税 0.1% 双边 + 交易征费等",
        currency="HKD",
    ),
    "us_equity": MarketRules(
        key="us_equity", label="美股", engine="GlobalEquityEngine",
        can_short=True, same_day_roundtrip=True, price_limit=None,
        lot="支持碎股（取到 0.01 股）",
        fees="零佣金（零售券商）",
        currency="USD",
    ),
}


# ── 口径表：这是「需要什么」的事实来源 ──

@dataclass(frozen=True)
class Style:
    key: str
    label: str
    holding: str
    interval: str
    min_bars: int
    why_min: str
    position_adjustment: str


STYLES: Dict[str, Style] = {
    "long": Style(
        key="long", label="长线", holding="持仓以月 / 季度计", interval="1D",
        min_bars=480,
        why_min="持仓周期以月计时，两年才够十来个完整的进出；样本再少，胜率与盈亏比就是几笔交易的偶然",
        position_adjustment="hold",
    ),
    "swing": Style(
        key="swing", label="短线 / 波段", holding="持仓以天 / 周计", interval="1D",
        min_bars=240,
        why_min="持仓以周计时，一年约能形成几十笔交易，统计量才开始有意义",
        position_adjustment="rebalance",
    ),
    "intraday": Style(
        key="intraday", label="做 T（日内回转）", holding="当日进出", interval="1m",
        min_bars=0,
        why_min="",
        position_adjustment="rebalance",
    ),
}


@dataclass(frozen=True)
class Refusal:
    """这个回测不成立。``reason`` 说为什么，``remedy`` 说怎么才能跑。"""

    reason: str
    remedy: str

    def __bool__(self) -> bool:      # 便于 `if not plan:` 这样用
        return False


@dataclass(frozen=True)
class Plan:
    """一个能跑的回测。``limits`` 是**必须随结果一起呈现**的限制说明。"""

    codes: List[str]
    market: MarketRules
    style: Style
    start: str
    end: str
    interval: str
    initial_cash: float
    limits: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    #: 调用方是否声明了要做空。运行期要拿它与**策略真正发出的信号**对一次 ——
    #: 只靠调用方声明是不够的：忘了声明而策略发出负权重时，引擎会静默拒单，
    #: 报告描述的就变成「删掉所有做空信号后的策略」，而不是用户写的那个。
    allow_short: bool = False

    def __bool__(self) -> bool:
        return True

    def to_config(self) -> Dict[str, Any]:
        """转成引擎吃的 config。"""
        return {
            "codes": list(self.codes),
            "start_date": self.start,
            "end_date": self.end,
            "interval": self.interval,
            "initial_cash": self.initial_cash,
            "position_adjustment": self.style.position_adjustment,
            "source": "vibe",
            # 对照用本市场的指数；取不到时结果里如实写明，不悄悄当成指数
            "benchmark": INDEX_BENCHMARKS[self.market.key].ticker,
            # 稳健性检验默认打开：夏普的重抽样置信区间 + 把净值切成 5 段分别看
            "validation": {"bootstrap": {"n_bootstrap": 1000, "confidence": 0.95, "seed": 42},
                           "walk_forward": {"n_windows": 5}},
        }


def _parse_day(s: str, what: str) -> date:
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(s)):
            raise ValueError("date_format")
        return datetime.fromisoformat(str(s)).date()
    except ValueError as exc:
        raise ValueError(f"{what} 要写成 YYYY-MM-DD，收到 {s!r}") from exc


def _trading_days(start: date, end: date) -> int:
    """粗估区间内的交易日数（按每周 5 天，不扣长假 —— 只用来判「够不够」，宁可高估）。"""
    return max(int((end - start).days * 5 / 7), 0)


def plan_backtest(
    codes: Sequence[str],
    start: str,
    end: str,
    style: str = "swing",
    initial_cash: float = 1_000_000.0,
    allow_short: bool = False,
) -> Plan | Refusal:
    """闸口本体。返回能跑的 :class:`Plan`，或说得清的 :class:`Refusal`。"""

    # ① 要回测什么 —— 代码是否认得出、属于哪个市场
    if not codes:
        return Refusal("没给标的代码", "给至少一个代码，如 600519.SH / AAPL / 00700.HK")
    try:
        canon = [canonical_code(c) for c in codes]
    except LoaderError as exc:
        return Refusal(str(exc), "把代码写全（带交易所后缀）再试")

    try:
        # 🔴 这里也要接 —— 闸口的契约是「要么 Plan 要么 Refusal」。
        #    泄一个异常出去，调用方的 `if not plan:` 根本走不到，整条链直接崩。
        markets = {c: market_of(c) for c in canon}
    except LoaderError as exc:
        return Refusal(str(exc), "改用 A股 600519.SH / 美股 AAPL / 港股 00700.HK 这三种写法")
    unknown = {c: m for c, m in markets.items() if m not in MARKETS}
    if unknown:
        return Refusal(
            f"这一版只做 A股 / 港股 / 美股，认不出：{', '.join(f'{c}({m})' for c, m in unknown.items())}",
            "去掉这些代码，或等期货 / 外汇 / 加密那几个引擎接进来",
        )

    kinds = sorted(set(markets.values()))
    if len(kinds) > 1:
        names = " + ".join(MARKETS[k].label for k in kinds)
        return Refusal(
            f"一次只能回测一个市场，这批里有 {names} —— 它们的交易规则、"
            f"币种、交易日历都不一样，混在一个资金池里算出来的收益没有意义",
            "按市场分开跑，各出一份结果",
        )
    rules = MARKETS[kinds[0]]

    # A股只回测**个股**：ETF / 指数 / 可转债 的日线取不到（端点对它们返回空序列而不报错）。
    # 🔴 这条必须在闸口就判 —— 只在取数层拦的话，闸口会先说「能跑」，
    #    跑到一半才以「一只标的的数据都没取到」中止，说的不是真正的原因。
    if rules.key == "a_share":
        try:
            for c in canon:
                assert_a_share_stock(c)
        except LoaderError as exc:
            return Refusal(str(exc), "换成个股代码；ETF / 指数 / 可转债 要等对应的取数接进来")

    # ② 需要什么 —— 口径决定 bar 粒度与最少样本
    st = STYLES.get(style)
    if st is None:
        return Refusal(
            f"不认识的口径 {style!r}",
            "用 long（长线）/ swing（短线波段）/ intraday（做T）之一",
        )

    try:
        d0, d1 = _parse_day(start, "start"), _parse_day(end, "end")
    except ValueError as exc:
        return Refusal(str(exc), "改成 YYYY-MM-DD")
    if d0 >= d1:
        return Refusal(f"start 不早于 end（{start} → {end}）", "把区间调过来")

    # ③ 限制是什么 —— 先看有没有直接不成立的
    if st.key == "intraday":
        if not rules.same_day_roundtrip:
            return Refusal(
                f"{rules.label}是 T+1，当天买入当天卖不掉 —— 真实的「做T」是「有底仓、"
                f"当日先卖后买」，跟「当日买入再卖出」是两回事，这一版的引擎表达不了",
                "改用 swing（短线波段）看多日持仓的表现；做T 要等专门的一期",
            )
        return Refusal(
            "做T 要分钟级 bar，而这一版的取数只做日线 —— "
            "拿日线跑日内策略，出来的数字看着完全正常，但它测的不是日内",
            "等做T 那一期把分钟级数据接进来；现在可以先用 swing 看看多日持仓的表现",
        )

    cash = float(initial_cash) if isinstance(initial_cash, (int, float)) else float("nan")
    if not (cash > 0) or cash in (float("inf"), float("-inf")) or cash != cash:
        return Refusal(
            f"起始资金要是一个大于 0 的有限数字，收到 {initial_cash!r}",
            "给个正常的数，比如 1000000",
        )
    # 一手都买不起时算不出任何东西，但引擎照样会输出一份「总收益 0.00%」的完整报告
    if cash < 10_000:
        return Refusal(
            f"起始资金 {cash:,.0f} 太小 —— {rules.label}最小交易单位是{rules.lot}，"
            f"很可能一手都买不起，回测会得到一份「零成交、总收益 0.00%」的报告，看不出是资金不够",
            "把起始资金调到能买得起至少一手的水平",
        )

    est = _trading_days(d0, d1)
    if est < st.min_bars:
        return Refusal(
            f"{st.label}至少要约 {st.min_bars} 根日线，这个区间大约只有 {est} 根。"
            f"{st.why_min}",
            f"把区间拉长到约 {round(st.min_bars * 7 / 5 / 365, 1)} 年以上，或改用更短的口径",
        )

    if allow_short and not rules.can_short:
        return Refusal(
            f"{rules.label}散户不能做空，引擎会把做空信号直接拒掉 —— "
            f"带做空的策略在这里回测出来的是「只做多」的结果，不是你写的那个策略",
            "把策略改成只做多，或换到港股 / 美股",
        )

    limits = [
        f"交易机制：{'T+0，当日可回转' if rules.same_day_roundtrip else 'T+1，当日买入次日才能卖'}",
        f"做空：{'允许' if rules.can_short else '不允许（做空信号会被拒掉）'}",
        f"最小交易单位：{rules.lot}",
        f"费用：{rules.fees}",
        f"计价币种：{rules.currency}",
    ]
    if rules.price_limit:
        limits.append(f"涨跌停：{rules.price_limit}；创业板 2020-08-24 前按 ±10%。用不复权前收按交易所规则四舍五入到分算涨跌停价，开盘就在涨跌停价视为封板、不成交；取不到不复权价时按复权价近似。ST、上市初期/退市例外未建模，不等于真实撮合。")

    notes = [
        f"口径：{st.label}（{st.holding}）",
        f"bar 粒度：日线；区间约 {est} 根",
        "信号按次日开盘执行（当日收盘拿到的信号不会当日成交）",
        price_basis(rules.key),
    ]
    if len(canon) == 1:
        notes.append("单只标的：没有分散，最大回撤基本等于这只票自己的回撤")

    return Plan(
        codes=canon, market=rules, style=st, start=str(d0), end=str(d1),
        interval=st.interval, initial_cash=float(initial_cash),
        limits=limits, notes=notes, allow_short=bool(allow_short),
    )
