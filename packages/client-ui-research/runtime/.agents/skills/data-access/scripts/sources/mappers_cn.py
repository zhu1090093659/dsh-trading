"""映射层(第二文件):腾讯 / 百度 / 新浪 / 财联社 / 巨潮 / 申万 / 宏观 / 交易所备源 / 问财 / baostock / 通达信 端点的 mapper。约定同 mappers.py。"""
from __future__ import annotations

import hashlib

import json
import os
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import to_float, today_str  # noqa: E402
from sources.mappers import dict_fields, empty, ev, extracted, out, rows_fields, series_summary, text_items  # noqa: E402
from sources.textsafe import safe_url  # noqa: E402


def _num(v) -> Optional[float]:
    if isinstance(v, str):
        v = v.replace(",", "").replace("--", "").strip()
    return to_float(v)


# ---------- 腾讯 ----------
_TX_SPECS = [("price", "price", "元"), ("change_pct", "change_pct", "%"), ("pe_ttm", "pe_ttm", "倍"), ("pe_static", "pe_static", "倍"), ("pb", "pb", "倍"), ("mcap_yi", "market_cap", "亿元"),
             ("float_mcap_yi", "float_market_cap", "亿元"), ("turnover_pct", "turnover_rate", "%"), ("amount_wan", "turnover_amount", "万元"), ("vol_ratio", "volume_ratio", "倍"),
             ("limit_up", "limit_up_price", "元"), ("limit_down", "limit_down_price", "元"), ("open", "open", "元"), ("high", "high", "元"), ("low", "low", "元"), ("last_close", "last_close", "元")]


#: 港美股行情里没有的字段(见 tencent._NOT_IN_GLOBAL),缺了不报
_TX_NOT_IN_GLOBAL = ("limit_up_price", "limit_down_price", "volume_ratio", "pe_static")


def _tx_specs(market: str) -> list:
    """同一组腾讯字段在三市场的计价单位不同，不能只换 currency 而仍把港元 / 美元写成「元」。"""
    units = {
        "CN": {"元": "元", "万元": "万元", "亿元": "亿元"},
        "HK": {"元": "港元", "万元": "港元", "亿元": "亿港元"},
        "US": {"元": "美元", "万元": "美元", "亿元": "亿美元"},
    }[market]
    return [(src, field, units.get(unit, unit)) for src, field, unit in _TX_SPECS]


def _tx_market(code: str) -> str:
    """腾讯批量行情的代码 → 市场。美股 `us` / 港股 `hk` 前缀,其余按 A 股。"""
    low = code.strip().lower()
    if low.startswith("us"):
        return "US"
    if low.startswith("hk"):
        return "HK"
    return "CN"


def tencent_quotes_map(result: dict, ctx: dict) -> dict:
    if not result:
        return empty("腾讯无返回(代码无效或被拒)")
    day = today_str()
    evs, stale, missing = [], [], []
    for code, q in result.items():
        note = f"{q.get('name')}({q.get('query')})" + (f";僵尸报价:{q.get('stale_reason')}" if q.get("is_stale") else "")
        # 🔴 **逐行判市场**:这个端点同时能取 A股 / 美股 / 港股(腾讯的 usDJI、hkHSI 等)。
        #    沿用端点级的 CN 会把道指标成 `CNY` —— 数字对、标签错,而界面上不显示币种,
        #    所以**看不出来**;错的那份会随证据进 AI 上下文。市场决定币种(见 `ev()`)。
        rctx = {**ctx, "market": _tx_market(str(code))}
        e, miss = dict_fields(rctx, q, _tx_specs(rctx["market"]), day, record_key=str(code), note=note)
        evs += e
        # 缺的字段如实列出(腾讯给空值时不再读成 0);港美股本来就没有的几项(涨跌停、量比、静态市盈率)不算缺
        skip = _TX_NOT_IN_GLOBAL if rctx["market"] != "CN" else ()
        missing += [{**m, "record_key": str(code)} for m in miss if m["field"] not in skip]
        evs.append(ev(rctx, "security_name", q.get("name", ""), "text", day, currency="n/a", record_key=str(code), note=note))
        if q.get("quote_time"):   # 成交时间原样(交易所当地时间),没有就不出这一条
            evs.append(ev(rctx, "quote_time", q["quote_time"], "text", day, currency="n/a", record_key=str(code), note=note))
        if q.get("is_stale"):
            stale.append(code)
    all_stale = bool(stale) and len(stale) == len(result)
    return out(evs, extra={"stale": stale, "codes": list(result)}, missing=missing, status="partial" if all_stale else None, degraded="全部为僵尸报价(停牌 / 废码 / 非交易时段无成交)" if all_stale else None)


