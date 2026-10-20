"""a-stock-data v3.8–v3.10 移植端点(sources/astock_ported + astock_defaults)的映射。

共同做法:
- 上游返回 DataFrame。先整表转成 JSON 安全的行(NaN → null,numpy 标量 → Python)落一个 extracted_ 文件
  {endpoint, rows, attrs, transport_raw_refs},本次全部证据的 raw_ref 指向它:一次调用常有多次请求(翻页 / 交易日历 /
  多入口轮换),证据值都能在这一个文件里按 record_key 找到;各次请求的传输层原文路径记在 transport_raw_refs。
- 时间序列附 calc_hint(history_json,rows_path=rows),计算层直接读这个文件。
- 单位照上游列名(_10k = 万、_100m = 亿、_pct = %),不换算;多行表只给有限条证据(按说明排序取前 N),全表在文件里。
- 上游对参数错 / 确实没数据抛 ValueError、来源坏了抛 RuntimeError,由取数器记 failed;这里只处理返回空表的情况。
"""
from __future__ import annotations

import json
import math
import os
import sys
from datetime import date, datetime
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import to_float, today_str  # noqa: E402
from sources.mappers import ev, extracted, out  # noqa: E402

EV_CAP = 30  # 多行表每次最多给多少行证据;其余在 extracted 文件里


# ---------- 公共 ----------
def _clean(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [_clean(x) for x in v]
    if v is None:
        return None
    if hasattr(v, "tolist") and not hasattr(v, "item"):  # numpy 数组
        return _clean(v.tolist())
    try:
        import pandas as pd
        if pd.isna(v):
            return None
    except (TypeError, ValueError, ImportError):
        pass
    if hasattr(v, "item") and not isinstance(v, (str, bytes)):  # numpy 标量
        try:
            v = v.item()
        except (ValueError, AttributeError):
            pass
    if isinstance(v, float) and math.isinf(v):
        return None
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return v


def _table(result) -> tuple[list[dict], dict]:
    if result is None:
        return [], {}
    attrs = _clean(dict(getattr(result, "attrs", {}) or {}))
    cols = [str(c) for c in result.columns]
    rows = [{c: _clean(v) for c, v in zip(cols, rec)} for rec in result.itertuples(index=False, name=None)]
    return rows, attrs


def _bind(ctx: dict, rows: list, attrs: dict) -> dict:
    """整表落 extracted 文件,返回 raw_ref 指向它的 ctx 副本。"""
    transport = [r.get("raw_ref") for r in ctx.get("raws", []) if r.get("raw_ref")]  # 先取:extracted() 会往 raws 里追加
    ref = extracted(ctx, {"endpoint": ctx["script"], "rows": rows, "attrs": attrs, "transport_raw_refs": transport})
    return dict(ctx, raw_ref=ref)


def _d(v: Any) -> str:
    """日期 / 时间戳 → YYYY-MM-DD(证据 period / as_of 用);空值给今天。"""
    s = str(v or "").strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s[:10] if len(s) >= 10 else today_str()


def _span(rows: list, key: str) -> str:
    ds = sorted(str(r.get(key) or "")[:10] for r in rows if r.get(key))
    return f"{ds[0]}..{ds[-1]}" if ds else today_str()


def _count(c: dict, field: str, n: int, unit: str, period: str, note: Optional[str] = None) -> dict:
    return ev(c, field, n, unit, period, currency="n/a", note=note)


def _fields(c: dict, row: dict, specs, period: str, *, record_key: Optional[str] = None, note: Optional[str] = None,
            as_of: Optional[str] = None, adjustment: str = "not_applicable") -> list:
    """一行 → 多条证据;specs = (列名, 字段, 单位[, 币种])。数值列非数则跳过;单位为 text / date 时原样。"""
    evs = []
    for spec in specs:
        key, field, unit = spec[0], spec[1], spec[2]
        cur = spec[3] if len(spec) > 3 else None
        v = row.get(key)
        if unit not in ("text", "date", "bool"):
            v = to_float(v)
        if v is None or v == "":
            continue
        if unit == "text":
            v = str(v)[:300]
        evs.append(ev(c, field, v, unit, period, currency=cur, as_of=as_of or (period if len(period) == 10 else None),
                      record_key=record_key, note=note, adjustment=adjustment))
    return evs


def _hint(columns: dict, where: Optional[dict] = None) -> dict:
    h: dict[str, Any] = {"rows_path": "rows", "columns": columns}
    if where:
        h["where"] = where
    return {"history_json": h}


# ---------- 1 行情 ----------
def _cn_price_unit(code: str) -> str:
    """指数报点位,其余报元。code 带 sh/sz/bj 前缀(上游输出口径)。
    沪市 000xxx 只有指数;通达信另把上证指数编成 sh999999、自编板块指数为 sh880xxx / sh881xxx;深市 399xxx、北交所 899xxx 是指数。"""
    c = str(code).lower()
    return "点" if c.startswith(("sh000", "sh999", "sh880", "sh881", "sz399", "bj899")) else "元"


def _is_cn_stock(key: str) -> bool:
    """带市场前缀的 A 股个股(沪深主板 / 创业板 / 科创板 / 北交所);指数、ETF、债券、B 股等返回 False。"""
    k = str(key).lower()
    m, code = k[:2], k[2:]
    if len(code) != 6 or not code.isdigit():
        return False
    if m == "sh":
        return code[:3] in ("600", "601", "603", "605", "688", "689")
    if m == "sz":
        return code[:3] in ("000", "001", "002", "003", "300", "301")
    if m == "bj":
        return code.startswith("920") or code[:2] in ("43", "83", "87")
    return False


def _cn_volume_unit(code: str) -> str:
    """腾讯 K 线成交量:科创板(688/689)是股,其余是手(上游 §1.2)。"""
    digits = str(code)[-6:]
    return "股" if digits.startswith(("688", "689")) else "手"


def tencent_kline_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="腾讯 K 线返回 0 根")
    c = _bind(ctx, rows, attrs)
    code = str(rows[-1].get("code") or ctx["symbol"])
    minute = "datetime" in rows[0]
    dk = "datetime" if minute else "date"
    rows = sorted(rows, key=lambda r: str(r.get(dk)))
    last = rows[-1]
    adj = "none" if minute else {"qfq": "qfq", "hfq": "hfq"}.get(str(last.get("adjust") or ""), "none")
    unit, vunit = _cn_price_unit(code), _cn_volume_unit(code)
    period = str(ctx["args"].get("period") or "day")
    stamp = str(last.get(dk))
    note = f"{code} {period};" + ("分钟线只有不复权" if minute else f"复权={adj}") + ";腾讯无成交额"
    evs = _fields(c, last, [("close", f"kline_close_{adj}", unit), ("open", f"kline_open_{adj}", unit), ("high", f"kline_high_{adj}", unit),
                            ("low", f"kline_low_{adj}", unit), ("volume", "kline_volume", vunit)],
                  stamp if minute else _d(stamp), record_key=f"{code}:{period}:{stamp}", note=note, as_of=_d(stamp), adjustment=adj)
    evs.append(_count(c, "kline_points", len(rows), "根", _span(rows, dk), note=f"{code} {period}"))
    cols = {"date": dk, "open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume"}
    return out(evs, extra={"code": code, "period": period, "adjust": adj, "rows": len(rows), "last3": rows[-3:], "calc_hint": _hint(cols)})


