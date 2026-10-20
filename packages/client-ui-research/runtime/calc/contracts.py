"""确定性计算的入参形状契约。只校验调用形状，不执行公式。"""
from __future__ import annotations

import inspect
import math


ARG_KINDS = {
    "pe_deducted_annualized": {"total_market_cap": "number", "cap_unit": "string", "latest_quarter_deducted_profit": "number", "profit_unit": "string"},
    "pe_ttm_from_parts": {"total_market_cap": "number", "cap_unit": "string", "ttm_profit": "number", "profit_unit": "string", "fx_rate": "number", "fx_unit": "string"},
    "forward_pe": {"price": "number", "eps_forecast": "number", "price_unit": "string", "eps_unit": "string", "fx_rate": "number", "fx_unit": "string"},
    "fx_convert": {"value": "number", "unit": "string", "fx_rate": "number", "fx_unit": "string"},
    "forward_cagr": {"eps_t": "number", "eps_t_plus_n": "number", "years": "integer"},
    "growth_rate": {"current": "number", "base": "number", "label": "string"},
    "ratio": {"numerator": "number", "denominator": "number", "label": "string", "unit_in": "string"},
    "peg": {"pe": "number", "cagr": "number"},
    "pe_digestion_years": {"pe": "number", "cagr": "number", "anchor": "number"},
    "pe_digestion_scenarios": {"pe": "number", "cagr": "number"},
    "percentile_rank": {"history": "sequence_or_source", "current": "number", "exclude_nonpositive": "boolean"},
    "consensus_dispersion": {"low": "number", "mean": "number", "high": "number"},
    "forward_vs_ttm_judgement": {"forward_cagr_value": "number", "ttm_yoy_value": "number", "tolerance_pp": "number"},
    "quarterize": {"cumulative": "sequence", "unit": "string", "money": "boolean"},
    "latest_quarter": {"single_quarters": "sequence", "unit": "string", "money": "boolean"},
    "ttm_sum": {"single_quarters": "sequence", "end_period": "string", "unit": "string", "money": "boolean"},
    "ttm_yoy": {"single_quarters": "sequence", "end_period": "string", "unit": "string", "money": "boolean"},
    "qoq": {"single_quarters": "sequence", "end_period": "string", "unit": "string", "money": "boolean"},
    "ttm_from_ytd": {"cumulative": "sequence", "end_period": "string", "unit": "string", "money": "boolean"},
    "ttm_yoy_from_ytd": {"cumulative": "sequence", "end_period": "string", "unit": "string", "money": "boolean"},
    "technical_indicators": {"klines": "sequence_or_source", "ma": "number_sequence", "ema": "number_sequence", "macd": "number_sequence", "rsi": "number_sequence", "kdj": "number_sequence", "boll": "number_sequence", "min_points": "integer"},
    "chip_distribution": {"klines": "sequence_or_source", "grid_size": "integer", "decay": "number", "min_points": "integer"},
    "earnings_reaction": {"klines": "sequence_or_source", "events": "sequence", "lookback": "integer"},
    "earnings_surprise": {"actual": "number", "estimate": "number", "low": "number", "high": "number", "unit": "string"},
}


def _kind_ok(value, kind: str) -> bool:
    if kind == "number":
        return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    if kind == "integer":
        return not isinstance(value, bool) and isinstance(value, int)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "string":
        return isinstance(value, str)
    if kind == "sequence":
        return isinstance(value, list)
    if kind == "number_sequence":
        return isinstance(value, list) and all(_kind_ok(item, "number") for item in value)
    if kind == "sequence_or_source":
        return isinstance(value, (list, dict))
    return False


def validate_contract(function: str, args: object, functions: dict) -> str | None:
    """返回 None 表示形状合法；否则返回不含原始入参的错误说明。"""
    fn = functions.get(function)
    kinds = ARG_KINDS.get(function)
    if fn is None or kinds is None:
        return f"未知函数 {function}"
    if not isinstance(args, dict):
        return "参数必须是 JSON 对象"
    signature = inspect.signature(fn)
    if set(signature.parameters) != set(kinds):
        return "计算契约与函数签名不一致"
    try:
        signature.bind(**args)
    except TypeError as exc:
        return f"参数错误:{exc}"
    for name, value in args.items():
        kind = kinds[name]
        if not _kind_ok(value, kind):
            return f"参数 {name} 必须是 {kind}"
    return None
