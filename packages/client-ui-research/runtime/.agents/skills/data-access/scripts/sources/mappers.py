"""映射层:把源函数的结构化结果变成契约证据(evidence)+ extra + missing。

约定:每个 mapper 签名 mapper(result, ctx) -> {"evidence": [...], "extra": {...}, "missing": [...], "status"?: ok|partial|failed, "degraded"?: str, "reason"?: str}
ctx = {script, symbol, market, source, endpoint, raw_ref, raws, as_of, args, ep}
原则(研究宪法 §4 / data-access 手册):
- 单位按源原样,不换算;金额 currency 默认 CNY(美股 USD / 港股 HKD 由各 mapper 指定);非金额 currency="n/a"
- 时间序列 / 多行表:原始数据已在 raw/ 落盘;evidence 只放"最新值 + 统计(条数 / 起止)"或逐行关键字段(带 record_key,避免撞 id)
- 缺关键字段 → missing;一条证据都没有 → failed(由取数器判),不伪造
"""
from __future__ import annotations

import json
import re
import os
import sys
from typing import Any, Callable, Iterable, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import evidence as _ev, to_float, today_str  # noqa: E402
from sources._http import record_raw, dump_json_bytes  # noqa: E402

MONEY_UNITS = {"元", "万元", "亿元", "元/股", "美元", "港元", "万美元", "亿美元", "万港元", "亿港元"}


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ]")


def _as_of_date(v: str) -> str:
    """
    证据契约要求 as_of 是 **YYYY-MM-DD**。在这里收口,不靠每个 mapper 自己记得截断。

    🔴 为什么放在 ev():原来是"每个 mapper 各自 `[:10]`",于是**有一个忘了** ——
       宏观概率那条把完整时间戳 `2026-08-26T02:20:07Z` 写进 as_of,取数当时不报错,
       一路跑到四分钟后的阶段校验才炸,而且 agent 重试三次也修不好(取数产物不是它能改的)。
       同一个不变量散在九个 mapper 里,迟早漏一个。
    ⚠️ 非法值**当场抛错**,不"尽力修好":取数阶段失败是有兜底的(记 gap、照常往下走),
       而一个违约的信封会让整个阶段失败 —— 早失败、错得清楚,比晚失败、错得含糊好。
    ⚠️ 诚实的边界:带 Z 的时间戳截出来的是 **UTC 日期**,靠近 UTC 午夜时可能与当地交易日差一天。
       调用方要当地日期就自己先转好再传进来。
    """
    v = str(v)
    if _DATE_RE.match(v):
        return v
    m = _TS_RE.match(v)
    if m:
        return m.group(1)
    raise ValueError(f"as_of 必须是 YYYY-MM-DD 或 ISO 时间戳,收到 {v!r}")


def ev(ctx: dict, field: str, value: Any, unit: str, period: str, *, currency: Optional[str] = None, as_of: Optional[str] = None,
       record_key: Optional[str] = None, note: Optional[str] = None, adjustment: str = "not_applicable", raw_ref: Optional[str] = None,
       source: Optional[str] = None, endpoint: Optional[str] = None) -> dict:
    """构造一条证据;currency 未指定时:金额单位 → 按市场(CN=CNY / US=USD / HK=HKD),其余 n/a。"""
    if currency is None:
        currency = {"US": "USD", "HK": "HKD"}.get(ctx["market"], "CNY") if unit in MONEY_UNITS or unit.endswith(("元", "美元", "港元")) else "n/a"
    return _ev(script=ctx["script"], symbol=ctx["symbol"], market=ctx["market"], field=field, value=value, unit=unit, period=str(period),
               source=source or ctx["source"], endpoint=endpoint or ctx["endpoint"], raw_ref=raw_ref if raw_ref is not None else ctx.get("raw_ref"),
               currency=currency, as_of=_as_of_date(as_of or ctx.get("as_of") or today_str()), adjustment=adjustment, note=note, record_key=record_key)


def out(evidence: list, extra: Optional[dict] = None, missing: Optional[list] = None, status: Optional[str] = None, degraded: Optional[str] = None,
        reason: Optional[str] = None) -> dict:
    d: dict[str, Any] = {"evidence": evidence, "extra": extra or {}, "missing": missing or []}
    if status:
        d["status"] = status
    if degraded:
        d["degraded"] = degraded
    if reason:
        d["reason"] = reason
    return d


def extracted(ctx: dict, obj: Any, ext: str = "json") -> Optional[str]:
    """把 SDK / TCP 拼装的结果以 extracted_ 前缀落盘(不冒充传输层原文),返回 raw_ref。"""
    if ext == "json":
        return record_raw(dump_json_bytes(obj), "json", kind="extracted")
    return record_raw(obj if isinstance(obj, bytes) else str(obj).encode("utf-8"), ext, kind="extracted")


# ---------- 通用:字典 → 多条证据 ----------
FieldSpec = tuple  # (result_key, field, unit) 或 (result_key, field, unit, currency)


def dict_fields(ctx: dict, d: dict, specs: Iterable[FieldSpec], period: str, *, as_of: Optional[str] = None, note: Optional[str] = None,
                record_key: Optional[str] = None, numeric: bool = True) -> tuple[list, list]:
    """按 specs 从字典里取字段 → 证据;缺失 / 非数 → missing。numeric=False 时字符串原样(unit 通常 'text')。"""
    evs, missing = [], []
    for spec in specs:
        key, field, unit = spec[0], spec[1], spec[2]
        cur = spec[3] if len(spec) > 3 else None
        v = d.get(key)
        if numeric and unit != "text":
            v = to_float(v)
        if v is None or v == "":
            missing.append({"field": field, "period": period, "reason": f"源字段 {key} 缺失"})
            continue
        evs.append(ev(ctx, field, v, unit, period, currency=cur, as_of=as_of, note=note, record_key=record_key))
    return evs, missing


# ---------- 通用:行列表 → 逐行证据 ----------
def rows_fields(ctx: dict, rows: list[dict], specs: Iterable[FieldSpec], *, period_of: Callable[[dict], str], key_of: Callable[[dict], str],
                as_of_of: Optional[Callable[[dict], Optional[str]]] = None, note_of: Optional[Callable[[dict], Optional[str]]] = None,
                limit: Optional[int] = None, numeric: bool = True) -> list:
    """每行按 specs 产出若干证据,period / record_key 由回调给出(同日多条靠 record_key 区分)。"""
    evs = []
    for i, row in enumerate(rows if limit is None else rows[:limit]):
        period = period_of(row)
        rk = key_of(row)
        for spec in specs:
            key, field, unit = spec[0], spec[1], spec[2]
            cur = spec[3] if len(spec) > 3 else None
            v = row.get(key)
            if numeric and unit != "text":
                v = to_float(v)
            if v is None or v == "":
                continue
            evs.append(ev(ctx, field, v, unit, period, currency=cur, as_of=as_of_of(row) if as_of_of else None, record_key=rk,
                          note=note_of(row) if note_of else None, raw_ref=row.get("_raw")))  # 行级 _raw(多请求端点逐请求绑定)优先
    return evs


def none_fields(rows: list[dict], specs: Iterable[tuple[str, str, str]], *, period_of: Callable[[dict], str]) -> list:
    """源没给的数值字段逐条记成 missing(key, 证据字段名, 原因):只省略证据的话,剩下的证据会让结果被判成完整(ok)。"""
    return [{"field": field, "period": period_of(r), "reason": what}
            for r in rows for key, field, what in specs if to_float(r.get(key)) is None]


