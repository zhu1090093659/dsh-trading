"""持仓体检的 **JSON 入口**：stdin 进 ``{positions: [{symbol, name, value}]}``，stdout 出按币种分开的体检结果。

给「我的持仓」页用，不需要模型。价格走 K 线工具（A 股前复权 = 腾讯不复权价 × 新浪因子；港美股 Yahoo），
风险数字全部由 ``risk_xray.compute_risk_xray`` 算，这里只负责取数、分组、对齐和说清缺口。

🔴 不同币种**分别体检**：不做汇率换算就不能把人民币和美元的市值放进同一个权重里。
🔴 只给数字和缺口，**不出综合分**、不评好坏；超没超线由用户在页面上自己设阈值来判断。
🔴 缺数据就进缺口（没现价、历史太短、北交所、行业没取到），不拿 0 或别的票去凑。
🔴 港美股价格只做了拆股调整、没含分红，除息日会多出一个小跌幅 —— 明写在说明里。

用法::

    echo '{"positions":[{"symbol":"600519","name":"贵州茅台","value":125000}]}' | python -m backtest.portfolio_xray
"""

from __future__ import annotations

import json
import math
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from backtest import gics, kline
from backtest.loader import LoaderError, _a_lookup, bare, canonical_code, market_of
from backtest.risk_xray import compute_risk_xray
from backtest.stdio_utf8 import force_utf8_stdio

#: 体检窗口：最近一年的日收盘价
WINDOW_DAYS = 365
#: 窗口内至少要有这么多根才参与计算（约三个月）
MIN_BARS = 60
MAX_POSITIONS = 60
FETCH_WORKERS = 4

#: 市场 → (币种, 页面上的名字)。分组顺序也按这个来
GROUPS = {"a_share": ("CNY", "A 股 · 人民币"), "hk_equity": ("HKD", "港股 · 港元"), "us_equity": ("USD", "美股 · 美元")}

#: 申万 2021 版一级行业。2026-10-08 对照申万研究所官方代码表
#: https://www.swsresearch.com/swindex/pdf/SwClass2021/SwClassCode_2021.xls 逐条核对（31 个）
SW_L1 = {
    "110000": "农林牧渔", "220000": "基础化工", "230000": "钢铁", "240000": "有色金属", "270000": "电子",
    "280000": "汽车", "330000": "家用电器", "340000": "食品饮料", "350000": "纺织服饰", "360000": "轻工制造",
    "370000": "医药生物", "410000": "公用事业", "420000": "交通运输", "430000": "房地产", "450000": "商贸零售",
    "460000": "社会服务", "480000": "银行", "490000": "非银金融", "510000": "综合", "610000": "建筑材料",
    "620000": "建筑装饰", "630000": "电力设备", "640000": "机械设备", "650000": "国防军工", "710000": "计算机",
    "720000": "传媒", "730000": "通信", "740000": "煤炭", "750000": "石油石化", "760000": "环保", "770000": "美容护理",
}
FUND_INDUSTRY = "ETF / 基金（不归入单一行业）"
NO_INDUSTRY = "行业未取到"
#: 港美股东财没有公司资料、或资料里两种行业都没写的（多是 ETF / 基金，但东财的搜索结果分不出来，不硬判）
NO_PROFILE = "没有行业资料（ETF、基金多是这样）"


class XrayError(ValueError):
    """整次体检做不了（入参不对）—— 作为 ``ok: false`` 的原因原样给界面。单只的问题进缺口，不走这里。"""


def _r(v: Optional[float], digits: int = 6) -> Optional[float]:
    return round(v, digits) if v is not None and math.isfinite(v) else None


def _parse(req: Dict[str, Any], what: str = "体检") -> Tuple[Dict[str, List[Dict[str, Any]]], List[Dict[str, str]]]:
    """入参 → 按市场分好的持仓 + 一开始就进缺口的条目。同一代码出现多次按市值合并。

    情景回放也用它（``what="回放"``），两边对持仓的校验和缺口口径保持一致。
    """
    positions = req.get("positions")
    if not isinstance(positions, list) or not positions:
        raise XrayError(f"没有持仓可以{what}：positions 要是一个非空列表")
    if len(positions) > MAX_POSITIONS:
        raise XrayError(f"一次最多{what} {MAX_POSITIONS} 只")
    groups: Dict[str, Dict[str, Dict[str, Any]]] = {}
    gaps: List[Dict[str, str]] = []
    for p in positions:
        if not isinstance(p, dict):
            raise XrayError("positions 里每一项都要是对象")
        raw, name = p.get("symbol"), p.get("name")
        name = name.strip()[:40] if isinstance(name, str) else ""
        if not isinstance(raw, str) or not raw.strip() or len(raw) > 20:
            raise XrayError("每只持仓都要有代码，如 600519 / AAPL / 00700.HK")
        try:
            code = canonical_code(raw)
            market = market_of(code)
        except LoaderError as exc:
            gaps.append({"symbol": raw.strip(), "name": name, "reason": f"代码认不出：{exc}"})
            continue
        value = p.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            gaps.append({"symbol": code, "name": name, "reason": "没有现价算出的市值（可能行情没取到），算不了权重"})
            continue
        slot = groups.setdefault(market, {}).setdefault(code, {"symbol": code, "name": name, "value": 0.0})
        slot["value"] += float(value)
        slot["name"] = slot["name"] or name
    return {m: list(v.values()) for m, v in groups.items()}, gaps


