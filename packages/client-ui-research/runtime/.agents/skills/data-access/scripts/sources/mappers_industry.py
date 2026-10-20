"""产业温度计(第 13 层)mapper:产业链级证据。symbol / market 按温度计对象填(台股代码 + TW;GPU 型号 + US),不是研究标的本身。
每条数字证据的 note 都带读法护栏——报告引用时必须连护栏一起写(risk ⑤ 规则 + 硬测试第 8 组)。"""
from __future__ import annotations

import calendar
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import today_str  # noqa: E402
from sources.mappers import ev, out  # noqa: E402

TW_GUARD = "读法:环比连增=实体爬坡;台光环比转负=第一警讯;台光同时供英伟达链与 AWS Trainium,必须与金像电差分后才能归因"
GPU_GUARD = "读法:$3/卡时是 B200 设备折旧参考线不是完整经济保本线(不含电力 / 机房 / 运维);撮合市场取中位数;前沿紧与商品松可同时为真,只看一根线别下全市场结论"
FWD_GUARD = "远期概率来自公开预期市场,只作全球宏观预期概率,不是预测;P(月均 < 最低档) = 1 − P(高于最低档)"


def _month_range(period: str) -> str:
    y, m = int(period[:4]), int(period[5:7])
    return f"{period}-01..{period}-{calendar.monthrange(y, m)[1]:02d}"


def tw_monthly_revenue_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    day = result.get("checked_at") or today_str()
    evs = []
    stale, errs, missing_metrics = [], list(result.get("errors") or []), []
    for c in result.get("companies") or []:
        cctx = {**ctx, "symbol": c["ticker"], "market": "TW"}
        per = _month_range(c["latest_period"])
        base = f"name={c['name']};period={c['latest_period']};lag_months={c['lag_months']};stale={c['stale']};mom_seq_pct={c.get('mom_seq_pct')};{TW_GUARD}"
        evs.append(ev(cctx, "tw_monthly_revenue", c["revenue_e8twd"], "亿新台币", per, currency="TWD", as_of=day, record_key=c["ticker"], raw_ref=c.get("raw_ref"), note=base))
        if c.get("mom_pct") is not None:
            evs.append(ev(cctx, "tw_monthly_revenue_mom_pct", c["mom_pct"], "%", per, currency="n/a", as_of=day, record_key=c["ticker"], raw_ref=c.get("raw_ref"), note=f"name={c['name']};环比上月;{TW_GUARD}"))
        if c.get("yoy_pct") is not None:
            evs.append(ev(cctx, "tw_monthly_revenue_yoy_pct", c["yoy_pct"], "%", per, currency="n/a", as_of=day, record_key=c["ticker"], raw_ref=c.get("raw_ref"), note=f"name={c['name']};同比去年同月;{TW_GUARD}"))
        if c.get("cum_yoy_pct") is not None:
            evs.append(ev(cctx, "tw_monthly_revenue_cum_yoy_pct", c["cum_yoy_pct"], "%", per, currency="n/a", as_of=day, record_key=c["ticker"], raw_ref=c.get("raw_ref"), note=f"name={c['name']};年初至今累计同比;{TW_GUARD}"))
        if c.get("stale"):
            stale.append(c["ticker"])
        for miss in c.get("missing") or []:
            missing_metrics.append(f"{c['ticker']}:{miss}")
    d = result.get("differential")
    if d and not d.get("reading"):
        missing_metrics.append(f"台光/金像电差分:最新月份不同({d.get('period_2383')} / {d.get('period_2368')}),不比")
    elif d:
        # 差分证据绑定台光(2383)那次响应,note 里带金像电(2368)的 raw_ref(两份输入都可追溯;不继承 capture 的最后一个响应)
        dctx = {**ctx, "symbol": "2383", "market": "TW"}
        evs.append(ev(dctx, "tw_chain_differential", d["reading"], "text", _month_range(d.get("period_2383") or day[:7]), currency="n/a", as_of=day, record_key="2383x2368", raw_ref=d.get("raw_ref_2383"),
                      note=f"ccl_2383_mom_pct={d['ccl_2383_mom_pct']};pcb_2368_mom_pct={d['pcb_2368_mom_pct']};period_2368={d.get('period_2368')};raw_ref_2368={d.get('raw_ref_2368')};{TW_GUARD}"))
    n_ok = len(result.get("companies") or [])
    n_all = n_ok + len(errs)
    status, degraded = "ok", None
    if errs:
        status, degraded = "partial", f"{len(errs)}/{n_all} 家取数失败:" + "; ".join(e["error"] for e in errs)[:200]
    elif stale:
        status, degraded = "partial", f"资料期已过期(> 2 个月):{','.join(stale)}"
    elif missing_metrics:
        status, degraded = "partial", "缺基数:" + "; ".join(missing_metrics)[:200]
    return out(evs, extra={"source": result.get("source"), "checked_tz": result.get("checked_tz"), "companies": n_ok, "errors": errs, "stale": stale, "missing_metrics": missing_metrics, "differential": d, "guard": TW_GUARD},
               missing=missing_metrics, status=status, degraded=degraded)


def _ts_day(ts) -> str:
    """秒级时间戳 → YYYY-MM-DD。给不出来就返回空串，由调用方回退到取数日。"""
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