def tdx_daily_package_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    c = _bind(ctx, rows, attrs)
    day = _d(rows[0].get("date")) if rows else today_str()
    evs = [_count(c, "tdx_package_total_rows", attrs.get("total_rows", 0), "条", day,
                  note="全市场各市场条数:" + ",".join(f"{k}={v}" for k, v in (attrs.get("market_counts") or {}).items()))]
    for r in rows[:EV_CAP]:
        key = f"{r.get('market')}{r.get('code')}"
        u = _cn_price_unit(key)
        vu = "股" if _is_cn_stock(key) else "通达信原值"  # 上游只保证个股 volume 是股;指数 / ETF / 债券等按通达信原值标注
        evs += _fields(c, r, [("close", "close", u), ("prev_close", "prev_close", u), ("open", "open", u), ("high", "high", u), ("low", "low", u),
                              ("volume", "volume", vu), ("amount", "turnover_amount", "元")],
                       _d(r.get("date")), record_key=key, note=f"{r.get('name')};通达信盘后包不复权")
    unmatched = attrs.get("unmatched_codes") or []
    if not rows:
        return out(evs, status="partial", degraded=f"盘后包里没有请求的代码:{','.join(unmatched)}",
                   extra={"unmatched_codes": unmatched})
    return out(evs, status="partial" if unmatched else None, degraded=f"盘后包里没有:{','.join(unmatched)}" if unmatched else None,
               extra={"date": day, "matched": len(rows), "unmatched_codes": unmatched, "market_counts": attrs.get("market_counts")})


def tencent_ticks_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="腾讯逐笔为空")
    c = _bind(ctx, rows, attrs)
    day = _d(rows[0].get("date"))
    sides: dict[str, int] = {}
    for r in rows:
        sides[str(r.get("side"))] = sides.get(str(r.get("side")), 0) + 1
    complete = attrs.get("complete")
    evs = [_count(c, "tick_count", len(rows), "笔", day, note="方向分布:" + ",".join(f"{k}={v}" for k, v in sorted(sides.items())))]
    last = rows[-1]
    evs += _fields(c, last, [("price", "tick_last_price", "元"), ("volume", "tick_last_volume", "手"), ("amount", "tick_last_amount", "元")], day,
                   record_key=f"{last.get('code')}:{last.get('seq')}", note=f"最后一笔 {last.get('time')};腾讯逐笔成交量科创板也是手")
    missing = attrs.get("missing_seq") or []
    # 上游三态:True 已核对完整 / False 盘后定价有缺笔(稍后重试)/ None 盘中或 15:31 前、或快照没有盘后成交额,没法核对
    if complete is True:
        degraded = None
    elif complete is False:
        degraded = "盘后定价段有缺笔(中间缺号或末尾金额对不上),稍后重试"
    else:
        degraded = "未核对完整:盘中或 15:31 前取数,逐笔截至取数时刻、不保证完整"
    if missing:  # 上游 missing_seq 是逐个缺失序号的扁平列表;有缺号时 complete 必为 False
        degraded = (degraded + ";" if degraded else "") + f"中间缺 {len(missing)} 个序号"
    return out(evs, status="partial" if degraded else None, degraded=degraded,
               extra={"date": day, "complete": complete, "missing_seq": missing, "first_time": rows[0].get("time"), "last_time": last.get("time")})


