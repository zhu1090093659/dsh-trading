"""展示层格式化(确定性)。公式层(formulas / series / indicators)按 SPEC 不做四舍五入;cli.py 在记录落盘前
给 output 附一个 `display` 字符串,报告正文一律照抄它,不让 agent 自己对 15 位浮点做心算 / 换算。

规则(全部确定性,无 locale、无千分位):
- status ≠ ok / value 为 null / 非有限数 → display = None。
- **|x| ≥ 1 留 2 位小数;|x| < 1 留 4 位有效数字**:37.397700 → "37.40";2.5085 → "2.51";943 → "943.00";1.0 → "1.00";
  0.6328580 → "0.6329"(小数不只留 2 位,免得 0.63 丢掉信息);0.000123456 → "0.0001235"。
- 单位映射:
  - `小数`(比率 / 同比 / 环比 / CAGR)→ 百分比:2.004222 → "200.42%";0.2896 → "28.96%"
  - `%`(已是百分数,如分位)→ "64.91%";`百分点` → "-141.33 百分点"
  - `倍` → "37.40 倍";`年` → "2.35 年";`期`(计数)→ 整数 "11 期";`元/股` → "27.68 元/股"
  - 金额 `元 / 万元 / 亿元` → 先归一到元,再按量级选单位:≥ 1 亿 → "204.53 亿元";≥ 1 万 → "3.25 万元";否则 "943.00 元"
  - 美元 / 港元同理(0.5.0):`美元 / 万美元 / 亿美元` → "1124.80 亿美元";`港元 …` → "3.25 万港元";`美元/股` 这类每股单位不换算
  - 其他单位 → "<数> <单位>"(未知单位不猜换算)
与绑定校验的关系:编排器 hardtest 的 numberBound 允许 ×100 / ×1e4 / ×1e8 等量纲变体与 0.2% 相对容差,
上述格式化后的数字仍能绑定回原始 value(测试覆盖)。
"""
from __future__ import annotations

import math
from typing import Any, Optional

MIN_DECIMALS = 2
SIG_DIGITS = 4
YUAN_SCALE = {"元": 1.0, "万元": 1e4, "亿元": 1e8}
# 金额单位 → (基本单位, 倍数);展示时按量级换回 亿 / 万
MONEY_SCALE = {**{u: ("元", s) for u, s in YUAN_SCALE.items()},
               "美元": ("美元", 1.0), "万美元": ("美元", 1e4), "亿美元": ("美元", 1e8),
               "港元": ("港元", 1.0), "万港元": ("港元", 1e4), "亿港元": ("港元", 1e8)}


def format_number(value: float, min_decimals: int = MIN_DECIMALS, sig: int = SIG_DIGITS) -> str:
    """定点写法(无千分位):|v| ≥ 1 → min_decimals 位小数(37.40 / 1.00 / 943.00);|v| < 1 → sig 位有效数字(0.6329 / 0.0001235);0 → "0.00"。
    两种写法的舍入误差都落在编排器数字绑定校验的容差内(绝对 5e-3 / 相对 2e-3,见 test_display.py)。"""
    v = float(value)
    if v == 0.0:
        return f"{0.0:.{min_decimals}f}"
    decimals = min_decimals if abs(v) >= 1 else max(min_decimals, sig - 1 - int(math.floor(math.log10(abs(v)))))
    s = f"{v:.{decimals}f}"
    return f"{0.0:.{decimals}f}" if float(s) == 0.0 else s


def _is_int_like(v: float) -> bool:
    return float(v).is_integer()


def _fmt(v: float) -> Optional[str]:
    """缩放后再校验一次有限性:1e308 × 100 会溢出成 inf,不能把 inf 当展示值吐出去。"""
    return format_number(v) if math.isfinite(v) else None


def format_display(output: dict) -> Optional[str]:
    """由 output{status,value,unit} 生成展示字符串;不可展示时返回 None(绝不抛出)。"""
    if not isinstance(output, dict) or output.get("status") != "ok":
        return None
    v: Any = output.get("value")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        return None
    unit = output.get("unit") or ""
    v = float(v)
    if unit == "小数":
        s = _fmt(v * 100.0)
        return None if s is None else f"{s}%"
    if unit == "%":
        s = _fmt(v)
        return None if s is None else f"{s}%"
    if unit in MONEY_SCALE:
        base_unit, scale = MONEY_SCALE[unit]
        amount = v * scale
        if not math.isfinite(amount):
            return None
        if abs(amount) >= 1e8:
            s, u = _fmt(amount / 1e8), "亿" + base_unit
        elif abs(amount) >= 1e4:
            s, u = _fmt(amount / 1e4), "万" + base_unit
        else:
            s, u = _fmt(amount), base_unit
        return None if s is None else f"{s} {u}"
    if unit == "期":
        return f"{int(v)} 期" if _is_int_like(v) else f"{format_number(v)} 期"
    if unit == "":
        return format_number(v)
    return f"{format_number(v)} {unit}"


MAX_NESTED_DEPTH = 4


def _is_result_shaped(d: Any) -> bool:
    return isinstance(d, dict) and "status" in d and "value" in d and "unit" in d


def _with_nested_display(obj: Any, depth: int = 0) -> Any:
    """details 里凡是"结果形"子对象(含 status / value / unit,如 pe_digestion_scenarios.details.scenarios[*])都附 display;
    其余原样。递归深度封顶,返回新对象不改入参。"""
    if depth > MAX_NESTED_DEPTH:
        return obj
    if isinstance(obj, dict):
        out = {k: _with_nested_display(v, depth + 1) for k, v in obj.items()}
        if _is_result_shaped(obj) and "display" not in obj:
            out["display"] = format_display(obj)
        return out
    if isinstance(obj, list):
        return [_with_nested_display(x, depth + 1) for x in obj]
    return obj


def attach_display(output: dict) -> dict:
    """返回带 display 键的新 dict(不改入参;与库的不可变约定一致);details 里的结果形子对象也各自附 display
    (多结果函数顶层 value 为 null,四锚年数等在 details 里,报告照抄子结果的 display)。"""
    details = output.get("details")
    new_details = _with_nested_display(details) if isinstance(details, (dict, list)) else details
    return {**output, "details": new_details, "display": format_display(output)}