# ---------- 新浪 ----------
def sina_adjust_factor_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("新浪无该标的复权因子(不支持的标的返回空 data)")
    kind = ctx["args"].get("kind", "qfq")
    rows = sorted(result, key=lambda r: r["date"])
    evs = [ev(ctx, f"adjust_factor_{kind}_latest", rows[-1]["factor"], "小数", rows[-1]["date"], currency="n/a", note=f"{kind}:{'价 ÷ 因子' if kind == 'qfq' else '价 × 因子'}"),
           ev(ctx, f"adjust_factor_{kind}_points", len(rows), "条", f"{rows[0]['date']}..{rows[-1]['date']}", currency="n/a")]
    return out(evs, extra={"kind": kind, "latest": rows[-1], "earliest": rows[0]})


_SINA_ITEMS = {"lrb": [("营业总收入", "revenue_total", "元"), ("营业收入", "revenue", "元"), ("营业利润", "operating_profit", "元"), ("利润总额", "total_profit", "元"), ("净利润", "net_profit", "元"),
                       ("归属于母公司所有者的净利润", "net_profit_parent", "元"), ("基本每股收益", "eps_basic", "元/股")],
               "fzb": [("资产总计", "total_assets", "元"), ("负债合计", "total_liabilities", "元"), ("所有者权益(或股东权益)合计", "total_equity", "元"), ("归属于母公司股东权益合计", "equity_parent", "元"),
                       ("货币资金", "cash", "元"), ("存货", "inventory", "元"), ("应收账款", "accounts_receivable", "元"), ("流动资产合计", "current_assets", "元"), ("流动负债合计", "current_liabilities", "元")],
               "llb": [("经营活动产生的现金流量净额", "cfo", "元"), ("投资活动产生的现金流量净额", "cfi", "元"), ("筹资活动产生的现金流量净额", "cff", "元"), ("现金及现金等价物净增加额", "net_cash_change", "元")]}


def _find_item(rec: dict, title: str):
    if title in rec:
        return rec[title], rec.get(title + "_同比")
    cands = [k for k in rec if not k.endswith("_同比") and k != "报告期" and title in k]
    if len(cands) == 1:
        return rec[cands[0]], rec.get(cands[0] + "_同比")
    return None, None


def sina_financial_report_map(result: list, ctx: dict) -> dict:
    rt = ctx["args"].get("report_type", "lrb")
    if not result:
        return empty(f"新浪 {rt} 为空")
    evs, missing = [], []
    for rec in result:
        period = rec.get("报告期", "")
        for title, field, unit in _SINA_ITEMS.get(rt, []):
            val, yoy = _find_item(rec, title)
            v = _num(val)
            if v is None:
                missing.append({"field": field, "period": period, "reason": f"新浪科目「{title}」缺失或非数"})
                continue
            evs.append(ev(ctx, field, v, unit, period, as_of=period, note=f"新浪财报三表 {rt} 科目「{title}」原值(未换算)"))
            y = _num(yoy)
            if y is not None:
                evs.append(ev(ctx, f"{field}_yoy", y, "小数", period, currency="n/a", as_of=period, note=f"「{title}」同比(新浪 item_tongbi 为比率:1.82 = +182%,未换算)"))
    return out(evs, missing=missing[:20], extra={"report_type": rt, "periods": [r.get("报告期") for r in result], "items_sample": list(result[0].keys())[:40] if result else []})


def sina_fund_flow_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("新浪资金流为空")
    rows = sorted([r for r in result if r.get("date")], key=lambda r: r["date"])
    for r in rows:
        r["net_amount_f"] = _num(r.get("net_amount"))
    evs = series_summary(ctx, rows, field_prefix="fund_net_inflow_daily", value_key="net_amount_f", unit="元", date_key="date", note="新浪 netamount 字段口径(主力净流入)")
    return out(evs)  # 多日合计不在取数层计算(全序列在 raw)