def series_summary(ctx: dict, rows: list[dict], *, field_prefix: str, value_key: str, unit: str, date_key: str, currency: Optional[str] = None,
                   note: Optional[str] = None) -> list:
    """时间序列只给"最新值 + 起止 + 条数"三类证据;全序列在 raw/ 里。"""
    if not rows:
        return []
    rows_sorted = sorted(rows, key=lambda r: str(r.get(date_key, "")))
    last = rows_sorted[-1]
    first = rows_sorted[0]
    evs = []
    v = to_float(last.get(value_key))
    if v is not None:
        evs.append(ev(ctx, f"{field_prefix}_latest", v, unit, str(last.get(date_key)), currency=currency, as_of=str(last.get(date_key))[:10], note=note))
    evs.append(ev(ctx, f"{field_prefix}_points", len(rows), "条", f"{str(first.get(date_key))[:10]}..{str(last.get(date_key))[:10]}", currency="n/a"))
    return evs


def text_items(ctx: dict, items: list[dict], *, field: str, title_key: str, date_key: str, key_of: Callable[[dict], str], limit: int = 30,
               extra_keys: Iterable[str] = ()) -> list:
    """新闻 / 公告 / 研报标题类:每条一证据(value = 标题文本,period = 日期,record_key 唯一),附 note 放来源 / 链接等。"""
    evs = []
    for it in items[:limit]:
        title = str(it.get(title_key, "")).strip()
        if not title:
            continue
        date = str(it.get(date_key, ""))[:10] or today_str()
        note = "; ".join(f"{k}={str(it.get(k))[:120]}" for k in extra_keys if it.get(k) not in (None, ""))
        evs.append(ev(ctx, field, title[:300], "text", date, currency="n/a", as_of=date, record_key=key_of(it), note=note or None, raw_ref=it.get("_raw")))
    return evs


def empty(reason: str) -> dict:
    return out([], status="failed", reason=reason)


# =====================================================================
# 东财(eastmoney)端点
# =====================================================================
def em_reports(result: list, ctx: dict) -> dict:
    """研报列表:每篇一条标题证据(record_key=infoCode;note 含机构 / 评级 / 三年 EPS 预测),再给近一年篇数 / 评级分布汇总。"""
    if not result:
        return empty("东财无该标的研报")
    rows = sorted(result, key=lambda r: str(r.get("publishDate", "")), reverse=True)
    evs = text_items(ctx, rows, field="research_report_title", title_key="title", date_key="publishDate",
                     key_of=lambda r: str(r.get("infoCode") or r.get("encodeUrl") or f"{r.get('orgSName')}-{str(r.get('publishDate'))[:10]}"), limit=int(ctx["args"].get("limit", 40)),
                     extra_keys=("orgSName", "emRatingName", "predictThisYearEps", "predictNextYearEps", "predictNextTwoYearEps", "author"))
    cutoff = (__import__("datetime").datetime.now() - __import__("datetime").timedelta(days=365)).strftime("%Y-%m-%d")
    last_year = [r for r in rows if str(r.get("publishDate", ""))[:10] >= cutoff]
    ratings: dict[str, int] = {}
    for r in last_year:
        k = str(r.get("emRatingName") or "未评级")
        ratings[k] = ratings.get(k, 0) + 1
    period = f"{cutoff}..{today_str()}"
    # 🔴 取数有页数上限:源还有下一页、取到的最早一篇又还在近一年里,说明近一年没取完 —— 这时取到的只是样本,
    #    不能写成「近一年 N 篇」和评级分布(第四轮审计 B5)。列进 missing,端点标 partial
    oldest = str(rows[-1].get("publishDate", ""))[:10]
    if any(r.get("_more_pages") for r in result) and oldest >= cutoff:
        miss = [{"field": f, "period": period, "reason": f"只取到最近 {len(rows)} 篇(最早 {oldest}),近一年没取完,不给全年篇数和评级分布"}
                for f in ("research_report_count_1y", "research_report_rating_count_1y")]
        return out(evs, extra={"total_reports": len(rows), "orgs": len({r.get("orgSName") for r in rows}), "sample_only": True}, missing=miss)
    evs.append(ev(ctx, "research_report_count_1y", len(last_year), "篇", period, currency="n/a", note="东财 reportapi 近一年研报篇数"))
    for k, n in sorted(ratings.items(), key=lambda x: -x[1]):
        evs.append(ev(ctx, "research_report_rating_count_1y", n, "篇", period, currency="n/a", record_key=k, note=f"评级={k}"))
    return out(evs, extra={"total_reports": len(rows), "orgs": len({r.get("orgSName") for r in rows}), "ratings_1y": ratings})