def bse_quote_backup_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="北交所官方行情里没有该代码")
    c = _bind(ctx, rows, attrs)
    r = rows[0]
    day = _d(r.get("date"))
    evs = _fields(c, r, [("close", "close", "元"), ("previous_close", "prev_close", "元"), ("open", "open", "元"), ("high", "high", "元"),
                         ("low", "low", "元"), ("volume", "volume", "股"), ("amount", "turnover_amount", "元"),
                         ("bid_price_1", "bid1", "元"), ("ask_price_1", "ask1", "元")],
                  day, record_key=str(r.get("code")), note=f"{r.get('name')};北交所官网行情;quote_time={r.get('quote_time')}")
    return out(evs, extra={"quote_time": r.get("quote_time"), "pe_source": r.get("pe_source")})


# ---------- 4 资金筹码 ----------
def etf_shares_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    c = _bind(ctx, rows, attrs)
    ex = str(ctx["args"].get("exchange") or "SH")
    if not rows:
        return out([_count(c, "etf_count", 0, "只", today_str())], status="partial", degraded=f"没有匹配的 ETF:{attrs.get('unmatched_codes')}")
    day = _d(rows[0].get("date"))
    sz_note = ";深交所 T 日晚为预估、T+1 早为确认值" if ex.upper() == "SZ" else ""
    evs = [_count(c, "etf_count", len(rows), "只", day, note=f"交易所={ex}{sz_note}")]
    top = sorted(rows, key=lambda r: to_float(r.get("shares_10k")) or 0, reverse=True)[:EV_CAP]
    for r in top:
        evs += _fields(c, r, [("shares_10k", "etf_shares", "万份")], day, record_key=f"{ex}:{r.get('code')}", note=f"{r.get('name')}{sz_note}")
    unmatched = attrs.get("unmatched_codes") or []
    return out(evs, status="partial" if unmatched else None, degraded=f"没有匹配:{','.join(unmatched)}" if unmatched else None,
               extra={"exchange": ex, "total_rows": attrs.get("total_rows", len(rows)), "unmatched_codes": unmatched})


def margin_trading_backup_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    c = _bind(ctx, rows, attrs)
    if not rows:
        return out([], status="failed", reason="交易所两融明细里没有该代码(可能不是两融标的)")
    r = rows[0]
    day = _d(r.get("date"))
    evs = _fields(c, r, [("margin_balance", "margin_financing_balance", "元"), ("margin_buy", "margin_financing_buy", "元"),
                         ("short_balance", "margin_short_balance", "元"), ("short_volume", "margin_short_volume", "股"),
                         ("short_sell_volume", "margin_short_sell_volume", "股")],
                  day, record_key=f"{r.get('exchange')}:{r.get('code')}", note=f"{r.get('name')};交易所官方两融明细")
    return out(evs)


# ---------- 5 新闻 ----------
def wallstreetcn_lives_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    c = _bind(ctx, rows, attrs)
    if not rows:
        return out([_count(c, "live_count", 0, "条", today_str())], status="partial", degraded="华尔街见闻快讯为空")
    evs = [_count(c, "live_count", len(rows), "条", _span(rows, "time"), note=f"频道={ctx['args'].get('channel', 'global-channel')}")]
    for r in rows[:EV_CAP]:
        text = str(r.get("title") or "").strip() or str(r.get("content") or "").strip()
        if not text:
            continue
        d = _d(r.get("time"))
        evs.append(ev(c, "market_news_title", text[:300], "text", d, currency="n/a", as_of=d, record_key=f"wscn:{r.get('id')}",
                      note=f"time={r.get('time')};importance={r.get('importance')};url={r.get('url')}"))
    return out(evs, extra={"next_cursor": attrs.get("next_cursor")})


def cctv_news_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    c = _bind(ctx, rows, attrs)
    if not rows:
        return out([], status="failed", reason="新闻联播文字稿为空")
    day = _d(rows[0].get("date"))
    evs = [_count(c, "cctv_item_count", len(rows), "条", day)]
    for i, r in enumerate(rows[:EV_CAP]):
        evs.append(ev(c, "cctv_news_title", str(r.get("title") or "")[:300], "text", day, currency="n/a", as_of=day,
                      record_key=f"cctv:{day}:{i}", note=f"url={r.get('url')}" + (f";正文 {len(str(r.get('content') or ''))} 字,全文见 raw" if "content" in r else "")))
    return out(evs)