def sina_option_chain_map(result: dict, ctx: dict) -> dict:
    cs = (result or {}).get("contracts") or []
    if not cs:
        return empty("期权链为空")
    day = today_str()
    evs = [ev(ctx, "option_contract_count", len(cs), "张", day, currency="n/a", note=f"{result.get('underlying')} {result.get('side')} {result.get('month')} 月")]
    for c in cs:
        tq, gk = c.get("tquote") or {}, c.get("greeks") or {}
        rk = str(c.get("code"))
        note = f"{tq.get('name') or gk.get('name')}"
        e1, _ = dict_fields(ctx, tq, [("strike", "option_strike", "元"), ("last", "option_last", "元"), ("open_interest", "option_open_interest", "张"), ("volume", "option_volume", "张"), ("pct", "option_change_pct", "%")], day, record_key=rk, note=note)
        e2, _ = dict_fields(ctx, gk, [("iv", "option_iv", "小数"), ("delta", "option_delta", "小数"), ("gamma", "option_gamma", "小数"), ("theta", "option_theta", "小数"), ("vega", "option_vega", "小数"), ("theory", "option_theory_price", "元")], day, record_key=rk, note=note)
        for x in e1:
            x["raw_ref"] = c.get("_raw_tq") or x["raw_ref"]
        for x in e2:
            x["raw_ref"] = c.get("_raw_gk") or x["raw_ref"]
        evs += e1 + e2
    return out(evs, extra={"underlying": result.get("underlying"), "side": result.get("side"), "month": result.get("month"), "months": result.get("months")})


# ---------- 财联社 / 巨潮 ----------
def cls_telegraph_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("财联社电报为空")
    evs = text_items(ctx, result, field="market_news_title", title_key="title", date_key="time", key_of=lambda r: f"{str(r.get('time'))[:19]}|{str(r.get('title'))[:60]}", limit=int(ctx["args"].get("limit", 50)), extra_keys=("content",))
    return out(evs, extra={"count": len(result)})


def cninfo_announcements_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("巨潮无公告(orgId 可能解析失败)")
    evs = text_items(ctx, result, field="announcement_title", title_key="title", date_key="date", key_of=lambda r: str(r.get("url"))[-40:], limit=int(ctx["args"].get("limit", 40)), extra_keys=("type", "url"))
    return out(evs, extra={"count": len(result)})


def cninfo_irm_map(result: list, ctx: dict) -> dict:
    if not result:
        return out([ev(ctx, "irm_qa_count", 0, "条", today_str(), currency="n/a")], status="partial", degraded="互动易无问答或代码未收录")
    evs = [ev(ctx, "irm_qa_count", len(result), "条", today_str(), currency="n/a", note=f"已回复 {sum(1 for r in result if r.get('answer'))} 条")]
    for i, r in enumerate(result[:int(ctx["args"].get("limit", 30))]):
        rk = f"{r.get('ask_time', '')}|{i}"
        day = str(r.get("ask_time", ""))[:10] or today_str()
        if r.get("question"):
            evs.append(ev(ctx, "irm_question", str(r["question"])[:300], "text", day, currency="n/a", as_of=day, record_key=rk))
        if r.get("answer"):
            evs.append(ev(ctx, "irm_answer", str(r["answer"])[:300], "text", day, currency="n/a", as_of=day, record_key=rk, note=f"回答方={r.get('answerer')}"))
    return out(evs)


# ---------- 申万 / 宏观 ----------
def sw_industry_map(result: dict, ctx: dict) -> dict:
    cur = (result or {}).get("current")
    hist = (result or {}).get("history") or []
    as_of = (result or {}).get("as_of") or today_str()
    if not cur and not hist:
        return empty("申万分类表无该代码")
    evs = []
    tls = "" if result.get("tls_verified", True) else ";TLS 证书未校验(申万站点证书链问题)"
    if cur:
        for k, f in (("industry_code", "sw_industry_code"), ("l1_code", "sw_l1_code"), ("l2_code", "sw_l2_code")):
            evs.append(ev(ctx, f, cur[k], "text", as_of, currency="n/a", note=f"申万 2021 版,自 {cur['since']} 起{tls}"))
    evs.append(ev(ctx, "sw_industry_change_count", len(hist), "次", f"..{as_of}", currency="n/a", note="行业归属调整记录数(含初次计入)"))
    for h in hist:
        evs.append(ev(ctx, "sw_industry_history", h["industry_code"], "text", h["since"] or as_of, currency="n/a", record_key=h["since"] or "?", note=f"自 {h['since']} 计入"))
    tls_ok = result.get("tls_verified", True)
    return out(evs, extra={"table_rows": result.get("table_rows"), "table_stocks": result.get("table_stocks"), "tls_verified": tls_ok},
               status=None if (cur and tls_ok) else "partial", degraded=None if cur and tls_ok else ("TLS 证书未校验(降级取得,可信度降级)" if not tls_ok else "as_of 日尚无归属"))


