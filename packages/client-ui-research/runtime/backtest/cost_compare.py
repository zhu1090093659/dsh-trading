"""扣费前后对照：同一套信号、费用和滑点全设为零再跑一遍，看交易成本吃掉多少收益。

主回测的 execution_fees 只是成交记录里扣掉的费用合计，滑点藏在成交价里看不出来；
换手高的策略，这两样加起来可能把账面收益吃掉一大块。这里用主回测已经缓存的同一份数据，
把成本全部归零重跑一次，两次的差就是「成本吃掉的部分」（含复利：省下的钱也会接着滚）。

不计成本那次不代表能做到的收益 —— 现实里交易不可能零成本，它只是用来量成本有多重。
A 股、港股按整手买，省下的费用可能让个别买单多买一手，所以两次的成交笔数可能差一点。
A 股贴着涨跌停价开盘时，实际那次加上滑点会越过涨跌停价、成交不了，不计成本那次能成交（开盘就在涨跌停价的两次都不成交）。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from backtest.run import run
from backtest.strategies import BUILTIN

# 两个引擎所有的费用和滑点参数。新加市场或费用项时这里要跟着补 ——
# 测试会逐个市场核对：用这组参数建出来的引擎，费用为 0、成交价等于原价。
ZERO_COST: Dict[str, float] = {
    # A 股（engines/china_a.py）
    "commission_rate": 0.0, "commission_min": 0.0, "stamp_tax": 0.0, "transfer_fee": 0.0, "slippage": 0.0,
    # 港美股、加拿大（engines/global_equity.py）
    "slippage_us": 0.0, "slippage_hk": 0.0, "slippage_ca": 0.0,
    "hk_commission": 0.0, "hk_stamp_tax": 0.0, "hk_levy": 0.0, "hk_settlement": 0.0, "ca_commission": 0.0,
}

KEYS = ("total_return", "annual_return", "max_drawdown", "sharpe", "fill_count")

NOTE = ("不计成本：同一套信号把费用和滑点都设为零再跑一遍，只用来量交易成本吃掉多少，现实里做不到零成本；"
        "成本吃掉 = 不计成本的收益 − 实际收益（含复利）。整手取整，以及滑点让贴着涨跌停价开盘的单子成交不了，"
        "都可能让两次成交笔数略有不同。")


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v else None


def compare(plan, key: str, params: Dict[str, Any], loader, run_dir: Path, actual: Dict[str, Any]) -> Dict[str, Any]:
    """``loader`` 必须是主回测用过的那个实例（数据已缓存）。``actual`` 是主回测的 metrics。

    重跑失败不影响主结果：返回 ``{"error": ...}``，界面和报告照常给主回测的数。
    """
    try:
        strategy = BUILTIN[key](**params)
        r = run(plan, strategy, run_dir=run_dir, loader=loader, config_overrides={"validation": None, **ZERO_COST})
    except Exception as exc:  # noqa: BLE001
        return {"error": f"不计成本那次没有跑出来（{type(exc).__name__}），只看实际扣费后的结果"}
    free = {k: r.metrics.get(k) for k in KEYS}
    drag = {}
    for k in ("total_return", "annual_return"):
        a, f = _num(actual.get(k)), _num(free.get(k))
        drag[k] = None if a is None or f is None else round(f - a, 6)
    fees = _num(r.metrics.get("execution_fees"))
    if fees:
        # 走到这里说明 ZERO_COST 漏了某个费用参数：宁可不给对照，也不给一个偏小的「成本吃掉」
        return {"error": f"不计成本那次仍扣了 {fees:g} 的费用，对照不成立，没有给出"}
    return {"cost_free": free, "drag": drag, "note": NOTE}
