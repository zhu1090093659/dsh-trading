"""数据日历(注册表第 15 层):让裁决点的"下一个数据点"带**具体日期**,而不是"8 月中中报"这类模糊窗口。

两个端点(看板信息源移植第 5 项,2026-08-24):
  - next_disclosure(cn6):东财 RPT_PUBLIC_BS_APPOIN 预约披露表 —— 本公司下一份定期报告的预约披露日、
    最近一次实际披露、以及"过了预约日还没披露"这一延期信号。⚠️ 预约日可能提前或推迟,以公司公告为准。
  - us_anchor_earnings(none,industry_tags=ai_compute):Nasdaq 单票 earnings-date(默认 NVDA)——
    美股锚的下一个财报日。⚠️ 文案带 * 的是交易所 / Zacks **预估日**,不是公司确认日;确认以公司 IR 为准。

纪律:
  - 日期只报日期,不附方向判断;拿不到就 failed 出声,绝不造日期、绝不外推(镜像看板 _tools_intel_earnings.py 的铁律④)。
  - 响应结构变化(success != true / data 缺失 / 文本里解析不出日期)= 契约错误,抛 RuntimeError,不当"没数据"。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from sources._http import em_json, last_raw_ref, official_get

EM_DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get"
NASDAQ_EARNINGS_DATE = "https://api.nasdaq.com/api/analyst/{ticker}/earnings-date"
APPOINT_ROWS = 12


class DatacalError(RuntimeError):
    pass


def _sh_today(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(ZoneInfo("Asia/Shanghai"))).strftime("%Y-%m-%d")


def _d(s: object) -> Optional[str]:
    """'2026-08-24 00:00:00' → '2026-08-24';不是日期就 None(不猜)。"""
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", str(s or ""))
    return m.group(1) if m else None


def next_disclosure(code: str, now: Optional[datetime] = None) -> dict:
    """东财预约披露表(RPT_PUBLIC_BS_APPOIN):按报告期倒序取最近 12 行。"""
    j = em_json(EM_DATACENTER, params={
        "reportName": "RPT_PUBLIC_BS_APPOIN", "columns": "ALL",
        "filter": f'(SECURITY_CODE="{code}")', "sortColumns": "REPORT_DATE", "sortTypes": "-1",
        "pageSize": str(APPOINT_ROWS), "pageNumber": "1",
    })
    raw_ref = last_raw_ref()
    if not isinstance(j, dict) or j.get("success") is not True:
        raise DatacalError(f"东财预约披露接口返回异常:success={j.get('success') if isinstance(j, dict) else type(j).__name__}")
    if "result" not in j:
        raise DatacalError("东财预约披露接口缺 result 字段(结构变了,不当\"无记录\")")
    result = j["result"]
    if result is None:
        # result=null = 该代码无任何预约记录(次新股间隙等):真实状态,不是故障(Codex datacal-r1:只有这个显式形态才算无记录)
        return {"code": code, "today": _sh_today(now), "rows": [], "raw_ref": raw_ref, "note": "预约披露表无记录"}
    if not isinstance(result, dict) or "data" not in result:
        raise DatacalError("东财预约披露接口 result 缺 data 字段(结构变了)")
    data = result["data"]
    if data == []:
        return {"code": code, "today": _sh_today(now), "rows": [], "raw_ref": raw_ref, "note": "预约披露表无记录"}
    if not isinstance(data, list):
        raise DatacalError("东财预约披露接口 result.data 不是数组(结构变了)")
    rows = []
    for r in data:
        if str(r.get("SECURITY_CODE") or "") != code:
            continue  # filter 语义变化时宁可少收,不把别家的日期算到本公司头上
        rd = _d(r.get("REPORT_DATE"))
        if not rd:
            continue
        rows.append({
            "report_date": rd,
            "appoint": _d(r.get("APPOINT_PUBLISH_DATE")),
            "first_appoint": _d(r.get("FIRST_APPOINT_DATE")),
            "actual": _d(r.get("ACTUAL_PUBLISH_DATE")),
        })
    if data and not rows:
        raise DatacalError("东财预约披露接口有数据但没有一行能解析(SECURITY_CODE / REPORT_DATE 字段结构变了)")
    return {"code": code, "today": _sh_today(now), "rows": rows, "raw_ref": raw_ref}


# 日期必须锚定在"report/announce/post … earnings/results … on <日期>"句式上,不能抓文案里第一个日期
# (Codex datacal-r1:"fiscal quarter ended 07/31/2026; will announce earnings on 08/26/2026" 会抓错)
_EARN_DATE_RE = re.compile(r"(?:report|announce|post|release)[^.]{0,60}?\bon\s+(\d{1,2})/(\d{1,2})/(\d{4})", re.IGNORECASE)
_FISCAL_RE = re.compile(r"(?:Quarter|Year)\s+ending\s+([A-Za-z]{3,9})\.?\s+(\d{4})", re.IGNORECASE)
_MONTHS = {m.lower(): i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}
_MONTHS.update({m.lower(): i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], start=1)})


def _valid_date(y: int, mo: int, d: int) -> Optional[str]:
    try:
        return datetime(y, mo, d).strftime("%Y-%m-%d")
    except ValueError:
        return None


def _parse_earnings_text(text: str) -> dict:
    dates = []
    for mm, dd, yyyy in _EARN_DATE_RE.findall(text):
        v = _valid_date(int(yyyy), int(mm), int(dd))
        if v is None:
            raise DatacalError(f"Nasdaq earnings-date 文案里的日期不是真实日历日:{mm}/{dd}/{yyyy}")
        dates.append(v)
    uniq = sorted(set(dates))
    if not uniq:
        raise DatacalError(f"Nasdaq earnings-date 文案里解析不出财报日(结构变了):{text[:120]}")
    if len(uniq) > 1:
        raise DatacalError(f"Nasdaq earnings-date 文案里出现多个互斥的财报日,拒绝猜:{uniq}")
    low = text.lower()
    estimated = "expected" in low or "*" in text
    timing = "盘后(美股当地交易日;≈北京时间次日凌晨)" if "after market close" in low else "盘前(美股当地交易日)" if "before market open" in low else "时段未注明"
    fm = _FISCAL_RE.search(text)
    fiscal = f"{fm.group(2)}-{_MONTHS[fm.group(1).lower()]:02d}" if fm and fm.group(1).lower() in _MONTHS else None
    return {"date": uniq[0], "estimated": estimated, "timing": timing, "fiscal_period_end": fiscal}


def us_anchor_earnings(tickers: str = "NVDA", now: Optional[datetime] = None) -> dict:
    """Nasdaq 单票财报日(逐 ticker 隔离失败;全失败才抛)。"""
    out, errors = [], []
    for t in [x.strip().upper() for x in tickers.split(",") if x.strip()]:
        try:
            j = official_get(NASDAQ_EARNINGS_DATE.format(ticker=t), headers={"Accept": "application/json"}, as_json=True)
            raw_ref = last_raw_ref()
            text = str(((j or {}).get("data") or {}).get("reportText") or "")
            if not text:
                raise DatacalError("Nasdaq earnings-date 响应无 reportText(结构变了或代码不存在)")
            parsed = _parse_earnings_text(text)
            out.append({"ticker": t, **parsed, "raw_ref": raw_ref, "text": text[:300]})
        except Exception as e:  # noqa: BLE001 — 逐 ticker 隔离,汇总出声
            errors.append(f"{t}: {type(e).__name__}: {str(e)[:160]}")
    if not out and errors:
        raise DatacalError("美股锚财报日全部失败:" + "; ".join(errors))
    return {"today": _sh_today(now), "anchors": out, "errors": errors}