_SF_SPECS = [("afre_total", "social_financing_increment", "亿元"), ("rmb_loans", "sf_rmb_loans", "亿元"), ("government_bonds", "sf_government_bonds", "亿元"), ("corporate_bonds", "sf_corporate_bonds", "亿元"),
             ("equity_financing", "sf_equity_financing", "亿元"), ("trust_loans", "sf_trust_loans", "亿元"), ("entrusted_loans", "sf_entrusted_loans", "亿元"), ("undiscounted_bankers_acceptance", "sf_undiscounted_ba", "亿元")]


def pboc_social_financing_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("社融表为空")
    evs = rows_fields(ctx, result, _SF_SPECS, period_of=lambda r: r["month"], key_of=lambda r: r["month"], note_of=lambda r: "人民银行社会融资规模增量统计表(月度,亿元)")
    return out(evs, extra={"months": [r["month"] for r in result]})  # 年内合计不在取数层计算


def nbs_pmi_map(result: dict, ctx: dict) -> dict:
    period = (result or {}).get("period") or today_str()[:7]
    evs, missing = dict_fields(ctx, result, [("manufacturing_pmi", "pmi_manufacturing", "%"), ("non_manufacturing_pmi", "pmi_non_manufacturing", "%"), ("composite_pmi", "pmi_composite", "%"), ("pmi_large", "pmi_large_enterprise", "%"),
                                             ("pmi_medium", "pmi_medium_enterprise", "%"), ("pmi_small", "pmi_small_enterprise", "%")], period, note=(result or {}).get("title"))
    return out(evs, missing=[m for m in missing if m["field"] in ("pmi_manufacturing", "pmi_non_manufacturing", "pmi_composite")], extra={"source_url": (result or {}).get("source_url"), "title": (result or {}).get("title")})


# ---------- 交易所备源 ----------
def dragon_tiger_backup_map(result: dict, ctx: dict) -> dict:
    day = (result or {}).get("date") or today_str()
    sz = (result or {}).get("szse") or []
    sse = (result or {}).get("sse_raw") or ""
    evs = [ev(ctx, "dragon_tiger_szse_count", len(sz), "条", day, currency="n/a", raw_ref=result.get("_raw_sz"), note="深交所交易公开信息" + ("" if result.get("tls_verified", True) else ";TLS 证书未校验(VRA_ALLOW_INSECURE_TLS 已开)")),
           ev(ctx, "dragon_tiger_sse_text_lines", len([ln for ln in sse.split("\n") if ln.strip()]), "行", day, currency="n/a", raw_ref=result.get("_raw_sse"), note="上交所交易公开信息全文(见 raw)")]
    for r in sz:
        rk = f"{r.get('code')}|{str(r.get('reason', ''))[:30]}"
        evs.append(ev(ctx, "dragon_tiger_szse_member", f"{r.get('code')} {r.get('name')}", "text", day, currency="n/a", record_key=rk, raw_ref=r.get("_raw"),
                      note=f"{str(r.get('reason', ''))[:80]};成交金额原值={r.get('amount')}(深交所 cjje 字段,单位以其表头为准,见 raw)"))
    st = None if (sz or sse.strip()) else "partial"
    return out(evs, status=st, degraded=None if st is None else "两所当日均无公开信息(非交易日或未发布)")


def announcements_backup_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("备源公告为空")
    evs = text_items(ctx, result, field="announcement_title", title_key="title", date_key="time", key_of=lambda r: str(r.get("pdf"))[-48:], limit=int(ctx["args"].get("limit", 40)), extra_keys=("pdf",))
    return out(evs, extra={"count": len(result)})


# ---------- 问财 ----------
def iwencai_search_map(result: list, ctx: dict) -> dict:
    ch = ctx["args"].get("channel", "report")
    if not result:
        return empty("问财无结果")
    for a in result:
        ex = a.get("extra") or {}
        if isinstance(ex, str):
            try:
                ex = json.loads(ex)
            except ValueError:
                ex = {}
        a["_org"] = ex.get("organization", "")
    evs = text_items(ctx, result, field=f"iwencai_{ch}_title", title_key="title", date_key="publish_date", key_of=lambda r: str(r.get("uid") or r.get("title"))[:80], limit=int(ctx["args"].get("limit", 50)), extra_keys=("_org", "score"))
    return out(evs, extra={"query": ctx["args"].get("query"), "count": len(result)})