# ---------- 6 基础数据 ----------
def st_stock_list_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    c = _bind(ctx, rows, attrs)
    if not rows:
        return out([], status="failed", reason="ST 名单为空")
    day = today_str()
    kinds: dict[str, int] = {}
    for r in rows:
        kinds[str(r.get("st_type"))] = kinds.get(str(r.get("st_type")), 0) + 1
    evs = [_count(c, "st_count", len(rows), "只", day, note="类型分布:" + ",".join(f"{k}={v}" for k, v in sorted(kinds.items())))]
    for r in rows[:EV_CAP]:
        evs.append(ev(c, "st_stock", f"{r.get('code')} {r.get('name')}", "text", day, currency="n/a", record_key=str(r.get("code")),
                      note=f"st_type={r.get('st_type')};market={r.get('market')}"))
    fb = attrs.get("fallback_reason")
    return out(evs, status="partial" if fb else None, degraded=f"东财名单不可用,改用 baostock:{fb}" if fb else None,
               extra={"coverage": attrs.get("coverage"), "fallback_reason": fb, "by_type": kinds})


# ---------- 10 情绪 ----------
def sse_e_interaction_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    c = _bind(ctx, rows, attrs)
    if not rows:
        return out([_count(c, "irm_qa_count", 0, "条", today_str())], status="partial", degraded="上证e互动没有返回该公司的问答(源页面提示近期暂无)")
    evs = [_count(c, "irm_qa_count", len(rows), "条", _span(rows, "question_time"), note=f"kind={ctx['args'].get('kind', 'answered')}")]
    for r in rows[:EV_CAP]:
        rk = f"ssee:{r.get('id')}"
        qd, ad = _d(r.get("question_time")), _d(r.get("answer_time") or r.get("question_time"))
        evs.append(ev(c, "irm_question", str(r.get("question") or "")[:300], "text", qd, currency="n/a", as_of=qd, record_key=rk, note=f"asker={r.get('asker')}"))
        if r.get("answer"):
            evs.append(ev(c, "irm_answer", str(r.get("answer"))[:300], "text", ad, currency="n/a", as_of=ad, record_key=rk))
    return out(evs)


# ---------- 11 宏观 ----------
def _latest_and_series(ctx: dict, rows: list, specs, *, record_key_of, note: Optional[str] = None, hint_cols: Optional[dict] = None,
                       extra: Optional[dict] = None, attrs: Optional[dict] = None) -> dict:
    c = _bind(ctx, rows, attrs or {})
    rows = sorted(rows, key=lambda r: str(r.get("date")))
    last = rows[-1]
    evs = _fields(c, last, specs, _d(last.get("date")), record_key=record_key_of(last), note=note)
    evs.append(_count(c, "series_points", len(rows), "条", _span(rows, "date")))
    ex = dict(extra or {})
    if hint_cols:
        ex["calc_hint"] = _hint(hint_cols)
    return out(evs, extra=ex)


def chinabond_yield_curve_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="中债收益率曲线为空")
    c = _bind(ctx, rows, attrs)
    tenors = ["3m", "6m", "1y", "3y", "5y", "7y", "10y", "30y"]
    latest: dict[str, dict] = {}
    for r in rows:
        k = str(r.get("curve"))
        if k not in latest or str(r.get("date")) > str(latest[k].get("date")):
            latest[k] = r
    evs = []
    for curve, r in sorted(latest.items()):
        evs += _fields(c, r, [(t, f"yield_{t}", "%") for t in tenors], _d(r.get("date")), record_key=f"chinabond:{curve}", note=f"曲线={curve}")
    evs.append(_count(c, "series_points", len(rows), "条", _span(rows, "date")))
    return out(evs, extra={"curves": sorted(latest)})


def repo_fixing_rates_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="回购定盘利率为空")
    keys = [k for k in rows[0] if k != "date" and k not in ("source", "source_url", "fetched_at")]
    return _latest_and_series(ctx, rows, [(k, f"repo_fixing_{k}", "%") for k in keys], record_key_of=lambda r: f"repo:{r.get('date')}",
                              note=f"kind={ctx['args'].get('kind', 'FR')}", attrs=attrs)


def lpr_history_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="LPR 历史为空")
    return _latest_and_series(ctx, rows, [("lpr_1y", "lpr_1y", "%"), ("lpr_5y", "lpr_5y", "%")], record_key_of=lambda r: f"lpr:{r.get('date')}", attrs=attrs)


# ---------- 15 数据日历 ----------
def macro_calendar_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    c = _bind(ctx, rows, attrs)
    if not rows:
        return out([_count(c, "macro_event_count", 0, "条", today_str())], status="partial", degraded="该区间没有符合重要度的宏观事件")
    evs = [_count(c, "macro_event_count", len(rows), "条", _span(rows, "time"))]
    top = sorted(rows, key=lambda r: (-(to_float(r.get("importance")) or 0), str(r.get("time"))))
    keys = _unique_keys([_rk("macro", r.get("time"), r.get("country"), r.get("title")) for r in top])
    for r, key in zip(top[:EV_CAP], keys):
        d = _d(r.get("time"))
        note = ";".join(f"{k}={r.get(k)}" for k in ("time", "country", "importance", "actual", "forecast", "previous", "unit", "period") if r.get(k) not in (None, ""))
        evs.append(ev(c, "macro_event", str(r.get("title") or "")[:300], "text", d, currency="n/a", as_of=d, record_key=key, note=note))
    return out(evs)


