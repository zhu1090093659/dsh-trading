"""数据日历(第 15 层)映射:日期只报日期,每条 note 带读法护栏;不造日期、不附方向判断。"""
from __future__ import annotations

from sources.mappers import ev, out

CAL_GUARD = "读法:日期是裁决点的时刻,不构成方向判断;预约/预估日可能提前或推迟,以公司公告 / IR 为准"


def next_disclosure_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    today = str(result.get("today") or "")
    rows = result.get("rows") or []
    raw = result.get("raw_ref")
    evs = []
    upcoming = sorted([r for r in rows if not r.get("actual") and r.get("appoint")], key=lambda r: r["appoint"])
    published = sorted([r for r in rows if r.get("actual")], key=lambda r: r["actual"], reverse=True)
    if upcoming:
        r = upcoming[0]
        overdue = bool(today and r["appoint"] < today)
        evs.append(ev(ctx, "next_report_appoint_date", r["appoint"], "日期", r["report_date"], as_of=today, record_key=r["report_date"], raw_ref=raw,
                      note=f"报告期 {r['report_date']} 定期报告的预约披露日(东财 RPT_PUBLIC_BS_APPOIN);首次预约 {r.get('first_appoint') or '同'};"
                           + ("⚠️ 今天已过预约日仍未披露=延期信号,查公司公告;" if overdue else "") + CAL_GUARD))
    else:
        evs.append(ev(ctx, "next_report_appoint_status", "尚未预约", "text", today or "n/a", as_of=today, raw_ref=raw,
                      note="东财预约表当前没有未披露的预约行;下一期预约通常临近法定披露季才出,不是数据缺口;" + CAL_GUARD))
    if published:
        r = published[0]
        evs.append(ev(ctx, "latest_report_published_date", r["actual"], "日期", r["report_date"], as_of=today, record_key=r["report_date"], raw_ref=raw,
                      note=f"最近披露的定期报告:报告期 {r['report_date']},实际披露 {r['actual']}(预约 {r.get('appoint') or '无'});刚披露=业绩验证材料已在手;" + CAL_GUARD))
    status = "ok" if evs else "partial"
    return out(evs, extra={"source": "eastmoney", "rows": len(rows), "note": result.get("note"), "guard": CAL_GUARD},
               status=status, degraded=None if rows else "预约披露表无记录(次新股间隙等真实状态)")


def us_anchor_earnings_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    today = str(result.get("today") or "")
    evs = []
    fiscal_missing = []
    for a in result.get("anchors") or []:
        # 口径三态(Codex datacal-r1):没有预估标记 ≠ 公司已确认——这是 Nasdaq analyst 页面,不是公司 IR
        est = "预估日(交易所 / Zacks 口径,带 * )" if a.get("estimated") else "Nasdaq 页面日期,确认状态未核实(公司确认以 IR 为准)"
        per = a.get("fiscal_period_end") or "n/a"
        if not a.get("fiscal_period_end"):
            fiscal_missing.append(a["ticker"])
        actx = {**ctx, "symbol": a["ticker"], "market": "US"}
        evs.append(ev(actx, "us_anchor_earnings_date", a["date"], "日期", per, currency="n/a", as_of=today, record_key=a["ticker"], raw_ref=a.get("raw_ref"),
                      note=f"{a['ticker']} 下一个财报日:{est};{a.get('timing')};财季止 {a.get('fiscal_period_end') or '未注明'};" + CAL_GUARD))
    errors = result.get("errors") or []
    deg = []
    if errors:
        deg.append("部分失败:" + "; ".join(errors)[:200])
    if fiscal_missing:
        deg.append("财季未解析(period=n/a):" + ",".join(fiscal_missing))
    status = "ok" if evs and not errors else "partial" if evs else "failed"
    return out(evs, extra={"source": "nasdaq", "errors": errors, "guard": CAL_GUARD},
               status=status, degraded=";".join(deg) if deg else None)