def iwencai_query_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("问财查询无数据")
    ref = extracted(ctx, result)
    evs = [ev(ctx, "iwencai_query_rows", len(result), "行", today_str(), currency="n/a", raw_ref=ref, note=f"query={ctx['args'].get('query')}")]
    for i, r in enumerate(result[:int(ctx["args"].get("limit", 50))]):
        evs.append(ev(ctx, "iwencai_query_row", json.dumps(r, ensure_ascii=False)[:300], "text", today_str(), currency="n/a", record_key=str(i), raw_ref=ref))
    return out(evs, extra={"query": ctx["args"].get("query")})


# ---------- baostock ----------
def bs_valuation_history_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("baostock 估值历史为空")
    rows = sorted(result, key=lambda r: r["date"])
    evs = []
    for k, f, u in (("peTTM", "pe_ttm", "倍"), ("pbMRQ", "pb_mrq", "倍"), ("psTTM", "ps_ttm", "倍"), ("pcfNcfTTM", "pcf_ttm", "倍"), ("turn", "turnover_rate", "%"), ("close", "close", "元")):
        evs += series_summary(ctx, rows, field_prefix=f, value_key=k, unit=u, date_key="date", currency=None if u == "元" else "n/a")
    st_days = sum(1 for r in rows if str(r.get("isST")) == "1")
    halt = sum(1 for r in rows if str(r.get("tradestatus")) == "0")
    per = f"{rows[0]['date']}..{rows[-1]['date']}"
    evs.append(ev(ctx, "st_days", st_days, "天", per, currency="n/a"))
    evs.append(ev(ctx, "halt_days", halt, "天", per, currency="n/a"))
    return out(evs, extra={"rows": len(rows)})


def bs_stock_basic_map(result: dict, ctx: dict) -> dict:
    if not result:
        return empty("baostock 无该代码基本信息")
    day = today_str()
    evs = []
    for k, f in (("code_name", "company_name"), ("ipoDate", "ipo_date"), ("outDate", "delist_date"), ("status", "listing_status"), ("type", "security_type")):
        if result.get(k) not in (None, ""):
            evs.append(ev(ctx, f, str(result[k]), "text", day, currency="n/a", note="baostock query_stock_basic;status 1=上市 0=退市;type 1=股票 2=指数 3=其它"))
    return out(evs)


def bs_chip_distribution_map(result: dict, ctx: dict) -> dict:
    if not result:
        return empty("筹码分布计算为空")
    w = result.get("window") or ("", "")
    per = f"{w[0]}..{w[1]}"
    note = f"窗口 {result.get('days')} 个交易日,累计换手 {round(result.get('cum_turnover_pct') or 0, 1)}%,前复权,decay={ctx['args'].get('decay', 1.0)};三角分布 + 换手衰减模型(非交易所数据)"
    evs = [ev(ctx, "chip_profit_ratio", round(result["profit_ratio"], 4), "小数", per, currency="n/a", note=note), ev(ctx, "chip_avg_cost", round(result["avg_cost"], 4), "元", per, note=note),
           ev(ctx, "chip_peak_price", round(result["peak_price"], 4), "元", per, note=note), ev(ctx, "chip_cost_90_low", round(result["cost_90"][0], 4), "元", per, note=note),
           ev(ctx, "chip_cost_90_high", round(result["cost_90"][1], 4), "元", per, note=note), ev(ctx, "chip_cost_70_low", round(result["cost_70"][0], 4), "元", per, note=note),
           ev(ctx, "chip_cost_70_high", round(result["cost_70"][1], 4), "元", per, note=note), ev(ctx, "chip_price_ref", round(result["price"], 4), "元", per, note="窗口末日前复权收盘价")]
    if result.get("concentration_90") is not None:
        evs.append(ev(ctx, "chip_concentration_90", round(result["concentration_90"], 4), "小数", per, currency="n/a", note=note))
    return out(evs, extra={"days": result.get("days"), "cum_turnover_pct": result.get("cum_turnover_pct"), "histogram_points": len(result.get("histogram") or []),
                           "computation": {"kind": "computed_endpoint", "library": "sources.baostock_src.chip_distribution", "version": result.get("algo_version"), "inputs_raw_ref": ctx.get("raw_ref"),
                                           "params": {"grid_size": 300, "decay": ctx["args"].get("decay", 1.0), "adjust": "qfq", "window": result.get("window")}, "note": "取数层确定性计算(非 calc DAG);可用同一库 + 同一 raw 复算"}})