def _closes(code: str, out_dir: Path) -> Tuple[Optional[pd.Series], Optional[str], Optional[Dict[str, Any]]]:
    """一只的日收盘价序列（A 股前复权）。返回 (序列, 取不到的原因, 来源信息)。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        got = kline.build({"symbol": code, "period": "day", "adjust": "qfq", "charts": True}, out_dir)
    except (kline.KlineError, LoaderError) as exc:
        return None, str(exc), None
    s = got["ui_only"]["series"]
    ser = pd.Series(s["close"], index=pd.to_datetime(s["dates"]), dtype="float64")
    return ser, None, {"source": got["source"], "fetched_at": got["fetched_at"], "adjust_label": got["adjust_label"],
                       "adjust": got.get("adjust")}


def _industries(codes: List[str]) -> Tuple[Dict[str, str], List[Dict[str, str]], Optional[str]]:
    """A 股申万一级行业。ETF / 指数归到「ETF / 基金」，取不到的进缺口。"""
    out: Dict[str, str] = {}
    gaps: List[Dict[str, str]] = []
    stocks: List[str] = []
    for code in codes:
        try:
            is_stock = _a_lookup(bare(code))[1]
        except LoaderError:
            is_stock = True
        if is_stock:
            stocks.append(code)
        else:
            out[code] = FUND_INDUSTRY
    if not stocks:
        return out, gaps, None
    try:
        from sources.sw import sw_industry  # kline 已把取数层脚本目录放进 sys.path
    except ImportError as exc:  # pragma: no cover - 取数层缺失属于安装问题
        return out, [{"symbol": c, "reason": f"申万行业模块载入失败：{exc}"} for c in stocks], None
    as_of = None
    for code in stocks:
        try:
            got = sw_industry(bare(code))
        except Exception as exc:  # noqa: BLE001 - 网络 / 表结构问题都只影响这一项，进缺口
            gaps.append({"symbol": code, "reason": f"申万行业没取到：{type(exc).__name__}: {str(exc)[:120]}"})
            continue
        as_of = got.get("as_of") or as_of
        cur = got.get("current")
        name = SW_L1.get(str((cur or {}).get("l1_code") or ""))
        if name:
            out[code] = name
        else:
            why = "申万表里没有这只的行业归属" if not cur else f"申万一级代码 {cur.get('l1_code')} 不在名称表里"
            gaps.append({"symbol": code, "reason": why})
    return out, gaps, as_of


def _global_industries(codes: List[str], market: str) -> Tuple[Dict[str, str], Dict[str, str], List[Dict[str, str]]]:
    """港美股 GICS 一级行业（东财公司资料）。返回 (一级行业, 东财细分行业名, 缺口)。

    港股用东财给的 GICS 四级路径取第一段；美股只有细分行业名，按 gics.US_INDUSTRY_SECTOR 对回一级。
    东财没有公司资料、或资料里一个行业都没写的单独归一组（NO_PROFILE，多是 ETF / 基金）；
    写了行业但对不回 GICS 一级的、没取到的进缺口，不猜。"""
    try:
        from sources import eastmoney as em  # kline 已把取数层脚本目录放进 sys.path
    except ImportError as exc:  # pragma: no cover - 取数层缺失属于安装问题
        return {}, {}, [{"symbol": c, "reason": f"行业模块载入失败：{exc}"} for c in codes]
    mkt = "HK" if market == "hk_equity" else "US"

    def one(code: str) -> Tuple[str, Optional[Dict[str, Any]], Optional[str]]:
        try:
            return code, em.global_industry(bare(code), mkt), None
        except Exception as exc:  # noqa: BLE001 - 网络 / 没收录都只影响这一只，进缺口
            return code, None, f"行业没取到：{type(exc).__name__}: {str(exc)[:120]}"

    sectors: Dict[str, str] = {}
    details: Dict[str, str] = {}
    gaps: List[Dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        for code, got, why in pool.map(one, codes):
            if why:
                gaps.append({"symbol": code, "reason": why})
                continue
            industry = (got or {}).get("industry")
            sector = gics.hk_sector((got or {}).get("gics_path")) if mkt == "HK" else gics.us_sector(industry)
            if industry:
                details[code] = industry
            if sector:
                sectors[code] = sector
            elif not industry and not (got or {}).get("gics_path"):
                sectors[code] = NO_PROFILE
            elif mkt == "HK":
                gaps.append({"symbol": code, "reason": "东财公司资料里没有这只的 GICS 行业"})
            else:
                gaps.append({"symbol": code, "reason": f"东财行业「{industry}」不在 GICS 对照表里"})
    return sectors, details, gaps


def _buckets(weights: Dict[str, float], ind_map: Dict[str, str]) -> List[Dict[str, Any]]:
    buckets: Dict[str, Dict[str, Any]] = {}
    for sym, w in weights.items():
        name = ind_map.get(sym, NO_INDUSTRY)
        b = buckets.setdefault(name, {"name": name, "weight": 0.0, "symbols": []})
        b["weight"] += w
        b["symbols"].append(sym)
    return sorted(({**b, "weight": _r(b["weight"])} for b in buckets.values()), key=lambda b: -(b["weight"] or 0))


def _group(market: str, positions: List[Dict[str, Any]], out_dir: Path) -> Dict[str, Any]:
    currency, label = GROUPS[market]
    total = sum(p["value"] for p in positions)
    gaps: List[Dict[str, str]] = []
    notes: List[str] = []

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        fetched = list(pool.map(lambda ip: _closes(ip[1]["symbol"], out_dir / f"p{ip[0]}"), enumerate(positions)))
    series: Dict[str, pd.Series] = {}
    sources = set()
    unadjusted = set()      # K 线工具说这只没有复权因子、给的是不复权价（如部分 ETF）
    for p, (ser, why, meta) in zip(positions, fetched):
        if ser is None:
            gaps.append({"symbol": p["symbol"], "name": p["name"], "reason": f"历史价格没取到：{why}"})
            continue
        series[p["symbol"]] = ser
        sources.add((meta or {}).get("source") or "")
        if (meta or {}).get("adjust") == "none":
            unadjusted.add(p["symbol"])

    included: List[Dict[str, Any]] = []
    panel = None
    if series:
        last = max(s.index.max() for s in series.values())
        start = last - timedelta(days=WINDOW_DAYS)
        frame = pd.DataFrame(series).sort_index()
        frame = frame[frame.index >= start]
        for p in positions:
            sym = p["symbol"]
            if sym not in frame:
                continue
            n = int(frame[sym].count())
            if n < MIN_BARS:
                gaps.append({"symbol": sym, "name": p["name"],
                             "reason": f"最近一年只有 {n} 个交易日的价格（至少要 {MIN_BARS} 天），不参与计算"})
                frame = frame.drop(columns=sym)
                continue
            included.append(p)
        if included:
            # 停牌那几天没有价格：按停牌前收盘价算（当天收益记 0），不让一只停牌把所有票的共同区间砍短
            filled = frame.ffill()
            halted = {sym: int((frame[sym].isna() & filled[sym].notna()).sum()) for sym in frame}
            for sym, n in halted.items():
                if n:
                    notes.append(f"{sym} 窗口内有 {n} 个交易日没有价格（多半是停牌），按停牌前收盘价计")
            panel = filled

    result: Dict[str, Any] = {
        "market": market, "currency": currency, "label": label,
        "total_value": _r(total, 2), "positions_input": len(positions), "positions_included": len(included),
        "positions": [], "metrics": None, "industry": None, "gaps": gaps, "notes": notes,
        "sources": sorted(s for s in sources if s),
    }
    if not included or panel is None:
        notes.append("这一组没有可以计算的持仓，只列出缺口")
        return result

    inc_total = sum(p["value"] for p in included)
    weights = {p["symbol"]: p["value"] / inc_total for p in included}
    if len(included) < len(positions):
        notes.append(f"权重只在算得出来的 {len(included)} 只之间分配（它们占这一组市值的 {inc_total / total:.1%}）")
    try:
        x = compute_risk_xray(panel[list(weights)], weights, min_history=MIN_BARS)
    except ValueError as exc:
        notes.append(f"风险指标算不出来：{exc}")
        return result

    ind_detail: Dict[str, str] = {}
    if market == "a_share":
        ind_map, ind_gaps, ind_as_of = _industries(list(weights))
        classification = "申万 2021 一级行业" + (f"（按 {ind_as_of} 的归属）" if ind_as_of else "")
    else:
        ind_map, ind_detail, ind_gaps = _global_industries(list(weights), market)
        classification = "GICS 一级行业（东财公司资料；美股按东财给的细分行业对回一级）"
    for g in ind_gaps:
        g["name"] = next((p["name"] for p in included if p["symbol"] == g["symbol"]), "")
    gaps.extend(ind_gaps)
    result["industry"] = {"classification": classification, "buckets": _buckets(weights, ind_map)}

    shares = (x.get("risk_contribution") or {}).get("shares") or {}
    vols = x.get("asset_vol_annualized") or {}
    result["positions"] = sorted(({
        "symbol": p["symbol"], "name": p["name"], "value": _r(p["value"], 2),
        "weight": _r(weights[p["symbol"]]), "risk_share": shares.get(p["symbol"]),
        "vol_annualized": vols.get(p["symbol"]), "industry": ind_map.get(p["symbol"]),
        **({"industry_detail": ind_detail[p["symbol"]]} if p["symbol"] in ind_detail else {}),
    } for p in included), key=lambda r: -(r["weight"] or 0))
    conc, inp = x["concentration"], x["inputs"]
    top = result["positions"][0]
    result["metrics"] = {
        "window": {"first_date": str(pd.Timestamp(inp["first_date"]).date()), "last_date": str(pd.Timestamp(inp["last_date"]).date()),
                   "days": inp["aligned_days"]},
        "top1": {"symbol": top["symbol"], "name": top["name"], "weight": top["weight"]},
        "top3_weight": conc.get("top3_weight"), "effective_n": conc.get("effective_n"), "hhi": conc.get("hhi"),
        "annualized_vol": x["volatility"].get("annualized_vol"),
        "downside_vol": x["volatility"].get("downside_deviation_annualized"),
        "max_drawdown": x["drawdown"].get("max_drawdown"),
        "max_drawdown_start": _date(x["drawdown"].get("max_drawdown_start")),
        "max_drawdown_trough": _date(x["drawdown"].get("max_drawdown_trough")),
        "var_95": x["tail_risk"].get("var_95"), "es_95": x["tail_risk"].get("expected_shortfall_95"),
        "diversification_ratio": x["diversification"].get("diversification_ratio"),
        "avg_abs_corr": x["correlation"].get("avg_pairwise_abs"),
        "max_corr_pair": x["correlation"].get("max_pair"),
    }
    result["_matrix"] = x.get("correlation_matrix")
    notes.append("按现在的持仓比例，回看这些股票最近一年的日收盘价算的；不代表未来，也不是当时真实的持仓")
    if market == "a_share":
        raw = [p["symbol"] for p in included if p["symbol"] in unadjusted]
        if len(raw) < len(included):
            notes.append("A 股价格是前复权（新浪复权因子等比换算），分红送转不会被当成下跌")
        if raw:
            notes.append(f"{'、'.join(raw)} 没有复权因子，用的是不复权价，除权除息日会多出一个跌幅")
    else:
        notes.append("港美股价格只做了拆股调整、没有含分红，除息日会多出一个小跌幅")
    return result


def _date(v: Any) -> Optional[str]:
    return str(pd.Timestamp(v).date()) if v else None


def build(req: Dict[str, Any], out_dir: Path) -> Dict[str, Any]:
    groups, gaps = _parse(req)
    out = [_group(m, groups[m], out_dir / m) for m in GROUPS if m in groups]
    matrices = {g["currency"]: g.pop("_matrix", None) for g in out}
    result: Dict[str, Any] = {"groups": out, "gaps": gaps, "window_days": WINDOW_DAYS, "min_bars": MIN_BARS}
    if req.get("charts") is True:
        # 相关性矩阵只给界面画热力图；Agent 那条路不带（60 只就是 3600 个数，对写报告没用）
        result["ui_only"] = {"correlation": {c: m for c, m in matrices.items() if m}}
    return result


CATALOG = {
    "description": "持仓体检：按币种分别算集中度（最大一只、前三合计、等效持股数）、年化波动、最大回撤、"
                   "单日 95% 历史 VaR / ES、每只的风险贡献、两两相关性和行业暴露（A 股按申万一级，港美股按 GICS 一级）。"
                   "回看最近一年日收盘价；缺数据的进缺口。只给数字，不出综合分，不给买卖建议。",
    "parameters": {
        "positions": "[{symbol: 600519 / AAPL / 00700.HK, name: 可选, value: 当前市值（原币种）}]，最多 60 只",
        "charts": "true 时附各组相关性矩阵（界面画图用）",
    },
}


def main() -> None:
    force_utf8_stdio()
    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"入参不是合法 JSON：{exc}"}, ensure_ascii=False))
        return
    if not isinstance(req, dict):
        print(json.dumps({"ok": False, "error": "入参必须是对象"}, ensure_ascii=False))
        return
    if req.get("action") == "catalog":
        print(json.dumps({"ok": True, "catalog": CATALOG}, ensure_ascii=False))
        return
    try:
        with tempfile.TemporaryDirectory(prefix="vra-xray-") as scratch:
            result = build(req, Path(scratch))
    except XrayError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