# ---------- 19 指数 ----------
def index_members_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="指数成分为空")
    c = _bind(ctx, rows, attrs)
    day = _d(rows[0].get("date"))
    has_w = "weight_percent" in rows[0]
    evs = [_count(c, "index_member_count", len(rows), "只", day, note=f"指数 {rows[0].get('index_code')}")]
    ordered = sorted(rows, key=lambda r: to_float(r.get("weight_percent")) or 0, reverse=True) if has_w else rows
    for r in ordered[:EV_CAP]:
        rk = f"{r.get('index_code')}:{r.get('code')}"
        if has_w:
            evs += _fields(c, r, [("weight_percent", "index_weight", "%")], day, record_key=rk, note=f"{r.get('name')};{r.get('exchange')}")
        else:
            evs.append(ev(c, "index_member", f"{r.get('code')} {r.get('name')}", "text", day, currency="n/a", as_of=day, record_key=rk, note=str(r.get("exchange"))))
    return out(evs, extra={"index_code": rows[0].get("index_code"), "date": day})


def index_valuation_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="指数估值为空")
    return _latest_and_series(ctx, rows, [("pe_total", "index_pe_total", "倍"), ("pe_calculation", "index_pe_calculation", "倍"),
                                          ("dividend_yield_total_percent", "index_dividend_yield_total", "%"),
                                          ("dividend_yield_calculation_percent", "index_dividend_yield_calculation", "%")],
                              record_key_of=lambda r: f"{r.get('index_code')}:{r.get('date')}", note="中证官网指标文件(两种股本口径分列,不含 PB)", attrs=attrs)


# ---------- 20 期货与大宗 ----------
_INDEX_FUT = ("IF", "IH", "IC", "IM")
_BOND_FUT = ("TS", "TF", "T", "TL")


def _fut_price_unit(symbol: object, exchange: str = "") -> tuple[str, Optional[str]]:
    """股指期货报点位;国债期货按百元面值报价;其余为各品种交易所计价单位(元 / 吨、元 / 克等,上游不给单位列)。"""
    letters = "".join(ch for ch in str(symbol or "").upper() if ch.isalpha())
    if letters in _INDEX_FUT or (exchange.upper() == "CFFEX" and letters.startswith(("IO", "MO", "HO"))):
        return "点", "n/a"
    if letters in _BOND_FUT:
        return "元/百元面值", "CNY"
    return "元/交易所计价单位", "CNY"


def futures_daily_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="期货日行情为空")
    c = _bind(ctx, rows, attrs)
    day = _d(rows[0].get("date"))
    ex = str(rows[0].get("exchange") or ctx["args"].get("exchange") or "")
    evs = [_count(c, "futures_contract_count", len(rows), "个", day, note=f"交易所={ex}")]
    top = sorted(rows, key=lambda r: to_float(r.get("open_interest")) or 0, reverse=True)[:EV_CAP]
    for r in top:
        u, cur = _fut_price_unit(r.get("symbol"), ex)
        evs += _fields(c, r, [("close", "futures_close", u, cur), ("settle", "futures_settle", u, cur), ("volume", "futures_volume", "手"),
                              ("open_interest", "futures_open_interest", "手")],
                       day, record_key=f"{ex}:{r.get('symbol')}", note=f"{r.get('product')};按持仓量排序前 {EV_CAP}")
    return out(evs, extra={"exchange": ex, "date": day, "contracts": len(rows)})


def options_daily_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="期权日行情为空")
    c = _bind(ctx, rows, attrs)
    day = _d(rows[0].get("date"))
    ex = str(rows[0].get("exchange") or ctx["args"].get("exchange") or "")
    calls = sum(1 for r in rows if str(r.get("option_type")).upper().startswith("C"))
    evs = [_count(c, "option_contract_count", len(rows), "个", day, note=f"交易所={ex};认购 {calls} / 认沽 {len(rows) - calls}")]
    top = sorted(rows, key=lambda r: to_float(r.get("open_interest")) or 0, reverse=True)[:EV_CAP]
    for r in top:
        u, cur = _fut_price_unit(r.get("symbol"), ex)
        evs += _fields(c, r, [("close", "option_close", u, cur), ("settle", "option_settle", u, cur), ("open_interest", "option_open_interest", "手"),
                              ("iv_pct", "option_iv", "%")],
                       day, record_key=f"{ex}:{r.get('symbol')}", note=f"{r.get('series')};{r.get('option_type')};strike={r.get('strike')}")
    return out(evs, extra={"exchange": ex, "date": day, "contracts": len(rows)})


def futures_position_rank_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="持仓排名为空")
    c = _bind(ctx, rows, attrs)
    day = _d(rows[0].get("date"))
    ex = str(rows[0].get("exchange") or "")
    symbols = sorted({str(r.get("symbol")) for r in rows})
    evs = [_count(c, "position_rank_rows", len(rows), "行", day, note=f"交易所={ex};合约/品种 {len(symbols)} 个")]
    for r in rows[:EV_CAP]:
        rk = f"{ex}:{r.get('symbol')}:{r.get('level')}:{r.get('rank')}"
        evs += _fields(c, r, [("long_oi", "rank_long_oi", "手"), ("short_oi", "rank_short_oi", "手"), ("volume", "rank_volume", "手")],
                       day, record_key=rk, note=f"rank={r.get('rank')};多={r.get('long_member')};空={r.get('short_member')};量={r.get('volume_member')}")
    return out(evs, extra={"exchange": ex, "date": day, "symbols": symbols[:200]})