# ---------- 通达信 ----------
def tdx_finance_map(result: dict, ctx: dict) -> dict:
    if not result:
        return empty("通达信财务快照为空")
    # mootdx 0.11.x 的 finance 没有 eps / roe 字段;每股净资产叫 meigujingzichan。期间取快照自带的 updated_date(报告期数据的更新日)
    u = str(result.get("updated_date") or "")
    day = f"{u[:4]}-{u[4:6]}-{u[6:8]}" if len(u) == 8 and u.isdigit() else today_str()
    evs, missing = dict_fields(ctx, result, [("meigujingzichan", "bvps", "元/股"), ("zongguben", "total_shares_tdx", "股"), ("liutongguben", "float_shares_tdx", "股")], day,
                               note="通达信 finance 快照(updated_date 为数据更新日;金额类字段量纲与报表不一致,未收录为证据,见 extra)")
    return out(evs, missing=missing, extra={"snapshot": result})


def tdx_f10_map(result: dict, ctx: dict) -> dict:
    if not result:
        return empty("F10 为空")
    day = today_str()
    failed = [k for k, v in result.items() if not v or str(v).startswith("[取数失败]")]
    evs = [ev(ctx, "f10_text", v[:300], "text", day, currency="n/a", record_key=k, note=f"类别={k};全文见 raw(长度 {len(v)})") for k, v in result.items() if k not in failed]
    if not evs:
        return empty("F10 全部类别取数失败:" + ";".join(f"{k}={str(result[k] or '空')[:80]}" for k in failed))
    return out(evs, missing=[{"field": "f10_text", "period": day, "reason": f"类别 {k}:{str(result[k] or '空')[:120]}"} for k in failed], status="partial" if failed else None,
               degraded=("部分类别取数失败:" + "、".join(failed)) if failed else None, extra={"categories": list(result), "failed": failed})


# ---------- RSS 新闻雷达 ----------
def rss_news_map(result: dict, ctx: dict) -> dict:
    items = (result or {}).get("items") or []
    day = today_str()
    evs = [ev(ctx, "rss_sources_ok", result.get("sources_ok", 0), "个", day, currency="n/a", note=f"尝试 {result.get('sources_tried')} 个源,行业={result.get('industry')},近 {result.get('recent_days')} 天"),
           ev(ctx, "rss_item_count", len(items), "条", day, currency="n/a")]
    for it in items[:int(ctx["args"].get("limit", 80))]:
        d = str(it.get("published") or "")[:10] or day
        note = f"source={it.get('source')};industry={it.get('industry')};link={it.get('link')}" + (f";redline={','.join(it['redline'])}" if it.get("redline") else "")
        evs.append(ev(ctx, "news_title", str(it.get("title"))[:300], "text", d, currency="n/a", as_of=d, record_key=str(it.get("link") or it.get("title"))[-80:], note=note))
    failures = result.get("failures") or []
    tried = result.get("sources_tried") or 0
    if tried and len(failures) >= tried:
        return empty(f"{tried} 个源全部没取到")
    # 🔴 有源失败就是部分结果(原来只要有一条新闻就标 ok,15/16 个源超时也算齐全)
    st = "partial" if failures or not items else "ok"
    degraded = (f"{len(failures)}/{tried} 个源没取到" if failures else None) or (None if items else "窗口内无条目")
    # industries / industry 透传给界面:能切哪几个行业、当前是哪个,**只有取数层知道**。
    # 界面自己抄一份行业表的话,配置改了它不知道,选项与真实源会静默对不上。
    return out(evs, extra={"failures": failures, "redline_hits": sum(1 for i in items if i.get("redline")),
                           "industries": result.get("industries") or [], "industry": result.get("industry")},
               status=st, degraded=degraded)


def bs_kline_map(result: list, ctx: dict) -> dict:
    """前复权日 K:只给最新收盘 / 起止 / 条数 / 停牌天数;全序列在 raw(extracted JSON),指标与筹码由 calc 读 raw 计算。"""
    rows = [r for r in (result or []) if r.get("date")]
    if not rows:
        return empty("baostock 前复权 K 线为空")
    rows.sort(key=lambda r: r["date"])
    evs = series_summary(ctx, rows, field_prefix="kline_close_qfq", value_key="close", date_key="date", unit="元", note="baostock adjustflag=2 前复权")
    halt = sum(1 for r in rows if str(r.get("tradestatus")) == "0")
    evs.append(ev(ctx, "kline_halt_days", halt, "天", f"{rows[0]['date']}..{rows[-1]['date']}", currency="n/a"))
    return out(evs, extra={"rows": len(rows), "calc_hint": {"history_json": {"rows_path": "rows", "columns": {"date": "date", "open": "open", "high": "high", "low": "low", "close": "close", "turn": "turn"}, "where": {"tradestatus": "1"}}}})