def em_industry_reports(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财无行业研报")
    rows = sorted(result, key=lambda r: str(r.get("publishDate", "")), reverse=True)
    evs = text_items(ctx, rows, field="industry_report_title", title_key="title", date_key="publishDate", key_of=lambda r: str(r.get("infoCode") or r.get("encodeUrl")),
                     limit=int(ctx["args"].get("limit", 40)), extra_keys=("industryName", "orgSName", "emRatingName"))
    return out(evs, extra={"total": len(rows)})


def em_concept_blocks(result: dict, ctx: dict) -> dict:
    boards = (result or {}).get("boards") or []
    if not boards:
        return empty("东财 slist 无板块归属")
    evs = [ev(ctx, "board_membership", b.get("name", ""), "text", today_str(), currency="n/a", record_key=str(b.get("code")), note=f"板块代码={b.get('code')};当日涨跌={b.get('change_pct')}%;龙头={b.get('lead_stock')}") for b in boards if b.get("name")]
    evs.append(ev(ctx, "board_membership_count", len(boards), "个", today_str(), currency="n/a"))
    return out(evs, extra={"concept_tags": result.get("concept_tags", [])})


def em_fund_flow_minute(result: list, ctx: dict) -> dict:
    """分钟资金流:东财 fflow/kline 的各档净额为**当日累计值**(盘中逐分钟刷新,收盘后为全天值),不做求和。"""
    if not result:
        return empty("当日无分钟资金流(非交易时段 / ETF 不覆盖 / 接口不通)")
    last = result[-1]
    t = str(last.get("time", ""))
    day = t[:10] if len(t) >= 10 else today_str()
    evs = [ev(ctx, "main_net_inflow_intraday_cum", last.get("main_net"), "元", day, as_of=day, note=f"主力净流入当日累计至 {t};共 {len(result)} 个分钟点"),
           ev(ctx, "super_net_inflow_intraday_cum", last.get("super_net"), "元", day, as_of=day, note=f"超大单净流入当日累计至 {t}"),
           ev(ctx, "large_net_inflow_intraday_cum", last.get("large_net"), "元", day, as_of=day, note=f"大单净流入当日累计至 {t}"),
           ev(ctx, "fund_flow_minute_points", len(result), "条", day, currency="n/a", as_of=day)]
    return out(evs, extra={"first_time": result[0].get("time"), "last_time": t})


def em_fund_flow_120d(result: list, ctx: dict) -> dict:
    if not result:
        return empty("120 日资金流为空(push2his 在部分网络不通)")
    rows = sorted(result, key=lambda r: r.get("date", ""))
    evs = series_summary(ctx, rows, field_prefix="main_net_inflow_daily", value_key="main_net", unit="元", date_key="date")
    degraded = None
    if len(rows) < 5:
        degraded = f"仅 {len(rows)} 条:push2his 不通时回落 push2delay 只给最新一日;历史序列请用备源 sina_fund_flow"
    # 最新一天源给的是 "-":没有最新值,进缺口(审计第三轮 B3:以前写成 0 元、状态还是 ok)
    missing = []
    if to_float(rows[-1].get("main_net")) is None:
        missing.append({"field": "main_net_inflow_daily_latest", "period": str(rows[-1].get("date", "")), "reason": "源在最新一天的主力净流入是空值(-),不当 0"})
    # 多日合计等派生量不在取数层计算(AGENTS §0.2:派生量只由 calc 计算并记 DAG);全序列在 raw 里,agent 用 calc 读 raw 求和
    return out(evs, missing=missing, status="partial" if (degraded or missing) else None, degraded=degraded)


def em_dragon_tiger(result: dict, ctx: dict) -> dict:
    recs = (result or {}).get("records") or []
    w = (result or {}).get("window") or ["", ""]
    period = f"{w[0]}..{w[1]}"
    evs = [ev(ctx, "dragon_tiger_count", len(recs), "次", period, currency="n/a", note="回看窗口内上榜次数")]
    evs += rows_fields(ctx, recs, [("net_buy", "dragon_tiger_net_buy", "万元"), ("turnover", "dragon_tiger_turnover", "%")], period_of=lambda r: r["date"],
                       key_of=lambda r: f"{r['date']}|{r.get('reason','')[:40]}", note_of=lambda r: f"上榜原因={r.get('reason','')[:80]}")
    # 源没给净买额 / 换手率的上榜记录进缺口(审计第三轮 B3:以前写成 0 万元)
    missing = [{"field": f, "period": r["date"], "reason": f"{r['date']} 这次上榜源没给{label}"}
               for r in recs for k, f, label in (("net_buy", "dragon_tiger_net_buy", "净买额"), ("turnover", "dragon_tiger_turnover", "换手率"))
               if to_float(r.get(k)) is None]
    inst = (result or {}).get("institution") or {}
    if recs and inst:
        if to_float(inst.get("net_amt")) is None:
            missing.append({"field": "dragon_tiger_institution_net", "period": recs[0]["date"], "reason": "机构席位里有金额缺失,机构净额不算"})
        else:
            evs.append(ev(ctx, "dragon_tiger_institution_net", inst["net_amt"], "万元", recs[0]["date"], note=f"机构买 {inst.get('buy_amt')} 卖 {inst.get('sell_amt')}(万元)"))
    return out(evs, extra={"seats": (result or {}).get("seats"), "window": w}, missing=missing)


def em_lockup(result: dict, ctx: dict) -> dict:
    hist = (result or {}).get("history") or []
    up = (result or {}).get("upcoming") or []
    w = (result or {}).get("window") or ["", ""]
    # 只出实际可流通股数和占总股本比例(审计第三轮 B2:以前把占流通股比例标成占总股本,还出了口径不清的 lockup_shares)
    specs = [("able_shares", "lockup_able_shares", "万股"), ("ratio", "lockup_ratio_of_total", "小数")]
    up = [{**r, "_i": i} for i, r in enumerate(up)]
    hist = [{**r, "_i": i} for i, r in enumerate(hist)]
    missing = [{"field": f, "period": r["date"], "reason": f"{tag} {r['date']} {r.get('type', '')}:源没给{label}"}
               for tag, rs in (("待解禁", up), ("历史解禁", hist[:10])) for r in rs
               for k, f, label in (("able_shares", "lockup_able_shares", "实际可流通股数"), ("ratio", "lockup_ratio_of_total", "占总股本比例"))
               if to_float(r.get(k)) is None]
    evs = rows_fields(ctx, up, specs, period_of=lambda r: r["date"], key_of=lambda r: f"up|{r['date']}|{r['_i']}|{r.get('type','')}", note_of=lambda r: f"待解禁:{r.get('type','')}")
    evs += rows_fields(ctx, hist, specs, period_of=lambda r: r["date"], key_of=lambda r: f"hist|{r['date']}|{r['_i']}|{r.get('type','')}", note_of=lambda r: f"历史解禁:{r.get('type','')}", limit=10)
    evs.append(ev(ctx, "lockup_upcoming_count", len(up), "批", f"{w[0]}..{w[1]}", currency="n/a", note="未来窗口待解禁批次"))
    return out(evs, missing=missing)


def em_industry_comparison(result: dict, ctx: dict) -> dict:
    rows = (result or {}).get("rows") or []
    if not rows:
        return empty("行业板块列表为空")
    evs = rows_fields(ctx, rows, [("change_pct", "industry_board_change_pct", "%"), ("up_count", "industry_board_up_count", "只"), ("down_count", "industry_board_down_count", "只")],
                      period_of=lambda r: today_str(), key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('name')} 排名 {r.get('rank')} 领涨 {r.get('leader')}")
    evs.append(ev(ctx, "industry_board_total", len(rows), "个", today_str(), currency="n/a"))
    return out(evs, extra={"top": result.get("top", [])[:10], "bottom": result.get("bottom", [])[-10:]})


def em_board_fund_flow(result: dict, ctx: dict) -> dict:
    rows = (result or {}).get("rows") or []
    if not rows:
        return empty("板块资金流为空")
    per = result.get("period", "today")
    specs = [("main_net", f"board_main_net_{per}", "元"), ("main_pct", f"board_main_pct_{per}", "%"), ("change_pct", f"board_change_pct_{per}", "%")]
    evs = rows_fields(ctx, rows, specs, period_of=lambda r: today_str(), key_of=lambda r: f"{result.get('board_type')}|{r.get('code')}", note_of=lambda r: f"{r.get('name')} 排名 {r.get('rank')}")
    extra = {"board_type": result.get("board_type"), "period": per, "total": result.get("total")}
    want = result.get("expected")
    if isinstance(want, int) and len(rows) < want:
        return out(evs, extra=extra, status="partial", missing=[{"field": specs[0][1], "period": today_str(), "reason": f"上游共 {result.get('total')} 个板块,应取 {want} 个,分页中途断了,只拿到 {len(rows)} 个"}])
    return out(evs, extra=extra)


def em_daily_dragon_tiger(result: dict, ctx: dict) -> dict:
    stocks = (result or {}).get("stocks") or []
    day = (result or {}).get("date") or today_str()
    if not stocks:
        return out([ev(ctx, "dragon_tiger_market_count", 0, "条", day, currency="n/a", note=(result or {}).get("note", ""))], status="partial", degraded="无龙虎榜数据(非交易日或盘后未更新)")
    limit = max(1, int(ctx["args"].get("limit", 100)))
    picked, note = stocks, None
    if len(stocks) > limit:
        # 逐条只留 limit 条时两头各留一半：净买入居前 + 净卖出居前（只留开头会把净卖出那头全丢掉）；净额没给的排不了序，不进逐条
        known = sorted((s for s in stocks if s.get("net_buy_wan") is not None), key=lambda s: s["net_buy_wan"], reverse=True)
        head = limit // 2
        if len(known) > limit:
            picked = known[:head] + known[head:][-(limit - head):]
            note = f"共 {len(stocks)} 条；逐条只列净买额最大的 {head} 条和最小的 {limit - head} 条"
        else:
            picked = known
            note = f"共 {len(stocks)} 条；净买额没给的 {len(stocks) - len(known)} 条不进逐条"
    evs = rows_fields(ctx, picked, [("net_buy_wan", "dragon_tiger_market_net_buy", "万元"), ("change_pct", "dragon_tiger_market_change_pct", "%")], period_of=lambda r: day,
                      key_of=lambda r: f"{r.get('code')}|{r.get('reason','')[:30]}", note_of=lambda r: f"{r.get('code')} {r.get('name')}:{r.get('reason','')[:60]}")
    evs.append(ev(ctx, "dragon_tiger_market_count", len(stocks), "条", day, currency="n/a", note=note))
    evs.append(ev(ctx, "dragon_tiger_market_stocks", len({s.get("code") for s in stocks if s.get("code")}), "只", day, currency="n/a",
                  note="按代码去重（同一只可能因几条理由各上榜一次）"))
    if result.get("truncated"):
        return out(evs, status="partial", degraded="上榜记录翻到上限还没取完：只取到按净买额从大到小的前面一部分，净卖出居前和上榜只数可能不全")
    return out(evs)


def em_margin(result: list, ctx: dict) -> dict:
    if not result:
        return empty("无两融明细(非两融标的或接口为空)")
    rows = sorted(result, key=lambda r: r["date"])
    evs = series_summary(ctx, rows, field_prefix="margin_financing_balance", value_key="rzye", unit="元", date_key="date", note="融资余额")
    evs += series_summary(ctx, rows, field_prefix="margin_short_balance", value_key="rqye", unit="元", date_key="date", note="融券余额")
    evs += rows_fields(ctx, rows[-10:], [("rzye", "margin_financing_balance", "元"), ("rzmre", "margin_financing_buy", "元"), ("rqye", "margin_short_balance", "元")],
                       period_of=lambda r: r["date"], key_of=lambda r: r["date"])
    # 两融标的这三项天天有数(10-11 实测三只各 30 天没有空值):空着 = 源这次没给,记进 missing 让结果标 partial(v2.2.0 审计 Codex 第 5 条)
    missing = none_fields(rows[-10:], [("rzye", "margin_financing_balance", "融资余额没取到"), ("rzmre", "margin_financing_buy", "融资买入额没取到"),
                                       ("rqye", "margin_short_balance", "融券余额没取到")], period_of=lambda r: r["date"])
    return out(evs, missing=missing)


def em_block_trade(result: list, ctx: dict) -> dict:
    if not result:
        return out([ev(ctx, "block_trade_count", 0, "笔", today_str(), currency="n/a")], status="ok")
    rows = [{**r, "_i": i} for i, r in enumerate(result)]  # 同日同买卖方同价可多笔,record_key 必须带行号防 id 撞车
    evs = rows_fields(ctx, rows, [("price", "block_trade_price", "元"), ("premium_pct", "block_trade_premium_pct", "%"), ("vol", "block_trade_volume", "万股"), ("amount", "block_trade_amount", "万元")],
                      period_of=lambda r: r["date"], key_of=lambda r: f"{r['date']}|{r['_i']}|{r.get('buyer','')[:20]}|{r.get('seller','')[:20]}", note_of=lambda r: f"买方={r.get('buyer','')[:40]};卖方={r.get('seller','')[:40]};单位按东财数据中心口径")
    evs.append(ev(ctx, "block_trade_count", len(result), "笔", f"{result[-1]['date']}..{result[0]['date']}", currency="n/a"))
    # 缺的字段逐笔记进 missing(审计第二轮 B4):只省略证据的话,有价格 / 笔数就被判成完整(ok)
    missing = []
    for r in rows:
        for key, field, what in (("price", "block_trade_price", "成交价没取到"), ("premium_pct", "block_trade_premium_pct", "缺收盘价或成交价,算不出溢价率"),
                                 ("vol", "block_trade_volume", "成交量没取到"), ("amount", "block_trade_amount", "成交额没取到")):
            if to_float(r.get(key)) is None:
                missing.append({"field": field, "period": r["date"], "reason": f"第 {r['_i'] + 1} 笔:{what}"})
    return out(evs, missing=missing)


def em_holder_num(result: list, ctx: dict) -> dict:
    if not result:
        return empty("股东户数为空")
    evs = rows_fields(ctx, result, [("holder_num", "shareholder_count", "户"), ("change_ratio", "shareholder_count_change_pct", "%"), ("avg_shares", "shareholder_avg_free_shares", "股")],
                      period_of=lambda r: r["date"], key_of=lambda r: r["date"])
    # 只有户数本身空着才算缺:户均持股源里经常就是空的(10-11 实测三只都空),环比在首期也可能本来没有
    return out(evs, missing=none_fields(result, [("holder_num", "shareholder_count", "股东户数没取到")], period_of=lambda r: r["date"]))


def em_dividend(result: list, ctx: dict) -> dict:
    if not result:
        return out([ev(ctx, "dividend_record_count", 0, "次", today_str(), currency="n/a")], status="ok")
    rows = [{**r, "_i": i} for i, r in enumerate(result) if r.get("date")]
    # 🔴 PRETAX_BONUS_RMB 是**每 10 股**派现（茅台 2025 年报 280.2423 = 每股 28.02 元，与 IMPL_PLAN_PROFILE「10派X元」一致）。
    #    之前写成 dividend_pretax_per_share / 元/股，进研究上下文就是放大 10 倍的每股分红。
    evs = rows_fields(ctx, rows, [("bonus_rmb", "dividend_pretax_per_10_shares", "元/10股", "CNY"), ("transfer_ratio", "transfer_per_10_shares", "股"), ("bonus_ratio", "bonus_per_10_shares", "股")],
                      period_of=lambda r: r["date"], key_of=lambda r: f"{r['date']}|{r['_i']}|{r.get('report_date','')}", note_of=lambda r: f"进度={r.get('plan','')};报告期={r.get('report_date','')};源字段 PRETAX_BONUS_RMB 口径")
    evs.append(ev(ctx, "dividend_record_count", len(result), "次", f"{result[-1].get('date','')}..{result[0].get('date','')}", currency="n/a"))
    return out(evs)


# ---------- 东财:新闻 / 基本面 / 打板 / 监控 / 异动 / 人气 ----------
def em_stock_news(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财个股新闻两次请求均返回空列表；仅表示本次搜索未返回条目，不代表该公司没有新闻")
    evs = text_items(ctx, result, field="news_title", title_key="title", date_key="time", key_of=lambda r: str(r.get("url") or r.get("title"))[:160], limit=int(ctx["args"].get("limit", 30)),
                     extra_keys=("source", "url", "content"))
    fallback = next((r["_fallback"] for r in result if r.get("_fallback")), None)
    if fallback:
        return out(evs, extra={"count": len(result), "transport": "browser_jsonp", "fallback_reason": fallback},
                   status="partial", degraded=f"主请求{fallback}；已用同一东财源的备用请求取得新闻，不代表独立信源交叉验证")
    return out(evs, extra={"count": len(result)})


def em_global_news(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财 7x24 资讯为空")
    evs = text_items(ctx, result, field="market_news_title", title_key="title", date_key="time", key_of=lambda r: f"{str(r.get('time'))[:19]}|{str(r.get('title'))[:60]}",
                     limit=int(ctx["args"].get("limit", 50)), extra_keys=("summary",))
    return out(evs, extra={"count": len(result)})


def em_stock_info(result: dict, ctx: dict) -> dict:
    if not result or not result.get("name"):
        return empty("push2 stock/get 无数据")
    day = today_str()
    evs, missing = dict_fields(ctx, result, [("total_shares", "total_shares", "股"), ("float_shares", "float_shares", "股"), ("mcap", "market_cap", "元"), ("float_mcap", "float_market_cap", "元"), ("price", "price", "元")], day)
    for k, f in (("name", "company_name"), ("industry", "industry_em"), ("list_date", "list_date")):
        if result.get(k):
            evs.append(ev(ctx, f, str(result[k]), "text", day, currency="n/a"))
    return out(evs, missing=missing)


# 涨停池带上**那一天**的价格 / 成交额 / 流通市值:复盘看上一个交易日时,页面原来另拉一次实时行情补这三列,
# 显示的是今天此刻的价,和那一天对不上。
_POOL_FIELDS = {"em_zt_pool": ("limit_up_pool", [("pct", "pool_change_pct", "%"), ("limit_days", "pool_limit_days", "板"), ("seal_fund", "pool_seal_fund", "元"), ("break_times", "pool_break_times", "次"), ("turnover", "pool_turnover", "%"),
                                                 ("price", "pool_price", "元"), ("amount", "pool_amount", "元"), ("float_cap", "pool_float_cap", "元")]),
                "em_zb_pool": ("break_board_pool", [("pct", "pool_change_pct", "%"), ("break_times", "pool_break_times", "次"), ("turnover", "pool_turnover", "%"), ("amplitude", "pool_amplitude", "%")]),
                "em_dt_pool": ("limit_down_pool", [("pct", "pool_change_pct", "%"), ("dt_days", "pool_limit_down_days", "天"), ("seal_fund", "pool_seal_fund", "元"), ("open_times", "pool_open_times", "次")]),
                "em_yzt_pool": ("yesterday_limit_up_pool", [("pct", "pool_change_pct", "%"), ("y_limit_days", "pool_y_limit_days", "板"), ("turnover", "pool_turnover", "%")])}


def em_zt_pools(result: list, ctx: dict) -> dict:
    prefix, specs = _POOL_FIELDS[ctx["ep"]["id"]]
    date = str(ctx["args"].get("date") or today_str().replace("-", ""))
    period = f"{date[:4]}-{date[4:6]}-{date[6:8]}" if len(date) == 8 else date
    if not result:
        # 🔴 交易日不可能没有涨停 ⇒ 涨停池 / 昨日涨停池为空只能是超出东财约一个月的保留期,不写成 0 只
        if prefix in ("limit_up_pool", "yesterday_limit_up_pool"):
            return empty(f"{period} 的池子是空的(超出东财约一个月的保留期,或不是交易日);不当成 0 只")
        return out([ev(ctx, f"{prefix}_count", 0, "只", period, currency="n/a", note="池为空(当日无;也可能超出东财约一个月的保留期)")], status="partial", degraded="池为空")
    evs = [ev(ctx, f"{prefix}_count", len(result), "只", period, currency="n/a")]
    # 🔴 逐只明细默认放全(上限 1000)。原来默认 150:行情火热的日子涨停两三百只,复盘页拿今天涨停池和昨日涨停池
    #    对"谁晋级了",被截掉的那些会被算成"没晋级",数字偏低还不报错。真被截了就标 partial 说出来。
    limit = int(ctx["args"].get("limit", 1000))
    evs += rows_fields(ctx, result, specs, period_of=lambda r: period, key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('code')} {r.get('name')} {r.get('industry','')} {r.get('zt_stat','')} 首封 {r.get('first_seal', r.get('y_first_seal', ''))}",
                       limit=limit)
    if len(result) > limit:
        return out(evs, extra={"pool": prefix, "date": period, "rows_total": len(result), "rows_returned": limit}, status="partial",
                   missing=[{"field": specs[0][1], "period": period, "reason": f"池里 {len(result)} 只,只放了前 {limit} 只的明细"}])
    return out(evs, extra={"pool": prefix, "date": period})


def em_limit_up_sentiment(result: dict, ctx: dict) -> dict:
    d = str(result.get("date", ""))
    period = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else d
    if not result.get("zt_count"):
        # 🔴 交易日不可能没有涨停:涨停池为空 = 超出东财保留期或不是交易日,不写成 0 只
        return empty(f"{period} 的涨停池是空的(超出东财约一个月的保留期,或不是交易日);不当成 0 只")
    raws = {k: (result.get(k) or [{}])[0].get("_raw") if result.get(k) else None for k in ("zt", "zb", "dt")}
    evs = [ev(ctx, "limit_up_count", result["zt_count"], "只", period, currency="n/a", raw_ref=raws["zt"] or ctx.get("raw_ref")),
           ev(ctx, "break_board_count", result["zb_count"], "只", period, currency="n/a", raw_ref=raws["zb"] or ctx.get("raw_ref")),
           ev(ctx, "limit_down_count", result["dt_count"], "只", period, currency="n/a", raw_ref=raws["dt"] or ctx.get("raw_ref"))]
    # 炸板率 / 最高连板 / 梯队属派生统计,不在取数层计算(三池明细在 raw 里)
    return out(evs)


def em_stock_monitor(result: list, ctx: dict) -> dict:
    day = today_str()
    evs = [ev(ctx, "monitor_pool_count", len(result or []), "只", day, currency="n/a", note="东财重点监控池(当前生效)")]
    for r in result or []:
        evs.append(ev(ctx, "monitor_pool_member", f"{r.get('code')} {r.get('name')}", "text", day, currency="n/a", record_key=str(r.get("code")), note=f"市场={r.get('market')};监控期 {r.get('start')}~{r.get('end')}"))
    return out(evs)


def em_price_anomaly(result: dict, ctx: dict) -> dict:
    items = (result or {}).get("items") or []
    day = (result or {}).get("date") or today_str()
    day = f"{day[:4]}-{day[4:6]}-{day[6:8]}" if len(day) == 8 and day.isdigit() else day
    evs = [ev(ctx, "price_anomaly_count", len(items), "条", day, currency="n/a")]
    evs += rows_fields(ctx, items, [("change_pct", "anomaly_change_pct", "%"), ("deviation", "anomaly_cum_deviation", "%"), ("days", "anomaly_window_days", "天")], period_of=lambda r: day,
                       key_of=lambda r: f"{r.get('code')}|{r.get('rule_code')}", note_of=lambda r: f"{r.get('code')} {r.get('name')}({r.get('market')}) {r.get('rule')}{'' if r.get('is_today') else '(非当日)'}", limit=int(ctx["args"].get("limit", 200)))
    return out(evs, status="ok" if items else "partial", degraded=None if items else "当日无异动记录")


def em_price_anomaly_count(result: dict, ctx: dict) -> dict:
    items = (result or {}).get("items") or []
    day = (result or {}).get("date") or today_str()
    day = f"{day[:4]}-{day[4:6]}-{day[6:8]}" if len(day) == 8 and day.isdigit() else day
    evs = [ev(ctx, "price_anomaly_stock_count", len(items), "只", day, currency="n/a")]
    evs += rows_fields(ctx, items, [("times", "anomaly_times", "次"), ("deviation", "anomaly_cum_deviation", "%"), ("price", "price", "元"), ("change_pct", "anomaly_change_pct", "%")], period_of=lambda r: day,
                       key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('code')} {r.get('name')}({r.get('market')}) 窗口 {r.get('days')} 天")
    return out(evs, status="ok" if items else "partial", degraded=None if items else "无异动统计")


def em_hot_rank(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财人气榜为空")
    day = today_str()
    # 🔴 `pct` 来自 push2 的 f3 = **涨跌幅**,不是排名变化 —— 旧字段名叫"排名变化百分比",名不副实。
    #    字段名会直接进证据、喂给 agent 写报告:**骗人的名字比缺数据更糟**,它不报错、只让人得出错的结论。
    #    改叫 `change_pct`(与 tx_quote / 板块等同一量同名,口径统一);
    #    **真正的排名变化 `rank_chg` 补成独立证据** —— 它原先只写在 note 里,取不出来用。
    evs = rows_fields(ctx, result, [("rank", "hot_rank", "名"), ("pct", "change_pct", "%"), ("rank_chg", "hot_rank_chg", "名"), ("price", "price", "元")], period_of=lambda r: day, key_of=lambda r: str(r.get("code")),
                      note_of=lambda r: f"{r.get('code')} {r.get('name')} 排名变化 {r.get('rank_chg')}")
    return out(evs, extra={"top10": [(r.get("rank"), r.get("code"), r.get("name")) for r in result[:10]]})


def em_hot_concept(result: list, ctx: dict) -> dict:
    day = today_str()
    if not result:
        return out([ev(ctx, "hot_concept_count", 0, "个", day, currency="n/a")], status="partial", degraded="当前无热门概念命中")
    evs = [ev(ctx, "hot_concept_count", len(result), "个", day, currency="n/a")]
    evs += rows_fields(ctx, result, [("hit", "hot_concept_hit", "热度")], period_of=lambda r: day, key_of=lambda r: str(r.get("bk")), note_of=lambda r: f"概念={r.get('concept')}")
    return out(evs, extra={"concepts": [r.get("concept") for r in result]})


# ---------- 同花顺 ----------
def ths_hot_reason(result: list, ctx: dict) -> dict:
    date = str(ctx["args"].get("date") or today_str())
    if not result:
        return out([ev(ctx, "strong_stock_count", 0, "只", date, currency="n/a", note="当日无强势股(非交易日 / 盘前)")], status="partial", degraded="无数据")
    evs = [ev(ctx, "strong_stock_count", len(result), "只", date, currency="n/a")]
    for r in result[:int(ctx["args"].get("limit", 150))]:
        code = str(r.get("code", ""))
        # 🔴 缺的字段就不写进 note。原来是 f-string 直接插 `.get()`,拿不到时渲染成
        #    "涨幅 None% 换手 None%" —— 这条 note 同时喂给 agent 和页面,
        #    一个看着像真值的 None 比留白危险得多。
        parts = [p for p in (code, str(r.get("name") or "")) if p]
        for label, key, suffix in (("涨幅", "zhangfu", "%"), ("换手", "huanshou", "%"), ("成交额", "chengjiaoe", "")):
            val = r.get(key)
            if val is not None and str(val) != "":
                parts.append(f"{label} {val}{suffix}")
        note = " ".join(parts)
        if r.get("reason"):
            evs.append(ev(ctx, "strong_stock_reason", str(r["reason"])[:300], "text", date, currency="n/a", record_key=code, note=note))
        v = to_float(r.get("zhangfu"))
        if v is not None:
            evs.append(ev(ctx, "strong_stock_change_pct", v, "%", date, currency="n/a", record_key=code, note=note))
    return out(evs)


def ths_hsgt_realtime(result: dict, ctx: dict) -> dict:
    times = (result or {}).get("times") or []
    hgt = [x for x in (result or {}).get("hgt") or [] if x is not None]
    sgt = [x for x in (result or {}).get("sgt") or [] if x is not None]
    day = today_str()
    if not times or not (hgt or sgt):
        return out([ev(ctx, "northbound_points", len(times), "个", day, currency="n/a", note="无北向分钟数据(非交易时段或源停更)")], status="partial", degraded="无数据")
    evs = [ev(ctx, "northbound_points", len(times), "个", day, currency="n/a", note=f"{times[0]}..{times[-1]}")]
    if hgt:
        evs.append(ev(ctx, "hgt_net_buy_cum", to_float(hgt[-1]), "亿元", day, note=f"沪股通累计净买入至 {times[len(hgt) - 1] if len(hgt) <= len(times) else times[-1]}"))
    if sgt:
        evs.append(ev(ctx, "sgt_net_buy_cum", to_float(sgt[-1]), "亿元", day, note=f"深股通累计净买入至 {times[len(sgt) - 1] if len(sgt) <= len(times) else times[-1]}"))
    return out(evs)  # 沪 + 深合计属派生量,不在取数层计算


def ths_limit_up_pool(result: list, ctx: dict) -> dict:
    date = str(ctx["args"].get("date") or today_str().replace("-", ""))
    period = f"{date[:4]}-{date[4:6]}-{date[6:8]}" if len(date) == 8 else date
    if not result:
        return out([ev(ctx, "ths_limit_up_count", 0, "只", period, currency="n/a")], status="partial", degraded="涨停揭秘为空(非交易日 / 盘前)")
    evs = [ev(ctx, "ths_limit_up_count", len(result), "只", period, currency="n/a")]
    evs += rows_fields(ctx, result, [("pct", "pool_change_pct", "%"), ("seal_rate", "seal_success_rate", "小数"), ("break_times", "pool_break_times", "次"), ("seal_amount", "seal_order_amount", "元")],
                       period_of=lambda r: period, key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('code')} {r.get('name')} {r.get('high_days','')} {r.get('board_type','')} 首封 {r.get('first_time','')} 原因={str(r.get('reason',''))[:80]}",
                       limit=int(ctx["args"].get("limit", 200)))
    for r in result[:int(ctx["args"].get("limit", 200))]:
        if r.get("reason"):
            evs.append(ev(ctx, "limit_up_reason", str(r["reason"])[:200], "text", period, currency="n/a", record_key=str(r.get("code")), note=f"{r.get('code')} {r.get('name')}"))
    return out(evs)


def ths_hot_list(result: list, ctx: dict) -> dict:
    if not result:
        return empty("同花顺热榜为空")
    day = today_str()
    # 同上:`pct` 是 `rise_and_fall`(涨跌幅);`rank_chg` 才是排名变化,补成独立证据。
    evs = rows_fields(ctx, result, [("rank", "ths_hot_rank", "名"), ("heat", "ths_hot_heat", "人气值"), ("pct", "change_pct", "%"), ("rank_chg", "hot_rank_chg", "名")], period_of=lambda r: day, key_of=lambda r: str(r.get("code")),
                      note_of=lambda r: f"{r.get('code')} {r.get('name')} 排名变化 {r.get('rank_chg')} 概念={','.join(map(str, r.get('concepts') or []))[:80]} {r.get('tag','')}")
    return out(evs, extra={"period": ctx["args"].get("period", "hour"), "top10": [(r.get("rank"), r.get("code"), r.get("name")) for r in result[:10]]})


def em_turnover_rank(result: dict, ctx: dict) -> dict:
    """全市场成交额榜 → 逐行证据(record_key = 代码,避免撞 id)。

    ⚠️ 客观公开榜单,只做客观展示 —— 非推荐、非预测、不评分。
    ⚠️ 上游给的是**全市场**排名(total 数千只),我们只取前 N;
       note 里写清"共 N 只里的前 M",别让人以为市场上就这么多。
    """
    rows = result.get("rows") or []
    total = result.get("total") or 0
    ictx = {**ctx, "symbol": "MARKET", "market": "CN"}
    evs = []
    for r in rows:
        code = str(r.get("code") or "")
        if not code:
            continue
        rk = f"stock|{code}"
        name = r.get("name") or code
        ind = r.get("industry") or ""
        note = f"{name}({code}){'·' + ind if ind else ''};成交额榜第 {r.get('rank')} 名(全市场 {total} 只)"
        for field, val, unit in (("turnover_amount", r.get("amount"), "元"),
                                 ("turnover_rank", r.get("rank"), "名"),
                                 ("last_price", r.get("price"), "元"),
                                 ("change_pct", r.get("pct"), "%")):
            if val is None:
                continue
            evs.append(ev(ictx, field, val, unit, ctx.get("as_of") or today_str(), record_key=rk, note=note))
    missing: list[Any] = [] if evs else ["成交额榜一条都没取到"]
    want = (result or {}).get("expected")
    short = bool(evs) and isinstance(want, int) and len(rows) < want
    if short:
        missing.append({"field": "turnover_rank", "period": ctx.get("as_of") or today_str(), "reason": f"全市场 {total} 只,应取前 {want} 名,分页中途断了,只拿到 {len(rows)} 名"})
    return out(evs, extra={"total": total, "returned": len(rows)}, missing=missing,
               status=("partial" if short else "ok") if evs else "failed")


# ---------- 复盘:涨跌分布 / 主要指数中长线 / 全市场两融 ----------
def em_market_breadth_map(result: dict, ctx: dict) -> dict:
    """涨跌分布每档一条(record_key = 档位)+ 三所家数与成交额(record_key = 交易所)。都是当日快照。"""
    day = (result or {}).get("date") or today_str()   # 取数层已按交易日历补过;还是空就只能标取数当天,notes 里写明了
    buckets = (result or {}).get("buckets") or []
    exchanges = (result or {}).get("exchanges") or []
    evs = [ev(ctx, "market_dist_count", b["count"], "只", day, currency="n/a", as_of=day, record_key=f"dist|{b['key']}", note=b["label"], raw_ref=b.get("_raw"))
           for b in buckets]
    for x in exchanges:
        rk = f"exchange|{x['market']}"
        src = x.get("source") or "eastmoney"
        note = f"{x['label']}全市场(" + ("东财指数行情口径" if src == "eastmoney" else "腾讯指数行情的成交额;东财三所家数这次没取到") + ")"
        for key, field, unit in (("up", "market_up_count", "只"), ("down", "market_down_count", "只"), ("flat", "market_flat_count", "只"), ("amount", "market_turnover_amount", "元")):
            if x.get(key) is not None:
                evs.append(ev(ctx, field, x[key], unit, day, as_of=day, record_key=rk, note=note, raw_ref=x.get("_raw"), source=src))
    missing = [{"field": "market_up_count", "period": day, "reason": n} for n in (result or {}).get("notes") or []]
    if not buckets:
        missing.append({"field": "market_dist_count", "period": day, "reason": "涨跌分布没取到"})
    if len(exchanges) < 3 and not (result or {}).get("notes"):
        got = {x["market"] for x in exchanges}
        missing += [{"field": "market_up_count", "period": day, "reason": f"{m} 的家数与成交额没取到"} for m in ("SH", "SZ", "BJ") if m not in got]
    if not evs:
        return empty("涨跌分布与三所家数都没取到")
    return out(evs, missing=missing, status="partial" if missing else None, extra={"date": day, "bucket_total": sum(b["count"] for b in buckets)})


def _now_sh():
    from datetime import datetime
    from common import TZ_SH
    return datetime.now(TZ_SH)


def _before_cn_close(day: str) -> bool:
    """day 是今天、且北京时间还没到 15:05(A 股 15:00 收盘):最后一根日线还没收完"""
    now = _now_sh()
    return day == today_str() and (now.hour, now.minute) < (15, 5)


def _ret(closes: list, n: int):
    return round((closes[-1] / closes[-1 - n] - 1) * 100, 2) if len(closes) > n and closes[-1 - n] else None


def em_market_trend_map(result: dict, ctx: dict) -> dict:
    """每条指数:最新收盘、当日与 5 / 20 / 60 / 250 日涨跌、年初至今、20 / 60 / 250 日均线、250 日高低点与离高点多远;
    外加沪深两市成交额近 60 个交易日逐日 + 20 / 60 日均值。

    🔴 这些是**按收盘价的固定算法**算出来的,写在每条的 note 里,可复算;不是趋势判断。
    🔴 盘中最后一根日线没收完 —— 当日涨跌、成交额都是截至取数时刻的。
    """
    evs, missing = [], []
    for it in (result or {}).get("indices") or []:
        rows = sorted(it.get("rows") or [], key=lambda r: r["date"])
        if not rows:
            continue
        closes = [r["close"] for r in rows]
        last = rows[-1]
        day = last["date"]
        rk = f"index|{it['code']}"
        src = it.get("source") or "eastmoney"
        base = f"{it['name']}({it['code']});按收盘价({'腾讯' if src == 'tencent' else '东财'}日线);N 日 = N 个交易日;最新一根={day}"

        def add(field, v, unit, extra_note=""):
            if v is not None:
                evs.append(ev(ctx, field, v, unit, day, currency="n/a", as_of=day, record_key=rk, note=base + (f";{extra_note}" if extra_note else ""),
                              raw_ref=last.get("_raw"), source=src))

        add("index_close", last["close"], "点")
        add("index_change_pct", _ret(closes, 1), "%")
        for n in (5, 20, 60, 250):
            add(f"index_return_{n}d", _ret(closes, n), "%", f"=最新收盘 ÷ {n} 个交易日前收盘 − 1")
        prev_year = [r for r in rows if r["date"][:4] < day[:4]]
        if prev_year and prev_year[-1]["close"]:
            add("index_return_ytd", round((closes[-1] / prev_year[-1]["close"] - 1) * 100, 2), "%", f"基准={prev_year[-1]['date']} 收盘(上一年最后一个交易日)")
        for n in (20, 60, 250):
            if len(closes) >= n:
                add(f"index_ma{n}", round(sum(closes[-n:]) / n, 2), "点", f"={n} 日收盘均值")
        if len(rows) >= 250:
            win = rows[-250:]
            hi = max(win, key=lambda r: r["close"])
            lo = min(win, key=lambda r: r["close"])
            add("index_high_250d", hi["close"], "点", f"250 日最高收盘,日期={hi['date']}")
            add("index_low_250d", lo["close"], "点", f"250 日最低收盘,日期={lo['date']}")
            add("index_off_high_250d_pct", round((closes[-1] / hi["close"] - 1) * 100, 2), "%", "=最新收盘 ÷ 250 日最高收盘 − 1")
    amounts = sorted((result or {}).get("amount_rows") or [], key=lambda r: r["date"])
    for r in amounts[-60:]:
        evs.append(ev(ctx, "market_amount_total", r["total"], "元", r["date"], as_of=r["date"], record_key=f"amount|{r['date']}",
                      note=f"沪深两市成交额=上证指数成交额 {r['sh']:.0f} + 深证综指成交额 {r['sz']:.0f}(元)", raw_ref=r.get("_raw"), source=r.get("source") or "eastmoney"))
    if amounts:
        tot = [r["total"] for r in amounts]
        day = amounts[-1]["date"]
        open_bar = _before_cn_close(day)
        for n in (20, 60):
            if len(tot) >= n:
                evs.append(ev(ctx, f"market_amount_ma{n}", round(sum(tot[-n:]) / n), "元", day, as_of=day, record_key="amount|avg",
                              note=f"沪深两市成交额近 {n} 个交易日均值(截至 {day},含这一天" + (";这一天是今天,收盘前还没收完)" if open_bar else ")"),
                              source=amounts[-1].get("source") or "eastmoney"))
            # 最新一根是今天(盘中没收完)时,另给一组不含它的均值:拿半天的量和整天的均值比会误导
            if open_bar and len(tot) >= n + 1:
                prev = amounts[-2]["date"]
                evs.append(ev(ctx, f"market_amount_ma{n}_prior", round(sum(tot[-n - 1:-1]) / n), "元", prev, as_of=prev, record_key="amount|avg",
                              note=f"沪深两市成交额近 {n} 个交易日均值(截至 {prev},不含今天这根还没收完的)",
                              source=amounts[-2].get("source") or "eastmoney"))
    for f in (result or {}).get("failed") or []:
        is_amount = "+" in str(f.get("code") or "")
        missing.append({"field": "market_amount_total" if is_amount else "index_close", "period": "", "reason": f"{f.get('name')}({f.get('code')}) 没取到:{f.get('error')}"})
    if not amounts and not any(m["field"] == "market_amount_total" for m in missing):
        missing.append({"field": "market_amount_total", "period": "", "reason": "两市成交额历史没取到(东财和 baostock 都没回)"})
    if not evs:
        return empty("主要指数日线一条都没取到")
    return out(evs, missing=missing, status="partial" if missing else None)


def em_market_margin_map(result: list, ctx: dict) -> dict:
    """全市场两融:逐日两融余额 / 融资净买入(record_key = 日期)+ 最新一天的融资余额、融券余额、融资余额占流通市值。"""
    rows = sorted([r for r in (result or []) if r.get("date")], key=lambda r: r["date"])
    if not rows:
        return empty("全市场两融汇总为空")
    note = "全市场两融(东财两融历史汇总);T 日数据 T+1 发布"
    evs = rows_fields(ctx, rows, [("rzrqye", "market_margin_balance", "元"), ("rzjme", "market_financing_net_buy", "元")],
                      period_of=lambda r: r["date"], key_of=lambda r: f"margin|{r['date']}", as_of_of=lambda r: r["date"], note_of=lambda r: note)
    last = rows[-1]
    evs += dict_fields(ctx, last, [("rzye", "market_financing_balance", "元"), ("rqye", "market_short_balance", "元"), ("rzmre", "market_financing_buy", "元"),
                                   ("rzye_float_pct", "market_financing_float_pct", "%")], last["date"], as_of=last["date"], note=note, record_key="margin|latest")[0]
    return out(evs)


# ---------- v2.3 补洞:十大股东 / 主营构成 / 停复牌(东财 F10 / 数据中心) ----------
def _untrusted(text, limit: int = 120) -> str:
    from sources.textsafe import sanitize_untrusted
    return sanitize_untrusted(text, limit)


def em_top10_holders_map(result: list, ctx: dict) -> dict:
    """十大股东 / 十大流通股东:每位股东一组证据(record_key = 报告期|名次);名字是源文本,经净化后放 value。"""
    free = bool(ctx["args"].get("free"))
    pre, label, base = ("top10_free_holder", "十大流通股东", "占流通股本") if free else ("top10_holder", "十大股东", "占总股本")
    rows = [r for r in (result or []) if r.get("period") and r.get("rank") is not None]
    if not rows:
        return empty(f"{label}为空(源里没有这只股票的{label}记录)")
    evs = []
    for r in rows:
        rk = f"{r['period']}|{int(r['rank']):02d}"
        name = _untrusted(r.get("name"))
        note = "; ".join(x for x in (f"{label}第 {r['rank']} 名", f"较上期={_untrusted(r.get('change'), 40)}(源原文)" if r.get("change") not in (None, "") else "",
                                     f"股东性质={r.get('holder_type')}" if r.get("holder_type") else "", f"股份类型={r.get('share_type')}" if r.get("share_type") else "",
                                     f"源更新日={r.get('updated')}" if r.get("updated") else "") if x)
        if name:
            evs.append(ev(ctx, f"{pre}_name", name, "text", r["period"], currency="n/a", as_of=r["period"], record_key=rk, note=note))
        for key, field, unit in (("shares", f"{pre}_shares", "股"), ("ratio", f"{pre}_ratio", "%")):
            v = to_float(r.get(key))
            if v is not None:
                evs.append(ev(ctx, field, v, unit, r["period"], currency="n/a", as_of=r["period"], record_key=rk, note=f"{name};{base}" if key == "ratio" else name))
    periods = sorted({r["period"] for r in rows})
    evs.append(ev(ctx, f"{pre}_periods", len(periods), "期", f"{periods[0]}..{periods[-1]}" if len(periods) > 1 else periods[0], currency="n/a", as_of=periods[-1]))
    return out(evs)


def em_main_business_map(result: list, ctx: dict) -> dict:
    """主营构成:每个分项一组证据(record_key = 报告期|口径|分项);收入占比 / 毛利率是源给的小数(0.86 = 86%),不换算。"""
    rows = [r for r in (result or []) if r.get("period") and r.get("item")]
    if not rows:
        return empty("主营构成为空(源里没有这只股票的主营构成)")
    evs = []
    for r in rows:
        item = _untrusted(r.get("item"), 60)
        rk = f"{r['period']}|{r.get('split')}|{item}"
        note = f"{r.get('report_name') or r['period']} {r.get('split')}:{item}"
        for key, field, unit in (("revenue", "main_business_revenue", "元"), ("revenue_ratio", "main_business_sales_share", "小数"), ("cost", "main_business_cost", "元"),
                                 ("profit", "main_business_gross_profit", "元"), ("gross_margin", "main_business_gross_margin", "小数")):
            v = to_float(r.get(key))
            if v is not None:
                evs.append(ev(ctx, field, v, unit, r["period"], currency="CNY" if unit == "元" else "n/a", as_of=r["period"], record_key=rk, note=note))
    splits = sorted({str(r.get("split")) for r in rows})
    return out(evs, extra={"splits": splits, "periods": sorted({r["period"] for r in rows})})


def em_suspensions_map(result: dict, ctx: dict) -> dict:
    """当日停复牌名单(全市场):名单条数 + 每只一条文本证据。名单为空 = 源当日名单里没有股票(仍是 ok,不当失败)。"""
    day = (result or {}).get("date") or today_str()
    rows = (result or {}).get("rows") or []
    mctx = {**ctx, "symbol": "MARKET", "market": "CN"}
    evs = [ev(mctx, "suspension_count", len(rows), "只", day, currency="n/a", as_of=day, note="东财停复牌名单(沪深京)")]
    for r in rows[:int(ctx["args"].get("limit", 200))]:
        code = str(r.get("code") or "")
        if not code:
            continue
        parts = [f"{code} {_untrusted(r.get('name'), 20)}", _untrusted(r.get("reason"), 60) or "原因未披露", str(r.get("expire") or ""),
                 f"停牌起 {r.get('start')}" if r.get("start") else "", f"预计复牌 {r['resume_date']}" if r.get("resume_date") else "预计复牌日未披露"]
        evs.append(ev(mctx, "suspension_item", " · ".join(p for p in parts if p), "text", day, currency="n/a", as_of=day, record_key=code, note=str(r.get("market") or "")))
    return out(evs)