def futures_realtime_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="期货实时行情为空")
    c = _bind(ctx, rows, attrs)
    evs = []
    for r in rows[:EV_CAP]:
        u, cur = _fut_price_unit(r.get("symbol"))
        d = _d(r.get("datetime"))
        evs += _fields(c, r, [("last", "futures_last", u, cur), ("pre_settle", "futures_pre_settle", u, cur), ("volume", "futures_volume", "手"),
                              ("open_interest", "futures_open_interest", "手")],
                       d, record_key=str(r.get("symbol")), note=f"{r.get('name')};datetime={r.get('datetime')}")
    return out(evs)


def futures_kline_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="期货日 K 为空")
    sym = str(rows[-1].get("symbol") or ctx["symbol"])
    u, cur = _fut_price_unit(sym)
    return _latest_and_series(ctx, rows, [("close", "futures_close", u, cur), ("settle", "futures_settle", u, cur), ("volume", "futures_volume", "手"),
                                          ("open_interest", "futures_open_interest", "手")],
                              record_key_of=lambda r: f"{sym}:{r.get('date')}", note=f"{sym} 新浪期货日 K",
                              hint_cols={"date": "date", "open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume"},
                              extra={"symbol": sym}, attrs=attrs)


def a50_futures_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="A50 期指为空")
    c = _bind(ctx, rows, attrs)
    r = rows[0]
    d = _d(r.get("datetime"))
    evs = _fields(c, r, [("last", "a50_last", "点"), ("pre_settle", "a50_pre_settle", "点"), ("high", "a50_high", "点"), ("low", "a50_low", "点")],
                  d, record_key="a50", note=f"{r.get('name')};datetime={r.get('datetime')}")
    return out(evs)


def sge_spot_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if not rows:
        return out([], status="failed", reason="上金所行情为空")
    inst = str(rows[-1].get("instrument") or ctx["symbol"])
    unit = "元/千克" if inst.lower().lstrip("m").startswith("ag") else "元/克"
    res = _latest_and_series(ctx, rows, [("close", "sge_close", unit, "CNY"), ("open", "sge_open", unit, "CNY"), ("high", "sge_high", unit, "CNY"), ("low", "sge_low", unit, "CNY")],
                             record_key_of=lambda r: f"{inst}:{r.get('date')}", note=f"上金所 {inst}",
                             hint_cols={"date": "date", "open": "open", "high": "high", "low": "low", "close": "close"},
                             extra={"instrument": inst, "ohlc_anomaly_dates": attrs.get("ohlc_anomaly_dates") or []}, attrs=attrs)
    # 上游说明:少数日子收盘价略超出高低区间是原始数据如此。历史上的这几天不影响最新值;只有最新一天在列时才降级
    last_day = max(str(r.get("date")) for r in rows)
    if last_day in (attrs.get("ohlc_anomaly_dates") or []):
        res["status"], res["degraded"] = "partial", f"最新一天 {last_day} 的收盘价超出当日高低区间(上金所原始数据如此)"
    return res


# ---------- 21 事件驱动 ----------
def _rk(*parts) -> str:
    """无歧义的记录键(JSON 数组);值里带分隔符也不会和别的记录拼成同一个键。"""
    return json.dumps([None if p is None else str(p) for p in parts], ensure_ascii=False)


def _rk_base(key: str) -> str:
    """去掉 _unique_keys 加的 #n(JSON 键以 ] 结尾,后缀只会出现在最后一个 ] 之后)。"""
    i = key.rfind("]")
    return key[:i + 1] if i >= 0 else key


def _unique_keys(keys: list) -> list:
    """源里完全相同的行各出一条证据:第 2 次起在键后加 #n,证据 id(完整键的哈希)就不会撞。
    加出来的键若恰好等于别的行的原始键(比如字段值本身就是「利润#2」),继续往后找没用过的编号。"""
    used = set(keys)
    seen: set = set()
    result = []
    for k in keys:
        if k not in seen:
            seen.add(k)
            result.append(k)
            continue
        n = 2
        while f"{k}#{n}" in used:
            n += 1
        used.add(f"{k}#{n}")
        result.append(f"{k}#{n}")
    return result


def _limit_hit(ctx: dict, n: int) -> Optional[int]:
    """上游东财事件表取满 limit 行就停、不报错:行数达到 limit 说明更早的记录可能没取到。返回 limit,没取满返回 None。"""
    limit = (ctx.get("args") or {}).get("limit")
    try:
        return int(limit) if limit is not None and n >= int(limit) else None
    except (TypeError, ValueError):
        return None