# ---------- 12 市场声音(Exa 免 key MCP;不可信文本,只作线索) ----------
def _url_key(prefix: str, url) -> str:
    """record_key 用完整 URL 的 sha256(展示链接与身份键分离;尾部截断会让长 URL 同尾撞 id)。"""
    return prefix + hashlib.sha256(str(url or "").encode("utf-8")).hexdigest()[:24]


def _voice_item_evs(ctx: dict, items: list, field: str, limit: int, day: str) -> list:
    """每条一证据。period:有发布日期用发布日期(period_basis=published);未注明 / 未来日期的条目 period=取数日(period_basis=fetched,
    note 里 published=N/A)——这类条目**不能被写成"最近"**,提示词与 SOP 都据 note 判断。raw_ref 逐条指向产生它的那次搜索响应。"""
    evs = []
    for it in items[:limit]:
        pub = str(it.get("published") or "")[:10]
        d = pub or day
        note = (f"topic={it.get('topic')};kind={it.get('kind')};domain={it.get('domain')};author={it.get('author') or 'N/A'};"
                f"published={pub or 'N/A'};period_basis={'published' if pub else 'fetched'};recent={it.get('recent')};link={safe_url(it.get('url'))}"
                + (f";highlights={it['highlights'][:200]}" if it.get("highlights") else "") + ";untrusted_text=sanitized")
        evs.append(ev(ctx, field, str(it.get("title") or "")[:200] or "(无标题)", "text", d, currency="n/a", as_of=d,
                      record_key=_url_key("u:", it.get("url")), note=note, raw_ref=it.get("raw_ref")))
    return evs


def _voice_status(items: list, counts: dict, recent_days, excerpt_expect: int = 0, excerpt_ok: int = 0, what: str = "结果"):
    """状态规则:无条目 → partial;有条目但近 recent_days 日零条带日期的新条目 → partial(全是旧帖 / 未注明日期,不能当"最近声音");
    需要摘录而一条都没读到 → partial。部分摘录失败只出 warning。返回 (status, degraded, warnings)。"""
    warnings: list[str] = []
    if not items:
        return "partial", f"Exa 无{what}(查询词未命中或网络)", warnings
    if not counts.get("recent"):
        return "partial", f"近 {recent_days} 日无带日期的新条目(旧帖 {counts.get('stale', 0)} / 未注明日期 {counts.get('undated', 0)}),不能当作当前市场声音", warnings
    if excerpt_expect and not excerpt_ok:
        return "partial", f"摘录全部失败({excerpt_expect} 条候选 0 条读到)", warnings
    if excerpt_expect and excerpt_ok < excerpt_expect:
        warnings.append(f"摘录部分失败:{excerpt_ok}/{excerpt_expect}")
    return "ok", None, warnings


def exa_market_voice_map(result: dict, ctx: dict) -> dict:
    """全网语义搜索结果 → 每条一证据(value = 净化后标题,note 带主题 / 域名 / 作者 / 日期 / 链接 / 摘要);摘录另成 web_excerpt 证据。
    这些证据是**线索**:数字不得作为事实引用(SOP catalyst-risk §2.11 / 提示词 / 硬测试三处约束)。"""
    result = result or {}
    items = result.get("items") or []
    day = today_str()
    c = result.get("counts") or {}
    limit = int(result.get("limit") or 40)
    evs = [ev(ctx, "web_result_count", len(items), "条", day, currency="n/a",
              note=f"name={result.get('name')};queries={len(result.get('queries') or [])};recent={c.get('recent')};stale={c.get('stale')};undated={c.get('undated')};forum={c.get('forum')}")]
    evs += _voice_item_evs(ctx, items, "web_result", limit, day)
    excerpts = result.get("excerpts") or []
    for ex in excerpts:
        if not ex.get("chars"):
            continue
        pub = str(ex.get("published") or "")[:10]
        d = pub or day
        evs.append(ev(ctx, "web_excerpt", ex["excerpt"], "text", d, currency="n/a", as_of=d, record_key=_url_key("excerpt:", ex.get("url")),
                      note=f"link={safe_url(ex.get('url'))};published={pub or 'N/A'};chars={ex.get('chars')};untrusted_text=sanitized", raw_ref=ex.get("raw_ref")))
    st, degraded, warnings = _voice_status(items, c, result.get("recent_days"), int(c.get("excerpt_candidates") or 0), int(c.get("excerpts") or 0), "结果")
    fetch_errors = [e.get("error") for e in excerpts if e.get("error")]
    return out(evs, extra={"name": result.get("name"), "queries": result.get("queries"), "counts": c, "recent_days": result.get("recent_days"), "limit": limit,
                           "untrusted_text": True, "sanitized": "textsafe(动作词替换 / 控制与不可见字符剥离 / 截断)", "fetch_errors": fetch_errors, "warnings": warnings},
               status=st, degraded=degraded)


