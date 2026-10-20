"""大宗温度计映射:每个品种一条价格证据 + 一条 30 日涨跌证据;护栏与陈旧状态原样进 note。

口径:
  - 大宗价格是**全市场证据**(不是某家公司的数据)→ 一律 symbol="MARKET",品种放 record_key(证据契约:market=CN 时 symbol 必须是 MARKET)。
  - 期货 market=CN / record_key=品种代码(CU0…)/ currency=CNY;period = 最新交易日。
  - DRAM market=US / record_key=品类(DDR5 / DDR4 / NAND_TLC)/ currency=USD;period = 最新报价日。
  - 陈旧(age_days 超阈值)→ note 写明"资料已陈旧 N 天,不代表当前",并把整个信封降为 partial。
"""
from __future__ import annotations

from sources.mappers import ev, out


def _chg_note(it: dict, base: str, guard: str) -> str:
    parts = [base, f"资料期 {it['date']}(距今 {it['age_days']} 天,序列 {it['n_points']} 点 {it['span']})"]
    if it.get("stale"):
        parts.append(f"⚠️ 资料已陈旧 {it['age_days']} 天,不代表当前价")
    if it.get("dropped_rows"):
        parts.append(f"已丢弃不合法行 {it['dropped_rows']} 条(日期或价格不合格)")
    for sk in it.get("skipped_windows") or []:
        parts.append(f"⚠️ 约 {sk['window_days']} 日涨跌未生成:最近可用基点 {sk['basis_date']} 距今 {sk['actual_gap_days']} 天,超出窗口不配叫该周期")
    parts.append(guard)
    return ";".join(parts)


def _chg_ev(ictx, prefix: str, it: dict, key: str, label: str, name: str, guard: str, today: str):
    """涨跌证据:note 必须写明**基点日期与实际自然日跨度**(Codex commodity-r1:序列稀疏时'约 7 日'可能是 27 天)。"""
    return ev(ictx, f"{prefix}_{key}", it[key], "%", it["date"], currency="n/a", as_of=today,
              record_key=it.get("symbol") or it.get("key"), raw_ref=it.get("raw_ref"),
              note=f"{name} {label}涨跌:{it['date']} 对比基点 {it.get(key.replace('_pct', '_basis'))}"
                   f"(实际间隔 {it.get(key.replace('_pct', '_gap_days'))} 自然日);{guard}")


def cn_commodity_futures_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    today = str(result.get("today") or "")
    guard = str(result.get("guard") or "")
    evs, stale = [], []
    for it in result.get("items") or []:
        base = f"{it['name']}({it['symbol']})连续合约收盘;用途:{it['use']}"
        ictx = {**ctx, "symbol": "MARKET", "market": "CN"}
        note = _chg_note(it, base, guard)
        if it.get("stale"):
            stale.append(it["symbol"])
        evs.append(ev(ictx, "commodity_futures_close", it["price"], it["unit"], it["date"], currency="CNY", as_of=today,
                      record_key=it["symbol"], raw_ref=it.get("raw_ref"), note=note))
        for k, label in (("chg1_pct", "较上一数据点"), ("chg7_pct", "约 7 日"), ("chg30_pct", "约 30 日")):
            if it.get(k) is None:
                continue
            evs.append(_chg_ev(ictx, "commodity_futures", it, k, label, it["name"], guard, today))
    errors = result.get("errors") or []
    deg = []
    if errors:
        deg.append("部分品种失败:" + "; ".join(errors)[:200])
    if stale:
        deg.append("资料陈旧:" + ",".join(stale))
    status = "ok" if evs and not errors and not stale else "partial" if evs else "failed"
    skipped = {it.get("symbol"): it.get("skipped_windows") for it in (result.get("items") or []) if it.get("skipped_windows")}
    return out(evs, extra={"source": "sina_futures(akshare)", "errors": errors, "stale": stale, "skipped_windows": skipped, "guard": guard},
               status=status, degraded=";".join(deg) if deg else None)


def dram_spot_thermo_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    today = str(result.get("today") or "")
    guard = str(result.get("guard") or "")
    evs, stale = [], []
    for it in result.get("items") or []:
        base = f"{it['key']} 现货均价({it['product']};社区仓 {it['source_url'].split('/')[3]})"
        ictx = {**ctx, "symbol": "MARKET", "market": "US"}
        note = _chg_note(it, base, guard)
        if it.get("stale"):
            stale.append(it["key"])
        evs.append(ev(ictx, "dram_spot_avg", it["price"], it["unit"], it["date"], currency="USD", as_of=today,
                      record_key=it["key"], raw_ref=it.get("raw_ref"), note=note))
        for k, label in (("chg1_pct", "较上一数据点"), ("chg7_pct", "约 7 日"), ("chg30_pct", "约 30 日")):
            if it.get(k) is None:
                continue
            evs.append(_chg_ev(ictx, "dram_spot", it, k, label, it["key"], guard, today))
    errors = result.get("errors") or []
    deg = []
    if errors:
        deg.append("部分品类失败:" + "; ".join(errors)[:200])
    if stale:
        deg.append("资料陈旧:" + ",".join(stale))
    status = "ok" if evs and not errors and not stale else "partial" if evs else "failed"
    skipped = {it.get("key"): it.get("skipped_windows") for it in (result.get("items") or []) if it.get("skipped_windows")}
    return out(evs, extra={"source": "github-community(DRAMeXchange 转录)", "errors": errors, "stale": stale, "skipped_windows": skipped, "guard": guard},
               status=status, degraded=";".join(deg) if deg else None)