def _event_rows(ctx: dict, rows: list, attrs: dict, *, count_field: str, unit: str, date_key: str, key_of, specs, note_of, empty_note: str,
                sort_key=None, limit_is_partial: bool = True) -> dict:
    """limit_is_partial:个股事件表取满 limit 记为 partial;「最近 N 条」型列表(新股日历)取满是常态,只在计数备注里说明。"""
    c = _bind(ctx, rows, attrs)
    if not rows:
        return out([_count(c, count_field, 0, unit, today_str())], status="partial", degraded=empty_note)
    hit = _limit_hit(ctx, len(rows))
    evs = [_count(c, count_field, len(rows), unit, _span(rows, date_key),
                  note=f"达到 limit={hit} 上限,只含最近的 {len(rows)} 条" if hit else None)]
    ordered = sorted(rows, key=sort_key or (lambda r: str(r.get(date_key) or "")), reverse=True)
    keys = _unique_keys([key_of(r) for r in ordered])
    for r, key in zip(ordered[:EV_CAP], keys):
        evs += _fields(c, r, specs, _d(r.get(date_key)), record_key=key, note=note_of(r))
    if hit and limit_is_partial:
        return out(evs, status="partial", degraded=f"返回 {len(rows)} 条,达到 limit 上限,更早的记录没取(limit 最多 5000)",
                   extra={"rows": len(rows), "limit": hit})
    return out(evs, extra={"rows": len(rows)})


def earnings_forecast_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    return _event_rows(ctx, rows, attrs, count_field="forecast_count", unit="条", date_key="notice_date",
                       key_of=lambda r: f"{r.get('code')}:{r.get('report_date')}:{r.get('indicator')}",
                       specs=[("forecast_type", "forecast_type", "text"), ("amount_lower", "forecast_amount_lower", "元"), ("amount_upper", "forecast_amount_upper", "元"),
                              ("change_pct_lower", "forecast_change_lower", "%"), ("change_pct_upper", "forecast_change_upper", "%"),
                              ("prior_year_amount", "forecast_prior_year_amount", "元")],
                       note_of=lambda r: f"报告期={r.get('report_date')};指标={r.get('indicator')}", empty_note="没有业绩预告")


def institution_survey_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    if rows and "org_name" in rows[0]:  # detail=True:一家机构一行,同一次调研有多行
        return _institution_survey_detail(ctx, rows, attrs)
    return _event_rows(ctx, rows, attrs, count_field="survey_count", unit="次", date_key="survey_date",
                       key_of=lambda r: f"{r.get('code')}:{r.get('survey_date')}:{r.get('notice_date')}",
                       specs=[("org_count", "survey_org_count", "家"), ("survey_way", "survey_way", "text")],
                       note_of=lambda r: f"公告日={r.get('notice_date')};地点={str(r.get('place') or '')[:60]}", empty_note="区间内没有机构调研")



def _institution_survey_detail(ctx: dict, rows: list, attrs: dict) -> dict:
    c = _bind(ctx, rows, attrs)
    event_of = lambda r: (str(r.get("code")), str(r.get("survey_date")), str(r.get("notice_date")))  # noqa: E731
    events = {event_of(r) for r in rows}
    span = _span(rows, "survey_date")
    hit = _limit_hit(ctx, len(rows))
    cut = f";达到 limit={hit} 上限,只含最近的 {len(rows)} 条明细" if hit else ""
    evs = [_count(c, "survey_count", len(events), "次", span, note="按 代码 + 接待日 + 公告日 去重的调研次数" + cut),
           _count(c, "survey_org_rows", len(rows), "条", span, note="机构明细行数(一家机构一行)" + cut)]
    ordered = sorted(rows, key=lambda r: str(r.get("survey_date") or ""), reverse=True)
    # 每行都出证据、不合并(合并要挑保留哪行,会丢字段);键用 JSON 数组不截断,完全相同的行靠 #n 区分
    keys = _unique_keys([_rk(*event_of(r), r.get("org_name"), r.get("org_type"), r.get("investigators")) for r in ordered])
    for r, key in zip(ordered[:EV_CAP], keys):
        evs += _fields(c, r, [("org_name", "survey_org_name", "text"), ("org_type", "survey_org_type", "text")], _d(r.get("survey_date")),
                       record_key=key, note=f"公告日={r.get('notice_date')};调研人员={str(r.get('investigators') or '')[:60]}")
    extra = {"rows": len(rows), "events": len(events), "duplicate_rows": len(keys) - len(set(map(_rk_base, keys)))}
    if hit:
        return out(evs, status="partial", degraded=f"返回 {len(rows)} 条机构明细,达到 limit 上限,更早的调研没取(limit 最多 5000)",
                   extra=dict(extra, limit=hit))
    return out(evs, extra=extra)


def holder_trades_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    return _event_rows(ctx, rows, attrs, count_field="holder_trade_count", unit="条", date_key="notice_date",
                       key_of=lambda r: f"{r.get('code')}:{r.get('holder')}:{r.get('start_date')}:{r.get('end_date')}:{r.get('notice_date')}",
                       specs=[("change_shares_10k", "holder_change_shares", "万股"), ("change_pct_total", "holder_change_pct_total", "%"),
                              ("after_pct_total", "holder_after_pct_total", "%"), ("avg_price", "holder_trade_avg_price", "元")],
                       note_of=lambda r: f"{r.get('holder')};{r.get('direction')};{r.get('channel')};{r.get('start_date')}~{r.get('end_date')}",
                       empty_note="没有增减持记录")