def exa_forum_voice_map(result: dict, ctx: dict) -> dict:
    """雪球 / 股吧讨论(经 Exa 索引):只有标题 / 作者 / 日期 / 链接;正文受 WAF 不可读。同样只作线索。"""
    result = result or {}
    items = result.get("items") or []
    day = today_str()
    c = result.get("counts") or {}
    limit = int(result.get("limit") or 40)
    evs = [ev(ctx, "forum_post_count", len(items), "条", day, currency="n/a",
              note=f"name={result.get('name')};recent={c.get('recent')};stale={c.get('stale')};undated={c.get('undated')};by_domain={c.get('by_domain')};正文不可读(WAF),只有索引元数据")]
    evs += _voice_item_evs(ctx, items, "forum_post", limit, day)
    st, degraded, warnings = _voice_status(items, c, result.get("recent_days"), what="论坛讨论")
    return out(evs, extra={"name": result.get("name"), "queries": result.get("queries"), "counts": c, "recent_days": result.get("recent_days"), "limit": limit,
                           "untrusted_text": True, "body_readable": False, "warnings": warnings}, status=st, degraded=degraded)



def sina_turnover_rank_map(result: dict, ctx: dict) -> dict:
    """新浪成交额榜 → 和东财成交额榜同名同单位的证据(record_key = stock|代码),note 写明是新浪口径。"""
    rows = (result or {}).get("rows") or []
    total = (result or {}).get("total")
    ictx = {**ctx, "symbol": "MARKET", "market": "CN"}
    evs = []
    for r in rows:
        rk = f"stock|{r['code']}"
        note = f"{r['name']}({r['code']});成交额榜第 {r['rank']} 名(新浪沪深京 A 股{f',共 {total} 只' if total else ''})"
        for field, key, unit in (("turnover_amount", "amount", "元"), ("turnover_rank", "rank", "名"), ("last_price", "price", "元"), ("change_pct", "pct", "%"),
                                 ("market_cap", "mcap", "元"), ("float_market_cap", "float_cap", "元")):
            if r.get(key) is not None:
                evs.append(ev(ictx, field, r[key], unit, ctx.get("as_of") or today_str(), record_key=rk, note=note, raw_ref=r.get("_raw")))
    if not evs:
        return empty("新浪成交额榜一条都没取到")
    return out(evs, extra={"total": total, "returned": len(rows)})


def sina_board_flow_map(result: dict, ctx: dict) -> dict:
    """新浪板块资金流 → 每个板块一组证据(字段名带 _sina,不和东财「主力净额」混用)。"""
    rows = (result or {}).get("rows") or []
    if not rows:
        return empty("新浪板块资金流为空")
    bt = (result or {}).get("board_type", "industry")
    day = today_str()
    specs = [("net", "board_net_sina", "元"), ("inflow", "board_inflow_sina", "元"), ("outflow", "board_outflow_sina", "元"),
             ("change_pct", "board_change_pct_sina", "%"), ("net_ratio", "board_net_ratio_sina", "%")]
    evs = rows_fields(ctx, rows, specs, period_of=lambda r: day, key_of=lambda r: f"{bt}|{r.get('code') or r.get('name')}",
                      note_of=lambda r: f"{r.get('name')} 排名 {r.get('rank')};领涨 {r.get('leader') or '—'} {'' if r.get('leader_pct') is None else str(r['leader_pct']) + '%'};新浪口径(流入 − 流出),不是东财主力净额")
    return out(evs, extra={"board_type": bt, "total": len(rows)})