def gpu_rent_thermometer_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    day = result.get("checked_at") or today_str()
    line = result.get("depreciation_line_usd")
    evs, errs, unavailable = [], [], []
    for s in result.get("spot") or []:
        sctx = {**ctx, "symbol": s["gpu"], "market": "US"}
        if "median_usd_per_gpu_hr" in s:
            # 现货 = 曲线最后一个点 ⇒ note 里带上那一点的时间戳与挂单卡数（规模读数，可能为 None）
            # 🔴 **资料期用那一点自己的日期,不是取数日**。上游最后一个有效采样可能停在几天前,
            #    标成今天就是让陈旧数据看着像当天的 —— 而这个温度计的用处正是判"还热不热"。
            sday = _ts_day(s.get("asof_ts")) or day
            evs.append(ev(sctx, "gpu_spot_median_usd_per_gpu_hr", s["median_usd_per_gpu_hr"], "美元/卡时", sday, currency="USD", as_of=sday, record_key=s["gpu"], raw_ref=s.get("raw_ref"),
                          note=f"gpu={s['gpu']};asof_ts={s.get('asof_ts')};available_gpus={s.get('available_gpus')};total_gpus={s.get('total_gpus')};"
                               f"depreciation_line_usd={line};below_line={s['below_depreciation_line']};{GPU_GUARD}"))
            if s.get("available_gpus") is not None:
                evs.append(ev(sctx, "gpu_available_count", s["available_gpus"], "张", sday, currency="n/a", as_of=sday, record_key=s["gpu"], raw_ref=s.get("raw_ref"),
                              note=f"gpu={s['gpu']};当前可租挂单卡数(规模读数,不是信号本体);total={s.get('total_gpus')};{GPU_GUARD}"))
        elif s.get("unavailable"):
            unavailable.append(s["gpu"])
            # 🔴 **不发 `gpu_available_count = 0`**：上游只说了"没有统计序列",
            #    没说"当前可租 0 张"。0 是一个断言,而我们并不知道它成不成立。
            #    改用 status 型证据（与管制与准入层同一套写法）—— 界面照样看得到这张卡,
            #    但看到的是「未覆盖」而不是一个假的零。
            evs.append(ev(sctx, "gpu_spot_status", "unavailable", "status", day, currency="n/a", as_of=day, record_key=s["gpu"], raw_ref=s.get("raw_ref"),
                          note=f"gpu={s['gpu']};{s.get('note') or '暂无统计序列(市场状态不是故障)'};未覆盖≠可租 0 张;{GPU_GUARD}"))
        else:
            errs.append(f"{s['gpu']}: {s.get('error')}")
    f = result.get("forward") or {}
    fctx = {**ctx, "symbol": "B200", "market": "US"}
    if "p_below_lowest" in f:
        cm = f.get("contract_month") or day[:7]
        fper = _month_range(cm)  # 远期证据的 period = 被预测的合约月,不是取数日
        rk = f"KXB200MS:{cm}"
        evs.append(ev(fctx, "gpu_forward_p_below_lowest_strike", f["p_below_lowest"], "小数", fper, currency="n/a", as_of=day, record_key=rk, raw_ref=f.get("raw_ref"),
                      note=f"contract_month={cm};lowest_strike_usd={f['lowest_strike']};n_rungs={f['n_rungs']};other_months={f.get('other_months')};ladder={f.get('ladder')};{FWD_GUARD};{GPU_GUARD}"))
        evs.append(ev(fctx, "gpu_forward_lowest_strike_usd", f["lowest_strike"], "美元/卡时", fper, currency="USD", as_of=day, record_key=rk, raw_ref=f.get("raw_ref"), note=f"contract_month={cm};Kalshi KXB200MS 阶梯最低档;{FWD_GUARD};{GPU_GUARD}"))
    elif f.get("unavailable"):
        # 同上：能确定的是"没取到有效阶梯",不是"真实档数为 0"
        evs.append(ev(fctx, "gpu_forward_status", "unavailable", "status", day, currency="n/a", as_of=day, record_key="KXB200MS", raw_ref=f.get("raw_ref"),
                      note=f"阶梯市场无有效报价(未开盘或无成交,市场状态不是故障);未覆盖≠档数为 0;{FWD_GUARD}"))
    elif f.get("error"):
        errs.append(f"forward: {f['error']}")
    status, degraded = "ok", None
    if errs:
        status, degraded = "partial", "部分失败:" + "; ".join(errs)[:200]
    # 近一年逐日曲线走 extra:它是**序列**不是证据(一条线上三百多个点,逐点发证据既无意义也淹没报告)。
    # 🔴 曲线取不到不降级整个端点 —— 它是配图,现货与远期才是这个温度计的本体;
    #    但**每张卡的失败原因要带出去**,不能让界面上少一条线而没人知道为什么。
    hist = [h for h in (result.get("history") or []) if isinstance(h, dict)]
    hist_errs = [f"{h.get('gpu')}: {h.get('error')}" for h in hist if h.get("error")]
    return out(evs, extra={"source": result.get("source"), "checked_tz": result.get("checked_tz"), "depreciation_line_usd": line, "unavailable": unavailable, "errors": errs, "guard": GPU_GUARD, "forward_guard": FWD_GUARD,
                           "history": {"gpus": hist, "days": result.get("history_days"), "source": result.get("history_source"), "errors": hist_errs},
                           "spot_rows": result.get("spot"), "spot_source": result.get("spot_source")},
               status=status, degraded=degraded)