def share_buyback_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    return _event_rows(ctx, rows, attrs, count_field="buyback_count", unit="条", date_key="latest_notice",
                       key_of=lambda r: f"{r.get('code')}:{r.get('plan_start')}:{r.get('latest_notice')}",
                       specs=[("progress", "buyback_progress", "text"), ("amount_upper", "buyback_amount_upper", "元"), ("price_cap", "buyback_price_cap", "元"),
                              ("done_amount", "buyback_done_amount", "元"), ("done_shares", "buyback_done_shares", "股")],
                       note_of=lambda r: f"计划 {r.get('plan_start')}~{r.get('plan_end')};目的={str(r.get('objective') or '')[:60]}", empty_note="没有回购记录")


def buyback_history_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    return _event_rows(ctx, rows, attrs, count_field="buyback_plan_count", unit="个", date_key="first_notice",
                       key_of=lambda r: _rk(r.get("code"), r.get("first_notice"), r.get("plan_start"), r.get("amount_upper")),
                       specs=[("progress", "buyback_progress", "text"), ("amount_lower", "buyback_amount_lower", "元"), ("amount_upper", "buyback_amount_upper", "元"),
                              ("price_cap", "buyback_price_cap", "元"), ("done_amount", "buyback_done_amount", "元"), ("done_shares", "buyback_done_shares", "股")],
                       note_of=lambda r: f"首次公告 {r.get('first_notice')};计划 {r.get('plan_start')}~{r.get('plan_end')};最新公告 {r.get('latest_notice')}",
                       empty_note="没有回购方案")


def dragon_tiger_history_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    return _event_rows(ctx, rows, attrs, count_field="dragon_tiger_rows", unit="条", date_key="date",
                       key_of=lambda r: _rk(r.get("code"), r.get("date"), r.get("reason")),
                       specs=[("change_pct", "lhb_change_pct", "%"), ("net_buy", "lhb_net_buy", "元"), ("buy_amt", "lhb_buy_amt", "元"),
                              ("sell_amt", "lhb_sell_amt", "元"), ("turnover_pct", "lhb_turnover", "%")],
                       note_of=lambda r: f"上榜理由:{str(r.get('reason') or '')[:80]}", empty_note="没有上过龙虎榜")


def lockup_history_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    return _event_rows(ctx, rows, attrs, count_field="lockup_batch_count", unit="批", date_key="date",
                       key_of=lambda r: _rk(r.get("code"), r.get("date"), r.get("type")),
                       specs=[("able_shares_10k", "lockup_able_shares", "万股"), ("total_ratio_pct", "lockup_total_ratio", "%"), ("holders", "lockup_holders", "个")],
                       note_of=lambda r: f"{r.get('type')}", empty_note="没有限售解禁记录")


def equity_pledge_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    return _event_rows(ctx, rows, attrs, count_field="pledge_snapshot_count", unit="期", date_key="date",
                       key_of=lambda r: f"{r.get('code')}:{r.get('date')}",
                       specs=[("pledge_ratio_pct", "pledge_ratio", "%"), ("pledged_shares_10k", "pledged_shares", "万股"),
                              ("pledged_mktcap_10k", "pledged_mktcap", "万元"), ("pledge_count", "pledge_count", "笔")],
                       note_of=lambda r: f"{r.get('name')};{r.get('industry')}", empty_note="没有质押记录")


def ipo_calendar_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    return _event_rows(ctx, rows, attrs, count_field="ipo_count", unit="只", date_key="apply_date",
                       key_of=lambda r: f"ipo:{r.get('code')}",
                       specs=[("issue_price", "ipo_issue_price", "元"), ("issue_pe", "ipo_issue_pe", "倍"), ("win_rate_pct", "ipo_win_rate", "%"),
                              ("listing_date", "ipo_listing_date", "date")],
                       note_of=lambda r: f"{r.get('code')} {r.get('name')};{r.get('exchange')}/{r.get('board')};申购代码={r.get('apply_code')}",
                       empty_note="新股日历为空", limit_is_partial=False)


# ---------- 22 可转债 ----------
def convertible_bonds_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    c = _bind(ctx, rows, attrs)
    day = today_str()
    if not rows:
        return out([_count(c, "cb_count", 0, "只", day)], status="partial", degraded="没有符合条件的可转债")
    evs = [_count(c, "cb_count", len(rows), "只", day, note="状态分布:" + ",".join(f"{k}={v}" for k, v in sorted(
        {s: sum(1 for r in rows if r.get("status") == s) for s in {r.get("status") for r in rows}}.items(), key=lambda kv: str(kv[0]))))]
    ordered = sorted(rows, key=lambda r: to_float(r.get("issue_size_100m")) or 0, reverse=True)
    for r in ordered[:EV_CAP]:
        evs += _fields(c, r, [("bond_price", "cb_price", "元"), ("convert_price", "cb_convert_price", "元"), ("convert_value", "cb_convert_value", "元"),
                              ("premium_pct", "cb_premium", "%"), ("issue_size_100m", "cb_issue_size", "亿元")],
                       day, record_key=f"cb:{r.get('code')}", note=f"{r.get('code')} {r.get('name')};正股 {r.get('stock_code')} {r.get('stock_name')};{r.get('status')};评级 {r.get('rating')}")
    return out(evs, extra={"rows": len(rows)})
