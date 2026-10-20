"""映射层(第三文件):美股 / 港股 / 海外官方源(腾讯 / 新浪 / 东财全球 / Yahoo / SEC / CBOE / FINRA / 财政部 / CFTC / Nasdaq)+ 技术指标。约定同 mappers.py。
币种:US → 美元 / HK → 港元(单位字符串本身带币种,ev 自动填 currency);东财三表按行内 CURRENCY 字段。"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import to_float, today_str  # noqa: E402
from sources.mappers import dict_fields, empty, ev, extracted, none_fields, out, rows_fields, series_summary, text_items  # noqa: E402
from sources.textsafe import safe_url, sanitize_untrusted  # noqa: E402

_MONEY = {"US": "美元", "HK": "港元", "CN": "元", "SH": "元", "SZ": "元", "BJ": "元"}
_CCY_OF_UNIT = {"美元": "USD", "港元": "HKD", "人民币": "CNY", "元": "CNY"}
#: 业绩发布日逐条最多写这么多条证据(整份明细在 extracted 文件里)
EV_ROWS = 40


def _mu(ctx: dict) -> str:
    return _MONEY.get(ctx["market"], "元")


def _num(v) -> Optional[float]:
    if isinstance(v, str):
        v = v.replace(",", "").replace("--", "").strip()
    return to_float(v)


# ---------- 行情 / K 线 / 指标 ----------
def kline_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("K 线为空")
    mu = _mu(ctx)
    rows = sorted([r for r in result if r.get("close")], key=lambda r: str(r["date"]))
    if not rows:
        return empty("K 线无有效收盘价")
    evs = series_summary(ctx, rows, field_prefix="kline_close", value_key="close", unit=mu, date_key="date")
    per = f"{str(rows[0]['date'])[:10]}..{str(rows[-1]['date'])[:10]}"
    gaps = []
    for key, fn in (("high", max), ("low", min)):
        values = [_num(r.get(key)) for r in rows]
        known = [v for v in values if v is not None]
        # 缺任一条不能把不完整窗口称为全窗口极值。
        if len(known) < len(values):
            gaps.append(key)
        else:
            evs.append(ev(ctx, f"kline_window_{key}", fn(known), mu, per))
    if rows[-1].get("volume") is not None:
        evs.append(ev(ctx, "kline_volume_latest", rows[-1]["volume"], "股", str(rows[-1]["date"])[:10], currency="n/a"))
    return out(evs, extra={"last5": rows[-5:], "interval": ctx["args"].get("interval", "1d")},
               status="partial" if gaps else None, degraded="窗口最高/最低价缺失，未计算极值" if gaps else None)


def indicators_map(result: dict, ctx: dict) -> dict:
    snap = (result or {}).get("snapshot") or {}
    if not snap:
        return empty("指标快照为空")
    mu = _mu(ctx)
    day = snap["date"]
    note = f"{result.get('klines_source')};窗口 {snap['points']} 根 {snap['window'][0]}..{snap['window'][1]};纯计算"
    evs = [ev(ctx, "ind_close", snap["close"], mu, day, as_of=day, note=note)]
    for k, v in (snap.get("ma") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_{k}", v, mu, day, as_of=day, note=note))
    for k, v in (snap.get("macd") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_macd_{k}" if k != "macd_hist" else "ind_macd_hist", v, mu, day, as_of=day, note=note + ";MACD(12,26,9)"))
    for k, v in (snap.get("rsi") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_{k}", v, "点", day, currency="n/a", as_of=day, note=note))
    for k, v in (snap.get("kdj") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_kdj_{k}", v, "点", day, currency="n/a", as_of=day, note=note + ";KDJ(9,3,3)"))
    for k, v in (snap.get("boll") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_boll_{k}", v, "%" if k == "bandwidth" else mu, day, currency="n/a" if k == "bandwidth" else None, as_of=day, note=note + ";BOLL(20,2)"))
    return out(evs, extra={"tail": result.get("tail"), "klines_source": result.get("klines_source"),
                           "computation": {"kind": "computed_endpoint", "library": "sources.indicators", "version": result.get("algo_version"), "inputs_raw_ref": ctx.get("raw_ref"),
                                           "params": {"ma": [5, 10, 20, 60], "ema": [12, 26], "macd": [12, 26, 9], "rsi": [6, 12, 24], "kdj": [9, 3, 3], "boll": [20, 2.0], "window": snap.get("window")},
                                           "note": "取数层确定性计算(非 calc DAG);可用同一库 + 同一 raw K 线复算"}})


# ---------- Yahoo ----------
def yahoo_key_statistics_map(result: dict, ctx: dict) -> dict:
    if not result or all(result.get(k) is None for k in ("current_price", "trailing_pe", "market_cap")):
        return empty("Yahoo quoteSummary 为空(标的不存在或模块下线)")
    mu, day = _mu(ctx), today_str()
    fc = result.get("financial_currency") or ""
    note = f"Yahoo quoteSummary {result.get('symbol')};financialCurrency={fc}"
    specs = [("current_price", "price", mu), ("trailing_pe", "pe_ttm", "倍"), ("forward_pe", "pe_forward", "倍"), ("peg_ratio", "peg", "倍"), ("price_to_book", "pb", "倍"), ("enterprise_value", "enterprise_value", mu), ("ev_to_ebitda", "ev_ebitda", "倍"),
             ("ev_to_revenue", "ev_revenue", "倍"), ("profit_margin", "net_margin", "小数"), ("operating_margin", "operating_margin", "小数"), ("gross_margin", "gross_margin", "小数"), ("return_on_equity", "roe", "小数"),
             ("return_on_assets", "roa", "小数"), ("earnings_growth", "earnings_growth", "小数"), ("revenue_growth", "revenue_growth", "小数"), ("beta", "beta", "小数"), ("short_ratio", "short_ratio", "天"),
             ("dividend_yield", "dividend_yield", "小数"), ("payout_ratio", "payout_ratio", "小数"), ("market_cap", "market_cap", mu), ("total_revenue", "revenue_ttm", mu), ("total_cash", "total_cash", mu), ("total_debt", "total_debt", mu)]
    evs, missing = dict_fields(ctx, result, specs, day, note=note)
    missing = [m for m in missing if m["field"] in ("price", "pe_ttm", "market_cap")]
    fin_unit, fin_ccy = _fin_unit(result, ctx)
    # financialData 的营收 / 现金 / 负债按 financialCurrency 计价;价格 / 市值 / EV 按上市地币种。
    # 🔴 没给报告币种时这三项**不出**(审计第三轮 B4):以前先按上市地标成港元 / 美元,港股公司按人民币列报的营收就被当成港元
    fin_fields = ("revenue_ttm", "total_cash", "total_debt")
    if fin_ccy:
        for e in evs:
            if e["field"] in fin_fields:
                e["unit"], e["currency"] = fin_unit, fin_ccy
    else:
        missing += [{"field": e["field"], "period": e["period"], "reason": "Yahoo 没给报告币种(financialCurrency),财务金额不猜币种"} for e in evs if e["field"] in fin_fields]
        evs = [e for e in evs if e["field"] not in fin_fields]
    return out(evs, missing=missing)


def yahoo_analyst_map(result: dict, ctx: dict) -> dict:
    """EPS / 营收预期与历史财报按报告币种(financial_currency)计价,不按上市地币种(腾讯 0700.HK 的预期是人民币)。
    🔴 没给报告币种时**不出金额证据**(以前退回上市地币种 —— 腾讯的人民币预期会被标成港元,审计 B6);
    分析师人数、增长率、评级分布、超预期比例这些不带币种的照出,金额项列进 missing。"""
    code = str((result or {}).get("financial_currency") or "").upper() or None
    if code and not _research_unit(code):
        return empty(f"Yahoo 报告币种 {code} 不认识,不出金额证据")
    mu, day = _research_unit(code), today_str()
    evs: list[dict] = []
    missing: list[dict] = []

    def money(specs: list, period: str) -> list:
        if mu:
            return specs
        missing.extend({"field": s[1], "period": period, "reason": "Yahoo 没给报告币种,金额不猜币种"} for s in specs)
        return []
    for t in (result or {}).get("eps_trend") or []:
        rk = str(t.get("period"))
        note = f"期间 {t.get('period')} 截止 {t.get('end_date')}"
        per = str(t.get("end_date") or day)
        e, _ = dict_fields(ctx, t, money([("eps_estimate", "eps_estimate_avg", f"{mu}/股", code), ("eps_high", "eps_estimate_high", f"{mu}/股", code), ("eps_low", "eps_estimate_low", f"{mu}/股", code), ("revenue_estimate", "revenue_estimate_avg", mu, code)], per)
                           + [("num_analysts", "analyst_count", "人"), ("growth", "eps_growth_estimate", "小数")], per, record_key=rk, note=note)
        evs += e
    for r in (result or {}).get("rating_trend") or []:  # 机构评级聚合篇数(事实统计);逐家升降级与目标价不取
        rk = str(r.get("period"))
        e, _ = dict_fields(ctx, r, [("strong_buy", "rating_strong_buy", "人"), ("buy", "rating_buy", "人"), ("hold", "rating_hold", "人"), ("sell", "rating_sell", "人"), ("strong_sell", "rating_strong_sell", "人")], day, record_key=rk, note=f"评级分布 {r.get('period')}")
        evs += e
    for h in (result or {}).get("earnings_history") or []:
        if h.get("quarter"):
            e, _ = dict_fields(ctx, h, money([("eps_actual", "eps_actual", f"{mu}/股", code), ("eps_estimate", "eps_estimate_at_report", f"{mu}/股", code)], h["quarter"])
                               + [("surprise_pct", "eps_surprise_pct", "小数")], h["quarter"], record_key=h["quarter"], note="财报季度实际 vs 预期")
            evs += e
    if not evs:
        return empty("Yahoo 分析师模块为空" if not missing else "Yahoo 没给报告币种,金额预期不出;其余项为空")
    return out(evs, extra={"financial_currency": code}, missing=missing)


def yahoo_holders_map(result: dict, ctx: dict) -> dict:
    mu, day = _mu(ctx), today_str()
    ov = (result or {}).get("overview") or {}
    evs, _ = dict_fields(ctx, ov, [("insiders_pct", "insiders_pct_held", "小数"), ("institutions_pct", "institutions_pct_held", "小数"), ("institutions_float_pct", "institutions_float_pct_held", "小数"), ("institutions_count", "institutions_count", "家")], day)
    for h in (result or {}).get("top_holders") or []:
        if not h.get("name"):
            continue
        e, _ = dict_fields(ctx, h, [("shares", "holder_shares", "股"), ("value", "holder_value", mu), ("pct_held", "holder_pct_held", "小数")], h.get("report_date") or day, record_key=str(h["name"])[:60], note=f"机构={h['name']};报告日={h.get('report_date')}")
        evs += e
    if not evs:
        return empty("Yahoo 机构持仓为空")
    return out(evs)


_CCY_UNIT = {"USD": "美元", "HKD": "港元", "CNY": "人民币", "EUR": "欧元", "JPY": "日元", "GBP": "英镑", "TWD": "新台币", "KRW": "韩元", "SGD": "新加坡元", "CAD": "加元", "AUD": "澳元", "CHF": "瑞士法郎", "INR": "卢比"}

def _report_currency(value: Any) -> tuple[Optional[str], Optional[str]]:
    raw = str(value or "").strip()
    code = _CCY_OF_UNIT.get(raw) or {v: k for k, v in _CCY_UNIT.items()}.get(raw) or raw.upper()
    return (_CCY_UNIT[code], code) if code in _CCY_UNIT else (None, None)


def _fin_unit(result: dict, ctx: dict) -> tuple:
    """Yahoo 财务类金额按 financialCurrency 计价(港股公司常以人民币 / 美元列报),不按上市地币种。返回 (unit, currency_code)。"""
    code = str((result or {}).get("financial_currency") or "").upper()
    if code:
        return _CCY_UNIT.get(code, code), code
    return _mu(ctx), None


_YF_TS_FIELDS = {"TotalRevenue": "revenue", "GrossProfit": "gross_profit", "OperatingIncome": "operating_profit", "NetIncome": "net_profit", "DilutedEPS": "eps_diluted",
                 "EBITDA": "ebitda", "OperatingCashFlow": "cfo", "CapitalExpenditure": "capex", "FreeCashFlow": "fcf", "TotalAssets": "total_assets",
                 "TotalLiabilitiesNetMinorityInterest": "total_liabilities", "StockholdersEquity": "total_equity", "CashAndCashEquivalents": "cash", "TotalDebt": "total_debt"}
# 硬测试要求金额单位与币种配对:人民币写「人民币元」(含「元」),其余按 _CCY_UNIT;不认识的币种原样写代码(会被硬测试计为不配对,如实暴露)
_TS_UNIT = {"CNY": "人民币元"}


def yahoo_timeseries_map(result: dict, ctx: dict) -> dict:
    """Yahoo 财务时间序列(fundamentals-timeseries):每个科目每个期末一条;金额按行内报告币种(港股常以人民币列报),不按上市地;0 是源给的值,原样保留。
    record_key = 期间类型(12M 全年 / 3M 单季 / TTM 近四季),同一期末的单季与近四季靠它区分。"""
    items = (result or {}).get("items") or {}
    label = {"annual": "全年", "quarterly": "单季", "trailing": "近四季"}.get(str((result or {}).get("period") or ""), "")
    evs, currencies, missing = [], set(), []
    for key, field in _YF_TS_FIELDS.items():
        for p in items.get(key) or []:
            v, day = to_float(p.get("value")), str(p.get("as_of") or "")[:10]
            if v is None or len(day) != 10:
                continue
            code = str(p.get("currency") or "").upper() or None
            if code is None:
                # 🔴 没给报告币种就不出这条金额(同 quoteSummary / 分析师预期):以前按上市地补成港元,
                #    港股公司按人民币列报的营收就成了「港元」,端点还是 ok(第四轮审计 B2)
                missing.append({"field": field, "period": day, "record_key": str(p.get("period_type") or label),
                                "reason": "Yahoo 没给报告币种,财务金额不猜币种"})
                continue
            currencies.add(code)
            money = _TS_UNIT.get(code) or _CCY_UNIT.get(code) or code
            unit = f"{money}/股" if field == "eps_diluted" else money
            evs.append(ev(ctx, field, v, unit, day, currency=code, as_of=day, record_key=str(p.get("period_type") or label),
                          note=f"Yahoo 财务时间序列 {label}({p.get('period_type')});期末 {day};报告币种={code}"))
    if not evs:
        return empty("Yahoo 财务时间序列没有带报告币种的金额(全部缺币种,不猜)" if missing else "Yahoo 财务时间序列为空(代码无效 / 该源不收录这只股票)")
    return out(evs, extra={"period": (result or {}).get("period"), "currencies": sorted(currencies)}, missing=missing)


def yahoo_events_map(result: dict, ctx: dict) -> dict:
    """Yahoo 分红 / 拆合股历史(K 线接口的事件段):每次派息一条(每股金额,按交易币种);拆股写比例文本;日期已按交易所时区换算。"""
    r = result or {}
    divs, splits, gains = r.get("dividends") or [], r.get("splits") or [], r.get("capital_gains") or []
    code = str(r.get("currency") or "").upper()
    money = _CCY_UNIT.get(code) or _mu(ctx)
    day, rng = today_str(), r.get("range") or ""
    evs = [ev(ctx, "dividend_events", len(divs), "次", day, currency="n/a", note=f"区间 {rng} 内的派息次数(Yahoo)"),
           ev(ctx, "split_events", len(splits), "次", day, currency="n/a", note=f"区间 {rng} 内的拆合股次数(Yahoo)")]
    for d in divs:
        v = to_float(d.get("amount"))
        if v is not None and d.get("date"):
            evs.append(ev(ctx, "dividend_per_share", v, f"{money}/股", d["date"], currency=code or None, as_of=d["date"],
                          record_key=d["date"], note="除息日(Yahoo 事件日);未区分常规 / 特别派息"))
    for s in splits:
        if s.get("date"):
            evs.append(ev(ctx, "split_ratio", str(s.get("ratio") or f"{s.get('numerator')}:{s.get('denominator')}"), "text", s["date"], currency="n/a", as_of=s["date"],
                          record_key=s["date"], note="拆合股生效日;比例 = 新股数:旧股数"))
    for g in gains:
        v = to_float(g.get("amount"))
        if v is not None and g.get("date"):
            evs.append(ev(ctx, "capital_gain_per_share", v, f"{money}/股", g["date"], currency=code or None, as_of=g["date"], record_key=g["date"]))
    return out(evs)


def yahoo_options_map(result: dict, ctx: dict) -> dict:
    calls, puts = (result or {}).get("calls") or [], (result or {}).get("puts") or []
    if not calls and not puts:
        return empty("Yahoo 期权链为空(港股不覆盖 / 标的无期权)")
    mu, day = _mu(ctx), today_str()
    exp = (calls or puts)[0].get("expiration") or ""
    evs = [ev(ctx, "option_expiration_count", len(result.get("expiration_dates") or []), "个", day, currency="n/a"), ev(ctx, "option_calls_count", len(calls), "张", day, currency="n/a", note=f"到期 {exp}"),
           ev(ctx, "option_puts_count", len(puts), "张", day, currency="n/a", note=f"到期 {exp}")]
    if result.get("underlying_price"):
        evs.append(ev(ctx, "option_underlying_price", result["underlying_price"], mu, day))
    for side, lst in (("call", calls), ("put", puts)):  # 合计不在取数层算;只按成交量排序取前 10 张合约的源事实
        for o in sorted(lst, key=lambda x: -(_num(x.get("volume")) or 0))[:10]:
            rk = str(o.get("contract_symbol"))
            e, _ = dict_fields(ctx, o, [("strike", "option_strike", mu), ("last_price", "option_last", mu), ("volume", "option_volume", "张"), ("open_interest", "option_open_interest", "张"), ("implied_volatility", "option_iv", "小数")], day, record_key=rk, note=f"{side} 到期 {o.get('expiration')}")
            evs += e
    return out(evs, extra={"expiration_dates": result.get("expiration_dates")})


def yahoo_news_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("Yahoo 新闻为空")
    evs = text_items(ctx, result, field="news_title", title_key="title", date_key="publish_time", key_of=lambda r: str(r.get("link"))[-60:], limit=int(ctx["args"].get("limit", 20)), extra_keys=("publisher", "link"))
    return out(evs)


# ---------- 东财全球 ----------
_EM_EXACT = {"营业收入": "revenue", "营业总收入": "revenue_total", "总收入": "revenue_total", "毛利": "gross_profit", "毛利润": "gross_profit", "营业利润": "operating_profit", "经营溢利": "operating_profit", "净利润": "net_profit",
             "归属于母公司股东的净利润": "net_profit_parent", "股东应占溢利": "net_profit_parent", "基本每股收益": "eps_basic", "稀释每股收益": "eps_diluted", "资产总计": "total_assets", "总资产": "total_assets", "负债合计": "total_liabilities",
             "总负债": "total_liabilities", "股东权益合计": "total_equity", "经营活动产生的现金流量净额": "cfo", "投资活动产生的现金流量净额": "cfi", "筹资活动产生的现金流量净额": "cff", "融资活动产生的现金流量净额": "cff"}
_EM_SUBSTR = {"income": ("收入", "毛利", "利润", "溢利", "每股收益", "研发", "成本", "EBITDA"), "balance": ("资产总计", "总资产", "负债合计", "总负债", "股东权益", "权益总计", "现金及", "存货", "应收", "流动资产", "流动负债", "借款", "长期债务"),
              "cashflow": ("经营活动", "投资活动", "筹资活动", "融资活动", "资本支出", "购建", "现金及现金等价物净增加", "自由现金流", "折旧")}


def em_financials_global_map(result: list, ctx: dict) -> dict:
    st = ctx["args"].get("statement", "income")
    if not result:
        return empty(f"东财全球三表 {st} 为空(标的未收录或 secucode 解析失败)")
    evs = []
    unknown_currency = False
    for r in result:
        name = str(r.get("ITEM_NAME") or "")
        if not name or not any(s in name for s in _EM_SUBSTR.get(st, ())):
            continue
        v = _num(r.get("AMOUNT"))
        if v is None:
            continue
        unit, ccy = _report_currency(r.get("CURRENCY"))
        if unit is None:
            unknown_currency = True
            continue
        period = str(r.get("REPORT_DATE") or "")[:10]
        field = _EM_EXACT.get(name, "fs_item")
        if field == "fs_item" and "摊薄每股收益" in name:
            field = "eps_diluted"
        elif field == "fs_item" and "基本每股收益" in name:
            field = "eps_basic"
        if field in ("eps_basic", "eps_diluted") or "每股" in name:
            unit = f"{unit}/股"
        rep = str(r.get("REPORT") or r.get("REPORT_TYPE") or "")
        note = f"{rep} {r.get('ACCOUNT_STANDARD') or ''} 科目「{name}」".strip()
        # 同一 REPORT_DATE 可同时有单季(2026/Q3)与累计(2026/Q9)两种口径 → record_key 必须带 REPORT,否则同 id 不同值
        rk = f"{rep}|{name}"
        evs.append(ev(ctx, field, v, unit, period, currency=ccy, as_of=period, record_key=rk, note=note))
        y = _num(r.get("YOY_RATIO"))
        if y is not None and field != "fs_item":
            evs.append(ev(ctx, f"{field}_yoy", y, "%", period, currency="n/a", as_of=period, record_key=rk, note=f"「{name}」同比(东财 YOY_RATIO;{rep})"))
        if len(evs) >= 160:
            break
    if not evs:
        return empty(f"东财三表 {st} 列报币种缺失或未识别" if unknown_currency else f"东财三表 {st} 无匹配科目")
    return out(evs, extra={"rows": len(result), "periods": sorted({str(r.get('REPORT_DATE'))[:10] for r in result}, reverse=True)[:8]},
               status="partial" if unknown_currency else None, degraded="部分科目币种未识别，已跳过金额" if unknown_currency else None)


_EM_IND = [("OPERATE_INCOME", "revenue", "money"), ("GROSS_PROFIT", "gross_profit", "money"), ("GROSS_PROFIT_RATIO", "gross_margin", "%"), ("PARENT_HOLDER_NETPROFIT", "net_profit_parent", "money"), ("HOLDER_PROFIT", "net_profit_parent", "money"),
           ("NET_PROFIT_RATIO", "net_margin", "%"), ("BASIC_EPS", "eps_basic", "money/股"), ("DILUTED_EPS", "eps_diluted", "money/股"), ("ROE_AVG", "roe", "%"), ("ROA", "roa", "%"), ("ROIC", "roic", "%"), ("CURRENT_RATIO", "current_ratio", "倍"),
           ("DEBT_ASSET_RATIO", "debt_asset_ratio", "%"), ("OPERATE_INCOME_YOY", "revenue_yoy", "%"), ("BASIC_EPS_YOY", "eps_basic_yoy", "%"), ("BPS", "bvps", "money/股"), ("DPS_HKD", "dps", "港元/股"), ("DIVI_RATIO", "dividend_yield", "%"),
           ("OCF_SALES", "ocf_to_sales", "%"), ("PER_NETCASH_OPERATE", "ocf_per_share", "money/股")]


def em_key_indicators_global_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财 GMAININDICATOR 为空")
    evs = []
    unknown_currency = False
    for r in result:
        period = str(r.get("REPORT_DATE") or "")[:10]
        mu, ccy = _report_currency(r.get("CURRENCY"))
        rep = f"{r.get('REPORT') or ''}|{r.get('REPORT_TYPE') or ''}"
        note = f"{rep.replace('|', ' ')} 东财关键指标".strip()
        for k, f, u in _EM_IND:
            v = _num(r.get(k))
            if v is None:
                continue
            if "money" in u and mu is None:
                unknown_currency = True
                continue
            unit = u.replace("money", mu or "")
            evs.append(ev(ctx, f, v, unit, period, currency="n/a" if unit in ("%", "倍") else ("HKD" if u == "港元/股" else ccy), as_of=period, record_key=rep, note=note))
    return out(evs, status="partial" if unknown_currency else None, degraded="列报币种未识别，已跳过金额，保留比率" if unknown_currency else None) if evs else empty("东财关键指标无可用字段或列报币种未知")


def em_fund_flow_global_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财全球资金流为空")
    mu = _mu(ctx)
    rows = sorted(result, key=lambda r: r["date"])
    evs = series_summary(ctx, rows, field_prefix="main_net_inflow_daily", value_key="main_net", unit=mu, date_key="date")
    pct = _num(rows[-1].get("main_pct"))
    if pct is not None:
        evs.append(ev(ctx, "main_net_inflow_pct_latest", pct, "%", rows[-1]["date"], currency="n/a"))
    # 最新一行的净流入 / 占比源没给(「-」):记进 missing,别让条数证据把结果撑成完整(v2.2.0 审计 Codex 第 5 条)
    missing = none_fields(rows[-1:], [("main_net", "main_net_inflow_daily_latest", "最新一天主力净流入没取到"),
                                      ("main_pct", "main_net_inflow_pct_latest", "最新一天主力净流入占比没取到")], period_of=lambda r: r["date"])
    return out(evs, missing=missing, status="partial" if len(rows) < 5 else None, degraded=None if len(rows) >= 5 else f"仅 {len(rows)} 条(push2his 不通时回落 push2delay)")


def em_stock_search_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财搜索无结果")
    day = today_str()
    evs = [ev(ctx, "search_hit", f"{r.get('code')} {r.get('name')}", "text", day, currency="n/a", record_key=f"{r.get('mkt_num')}.{r.get('code')}", note=f"{r.get('market_name')} {r.get('security_type')} mkt_num={r.get('mkt_num')}") for r in result]
    return out(evs, extra={"count": len(result)})


def em_market_list_map(result: dict, ctx: dict) -> dict:
    stocks = (result or {}).get("stocks") or []
    if not stocks:
        return empty("全市场列表为空")
    day = today_str()
    evs = [ev(ctx, "market_list_total", result.get("total", 0), "只", day, currency="n/a", note=f"market={result.get('market')} 排序 {ctx['args'].get('sort_field', 'f3')}")]
    evs += rows_fields(ctx, stocks, [("change_pct", "list_change_pct", "%"), ("volume", "list_volume", "股"), ("amplitude", "list_amplitude", "%")], period_of=lambda r: day, key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('code')} {r.get('name')}", limit=100)
    return out(evs)


# ---------- SEC / FINRA / CBOE / 宏观 ----------
def sec_ticker_cik_map(result: dict, ctx: dict) -> dict:
    if not result:
        return empty("无 CIK")
    day = today_str()
    return out([ev(ctx, "sec_cik", result["cik"], "text", day, currency="n/a", note=f"{result.get('company')}"), ev(ctx, "company_name", str(result.get("company")), "text", day, currency="n/a")])


def sec_filings_map(result: dict, ctx: dict) -> dict:
    fl = (result or {}).get("filings") or []
    if not fl:
        return empty("无申报记录(form_type 过滤后为空?)")
    evs = [ev(ctx, "company_name", str(result.get("company_name")), "text", today_str(), currency="n/a", note=f"CIK {result.get('cik')}")]
    for f in fl:
        evs.append(ev(ctx, "sec_filing", f"{f['form']} {f.get('description') or ''}".strip(), "text", f["date"], currency="n/a", as_of=f["date"], record_key=f["accession_number"], note=f"url={f.get('url')}"))
    return out(evs, extra={"count": len(fl), "cik": result.get("cik")})


_XBRL_UNIT = {"USD": "美元", "USD/shares": "美元/股", "shares": "股", "pure": "小数"}


def sec_xbrl_map(result: dict, ctx: dict) -> dict:
    ms = (result or {}).get("metrics") or {}
    if not ms:
        return empty("companyfacts 无匹配指标")
    evs = []
    for name, m in ms.items():
        unit = _XBRL_UNIT.get(m.get("unit"), m.get("unit") or "n/a")
        for e in m.get("entries") or []:
            if e.get("val") is None or not e.get("end"):
                continue
            per = f"{e['start']}..{e['end']}" if e.get("start") else e["end"]
            evs.append(ev(ctx, f"xbrl_{name}", e["val"], unit, per, currency="USD" if m.get("unit", "").startswith("USD") else "n/a", as_of=e.get("filed") or e["end"], record_key=f"{e.get('form')}|{e.get('fy')}{e.get('fp')}|{e['end']}|{e.get('filed')}",
                          note=f"{m.get('label') or name};{e.get('form')} FY{e.get('fy')} {e.get('fp')} filed {e.get('filed')}"))
    return out(evs, extra={"company": result.get("company"), "cik": result.get("cik"), "available_count": result.get("available_count"), "metrics": list(ms)})


def sec_daily_filings_map(result: dict, ctx: dict) -> dict:
    d = (result or {}).get("date") or ""
    day = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else today_str()
    evs = [ev(ctx, "sec_daily_total", result.get("total", 0), "份", day, currency="n/a")]
    for form, n in list((result.get("by_form") or {}).items())[:30]:
        evs.append(ev(ctx, "sec_daily_by_form", n, "份", day, currency="n/a", record_key=form, note=f"表单 {form}"))
    for i, f in enumerate((result.get("filings") or [])[:int(ctx["args"].get("limit", 150))]):
        evs.append(ev(ctx, "sec_daily_filing", f"{f['form']} {f['company']}", "text", day, currency="n/a", record_key=f"{f.get('cik')}|{f['form']}|{i}", note=f"{f.get('form_label')} url={f.get('url')}"))
    return out(evs, extra={"filtered": len(result.get("filings") or [])})


def sec_fulltext_map(result: dict, ctx: dict) -> dict:
    day = today_str()
    evs = [ev(ctx, "sec_fulltext_total", result.get("total", 0), "份", day, currency="n/a", note=f"query={result.get('query')}")]
    for r in result.get("results") or []:
        evs.append(ev(ctx, "sec_fulltext_hit", f"{r.get('form')} {r.get('company')}", "text", r.get("filed") or day, currency="n/a", record_key=str(r.get("id")), note=f"id={r.get('id')}"))
    return out(evs)


def sec_frame_map(result: dict, ctx: dict) -> dict:
    top = (result or {}).get("top") or []
    if not top:
        return empty("frames 无数据")
    # unit / period 都是源函数按入参原样写回的，不会缺
    unit = _XBRL_UNIT.get(str(result.get("unit") or ""), str(result.get("unit") or ""))
    per = str(result.get("period") or "")
    evs = [ev(ctx, "frame_company_count", result.get("count", 0), "家", per, currency="n/a", note=f"{result.get('tag')} {per} instant={result.get('instant')}")]
    for r in top:
        if r.get("value") is not None:
            evs.append(ev(ctx, f"frame_{result.get('tag')}", r["value"], unit, per, currency="USD" if str(result.get("unit", "")).startswith("USD") else "n/a", record_key=str(r.get("cik")), note=f"{r.get('entity')} end={r.get('end')}"))
    return out(evs)


def finra_short_map(result: list, ctx: dict) -> dict:
    if not result:
        return out([ev(ctx, "short_volume_points", 0, "天", today_str(), currency="n/a")], status="partial", degraded="FINRA 已取得的日文件内未检出该标的记录，原因未核实；未取得的日期不代表无成交，也不能推断市场覆盖范围")
    rows = sorted(result, key=lambda r: r["date"])
    evs = rows_fields(ctx, rows, [("ratio", "short_volume_ratio", "小数"), ("short", "short_volume", "股"), ("total", "total_volume_finra", "股")], period_of=lambda r: f"{r['date'][:4]}-{r['date'][4:6]}-{r['date'][6:8]}",
                      key_of=lambda r: r["date"], note_of=lambda r: "FINRA Reg SHO 日度空头成交(CNMS)")
    # 没取满请求的天数、又有日文件没取到:是部分结果,写明哪几天没取到(审计第三轮 B7:以前照样标完整)
    cov = getattr(result, "coverage", None) or {}
    failed, want = cov.get("failed_dates") or [], cov.get("requested_days") or 0
    if failed and len(rows) < want:
        days = "、".join(f"{d[:4]}-{d[4:6]}-{d[6:8]}" for d in failed[:6]) + (f" 等 {len(failed)} 天" if len(failed) > 6 else "")
        return out(evs, extra={"coverage": cov}, status="partial",
                   degraded=f"请求近 {want} 个交易日,只取到 {len(rows)} 天;{days} 的日文件没取到(不代表那几天没有空头成交)")
    return out(evs, extra={"coverage": cov} if cov else None)


def finra_ranking_map(result: dict, ctx: dict) -> dict:
    rk = (result or {}).get("ranking") or []
    d = result.get("date") or ""
    day = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else today_str()
    evs = [ev(ctx, "short_volume_universe", result.get("count", 0), "只", day, currency="n/a", note=f"market={result.get('market')}")]
    evs += rows_fields(ctx, rk, [("ratio", "short_volume_ratio", "小数"), ("total", "total_volume_finra", "股")], period_of=lambda r: day, key_of=lambda r: str(r.get("symbol")), note_of=lambda r: f"{r.get('symbol')} 空头占比排行")
    return out(evs)


def cboe_options_map(result: dict, ctx: dict) -> dict:
    sm = (result or {}).get("selected")  # 筛选后合约数(0 → partial)
    mu, day = _mu(ctx), today_str()
    note = f"CBOE 延时链 {result.get('timestamp')};筛选 {result.get('filter')};{result.get('selected')}/{result.get('all_contracts')} 张"
    evs = [ev(ctx, "option_contracts_total", result.get("all_contracts", 0), "张", day, currency="n/a", note=note), ev(ctx, "option_expiry_count", len(result.get("expiries") or []), "个", day, currency="n/a", note=note)]
    if result.get("spot") is not None:
        evs.append(ev(ctx, "option_underlying_price", result["spot"], mu, day, note=note))
    # 链级聚合 / vol-OI 比等派生量不在取数层计算;证据只留按成交量排序的前 N 张合约的源事实(全链在 raw)
    for c in (result.get("top_by_volume") or [])[:20]:
        e, _ = dict_fields(ctx, c, [("volume", "option_volume", "张"), ("open_interest", "option_open_interest", "张"), ("iv", "option_iv", "小数"), ("delta", "option_delta", "小数"), ("strike", "option_strike", mu), ("last_trade_price", "option_last", mu)],
                           day, record_key=c["symbol"], note=f"{c['type']} 到期 {c['expiry']}(按成交量排序前 20)")
        evs += e
    return out(evs, extra={"expiries": result.get("expiries"), "selected": result.get("selected")}, status=None if sm else "partial", degraded=None if sm else "筛选后无合约")


def cboe_quote_map(result: dict, ctx: dict) -> dict:
    if not result:
        return empty("CBOE 快照为空")
    mu, day = _mu(ctx), today_str()
    evs, _ = dict_fields(ctx, result, [("current_price", "price", mu), ("prev_day_close", "last_close", mu), ("open", "open", mu), ("high", "high", mu), ("low", "low", mu), ("volume", "volume", "股"), ("iv30", "iv30", "小数"), ("iv30_change", "iv30_change", "小数"),
                                       ("iv30_change_percent", "iv30_change_pct", "%"), ("hv30", "hv30", "小数")], day, note="CBOE delayed_quotes")
    return out(evs, extra={"keys": list(result)[:40]}) if evs else empty("CBOE 快照无可用字段")


def treasury_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("美债收益率 CSV 为空")
    rows = sorted(result, key=lambda r: _dt(r.get("Date")))
    last = rows[-1]
    day = _dt(last.get("Date"))
    evs = []
    for k, v in last.items():
        if k == "Date":
            continue
        x = _num(v)
        if x is not None:
            evs.append(ev(ctx, "treasury_yield", x, "%", day, currency="n/a", as_of=day, record_key=k.replace(" ", ""), note=f"期限 {k}(财政部每日收益率曲线)"))
    evs.append(ev(ctx, "treasury_points", len(rows), "天", f"{_dt(rows[0].get('Date'))}..{day}", currency="n/a"))
    return out(evs, extra={"latest": last})  # 利差等派生量由 calc 计算


def _dt(s) -> str:
    """MM/DD/YYYY → YYYY-MM-DD(财政部 CSV 日期)。"""
    s = str(s or "")
    if "/" in s:
        m, d, y = s.split("/")[:3]
        return f"{y}-{int(m):02d}-{int(d):02d}"
    return s[:10]


def cftc_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("CFTC COT 为空")
    evs = []
    for r in result[:int(ctx["args"].get("limit", 20))]:
        name = str(r.get("contract_market_name") or r.get("market_and_exchange_names") or "")
        day = str(r.get("report_date_as_yyyy_mm_dd") or "")[:10]
        rk = f"{name[:40]}|{day}"
        oi, nl, ns = _num(r.get("open_interest_all")), _num(r.get("noncomm_positions_long_all")), _num(r.get("noncomm_positions_short_all"))
        if oi is not None:
            evs.append(ev(ctx, "cot_open_interest", oi, "张", day, currency="n/a", as_of=day, record_key=rk, note=name))
        if nl is not None:
            evs.append(ev(ctx, "cot_noncomm_long", nl, "张", day, currency="n/a", as_of=day, record_key=rk, note=f"{name} 非商业多头"))
        if ns is not None:
            evs.append(ev(ctx, "cot_noncomm_short", ns, "张", day, currency="n/a", as_of=day, record_key=rk, note=f"{name} 非商业空头(净头寸请用 calc 相减)"))
    return out(evs) if evs else empty("CFTC 行无持仓字段")


def earnings_calendar_map(result: dict, ctx: dict) -> dict:
    rows = (result or {}).get("rows") or []
    day = result.get("date") or today_str()
    evs = [ev(ctx, "earnings_calendar_count", len(rows), "家", day, currency="n/a")]
    for r in rows[:int(ctx["args"].get("limit", 100))]:
        evs.append(ev(ctx, "earnings_calendar_entry", f"{r.get('symbol')} {r.get('name')}", "text", day, currency="n/a", record_key=str(r.get("symbol")), note=f"time={r.get('time')} EPS 预期={r.get('eps_forecast')} 市值={r.get('market_cap')}"))
    return out(evs, status="ok" if rows else "partial", degraded=None if rows else "该日无财报日程")


# ---------- v2.3 补洞:南向资金 / AH 溢价 / 公司资料 / 港股分红 / 估值历史 ----------
def em_southbound_flow_map(result: list, ctx: dict) -> dict:
    """南向资金每日成交(港股通,东财数据中心):单位百万港元(已与港交所披露核对);净买入 = 买入 − 卖出;全市场口径,symbol 记 MARKET。"""
    rows = [r for r in (result or []) if r.get("date")]
    if not rows:
        return empty("南向资金为空(港股休市 / 源未更新)")
    mctx = {**ctx, "symbol": "MARKET", "market": "HK"}
    ch = {"all": "南向合计", "sh": "港股通(沪)", "sz": "港股通(深)"}
    specs = [("net_buy", "southbound_net_buy", "百万港元"), ("buy", "southbound_buy", "百万港元"), ("sell", "southbound_sell", "百万港元"),
             ("turnover", "southbound_turnover", "百万港元"), ("trades", "southbound_trades", "笔"), ("accum_net_buy", "southbound_accum_net_buy", "百万港元"),
             ("hsi_close", "hsi_close", "点"), ("hsi_change_pct", "hsi_change_pct", "%")]
    evs = rows_fields(mctx, rows, specs, period_of=lambda r: r["date"], key_of=lambda r: f"{r['date']}|{r.get('channel')}", as_of_of=lambda r: r["date"],
                      note_of=lambda r: f"{ch.get(str(r.get('channel')), r.get('channel'))};累计净买入为开通以来口径")
    return out(evs)


def em_southbound_holding_map(result: list, ctx: dict) -> dict:
    """个股南向持股(港股通持股,东财):持股数 / 持股市值(港元)/ 占已发行港股比例;没有记录 = 不在港股通名单或源未收录(不是 0)。"""
    rows = [r for r in (result or []) if r.get("date")]
    if not rows:
        return empty("南向持股为空(这只股票不在港股通名单,或源未收录)")
    specs = [("hold_shares", "southbound_hold_shares", "股"), ("hold_value", "southbound_hold_value", "港元"), ("hold_ratio", "southbound_hold_ratio", "%"),
             ("shares_change", "southbound_shares_change", "股"), ("close", "southbound_ref_close", "港元")]
    evs = rows_fields(ctx, rows, specs, period_of=lambda r: r["date"], key_of=lambda r: r["date"], as_of_of=lambda r: r["date"],
                      note_of=lambda r: "持股比例 = 占已发行港股;持股变动 = 较上一日;参考收盘价为源当日价")
    return out(evs)


def ah_premium_map(result: dict, ctx: dict) -> dict:
    """AH 溢价(计算型):A 股价、H 股价、港元兑人民币汇率与三者时间戳原样留证;溢价 = A ÷ (H × 汇率) − 1。
    查不到对应的另一边不算失败:给一条文本证据说明「源里没有对应的 A / H 股」。"""
    r, day = result or {}, today_str()
    pair = r.get("pair")
    if not pair:
        return out([ev(ctx, "ah_pair", "源里没有这只股票对应的 " + ("H 股" if r.get("side") == "A" else "A 股"), "text", day, currency="n/a",
                       note="东财 F10 基本资料里没有 A / H 对应关系;不是 AH 两地上市就没有溢价可算")])
    rk = f"{pair['a_code']}|{pair['h_code']}"
    names = f"A:{pair['a_code']} {pair.get('a_name') or ''} · H:{pair['h_code']} {pair.get('h_name') or ''}"
    evs = [ev(ctx, "ah_pair", names, "text", day, currency="n/a", record_key=rk)]
    for key, field, unit, ccy, note in (("a_price", "ah_a_price", "元", "CNY", f"A 股最新价;报价时间 {r.get('a_time')};{'当日有成交' if r.get('a_traded') else '当日无成交(停牌 / 未开盘)'}"),
                                        ("h_price", "ah_h_price", "港元", "HKD", f"H 股最新价;报价时间 {r.get('h_time')}"),
                                        ("hkdcny", "hkd_cny_rate", "人民币/港元", "n/a", f"港元兑人民币;时间 {r.get('fx_time')}"),
                                        ("premium_pct", "ah_premium_pct", "%", "n/a", "A 相对 H 的溢价;正数 = A 股贵;两边收盘时间不同(A 15:00 / H 16:10),盘中两边报价时间也可能不一致"),
                                        ("ah_ratio", "ah_ratio", "倍", "n/a", "A 股价 ÷ 折算成人民币的 H 股价")):
        v = to_float(r.get(key))
        if v is not None:
            evs.append(ev(ctx, field, v, unit, day, currency=ccy, record_key=rk, note=note))
    missing = [{"field": f, "period": day, "reason": "源没给这一边的报价(0 视为无报价),溢价未计算"} for k, f in (("a_price", "ah_a_price"), ("h_price", "ah_h_price"), ("hkdcny", "hkd_cny_rate")) if to_float(r.get(k)) is None]
    return out(evs, missing=missing, extra={"pair": pair})


_PROFILE_TEXT = (("name", "company_short_name", 40), ("org_name", "company_name", 80), ("name_en", "company_name_en", 120), ("industry", "industry", 40),
                 ("market_board", "listing_board", 30), ("security_type", "security_type", 30), ("listing_date", "listing_date", 20), ("found_date", "found_date", 20),
                 ("reg_place", "registered_place", 80), ("country", "country", 60), ("chairman", "chairman", 60), ("fiscal_year_end", "fiscal_year_end", 20),
                 ("isin", "isin", 20), ("southbound_sh", "southbound_eligible_sh", 4), ("southbound_sz", "southbound_eligible_sz", 4),
                 ("profile", "company_profile", 600), ("main_business", "main_business_desc", 600))


def global_profile_map(result: dict, ctx: dict) -> dict:
    """港美股公司资料(东财 F10):名称 / 行业 / 上市板块 / 上市日 / 注册地 / 员工数 / 简介;源文本经净化后放 value;空字段不编。
    核心四项(公司名 / 行业 / 上市板块 / 上市日)为空记缺失;其余选填项为空只列在 extra.empty_fields(美股常没有主营描述,不该让整条变 partial)。"""
    r = result or {}
    if not (r.get("name") or r.get("org_name")):
        return empty("公司资料为空(代码无效 / 源不收录)")
    day = today_str()
    evs, missing, blank = [], [], []
    for key, field, limit in _PROFILE_TEXT:
        txt = sanitize_untrusted(r.get(key), limit) if r.get(key) not in (None, "") else ""
        if txt:
            evs.append(ev(ctx, field, txt, "text", day, currency="n/a", note=f"东财 F10 {r.get('secucode') or ''};源文本已净化"))
        elif field in ("company_name", "industry", "listing_board", "listing_date"):
            missing.append({"field": field, "period": day, "reason": f"源字段 {key} 为空"})
        else:
            blank.append(field)
    url = safe_url("https://" + r["website"] if r.get("website") and not str(r["website"]).startswith(("http://", "https://")) else r.get("website"))
    if url:
        evs.append(ev(ctx, "company_website", url, "text", day, currency="n/a"))
    for key, field, unit in (("employees", "employees", "人"), ("hk_shares", "hk_issued_shares", "股"), ("trade_unit", "board_lot", "股")):
        v = to_float(r.get(key))
        if v is not None:
            evs.append(ev(ctx, field, v, unit, day, currency="n/a", note="每手股数" if field == "board_lot" else None))
    return out(evs, missing=missing, extra={"secucode": r.get("secucode"), "empty_fields": blank})


def hk_dividend_map(result: list, ctx: dict) -> dict:
    """港股派息历史(东财 F10):方案是源原文(港股方案币种不一,有派港币 / 人民币 / 美元,不解析成数字),附除净日 / 派付日 / 过户日。"""
    rows = [r for r in (result or []) if r.get("notice_date") or r.get("ex_date")]
    if not rows:
        return empty("派息记录为空(没有派息,或源未收录)")
    evs = [ev(ctx, "hk_dividend_count", len(rows), "次", today_str(), currency="n/a", note="本次取到的派息公告条数(含中期 / 末期 / 特别)")]
    for r in rows:
        d = r.get("ex_date") or r.get("notice_date")
        parts = [str(r.get("year") or ""), str(r.get("kind") or ""), sanitize_untrusted(r.get("plan"), 120) or "方案未披露",
                 f"除净日 {r['ex_date']}" if r.get("ex_date") else "除净日未披露", f"派付日 {r['pay_date']}" if r.get("pay_date") else ""]
        evs.append(ev(ctx, "hk_dividend_plan", " · ".join(p for p in parts if p), "text", d, currency="n/a", as_of=d,
                      record_key=f"{r.get('notice_date')}|{r.get('kind')}", note=f"公告日 {r.get('notice_date')};过户日 {r.get('book_close') or '未披露'};方案为源原文,已净化"))
    return out(evs)


def results_dates_map(result: dict, ctx: dict) -> dict:
    """业绩发布日(港股披露易业绩公告 / 美股 8-K 2.02,SEC 全文检索或东财转载):整份明细落 extracted(事件回看读它的 rows),证据给次数 + 最近几次。

    没查到、或明细没取全(港交所 hasNextRow / 东财或 SEC 翻页到上限)都记 partial,不当失败。"""
    r = result or {}
    rows = [x for x in r.get("rows") or [] if isinstance(x, dict)]
    dated = [x for x in rows if x.get("date")]
    transport = [x.get("raw_ref") for x in ctx.get("raws", []) if x.get("raw_ref")]  # 先取:extracted() 会往 raws 里追加
    truncated = r.get("truncated")
    ref = extracted(ctx, {"endpoint": ctx["script"], "rows": rows, "truncated": truncated, "pages": r.get("pages"), "total": r.get("total"),
                          "transport_raw_refs": transport})
    c = dict(ctx, raw_ref=ref)
    hk = ctx["market"] == "HK"
    sec = ctx.get("source") == "sec"
    what = "业绩公告" if hk else "业绩 8-K(Item 2.02)"
    extra = {"rows": len(rows), "truncated": truncated}
    cut = ""
    if hk and truncated:
        cut = f";{'、'.join(truncated)}超过一次能取的 500 条,更早的没取到"
    elif sec and truncated:
        cut = f";全文检索命中 {r.get('total')} 条(含附件和更正版),只取了前 {r.get('pages')} 页(每页 100 条),其余没取到"
    elif not hk and truncated:
        cut = f";只取到最近 {r.get('pages')} 页申报(每页 100 份),更早的没取到"
    if not dated:
        why = f"没查到{what}" + ("" if hk else ";外国公司(ADR)用 6-K 报业绩,这里取不到") + cut
        return out([ev(c, "results_release_count", 0, "次", today_str(), currency="n/a", note=why)], status="partial", degraded=why, extra=extra)
    ds = sorted(x["date"] for x in dated)
    how = ("按港交所分类(末期 / 中期 / 季度业绩)检索,时间是香港时间" if hk
           else "SEC EDGAR 全文检索,按 8-K 自带的 items 只留 2.02(更正版 8-K/A 不算);日期是美东提交日" if sec
           else "东财转载的 SEC 8-K,按栏目「8-K 2.02」筛;日期是美东提交日")
    evs = [ev(c, "results_release_count", len(dated), "次", f"{ds[0]}..{ds[-1]}", currency="n/a", note=how + cut)]
    for x in dated[:EV_ROWS]:
        title = sanitize_untrusted(x.get("title"), 120) or "标题空"
        when = f"{x['date']} {x['time']}" if x.get("time") else x["date"]
        evs.append(ev(c, "results_release", f"{when} · {x.get('category') or '8-K 2.02'} · {title}", "text", x["date"], currency="n/a", as_of=x["date"],
                      record_key=str(x.get("news_id") or x.get("art_code") or x.get("accession") or x["date"]), note="标题为源原文,已净化"))
    missing = [{"field": "results_release", "period": None, "reason": f"有 {len(rows) - len(dated)} 条没有日期"}] if len(dated) < len(rows) else []
    if truncated:
        return out(evs, missing=missing, status="partial", degraded=f"{what}明细没取全" + cut, extra=extra)
    return out(evs, missing=missing, extra=extra)


_BAIDU_FIELD = {"市盈率(TTM)": "pe_ttm", "市盈率(静)": "pe_static", "市净率": "pb", "市现率": "pcf", "总市值": "market_cap"}


def baidu_valuation_map(result: dict, ctx: dict) -> dict:
    """港美股估值历史(百度股市通):每个指标给最新值 + 点数;全序列另存一份提取 CSV(列 date + 指标),计算历史分位用
    percentile_rank(history={"history_csv": {"raw_ref": <这条证据的 raw_ref>, "column": "pe_ttm", "date_column": "date"}})。
    源在周末与节假日会延续上一日的值:周末已剔除,节假日仍可能留着重复值。"""
    r = result or {}
    series = r.get("series") or {}
    if not any((s or {}).get("rows") for s in series.values()):
        return empty("估值历史为空(" + ("; ".join(f"{k}:{v}" for k, v in (r.get("errors") or {}).items()) or "代码无效 / 源不收录") + ")")
    cols = [(ind, _BAIDU_FIELD.get(ind, ind)) for ind in series]
    table: dict = {}
    for ind, col in cols:
        for d, v in (series[ind] or {}).get("rows") or []:
            if to_float(v) is not None:  # 空值不进表:单指标 CSV 的行数 = 点数证据,history_csv 绑定才对得上
                table.setdefault(str(d)[:10], {})[col] = v
    lines = ["date," + ",".join(c for _, c in cols)] + [d + "," + ",".join("" if table[d].get(c) is None else str(table[d][c]) for _, c in cols) for d in sorted(table)]
    ref = extracted(ctx, "\n".join(lines) + "\n", "csv")
    evs, missing = [], []
    for ind, col in cols:
        s = series[ind] or {}
        rows = [(str(d)[:10], to_float(v)) for d, v in s.get("rows") or [] if to_float(v) is not None]
        if not rows:
            missing.append({"field": f"{col}_latest", "period": today_str(), "reason": f"{ind} 序列为空"})
            continue
        # 比率类没写单位就是倍；总市值没写单位分不清亿还是万，不给数（第四轮审计 D 范围核实项）
        unit = s.get("unit") or ("倍" if col != "market_cap" else "")
        if not unit:
            missing.append({"field": f"{col}_latest", "period": today_str(), "reason": f"{ind} 源没有给单位，量级不明"})
            continue
        last, first = rows[-1], rows[0]
        evs.append(ev(ctx, f"{col}_latest", last[1], unit, last[0], as_of=last[0], raw_ref=ref, note=f"百度股市通 {ind}({r.get('period')});序列在 raw_ref CSV 列 {col}"))
        evs.append(ev(ctx, f"{col}_points", len(rows), "条", f"{first[0]}..{last[0]}", currency="n/a", as_of=last[0], raw_ref=ref,
                      note=f"已剔除周末 {s.get('dropped_weekend', 0)} 个延续值;节假日可能仍有延续上一日的重复值,算分位时注意"))
    for ind, err in (r.get("errors") or {}).items():
        missing.append({"field": f"{_BAIDU_FIELD.get(ind, ind)}_latest", "period": today_str(), "reason": f"{ind} 取数失败:{str(err)[:120]}"})
    return out(evs, missing=missing, extra={"period": r.get("period"), "csv_columns": [c for _, c in cols]})


def fred_map(result: dict, ctx: dict) -> dict:
    """FRED 美国宏观历史序列:每个系列给最新值 + 点数;全部序列另存一份提取 CSV(列 date + 各字段),环比 / 同比 / 分位交给 calc 用 history_csv 算。
    月度 / 季度数据的日期是所属期第一天(2026-08-01 = 8 月),不是发布日;数据会被修订,以取数时为准。"""
    from sources.macro_us import FRED_SERIES
    r = result or {}
    series = r.get("series") or {}
    mctx = {**ctx, "symbol": "MARKET", "market": "US"}
    cols = [(sid, FRED_SERIES[sid]) for sid in series if sid in FRED_SERIES]
    if not any((series[sid] or {}).get("rows") for sid, _ in cols):
        return empty("FRED 序列为空(" + ("; ".join(f"{k}:{v}" for k, v in (r.get("errors") or {}).items()) or "源没返回数据") + ")")
    table: dict = {}
    for sid, (field, *_rest) in cols:
        for d, v in (series[sid] or {}).get("rows") or []:
            table.setdefault(str(d)[:10], {})[field] = v
    lines = ["date," + ",".join(f for _, (f, *_r) in cols)] + [d + "," + ",".join(str(table[d].get(f, "")) for _, (f, *_r) in cols) for d in sorted(table)]
    ref = extracted(mctx, "\n".join(lines) + "\n", "csv")
    evs, missing = [], []
    for sid, (field, title, unit, freq) in cols:
        rows = [(str(d)[:10], to_float(v)) for d, v in (series[sid] or {}).get("rows") or [] if to_float(v) is not None]
        if not rows:
            missing.append({"field": f"{field}_latest", "period": today_str(), "reason": f"FRED {sid} 在 {r.get('start')} 之后没有数据"})
            continue
        ccy = "USD" if "美元" in unit else "n/a"
        when = {"月": "日期为所属月份第一天", "季": "日期为所属季度第一天", "周": "日期为周末(周六)", "日": "日期为观测日"}[freq]
        (d0, _), (d1, v1) = rows[0], rows[-1]
        evs.append(ev(mctx, f"{field}_latest", v1, unit, d1, currency=ccy, as_of=d1, raw_ref=ref, record_key=sid,
                      note=f"FRED {sid} {title};{freq}度,{when};序列在 raw_ref CSV 列 {field}"))
        evs.append(ev(mctx, f"{field}_points", len(rows), "条", f"{d0}..{d1}", currency="n/a", as_of=d1, raw_ref=ref, record_key=sid,
                      note=f"空值跳过 {(series[sid] or {}).get('blank', 0)} 个"))
    for sid, err in (r.get("errors") or {}).items():
        f = FRED_SERIES.get(sid, (sid,))[0]
        missing.append({"field": f"{f}_latest", "period": today_str(), "reason": f"FRED {sid} 取数失败:{str(err)[:120]}"})
    return out(evs, missing=missing, extra={"start": r.get("start"), "csv_columns": [f for _, (f, *_r) in cols]})


# ---------- 港美股六阶段研究(global_research.py) ----------
# 金额单位:人民币写「元」(与 A 股流水线、计算库的币种表一致),美元 / 港元按 _CCY_UNIT;币种一律显式给。
_RESEARCH_MONEY = {"CNY": "元", "USD": "美元", "HKD": "港元"}


def _research_unit(code: Optional[str]) -> Optional[str]:
    return _RESEARCH_MONEY.get(str(code or "").upper())


def global_quote_ref_map(result: dict, ctx: dict) -> dict:
    """个股报价 + 基准指数:报价日 / 基准报价日 / 交易时段 / 是否僵尸报价进 extra(编排器用它判报价时效,不信 agent 自填)。
    市值单位 亿美元 / 亿港元;pe_vendor 是腾讯口径未注明的市盈率,只作数据源原值。"""
    r = result or {}
    if not r.get("price"):
        return empty("行情为空(代码无效 / 该源不收录)")
    code = str(r.get("quote_currency") or {"US": "USD", "HK": "HKD"}[ctx["market"]]).upper()
    mu = _research_unit(code)
    if not mu:
        return empty(f"报价币种 {code} 不认识,不出金额证据")
    qd, ref, phase = r.get("quote_date") or "", r.get("reference_quote_day") or "", r.get("session_phase") or ""
    day = qd or today_str()
    bench = r.get("benchmark") or {}
    stale_note = "is_stale 命中(成交量 0 且现价 == 昨收):停牌 / 废码 / 盘前之一" if r.get("is_stale") else None
    note = f"{r.get('security_name', '')} {r.get('name_en', '')} ts={r.get('quote_time', '')}(交易所当地时间)".strip()
    evs, missing = [], []
    for key, field, unit, cur in (("price", "price", mu, code), ("prev_close", "last_close", mu, code), ("volume", "volume", "股", "n/a"),
                                  ("pe_vendor", "pe_vendor", "倍", "n/a"), ("market_cap_yi", "total_market_cap", f"亿{mu}", code)):
        v = to_float(r.get(key))
        if v is None:
            missing.append({"field": field, "period": day, "reason": f"源字段 {key} 缺失"})
            continue
        n = note + (";腾讯口径未注明 TTM / 静态,只作数据源原值" if field == "pe_vendor" else "") + (f";{stale_note}" if stale_note and field != "volume" else "")
        evs.append(ev(ctx, field, v, unit, day, currency=cur, as_of=day, note=n))
    for field, val in (("security_name", r.get("security_name")), ("security_name_en", r.get("name_en"))):
        if val:
            evs.append(ev(ctx, field, sanitize_untrusted(val, 80), "text", day, currency="n/a", as_of=day))
    bnote = f"基准 {bench.get('name', '')}({bench.get('key', '')})报价时间 {bench.get('quote_time', '')};港美股没有可查的假期日历,以基准指数的报价日作参考交易日"
    if ref:
        evs.append(ev(ctx, "reference_quote_day", ref, "date", ref, currency="n/a", as_of=ref, note=bnote))
        if to_float(bench.get("price")) is not None:
            evs.append(ev(ctx, "benchmark_close", to_float(bench.get("price")), "点", ref, currency="n/a", as_of=ref, note=bnote))
    else:
        missing.append({"field": "reference_quote_day", "period": day, "reason": "基准指数报价缺失,报价时效无法判定"})
    if phase:
        evs.append(ev(ctx, "session_phase", phase, "text", day, currency="n/a", as_of=day, note=f"按 {r.get('timezone')} 当地时刻 {r.get('local_now')} 推算"))
    extra = {"quote_date": qd, "quote_time": r.get("quote_time"), "reference_quote_day": ref, "last_trading_day": ref, "session_phase": phase, "is_stale": bool(r.get("is_stale")),
             "security_name": r.get("security_name"), "name_en": r.get("name_en"), "quote_currency": code, "benchmark": bench, "local_now": r.get("local_now"), "timezone": r.get("timezone")}
    degraded = [x for x in (stale_note, f"字段缺失 {len(missing)} 个,见 missing" if missing else None) if x]
    return out(evs, extra=extra, missing=missing, status="partial" if degraded else "ok", degraded=";".join(degraded) or None)


def global_financials_pit_map(result: dict, ctx: dict) -> dict:
    """按公告日过滤后的港美股关键财务:年初至今累计(含全年)出 *_cum,三个月的期间另出 *_quarter;period = 'YYYY-MM-DD..YYYY-MM-DD'。
    金额按行内报告币种(港股 / 中概常以人民币列报),不按上市地;as_of = 该行公告日。"""
    r = result or {}
    rows = r.get("rows") or []
    if not rows:
        why = f"研究日 {r.get('as_of')} 之前没有已公告的财务数据" if r.get("fetched_rows") else "东财关键指标为空(代码无效 / 源不收录,如部分银行股)"
        return empty(why)
    evs, missing, currencies = [], [], set()
    specs = (("revenue", "revenue"), ("net_profit_parent", "net_profit_parent"), ("eps_basic", "eps_basic"))
    for row in rows:
        code = row.get("currency")
        mu = _research_unit(code)
        if not mu:
            missing.append({"field": "revenue_cum", "period": row["period"], "reason": f"报告币种 {row.get('currency_raw')!r} 不认识,该期不出金额"})
            continue
        currencies.add(code)
        label = "全年" if row["kind"] == "ytd" and row["months"] == 12 else f"年初至今 {row['months']} 个月" if row["kind"] == "ytd" else "单季"
        note = (f"{row.get('date_type') or ''} {label};公告日 {row['notice_date']};报告币种 {code};"
                "东财旧期公告日会被后续再次披露覆盖成更晚日期(按它过滤只会多丢不会多放),留下的值可能是重述后的口径")
        suffixes = (["cum"] if row["kind"] == "ytd" else []) + (["quarter"] if row["months"] == 3 else [])
        for key, base in specs:
            v = to_float(row.get(key))
            if v is None:
                continue
            unit = f"{mu}/股" if key == "eps_basic" else mu
            for sfx in suffixes:
                evs.append(ev(ctx, f"{base}_{sfx}", v, unit, row["period"], currency=code, as_of=row["notice_date"], record_key=f"{row['code']}|{row['period']}", note=note))
    if not evs:
        return out([], missing=missing, status="failed", reason="没有可用的金额行")
    ytd = [x for x in rows if x["kind"] == "ytd"]
    fy = [x for x in ytd if x["months"] == 12]
    extra = {"as_of": r.get("as_of"), "report_currency": sorted(currencies)[0] if len(currencies) == 1 else sorted(currencies),
             "latest_cum_period": ytd[0]["period"] if ytd else None, "latest_fy_period": fy[0]["period"] if fy else None,
             "fiscal_year_end_mmdd": fy[0]["end"][5:] if fy else None, "fetched_rows": r.get("fetched_rows"), "kept_rows": len(rows),
             "dropped_after_as_of": r.get("dropped_after_as_of", 0), "dropped_no_notice": r.get("dropped_no_notice", 0), "dropped_too_old": r.get("dropped_too_old", 0),
             "unclassified": r.get("unclassified") or []}
    warn = []
    if len(currencies) > 1:
        warn.append(f"报告币种不止一种 {sorted(currencies)},跨期计算前先确认")
    if r.get("unclassified"):
        warn.append(f"{len(r['unclassified'])} 行期间代码与期间长度对不上,未使用(见 extra.unclassified)")
    if not fy:
        warn.append("研究日之前没有已公告的全年数据,近四季合计无法用累计值推出")
    return out(evs, extra=extra, missing=missing, status="partial" if (warn or missing) else "ok", degraded=";".join(warn) or None)


def fx_rates_map(result: dict, ctx: dict) -> dict:
    """汇率:每个货币对一条,单位写成「报价币种/基准币种」(CNY/USD = 1 美元兑多少人民币);不是金额,币种 n/a。"""
    evs, missing = [], []
    for p in (result or {}).get("pairs") or []:
        field = f"fx_{p['base'].lower()}_{p['quote'].lower()}"
        day = str(p.get("date") or "")[:10] or today_str()
        if to_float(p.get("rate")) is None:
            missing.append({"field": field, "period": day, "reason": "腾讯外汇报价缺失"})
            continue
        evs.append(ev(ctx, field, to_float(p["rate"]), f"{p['quote']}/{p['base']}", day, currency="n/a", as_of=day,
                      note=f"腾讯外汇 {p['pair']};1 {p['base']} = 该数 {p['quote']};源时间 {p.get('time')}(北京时间)"))
    if not evs:
        return empty("腾讯外汇报价为空")
    return out(evs, missing=missing, extra={"pairs": {f"{p['base']}{p['quote']}": to_float(p.get("rate")) for p in (result or {}).get("pairs") or []}})


def global_consensus_map(result: dict, ctx: dict) -> dict:
    """Yahoo 一致预期(按财年):0y = 当前未公布财年 T、+1y = T+1;period 按财年截止日所在年写 FYyyyy(财年不按自然年,截止日写在 note);
    金额按报告币种(financialCurrency;港股 / 中概常以人民币列报)。extra.current_fy = 当前财年标签,编排器据此定 FY T。"""
    r = result or {}
    code = str(r.get("financial_currency") or "").upper() or None
    mu = _research_unit(code)
    if not mu:
        return empty(f"Yahoo 未给报告币种或币种 {code!r} 不认识,一致预期不出金额证据")
    by = {str(t.get("period")): t for t in r.get("eps_trend") or []}
    evs, missing, labels = [], [], {}
    for pid in ("0y", "+1y"):
        t = by.get(pid)
        end = str((t or {}).get("end_date") or "")[:10]
        if not t or len(end) != 10:
            missing.append({"field": "eps_consensus_mean", "period": pid, "reason": f"Yahoo 无 {pid} 年度预期"})
            continue
        fy = f"FY{end[:4]}"
        labels[pid] = {"fy": fy, "fiscal_year_end": end}
        note = f"Yahoo {pid}(财年截止 {end});报告币种 {code}"
        for key, field, unit, cur in (("eps_estimate", "eps_consensus_mean", f"{mu}/股", code), ("eps_low", "eps_consensus_min", f"{mu}/股", code),
                                      ("eps_high", "eps_consensus_max", f"{mu}/股", code), ("num_analysts", "eps_analyst_count", "家", "n/a"),
                                      ("revenue_estimate", "revenue_consensus_mean", mu, code)):
            v = to_float(t.get(key))
            if v is None:
                missing.append({"field": field, "period": fy, "reason": f"Yahoo {pid} 源字段 {key} 缺失"})
                continue
            evs.append(ev(ctx, field, int(v) if field == "eps_analyst_count" else v, unit, fy, currency=cur, record_key=pid, note=note))
    if not evs:
        return empty("Yahoo 一致预期为空")
    extra: dict[str, Any] = {"financial_currency": code, "periods": labels}
    if "0y" in labels:
        extra["current_fy"] = labels["0y"]["fy"]
        extra["fiscal_year_end"] = labels["0y"]["fiscal_year_end"]
    warn = [f"{m['field']} {m['period']}" for m in missing]
    cnt = [e["value"] for e in evs if e["field"] == "eps_analyst_count"]
    if cnt and min(cnt) < 3:
        extra["warnings"] = [f"覆盖分析师少于 3 家(最少 {min(cnt)} 家),一致预期代表性弱"]
    return out(evs, extra=extra, missing=missing, status="partial" if warn else "ok", degraded=("缺 " + "、".join(warn)) if warn else None)
