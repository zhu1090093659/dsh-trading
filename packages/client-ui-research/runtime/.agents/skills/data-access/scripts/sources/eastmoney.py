"""东财(eastmoney)源:研报 / 板块归属 / 资金流 / 龙虎榜 / 解禁 / 行业排名 / 板块资金 / 两融 / 大宗 / 股东户数 / 分红 / 个股基本面 / 新闻 / 打板 / 人气。
移植自 simonlin1212/a-stock-data SKILL.md(V3.7.x)对应代码块;全部请求走 _http.em(跨进程串行锁 + 代理回退 + raw 落盘),403 不重试。
函数只返回结构化结果;信封 / 证据由 mappers 统一完成。单位按源字段口径原样返回(不换算),字段含义见各函数注释。
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import EM_PUSH2_HOSTS, EM_PUSH2HIS_HOSTS, TZ_SH, UA, em_secid, norm_ticker  # noqa: E402
from sources._http import em, em_json, last_raw_ref  # noqa: E402


def _multi_json(hosts: tuple, path: str, **kw):
    """按 hosts 顺序请求同一 path(push2 在部分网络被重置,push2delay 可达;与 legacy 脚本的 em_multi_host 同策略),全失败抛最后一个异常。"""
    import requests
    last: Optional[Exception] = None
    for h in hosts:
        try:
            r = em(f"https://{h}{path}", **kw)
            if r.status_code == 200:
                return r.json()
            last = RuntimeError(f"{h} HTTP {r.status_code}")
        except (requests.exceptions.RequestException, ValueError) as e:
            last = e
    raise last if last else RuntimeError("无可用东财主机")


def _push2_json(path: str, **kw):
    return _multi_json(EM_PUSH2_HOSTS, path, **kw)


def _push2his_json(path: str, **kw):
    return _multi_json(EM_PUSH2HIS_HOSTS, path, **kw)

DATACENTER_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
REPORT_API = "https://reportapi.eastmoney.com/report/list"
PDF_TPL = "https://pdf.dfcfw.com/pdf/H3_{info_code}_1.pdf"
_REF = {"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"}


def _secid(code: str) -> str:
    d, m = norm_ticker(code, stock_only=False)
    return em_secid(d, m)


def _today() -> str:
    return datetime.now(TZ_SH).strftime("%Y-%m-%d")


# ---------- 数据中心统一查询 ----------
def eastmoney_datacenter(report_name: str, columns: str = "ALL", filter_str: str = "", page_size: int = 50,
                         sort_columns: str = "", sort_types: str = "-1", page: int = 1) -> list[dict]:
    params = {"reportName": report_name, "columns": columns, "filter": filter_str, "pageNumber": str(page), "pageSize": str(page_size),
              "sortColumns": sort_columns, "sortTypes": sort_types, "source": "WEB", "client": "WEB"}
    d = em_json(DATACENTER_URL, params=params, timeout=15)
    # 🔴 HTTP 200 不等于取到了:东财用 code 区分。实测(2026-10-09)查无记录 = code 9201「返回数据为空」,
    #    报表名 / 参数错、被拒 = 9501 等其它码。以前一律返回 [],映射器再写成「0 笔大宗交易 / 0 次分红」,
    #    来源失败被当成「确实没有」(审计 B5)。⇒ 只有 9201 和 data 为空列表算没有数据,其余抛 RuntimeError。
    #    🔴 先看业务状态、再看结构:`{"success":false,"code":9501,"result":{}}` 这种 result 是字典的失败
    #       以前跳过了状态检查;成功码却缺 data 的畸形响应也不能当「没有」(审计第二轮 B5)。
    #       实测(2026-10-10)正常返回 = success:true、code:0、result.data 是列表。
    if not isinstance(d, dict):
        raise RuntimeError(f"东财数据中心 {report_name} 返回的不是 JSON 对象")
    if d.get("code") == 9201:
        return []
    if d.get("success") is False or d.get("code") not in (None, 0):
        raise RuntimeError(f"东财数据中心 {report_name} 返回失败:code={d.get('code')} {str(d.get('message') or '')[:80]}")
    res = d.get("result")
    data = res.get("data") if isinstance(res, dict) else None
    if isinstance(data, list) and all(isinstance(r, dict) for r in data):
        return data
    raise RuntimeError(f"东财数据中心 {report_name} 返回结构不对:result.data 不是记录列表")


# ---------- 2.1 研报 ----------
def eastmoney_reports(code: str, max_pages: int = 3) -> list[dict]:
    """个股研报列表(标题 / 机构 / 评级 / 三年 EPS 预测 / infoCode);reportapi 只认纯 6 位。"""
    digits, _ = norm_ticker(code, stock_only=True)
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        params = {"industryCode": "*", "pageSize": "100", "industry": "*", "rating": "*", "ratingChange": "*",
                  "beginTime": "2000-01-01", "endTime": "2030-01-01", "pageNo": str(page), "fields": "", "qType": "0",
                  "orgCode": "", "code": digits, "rcode": "", "p": str(page), "pageNum": str(page), "pageNumber": str(page)}
        d = em_json(REPORT_API, params=params, headers={"Referer": "https://data.eastmoney.com/"}, timeout=30)
        rows = d.get("data") or []
        if not rows:
            break
        ref = last_raw_ref()
        out.extend({**r, "_raw": ref} for r in rows)
        if page >= (d.get("TotalPage", 1) or 1):
            break
        if page == max_pages:
            # 页数上限到了、源还有下一页:在最后一条上做个记号,映射器据此不把取到的样本当全年篇数(第四轮审计 B5)
            out[-1]["_more_pages"] = True
    if not out and digits[:2] in ("43", "83", "87"):
        raise ValueError(f"{digits} 属北交所老号段,东财研报库已不再按老码索引;请按名称反查现行 920 代码")
    return out


def eastmoney_industry_reports(industry_code: str = "*", max_pages: int = 2, begin: str = "") -> list[dict]:
    """行业研报列表(qType=1);industry_code="*" 全行业;begin 留空 = 近两年。"""
    if not begin:
        begin = (datetime.now(TZ_SH) - timedelta(days=730)).strftime("%Y-%m-%d")
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        params = {"industryCode": industry_code, "pageSize": "100", "industry": "*", "rating": "*", "ratingChange": "*",
                  "beginTime": begin, "endTime": "2030-01-01", "pageNo": str(page), "fields": "", "qType": "1"}
        d = em_json(REPORT_API, params=params, headers={"Referer": "https://data.eastmoney.com/"}, timeout=30)
        rows = d.get("data") or []
        if not rows:
            break
        ref = last_raw_ref()
        out.extend({**r, "_raw": ref} for r in rows)
        if page >= (d.get("TotalPage", 1) or 1):
            break
    return out


def report_pdf_url(info_code: str) -> str:
    return PDF_TPL.format(info_code=info_code)


# ---------- 3.3 板块归属 / 3.4 分钟资金流 / 4.5 120 日资金流 ----------
def eastmoney_concept_blocks(code: str) -> dict:
    """个股所属板块 / 概念(slist 一次拿全):{total, boards:[{name, code, change_pct, lead_stock}], concept_tags}"""
    params = {"fltt": "2", "invt": "2", "secid": _secid(code), "spt": "3", "pi": "0", "pz": "200", "po": "1", "fields": "f12,f14,f3,f128"}
    d = _push2_json("/api/qt/slist/get", params=params, headers=_REF, timeout=15)
    diff = (d.get("data") or {}).get("diff") or {}
    items = diff.values() if isinstance(diff, dict) else diff
    boards = [{"name": it.get("f14", ""), "code": it.get("f12", ""), "change_pct": it.get("f3", ""), "lead_stock": it.get("f128", "")} for it in items]
    return {"total": len(boards), "boards": boards, "concept_tags": [b["name"] for b in boards]}


def eastmoney_fund_flow_minute(code: str) -> list[dict]:
    """个股资金流(分钟级,当日盘中);单位 元。ETF 不覆盖。"""
    params = {"secid": _secid(code), "klt": 1, "fields1": "f1,f2,f3,f7", "fields2": "f51,f52,f53,f54,f55,f56,f57"}
    d = _push2_json("/api/qt/stock/fflow/kline/get", params=params, headers={**_REF, "Origin": "https://quote.eastmoney.com"}, timeout=10)
    rows = []
    for line in (d.get("data") or {}).get("klines") or []:
        p = line.split(",")
        if len(p) >= 6:
            rows.append({"time": p[0], "main_net": float(p[1]), "small_net": float(p[2]), "mid_net": float(p[3]), "large_net": float(p[4]), "super_net": float(p[5])})
    return rows


def stock_fund_flow_120d(code: str) -> list[dict]:
    """个股资金流(日级,最近 120 个交易日);单位 元。push2his 在部分网络不通(本机如此),由取数器记失败。"""
    params = {"secid": _secid(code), "fields1": "f1,f2,f3,f7", "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65", "lmt": "120"}
    d = _push2his_json("/api/qt/stock/fflow/daykline/get", params=params, headers={**_REF, "Origin": "https://quote.eastmoney.com"}, timeout=15)
    rows = []
    for line in (d.get("data") or {}).get("klines") or []:
        p = line.split(",")
        if len(p) >= 7:
            # 源用 "-" / 空串表示这一天没数:留 None,不写成 0(审计第三轮 B3)
            f = _num_or_none
            rows.append({"date": p[0], "main_net": f(p[1]), "small_net": f(p[2]), "mid_net": f(p[3]), "large_net": f(p[4]), "super_net": f(p[5])})
    return rows


# ---------- 3.5 龙虎榜 / 3.6 解禁 ----------
def dragon_tiger_board(code: str, trade_date: Optional[str] = None, look_back: int = 30) -> dict:
    """个股龙虎榜:{records:[{date, reason, net_buy(万元), turnover(%)}], seats:{buy:[..], sell:[..]}(万元), institution:{buy_amt, sell_amt, net_amt}(万元)}

    源没给的金额 / 换手率留 None,不写 0(审计第三轮 B3);机构席位里有一笔金额缺失,机构合计整体留 None。
    """
    digits, _ = norm_ticker(code, stock_only=True)
    trade_date = trade_date or _today()
    start = (datetime.strptime(trade_date, "%Y-%m-%d") - timedelta(days=look_back)).strftime("%Y-%m-%d")
    data = eastmoney_datacenter("RPT_DAILYBILLBOARD_DETAILSNEW", filter_str=f"(TRADE_DATE>='{start}')(TRADE_DATE<='{trade_date}')(SECURITY_CODE=\"{digits}\")",
                                page_size=50, sort_columns="TRADE_DATE", sort_types="-1")
    raw_records = last_raw_ref()
    records = [{"date": str(r.get("TRADE_DATE", ""))[:10], "reason": r.get("EXPLANATION", ""), "net_buy": _wan(r.get("BILLBOARD_NET_AMT")),
                "turnover": _round_or_none(r.get("TURNOVERRATE"), 2), "_raw": raw_records} for r in data]
    buy_data: list = []
    sell_data: list = []
    seats: dict = {"buy": [], "sell": []}
    if records:
        latest = records[0]["date"]
        buy_data = eastmoney_datacenter("RPT_BILLBOARD_DAILYDETAILSBUY", filter_str=f"(TRADE_DATE='{latest}')(SECURITY_CODE=\"{digits}\")", page_size=10, sort_columns="BUY", sort_types="-1")
        sell_data = eastmoney_datacenter("RPT_BILLBOARD_DAILYDETAILSSELL", filter_str=f"(TRADE_DATE='{latest}')(SECURITY_CODE=\"{digits}\")", page_size=10, sort_columns="SELL", sort_types="-1")
        for rows_, side in ((buy_data, "buy"), (sell_data, "sell")):
            for r in rows_[:5]:
                seats[side].append({"name": r.get("OPERATEDEPT_NAME", ""), "buy_amt": _wan(r.get("BUY")), "sell_amt": _wan(r.get("SELL")), "net": _wan(r.get("NET"))})
    sums = {"buy": 0.0, "sell": 0.0}
    inst_missing = False
    for rows_, side in ((buy_data, "buy"), (sell_data, "sell")):
        for r in rows_:
            if str(r.get("OPERATEDEPT_CODE", "")) == "0":
                v = _num_or_none(r.get("BUY") if side == "buy" else r.get("SELL"))
                if v is None:
                    inst_missing = True
                else:
                    sums[side] += v
    if inst_missing:
        inst: dict = {"buy_amt": None, "sell_amt": None, "net_amt": None}
    else:
        inst = {"buy_amt": round(sums["buy"] / 10000, 1), "sell_amt": round(sums["sell"] / 10000, 1)}
        inst["net_amt"] = round(inst["buy_amt"] - inst["sell_amt"], 1)
    return {"records": records, "seats": seats, "institution": inst, "window": [start, trade_date]}


def lockup_expiry(code: str, trade_date: Optional[str] = None, forward_days: int = 90) -> dict:
    """限售解禁:{history:[{date, type, able_shares(万股), ratio(小数)}], upcoming:[...]}

    able_shares 是实际可上市流通的股数,ratio 是它**占总股本**的比例(TOTAL_RATIO)。源没给就留 None,不写 0。
    🔴 以前 ratio 取的是 FREE_RATIO(占流通股比例),却按「占总股本」输出,中芯国际一批 6.39% 写成了 27.35%(审计第三轮 B2)。
       FREE_SHARES / FREE_RATIO 两列历史批次和未来批次的分母对不上(见 em_events.lockup_history),都不取。
    """
    digits, _ = norm_ticker(code, stock_only=True)
    trade_date = trade_date or _today()
    conv = lambda r: {"date": str(r.get("FREE_DATE", ""))[:10], "type": r.get("FREE_SHARES_TYPE", ""),  # noqa: E731
                      "able_shares": _num_or_none(r.get("ABLE_FREE_SHARES")), "ratio": _num_or_none(r.get("TOTAL_RATIO"))}
    history = [conv(r) for r in eastmoney_datacenter("RPT_LIFT_STAGE", filter_str=f"(SECURITY_CODE=\"{digits}\")", page_size=15, sort_columns="FREE_DATE", sort_types="-1")]
    ref_h = last_raw_ref()
    history = [{**r, "_raw": ref_h} for r in history]
    end = (datetime.strptime(trade_date, "%Y-%m-%d") + timedelta(days=forward_days)).strftime("%Y-%m-%d")
    upcoming = [conv(r) for r in eastmoney_datacenter("RPT_LIFT_STAGE", filter_str=f"(SECURITY_CODE=\"{digits}\")(FREE_DATE>='{trade_date}')(FREE_DATE<='{end}')",
                                                        page_size=20, sort_columns="FREE_DATE", sort_types="1")]
    ref_u = last_raw_ref()
    upcoming = [{**r, "_raw": ref_u} for r in upcoming]
    return {"history": history, "upcoming": upcoming, "window": [trade_date, end]}


# ---------- 3.7 行业排名 / 3.8 板块资金流 / 3.9 全市场龙虎榜 ----------
def industry_comparison(top_n: int = 20) -> dict:
    params = {"pn": "1", "pz": "100", "po": "1", "np": "1", "fltt": "2", "invt": "2", "fid": "f3", "fs": "m:90+t:2",
              "fields": "f2,f3,f4,f12,f13,f14,f104,f105,f128,f136,f140,f141,f207"}
    d = _push2_json("/api/qt/clist/get", params=params, headers={"User-Agent": UA}, timeout=15)
    items = (d.get("data") or {}).get("diff") or []
    rows = [{"rank": i + 1, "name": it.get("f14", ""), "change_pct": it.get("f3", 0), "code": it.get("f12", ""), "up_count": it.get("f104", 0),
             "down_count": it.get("f105", 0), "leader": it.get("f140", ""), "leader_change": it.get("f136", 0)} for i, it in enumerate(items)]
    return {"top": rows[:top_n], "bottom": rows[-top_n:] if rows else [], "total": len(rows), "rows": rows}


_BOARD_FS = {"industry": "m:90+t:2", "concept": "m:90+t:3", "region": "m:90+t:1"}
_BOARD_PERIOD = {"today": ("f62", "f62", "f184", "f3", "f204"), "5d": ("f164", "f164", "f165", "f109", "f257"), "10d": ("f174", "f174", "f175", "f160", None)}


def board_fund_flow(board_type: str = "industry", period: str = "today", top_n: int = 20) -> dict:
    """板块资金流向排名(主力净额降序);main_net 元,main_pct %;today 另有四档净额。"""
    if board_type not in _BOARD_FS:
        raise ValueError(f"board_type 须为 {list(_BOARD_FS)}")
    if period not in _BOARD_PERIOD:
        raise ValueError(f"period 须为 {list(_BOARD_PERIOD)}")
    fid, f_main, f_pct, f_chg, f_leader = _BOARD_PERIOD[period]
    fields = ["f12", "f14", f_chg, f_main, f_pct] + ([f_leader] if f_leader else []) + (["f66", "f72", "f78", "f84"] if period == "today" else [])
    base = {"pz": "200", "po": "1", "np": "1", "fltt": "2", "invt": "2", "fid": fid, "fs": _BOARD_FS[board_type], "fields": ",".join(dict.fromkeys(fields))}

    def page(pn: int):
        d = _push2_json("/api/qt/clist/get", params={**base, "pn": str(pn)}, headers={"User-Agent": UA}, timeout=15).get("data") or {}
        return (d.get("diff") or []), int(d.get("total") or 0)

    items, total = page(1)
    # 🔴 **别假设上游认你请求的页大小**。这里 pz=200,而东财实际每页只给 100 条 ——
    #    原来的 `if len(more) < 200: break` 于是在第 2 页就停了:上游 total=496,我们只拿 200,
    #    而且**界面上完全看不出来**(看着像"就这么多板块")。
    #    实测:pn=1/2/3 各回 100 条、total 都报 496。
    #    ⇒ 页大小以**第一页实际回了多少**为准;只有"这一页一条都没有"或已达 total/top_n 才停。
    page_size = len(items) or 1
    pn = 2
    while len(items) < top_n and not (total and len(items) >= total):
        more, _ = page(pn)
        if not more:
            break
        items += more
        pn += 1
        if len(more) < page_size:   # 不满一页 = 最后一页
            break
    # 🔴 中途空页 / 短页不能证明取完:上游说有 total 条、请求了 top_n 条,实际少于 min(两者) 就是半份(映射层标 partial)
    expected = min(top_n, total) if total else None
    total = max(total, len(items))
    rows = []
    for i, it in enumerate(items):
        row = {"rank": i + 1, "name": it.get("f14", ""), "code": it.get("f12", ""), "change_pct": it.get(f_chg, 0), "main_net": it.get(f_main, 0), "main_pct": it.get(f_pct, 0),
               "leader": it.get(f_leader, "") if f_leader else ""}
        if period == "today":
            row.update({"super_large_net": it.get("f66", 0), "large_net": it.get("f72", 0), "medium_net": it.get("f78", 0), "small_net": it.get("f84", 0)})
        rows.append(row)
    return {"board_type": board_type, "period": period, "total": total, "expected": expected, "rows": rows[:top_n]}


DRAGON_PAGE_SIZE = 500
DRAGON_MAX_PAGES = 6


def _wan(v, digits: int = 1) -> Optional[float]:
    """元 → 万元；源没给就是 None（不当 0）"""
    x = _num_or_none(v)
    return None if x is None else round(x / 10000, digits)


def _round_or_none(v, digits: int) -> Optional[float]:
    x = _num_or_none(v)
    return None if x is None else round(x, digits)


def _num_or_none(v) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x else None


def daily_dragon_tiger(trade_date: Optional[str] = None, min_net_buy: Optional[float] = None) -> dict:
    """全市场龙虎榜日榜，一条上榜理由一行，按净买额从大到小。

    翻页取全（之前只取一页 500 条，且下游只留净买额最大的 100 条 —— 净卖出居前的那批正好排在最后、全被丢掉）。
    取满 DRAGON_MAX_PAGES 页还没完时 truncated=True。金额单位 万元；源没给的数留 None，不写 0。
    """
    trade_date = trade_date or _today()
    data: list = []
    truncated = False
    for page in range(1, DRAGON_MAX_PAGES + 1):
        rows = eastmoney_datacenter("RPT_DAILYBILLBOARD_DETAILSNEW", filter_str=f"(TRADE_DATE>='{trade_date}')(TRADE_DATE<='{trade_date}')",
                                    page_size=DRAGON_PAGE_SIZE, sort_columns="BILLBOARD_NET_AMT,TRADE_ID", sort_types="-1,1", page=page)
        data += rows
        if len(rows) < DRAGON_PAGE_SIZE:
            break
    else:
        truncated = True
    if not data:
        return {"date": trade_date, "total_records": 0, "stocks": [], "note": "无数据(非交易日或盘后未更新)"}
    actual = str(data[0].get("TRADE_DATE", ""))[:10]
    stocks = []
    for r in data:
        net_buy = _wan(r.get("BILLBOARD_NET_AMT"))
        if min_net_buy is not None and (net_buy is None or net_buy < min_net_buy):
            continue
        chg, tr = _num_or_none(r.get("CHANGE_RATE")), _num_or_none(r.get("TURNOVERRATE"))
        stocks.append({"code": r.get("SECURITY_CODE", ""), "name": r.get("SECURITY_NAME_ABBR", ""), "reason": r.get("EXPLANATION", ""),
                       "close": _num_or_none(r.get("CLOSE_PRICE")), "change_pct": None if chg is None else round(chg, 2),
                       "net_buy_wan": net_buy, "buy_wan": _wan(r.get("BILLBOARD_BUY_AMT")), "sell_wan": _wan(r.get("BILLBOARD_SELL_AMT")),
                       "turnover_pct": None if tr is None else round(tr, 2)})
    return {"date": actual, "total_records": len(stocks), "stocks": stocks, "truncated": truncated}


# ---------- 4.x 资金面 / 筹码(数据中心) ----------
def margin_trading(code: str, page_size: int = 30) -> list[dict]:
    """融资融券明细(日级):rzye 融资余额 / rzmre 融资买入额 / rzche 融资偿还额 / rqye 融券余额(元);rqmcl 融券卖出量 / rqchl 偿还量(股);rzrqye 合计(元)"""
    digits, _ = norm_ticker(code, stock_only=True)
    data = eastmoney_datacenter("RPTA_WEB_RZRQ_GGMX", filter_str=f'(SCODE="{digits}")', page_size=page_size, sort_columns="DATE", sort_types="-1")
    # 源没给的字段留 None(不当 0):省略 RZYE 原来会写出「融资余额 0 元」
    return [{"date": str(r.get("DATE", ""))[:10], "rzye": r.get("RZYE"), "rzmre": r.get("RZMRE"), "rzche": r.get("RZCHE"), "rqye": r.get("RQYE"),
             "rqmcl": r.get("RQMCL"), "rqchl": r.get("RQCHL"), "rzrqye": r.get("RZRQYE")} for r in data]


def block_trade(code: str, page_size: int = 20) -> list[dict]:
    """大宗交易:price 成交价(元) / close 收盘价(元) / premium_pct(%) / vol(万股,源口径) / amount(万元,源口径) / buyer / seller"""
    digits, _ = norm_ticker(code, stock_only=True)
    data = eastmoney_datacenter("RPT_DATA_BLOCKTRADE", filter_str=f'(SECURITY_CODE="{digits}")', page_size=page_size, sort_columns="TRADE_DATE", sort_types="-1")
    rows = []
    for r in data:
        # 缺哪个价就留 None:收盘价缺失时溢价率以前写成 0%,成交价缺失写成 -100%(审计 B4)
        close, price = _num_or_none(r.get("CLOSE_PRICE")), _num_or_none(r.get("DEAL_PRICE"))
        premium = round((price / close - 1) * 100, 2) if price is not None and price > 0 and close is not None and close > 0 else None
        rows.append({"date": str(r.get("TRADE_DATE", ""))[:10], "price": price, "close": close, "premium_pct": premium,
                     "vol": _num_or_none(r.get("DEAL_VOLUME")), "amount": _num_or_none(r.get("DEAL_AMT")), "buyer": r.get("BUYER_NAME", ""), "seller": r.get("SELLER_NAME", "")})
    return rows


def holder_num_change(code: str, page_size: int = 10) -> list[dict]:
    """股东户数(季度):holder_num(户) / change_num(户) / change_ratio(环比 %) / avg_shares(户均持股,股)"""
    digits, _ = norm_ticker(code, stock_only=True)
    data = eastmoney_datacenter("RPT_HOLDERNUMLATEST", filter_str=f'(SECURITY_CODE="{digits}")', page_size=page_size, sort_columns="END_DATE", sort_types="-1")
    return [{"date": str(r.get("END_DATE", ""))[:10], "holder_num": r.get("HOLDER_NUM"), "change_num": r.get("HOLDER_NUM_CHANGE"),
             "change_ratio": r.get("HOLDER_NUM_RATIO"), "avg_shares": r.get("AVG_FREE_SHARES")} for r in data]


def dividend_history(code: str, page_size: int = 20) -> list[dict]:
    """分红送转:bonus_rmb 每 10 股派息税前(元,源 PRETAX_BONUS_RMB 口径,茅台 2025 年报 = 280.2423)/ transfer_ratio 每 10 股转增 / bonus_ratio 每 10 股送股 / plan 进度;date = 除权除息日"""
    digits, _ = norm_ticker(code, stock_only=True)
    data = eastmoney_datacenter("RPT_SHAREBONUS_DET", filter_str=f'(SECURITY_CODE="{digits}")', page_size=page_size, sort_columns="EX_DIVIDEND_DATE", sort_types="-1")
    return [{"date": str(r.get("EX_DIVIDEND_DATE", ""))[:10], "bonus_rmb": r.get("PRETAX_BONUS_RMB"), "transfer_ratio": r.get("TRANSFER_RATIO"),
             "bonus_ratio": r.get("BONUS_RATIO"), "plan": r.get("ASSIGN_PROGRESS", ""), "report_date": str(r.get("REPORT_DATE", ""))[:10]} for r in data]


# ---------- 5.1 个股新闻 / 5.3 全球资讯 ----------
def eastmoney_stock_news(code: str, page_size: int = 20) -> list[dict]:
    """JSONP 主请求，失败或显式空列表时用浏览器请求形态重试一次。

    参考 PR #43 / AkShare stock_news_em 的 callback、缓存参数及文章链接构造。
    两路都是同一东财源，不是独立信源；不调用无 timeout 的 SDK，不携带 Cookie。
    保留原始响应与行级引用，任一路失败且未取得新闻时显式报错。
    """
    from requests import RequestException

    digits, _ = norm_ticker(code, stock_only=True)
    if type(page_size) is not int or not 1 <= page_size <= 100:
        raise ValueError("page_size 必须为 1..100 的整数")
    outcomes = []
    failed = False
    for browser_profile in (False, True):
        try:
            rows = _stock_news_request(digits, page_size, browser_profile=browser_profile)
        except (RequestException, ValueError) as exc:
            # 不把第三方异常正文（可能含代理凭据）送入报告。
            outcomes.append(f"请求失败（{type(exc).__name__}）")
            failed = True
            continue
        if rows:
            if browser_profile:
                for row in rows:
                    row["_fallback"] = outcomes[0]
            return rows
        outcomes.append("返回空列表")
    if failed:
        raise RuntimeError(f"东财个股新闻获取未完成：主请求{outcomes[0]}；备用请求{outcomes[1]}；不能判定为没有新闻")
    return []


def _stock_news_request(digits: str, page_size: int, *, browser_profile: bool) -> list[dict]:
    """两种请求形态共用捕获、超时与严格解析，避免 SDK 全局 monkeypatch。"""
    import json as _json
    import re as _re
    import time
    from datetime import date
    from html import unescape

    inner = _json.dumps({"uid": "", "keyword": digits, "type": ["cmsArticleWebOld"], "client": "web", "clientType": "web", "clientVersion": "curr",
                         "param": {"cmsArticleWebOld": {"searchScope": "default", "sort": "default", "pageIndex": 1, "pageSize": page_size, "preTag": "", "postTag": ""}}}, separators=(",", ":"))
    params = {"cb": "jQuery_news", "param": inner}
    headers = {"User-Agent": UA, "Referer": "https://so.eastmoney.com/"}
    if browser_profile:
        stamp = str(time.time_ns() // 1_000_000)
        params.update({"cb": f"jQuery35101792940631092459_{stamp}", "_": stamp})
        headers.update({"Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9",
                        "Referer": f"https://so.eastmoney.com/news/s?keyword={digits}"})
    r = em("https://search-api-web.eastmoney.com/search/jsonp", params=params, headers=headers, timeout=15, ext="js")
    r.raise_for_status()
    match = _re.fullmatch(_re.escape(params["cb"]) + r"\s*\((.*)\)\s*;?", r.text.strip(), _re.S)
    if not match:
        raise ValueError("东财新闻返回非预期 JSONP")
    d = _json.loads(match.group(1))
    result = d.get("result") if isinstance(d, dict) else None
    arts = result.get("cmsArticleWebOld") if isinstance(result, dict) else None
    if not isinstance(arts, list):
        raise ValueError("东财新闻缺少文章列表")
    rows = []
    for a in arts[:page_size]:
        if not isinstance(a, dict):
            raise ValueError("东财新闻条目格式错误")
        fields = {key: a.get(key) or "" for key in ("title", "content", "date", "mediaName", "url")}
        if not all(isinstance(value, str) for value in fields.values()):
            raise ValueError("东财新闻字段格式错误")
        title = unescape(_re.sub(r"<[^>]+>", "", fields["title"])).strip()
        if not title:
            raise ValueError("东财新闻缺少标题")
        date.fromisoformat(fields["date"][:10])  # 缺日期不能变成今天的新闻。
        article_code = str(a.get("code", ""))
        url = fields["url"]
        if not url and _re.fullmatch(r"[0-9]{8,40}", article_code):
            url = f"https://finance.eastmoney.com/a/{article_code}.html"
        rows.append({"title": title, "content": unescape(_re.sub(r"<[^>]+>", "", fields["content"]))[:200],
                     "time": fields["date"], "source": fields["mediaName"], "url": url,
                     "_raw": getattr(r, "_vra_raw_ref", None)})
    return rows


def eastmoney_global_news(page_size: int = 50) -> list[dict]:
    """东财全球财经资讯(7x24 滚动):[{title, summary, time}]"""
    import uuid
    params = {"client": "web", "biz": "web_724", "fastColumn": "102", "sortEnd": "", "pageSize": str(page_size), "req_trace": str(uuid.uuid4())}
    d = em_json("https://np-weblist.eastmoney.com/comm/web/getFastNewsList", params=params, headers={"User-Agent": UA, "Referer": "https://kuaixun.eastmoney.com/"}, timeout=10)
    return [{"title": it.get("title", ""), "summary": (it.get("summary", "") or "")[:200], "time": it.get("showTime", "")} for it in (d.get("data") or {}).get("fastNewsList") or []]


# ---------- 6.3 个股基本面 ----------
def eastmoney_stock_info(code: str) -> dict:
    """东财个股基本面:{code, name, industry, total_shares(股), float_shares(股), mcap(元), float_mcap(元), list_date(YYYYMMDD), price}"""
    d = (_push2_json("/api/qt/stock/get", params={"fltt": "2", "invt": "2", "fields": "f57,f58,f84,f85,f127,f116,f117,f189,f43", "secid": _secid(code)},
                 headers={"User-Agent": UA}, timeout=10).get("data") or {})
    return {"code": d.get("f57", ""), "name": d.get("f58", ""), "industry": d.get("f127", ""), "total_shares": d.get("f84", 0), "float_shares": d.get("f85", 0),
            "mcap": d.get("f116", 0), "float_mcap": d.get("f117", 0), "list_date": str(d.get("f189", "")), "price": d.get("f43", 0)}


# ---------- 8.x 打板层 ----------
ZTB_UT = "7eea3edcaed734bea9cbfc24409ed989"


def _fmt_zt_time(t) -> str:
    s = str(t).zfill(6)
    return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"


_POOL_FIRST_MATCH = "09:25"   # 集合竞价 09:25 撮合:这之前当天的池子不可能有票


def _now_sh() -> datetime:
    return datetime.now(TZ_SH)


def _em_zt_api(endpoint: str, sort: str, date: str) -> list[dict]:
    # 🔴 开盘前上游什么时候把 qdate 切到今天没实测过:要是先切日期、池子还没清,下面的 qdate 核对拦不住昨天的池子。
    #    09:25 之前当天的池子必然是空的,直接报还没开盘(请求也不发)。
    now = _now_sh()
    if str(date).replace("-", "") == now.strftime("%Y%m%d") and now.strftime("%H:%M") < _POOL_FIRST_MATCH:
        raise RuntimeError(f"东财{endpoint}:还没到 {_POOL_FIRST_MATCH} 集合竞价撮合,今天的池子还不可能有票")
    d = em_json(f"https://push2ex.eastmoney.com/{endpoint}", params={"ut": ZTB_UT, "dpt": "wz.ztzt", "Pageindex": 0, "pagesize": 10000, "sort": sort, "date": date}, headers=_REF, timeout=10)
    # 🔴 业务失败(参数错 / 令牌失效)是 HTTP 200 + rc 非 0 + data null(10-11 实测 rc=102 / 205):不能读成空池,否则炸板、跌停被写成 0 家
    rc = d.get("rc")
    if isinstance(rc, int) and rc != 0:
        raise RuntimeError(f"东财{endpoint}返回业务错误 rc={rc}")
    data = d.get("data") or {}
    if not isinstance(data, dict):
        raise RuntimeError(f"东财{endpoint}返回格式不对(data 不是对象)")
    # 🔴 上游对还没有数据的日子(周末 / 节假日 / 开盘前的今天)不报错,而是回最近一个交易日的池子(10-10 周六实测回 10-09 的 69 只)。
    #    qdate 是上游当前的行情日:请求日期晚于它 = 这一天上游还没数据。抛错而不是回空池:空池会被读成「0 家」。
    #    ⚠️ 历史日期的 qdate 照样是最新行情日(请求 0930 回的是 0930 的池子、qdate 却是 1009),不能拿它核对历史场次。
    q, want = str(data.get("qdate") or ""), str(date).replace("-", "")
    if len(q) == 8 and q.isdigit() and len(want) == 8 and want > q:
        raise RuntimeError(f"东财还没有 {want} 的{endpoint}数据(上游最新行情日 {q}):非交易日、还没开盘或数据还没出")
    pool = data.get("pool")
    if pool is not None and not isinstance(pool, list):
        raise RuntimeError(f"东财{endpoint}返回格式不对(pool 不是列表)")
    return pool or []


def _zt_stat(p: dict) -> str:
    z = p.get("zttj") or {}
    return f"{z.get('days', '?')}天{z.get('ct', '?')}板"


def em_zt_pool(date: Optional[str] = None) -> list[dict]:
    """涨停池(date=YYYYMMDD):code/name/price/pct/amount/float_cap/turnover/limit_days/first_seal/last_seal/seal_fund(元)/break_times/industry/zt_stat"""
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    rows = [{"code": p["c"], "name": p["n"], "price": p["p"] / 1000, "pct": round(p["zdp"], 2), "amount": p["amount"], "float_cap": p["ltsz"], "turnover": round(p["hs"], 2),
             "limit_days": p["lbc"], "first_seal": _fmt_zt_time(p["fbt"]), "last_seal": _fmt_zt_time(p["lbt"]), "seal_fund": p["fund"], "break_times": p["zbc"],
             "industry": p.get("hybk", ""), "zt_stat": _zt_stat(p)} for p in _em_zt_api("getTopicZTPool", "fbt:asc", date)]
    ref = last_raw_ref()
    return [{**r, "_raw": ref} for r in rows]


def em_zb_pool(date: Optional[str] = None) -> list[dict]:
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    rows = [{"code": p["c"], "name": p["n"], "price": p["p"] / 1000, "limit_price": p["ztp"] / 1000, "pct": round(p["zdp"], 2), "turnover": round(p["hs"], 2),
             "first_seal": _fmt_zt_time(p["fbt"]), "break_times": p["zbc"], "amplitude": round(p["zf"], 2), "speed": round(p["zs"], 2), "industry": p.get("hybk", ""), "zt_stat": _zt_stat(p)}
            for p in _em_zt_api("getTopicZBPool", "fbt:asc", date)]
    ref = last_raw_ref()
    return [{**r, "_raw": ref} for r in rows]


def em_dt_pool(date: Optional[str] = None) -> list[dict]:
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    rows = [{"code": p["c"], "name": p["n"], "price": p["p"] / 1000, "pct": round(p["zdp"], 2), "turnover": round(p["hs"], 2), "pe": p.get("pe"), "seal_fund": p["fund"],
             "last_seal": _fmt_zt_time(p["lbt"]), "board_amount": p.get("fba"), "dt_days": p.get("days"), "open_times": p.get("oc"), "industry": p.get("hybk", "")}
            for p in _em_zt_api("getTopicDTPool", "fund:asc", date)]
    ref = last_raw_ref()
    return [{**r, "_raw": ref} for r in rows]


def em_yzt_pool(date: Optional[str] = None) -> list[dict]:
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    rows = [{"code": p["c"], "name": p["n"], "price": p["p"] / 1000, "pct": round(p["zdp"], 2), "turnover": round(p["hs"], 2), "amplitude": round(p["zf"], 2), "speed": round(p["zs"], 2),
             "y_first_seal": _fmt_zt_time(p["yfbt"]), "y_limit_days": p["ylbc"], "industry": p.get("hybk", ""), "zt_stat": _zt_stat(p)} for p in _em_zt_api("getYesterdayZTPool", "zs:desc", date)]
    ref = last_raw_ref()
    return [{**r, "_raw": ref} for r in rows]


def limit_up_sentiment(date: Optional[str] = None) -> dict:
    """打板情绪:连板梯队 / 炸板率 / 涨跌停对比(由四池组合)。"""
    date = date or datetime.now(TZ_SH).strftime("%Y%m%d")
    zt, zb, dt = em_zt_pool(date), em_zb_pool(date), em_dt_pool(date)
    # 只返回三池原始列表与计数;炸板率 / 连板梯队等派生统计由 calc 计算
    return {"date": date, "zt_count": len(zt), "zb_count": len(zb), "dt_count": len(dt), "zt": zt, "zb": zb, "dt": dt}


_MONITOR_MARKET = {"1": "SH", "0": "SZ", "B": "BJ"}


def em_stock_monitor(only_active: bool = True) -> list[dict]:
    """东财重点监控池(风险警示名单 + 生效窗口):[{code, name, market, start, end, link}]"""
    rows = em_json("https://mobappconfig.securities.eastmoney.com/emcfg/stock_monitor.json", headers={"Referer": "https://vipmoney.eastmoney.com/"}, timeout=20) or []
    today = _today()
    out = []
    for x in rows:
        start, end = x.get("VALIDATESTARTDATE", ""), x.get("VALIDATEENDDATE", "")
        if only_active and not (start <= today <= end):
            continue
        mk = str(x.get("MARKET", "")).upper()
        out.append({"code": x.get("STKCODE", ""), "name": x.get("STKNAME", ""), "market": _MONITOR_MARKET.get(mk, f"?{mk}"), "start": start, "end": end, "link": x.get("LINK_URL", "")})
    return out


ANOMALY_BASE = "https://dycalchis.eastmoney.com/price-anomaly"
HQ_PARAMS = {"team": "h5", "product": "EastMoney", "client": "WAP", "version": "9001", "name": "WAP", "user": "123"}
ANOMALY_RULES = {1: "主板连续10个交易日内4次出现同向异常波动", 2: "创业板连续10个交易日内3次出现同向异常波动", 3: "科创板连续10个交易日内3次出现同向异常波动",
                 4: "连续十个交易日内日收盘价涨跌幅偏离值累计达到+100%", 5: "连续十个交易日内日收盘价涨跌幅偏离值累计达到-50%", 6: "连续三十个交易日内日收盘价涨跌幅偏离值累计达到+200%",
                 7: "连续三十个交易日内日收盘价涨跌幅偏离值累计达到-70%", 8: "北交所连续10个交易日内3次出现同向异常波动", 40: "连续十个交易日内日收盘价涨跌幅偏离值累计达到+150%",
                 50: "连续十个交易日内日收盘价涨跌幅偏离值累计达到-60%", 60: "连续30个交易日内日收盘价涨跌幅偏离值累计达到+300%", 70: "连续30个交易日内日收盘价涨跌幅偏离值累计达到-75%"}


def _anomaly_market(code, m, board=None) -> str:
    c = str(code or "")
    if c.startswith("920") or c[:2] in ("43", "83", "87") or board == 8:
        return "BJ"
    return "SH" if m == 1 else "SZ"


def _anomaly_get(path: str, page_size: int, page_no: int, **extra) -> dict:
    d = em_json(f"{ANOMALY_BASE}/{path}", params={**HQ_PARAMS, "pageSize": str(page_size), "pageNo": str(page_no), **extra}, headers={"Referer": "https://vipmoney.eastmoney.com/"}, timeout=20)
    if d.get("result") != 0:
        raise RuntimeError(f"东财异动接口拒绝: result={d.get('result')} msg={d.get('msg')!r}")
    return d


def em_price_anomaly(page_size: int = 200, page_no: int = 1) -> dict:
    d = _anomaly_get("list", page_size, page_no)
    items = []
    for x in d.get("data") or []:
        e = x.get("e")
        key = e * 10 if (x.get("s") == 6 and e in (4, 5, 6, 7)) else e
        items.append({"code": x.get("c"), "name": x.get("n"), "market": _anomaly_market(x.get("c"), x.get("m"), x.get("s")), "change_pct": x.get("a"), "deviation": x.get("x"),
                      "days": x.get("d"), "board": x.get("s"), "rule_code": key, "rule": ANOMALY_RULES.get(key, f"未知规则码 {key}"), "is_today": x.get("o") != 2})
    return {"date": str(d.get("date", "")), "pages": d.get("pages", 0), "items": items}


def em_price_anomaly_count(page_size: int = 50, page_no: int = 1, sort_key: str = "", sort_dir: str = "") -> dict:
    d = _anomaly_get("count", page_size, page_no, sortKey=sort_key, sortDir=sort_dir)
    items = [{"code": x.get("c"), "name": x.get("n"), "market": _anomaly_market(x.get("c"), x.get("m"), x.get("s")), "price": x.get("p"), "change_pct": x.get("a"), "times": x.get("t"),
              "deviation": x.get("x"), "days": x.get("d"), "board": x.get("s")} for x in d.get("data") or []]
    return {"date": str(d.get("date", "")), "pages": d.get("pages", 0), "items": items}


# ---------- 10.2 人气榜 / 概念命中(emappdata,POST) ----------
EM_HOT_BODY = {"appId": "appId01", "globalId": "786e4c21-70dc-435a-93bb-38"}


def em_hot_rank(top: int = 50) -> list[dict]:
    """东财人气榜:rank/code/name/price/pct/rank_chg(名称 / 价格用 push2 ulist.np 批量补)。emappdata 为 POST,经 record_raw 落盘。"""
    import requests
    from sources._http import record_raw
    resp = requests.post("https://emappdata.eastmoney.com/stockrank/getAllCurrentList", json={**EM_HOT_BODY, "marketType": "", "pageNo": 1, "pageSize": top}, headers={"User-Agent": UA}, timeout=10)
    resp.raise_for_status()
    raw_rank = record_raw(resp.content, "json", resp.url)
    data = resp.json().get("data") or []
    if not data:
        return []
    secids = [("0." if it["sc"].startswith("SZ") else "1.") + it["sc"][2:] for it in data]
    u = _push2_json("/api/qt/ulist.np/get", params={"ut": "f057cbcbce2a86e2866ab8877db1d059", "fltt": 2, "invt": 2, "fields": "f14,f3,f12,f2", "secids": ",".join(secids)}, headers=_REF, timeout=10)
    diff = (u.get("data") or {}).get("diff") or []
    if isinstance(diff, dict):
        diff = list(diff.values())
    nm = {x["f12"]: (x.get("f14"), x.get("f2"), x.get("f3")) for x in diff}
    out = []
    for it in data:
        code = it["sc"][2:]
        name, price, pct = nm.get(code, ("", None, None))
        out.append({"rank": it["rk"], "code": code, "name": name, "price": price, "pct": pct, "rank_chg": it.get("hisRc"), "_raw": raw_rank})
    return out


def em_hot_concept(code: str) -> list[dict]:
    """个股热门概念命中:[{concept, bk, hit}](按热度降序)"""
    import requests
    from sources._http import record_raw
    digits, market = norm_ticker(code, stock_only=True)
    resp = requests.post("https://emappdata.eastmoney.com/stockrank/getHotStockRankList", json={**EM_HOT_BODY, "srcSecurityCode": market + digits}, headers={"User-Agent": UA}, timeout=10)
    resp.raise_for_status()
    record_raw(resp.content, "json", resp.url)
    return [{"concept": x.get("conceptName"), "bk": x.get("conceptId"), "hit": x.get("hitCount")} for x in resp.json().get("data") or []]


# ---------- 全球(美股 / 港股):global-stock-data §1.3 / §4.1 / §4.2 / §5.1 / §8.1 / §8.4 ----------
_GLOBAL_SECID: dict = {}
_MKT_SUFFIX = {105: "O", 106: "N", 107: "A"}


def suggest_rows(keyword: str, count: int = 10) -> list[dict]:
    """东财搜索框同款联想接口(支持代码 / 中文名 / 拼音首字母),原样返回各行:
    Code / Name / MktNum / SecurityTypeName / Classify / PinYin。不做市场过滤,由调用方按需筛。"""
    d = em_json("https://searchapi.eastmoney.com/api/suggest/get", params={"input": keyword, "type": 14, "token": "D43BF722C8E33BDC906FB84D85E326E8", "count": count}, timeout=10)
    return [it for it in (d.get("QuotationCodeTable") or {}).get("Data") or [] if isinstance(it, dict)]


def stock_search(keyword: str, count: int = 10) -> list[dict]:
    """东财全球搜索:[{code, name, mkt_num(105 NASDAQ / 106 NYSE / 107 美股 ETF / 116 港股), market_name, security_type}]"""
    out = []
    mm = {"105": "NASDAQ", "106": "NYSE", "107": "US_OTHER", "116": "HK"}
    for it in suggest_rows(keyword, count):
        mkt = str(it.get("MktNum", ""))
        if mkt in mm:
            out.append({"code": it.get("Code"), "name": it.get("Name"), "mkt_num": int(mkt), "market_name": mm[mkt], "security_type": it.get("SecurityTypeName")})
    return out


def resolve_global_secid(symbol: str, market: str = "US") -> tuple[int, str]:
    """→ (mkt_num, code):港股固定 116;美股先查搜索接口(精确匹配 Code),再按 105/106/107 逐个试 push2。进程内缓存。"""
    from sources._http import norm_hk, us_ticker_for
    key = (market, symbol.upper())
    if key in _GLOBAL_SECID:
        return _GLOBAL_SECID[key]
    res: Optional[tuple[int, str]]
    if market == "HK":
        res = (116, norm_hk(symbol))
    else:
        t = us_ticker_for("eastmoney", symbol)   # BRK.B → BRK_B（东财的写法）
        res = None
        try:
            hits = [h for h in stock_search(t, 10) if str(h.get("code", "")).upper() == t and h["mkt_num"] in (105, 106, 107)]
            if hits:
                res = (hits[0]["mkt_num"], t)
        except Exception:  # noqa: BLE001 — 搜索失败则逐个试
            pass
        if res is None:
            for p_ in (105, 106, 107):
                d = _push2_json("/api/qt/stock/get", params={"secid": f"{p_}.{t}", "fields": "f57,f58"}, timeout=10)
                if d.get("data"):
                    res = (p_, t)
                    break
        if res is None:
            raise ValueError(f"东财未收录美股 {t}(105/106/107 均无数据)")
    _GLOBAL_SECID[key] = res
    return res


def _secucode(symbol: str, market: str) -> str:
    mkt, code = resolve_global_secid(symbol, market)
    return f"{code}.HK" if market == "HK" else f"{code}.{_MKT_SUFFIX.get(mkt, 'O')}"


def financial_statements_global(symbol: str, market: str = "US", statement: str = "income", page_size: int = 200) -> list[dict]:
    """东财 datacenter 财报三表(美股 / 港股),按科目行展开:[{ITEM_NAME, AMOUNT, YOY_RATIO, REPORT, REPORT_DATE, CURRENCY, ACCOUNT_STANDARD, ...}]"""
    rm = {"balance": {"us": "RPT_USF10_FN_BALANCE", "hk": "RPT_HKF10_FN_BALANCE"}, "income": {"us": "RPT_USF10_FN_INCOME", "hk": "RPT_HKF10_FN_INCOME"},
          "cashflow": {"us": "RPT_USSK_FN_CASHFLOW", "hk": "RPT_HKSK_FN_CASHFLOW"}}
    if statement not in rm:
        raise ValueError("statement 只能是 balance / income / cashflow")
    return eastmoney_datacenter(rm[statement]["hk" if market == "HK" else "us"], filter_str=f'(SECUCODE="{_secucode(symbol, market)}")', page_size=page_size, sort_columns="REPORT_DATE", sort_types="-1")


def key_indicators_global(symbol: str, market: str = "US", page_size: int = 4) -> list[dict]:
    """东财 GMAININDICATOR 关键财务指标(中文字段名,美股 49 / 港股 75 列):[{REPORT_DATE, OPERATE_INCOME, BASIC_EPS, ROE_AVG, ...}]"""
    return eastmoney_datacenter(f"RPT_{'HK' if market == 'HK' else 'US'}F10_FN_GMAININDICATOR", filter_str=f'(SECUCODE="{_secucode(symbol, market)}")', page_size=page_size, sort_columns="REPORT_DATE", sort_types="-1")


def fund_flow_daily_global(symbol: str, market: str = "US", limit: int = 100) -> list[dict]:
    """东财 push2his 日级资金流(美股 / 港股):[{date, main_net, small_net, mid_net, big_net, super_big_net, main_pct}]"""
    mkt, code = resolve_global_secid(symbol, market)
    d = _push2his_json("/api/qt/stock/fflow/daykline/get", params={"secid": f"{mkt}.{code}", "klt": 101, "fields1": "f1,f2,f3,f7", "fields2": "f51,f52,f53,f54,f55,f56,f57", "lmt": limit}, timeout=15)
    rows = []
    for line in ((d.get("data") or {}).get("klines") or []):
        p_ = line.split(",")
        # 「-」/ 空 / 缺列 = 源没给,留 None(原来写成 0.0:净流入 0、占比 0% 看着像真数)
        f_ = lambda x: float(x) if x not in ("-", "") else None  # noqa: E731
        rows.append({"date": p_[0], "main_net": f_(p_[1]), "small_net": f_(p_[2]), "mid_net": f_(p_[3]), "big_net": f_(p_[4]), "super_big_net": f_(p_[5]), "main_pct": f_(p_[6]) if len(p_) > 6 else None})
    return rows


def market_stock_list(market: str = "us_nasdaq", sort_field: str = "f3", sort_desc: bool = True, page: int = 1, page_size: int = 20) -> dict:
    """东财 push2 全市场列表(涨跌幅 / 成交量 / 成交额排名):{total, stocks:[{code, name, price(原始值), change_pct, volume, amount, amplitude, ...}]}。market: us_nasdaq / us_nyse / us_etf / hk 或 fs 原串"""
    fs = {"us_nasdaq": "m:105", "us_nyse": "m:106", "us_etf": "m:107", "hk": "m:116"}.get(market, market)
    d = _push2_json("/api/qt/clist/get", params={"fs": fs, "fields": "f2,f3,f4,f5,f6,f7,f12,f14,f15,f16,f17,f18", "pn": page, "pz": page_size, "fid": sort_field, "po": 1 if sort_desc else 0}, timeout=15)
    data = d.get("data") or {}
    diff = data.get("diff") or []
    if isinstance(diff, dict):
        diff = list(diff.values())
    stocks = [{"code": it.get("f12"), "name": it.get("f14"), "price": it.get("f2"), "change_pct": round(it["f3"] / 100, 2) if it.get("f3") not in (None, "-") else None, "change_amount": it.get("f4"),
               "volume": it.get("f5"), "amount": it.get("f6"), "amplitude": round(it["f7"] / 100, 2) if it.get("f7") not in (None, "-") else None, "high": it.get("f15"), "low": it.get("f16"), "open": it.get("f17"),
               "prev_close": it.get("f18")} for it in diff]
    return {"total": data.get("total", 0), "stocks": stocks, "market": market}


# 沪深京 A 股(主板 / 创业板 / 科创板 / 北交所);与东财行情中心「沪深京 A 股」同一口径
_A_SHARE_FS = "m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048"


def market_turnover_rank(top_n: int = 20) -> dict:
    """全市场成交额榜(沪深京 A 股按成交额降序 TopN)。

    ⚠️ 这是**客观公开榜单**(东财行情中心同款),只做客观展示 —— 非推荐、非预测、不评分。
    🔴 分页按**第一页实际回了多少**推进,不假设上游认我们请求的 pz
       (东财实测忽略 pz=200、每页只给 100;板块资金流就是这么少拿了一半,
       导致"净流出最多"那一栏里全是净流入的板块)。
    """
    base = {"pz": "100", "po": "1", "np": "1", "fltt": "2", "invt": "2", "fid": "f6",
            "fs": _A_SHARE_FS, "fields": "f12,f14,f2,f3,f6,f20,f21,f100"}

    def page(pn: int):
        d = _push2_json("/api/qt/clist/get", params={**base, "pn": str(pn)}, headers={"User-Agent": UA}, timeout=15).get("data") or {}
        return (d.get("diff") or []), int(d.get("total") or 0)

    items, total = page(1)
    page_size = len(items) or 1
    pn = 2
    while len(items) < top_n and not (total and len(items) >= total):
        more, _ = page(pn)
        if not more:
            break
        items += more
        pn += 1
        if len(more) < page_size:
            break

    rows = [{"rank": i + 1, "code": str(it.get("f12", "")), "name": it.get("f14", ""),
             "price": it.get("f2"), "pct": it.get("f3"), "amount": it.get("f6"),
             "mcap": it.get("f20"), "float_cap": it.get("f21"), "industry": it.get("f100", "")}
            for i, it in enumerate(items[:top_n])]
    # 中途空页 / 短页:少于 min(top_n, total) 就是半份,映射层标 partial
    return {"total": max(total, len(items)), "returned": len(rows), "expected": min(top_n, total) if total else None, "rows": rows}


# ---------- 复盘:全市场涨跌分布 / 三所家数与成交额 / 主要指数中长线 / 全市场两融 ----------
def _zdfb_label(k: int) -> str:
    """东财涨跌分布的档位 → 中文。

    11 / -11 = 涨停 / 跌停:10-09 盘中实测 11 档 38 只 = 涨停池 38 只;-11 与跌停池差 1~2 只(取数时刻不同)。
    10 / -10 = 涨跌超过 9% 但没封住(创业板 / 科创板 / 北交所的大涨大跌多数落在这里)。
    其余 k 档 = 涨跌幅绝对值在 k-1 到 k 之间(与新浪全市场涨幅榜逐档核对,边界那一只归哪档以东财为准)。
    """
    if k == 11:
        return "涨停"
    if k == -11:
        return "跌停"
    if k == 10:
        return "涨超 9%(未涨停)"
    if k == -10:
        return "跌超 9%(未跌停)"
    if k == 0:
        return "平盘"
    return f"涨 {k - 1}~{k}%" if k > 0 else f"跌 {-k - 1}~{-k}%"


# 三所全市场家数 / 成交额:东财指数行情里带的是**整个交易所**的涨跌家数与成交额(10-09 实测深证成指与深证综指的这三项完全相同,
# 北证50 给的是三百多家而不是 50 家)。用综指口径的代码,免得让人以为只算成分股。
_BREADTH_SECIDS = (("1.000001", "SH", "沪市"), ("0.399106", "SZ", "深市"), ("0.899050", "BJ", "北交所"))


def market_breadth() -> dict:
    """全市场涨跌分布 + 沪 / 深 / 京三所的上涨、下跌、平盘家数与成交额。

    **只有当日**:盘中是实时快照,收盘后是当天收盘;上游不认日期参数(10-09 实测传 date 照样回今天)。
    {date: YYYY-MM-DD(分布的上游日期), buckets: [{key, label, count}], exchanges: [{market, label, up, down, flat, amount(元)}]}
    ⚠️ 两份口径不同:分布的合计与三所家数合计会差几十到两百多只(停牌 / 北交所 / 取数时刻),各说各的,不互相凑。
    """
    exchanges, notes = [], []
    try:
        d = em_json("https://push2ex.eastmoney.com/getTopicZDFenBu", params={"ut": ZTB_UT, "dpt": "wz.ztzt"}, headers=_REF, timeout=15)
        ref_fb = last_raw_ref()
        data = d.get("data") or {}
    except Exception as e:  # noqa: BLE001  分布没了,三所成交额照取
        notes.append(f"东财涨跌分布没取到({type(e).__name__})")
        data, ref_fb = {}, None
    q = str(data.get("qdate") or "")
    day = f"{q[:4]}-{q[4:6]}-{q[6:8]}" if len(q) == 8 and q.isdigit() else ""
    buckets: list[dict] = []
    for item in data.get("fenbu") or []:
        for k, v in (item or {}).items():
            try:
                key, n = int(k), int(v)
            except (TypeError, ValueError):
                continue
            if -11 <= key <= 11:
                buckets.append({"key": key, "label": _zdfb_label(key), "count": n, "_raw": ref_fb})
    buckets.sort(key=lambda b: -b["key"])
    num = lambda x: x if isinstance(x, (int, float)) and not isinstance(x, bool) else None  # noqa: E731  fltt=2 时缺值是 "-"
    try:
        u = _push2_json("/api/qt/ulist.np/get", params={"fltt": "2", "secids": ",".join(s for s, _, _ in _BREADTH_SECIDS), "fields": "f12,f104,f105,f106,f6"},
                        headers={"User-Agent": UA}, timeout=15)
        ref_u = last_raw_ref()
        by_code = {str(it.get("f12")): it for it in ((u.get("data") or {}).get("diff") or []) if isinstance(it, dict)}
        blank = []
        for secid, mkt, label in _BREADTH_SECIDS:
            it = by_code.get(secid.split(".")[1])
            if it:
                row = {"market": mkt, "label": label, "up": num(it.get("f104")), "down": num(it.get("f105")), "flat": num(it.get("f106")),
                       "amount": num(it.get("f6")), "source": "eastmoney", "_raw": ref_u}
                # 盘前 / 接口异常时各字段都是 "-":这一行等于没取到,不能当成取到了(否则下游既没数、也不报缺口)
                if all(row[k] is None for k in ("up", "down", "flat", "amount")):
                    blank.append(label)
                else:
                    exchanges.append(row)
        if blank:
            notes.append(f"东财三所家数与成交额这次是空值({'、'.join(blank)};可能还没开盘)")
    except Exception as e:  # noqa: BLE001  东财 push2 被风控时常断连;家数没了,成交额改用腾讯行情
        notes.append(f"东财三所家数没取到({type(e).__name__}),成交额改用腾讯行情")
        from sources.tencent import tencent_quotes
        try:
            tq = tencent_quotes(["sh000001", "sz399106", "bj899050"])
            ref_t = last_raw_ref()
            for (_, mkt, label), code in zip(_BREADTH_SECIDS, ("sh000001", "sz399106", "bj899050")):
                qt = str((tq.get(code) or {}).get("quote_time") or "")
                if not day and len(qt) >= 8 and qt[:8].isdigit():
                    day = f"{qt[:4]}-{qt[4:6]}-{qt[6:8]}"  # 分布那份也没取到时,日期取腾讯的成交时间(节假日停在上一个交易日)
                amt = num((tq.get(code) or {}).get("amount_wan"))
                # 腾讯行情缺字段时是 None;一个交易所整天成交额也不可能是 0 ⇒ 两种都当没取到,不写「0 亿」
                if amt:
                    exchanges.append({"market": mkt, "label": label, "up": None, "down": None, "flat": None, "amount": amt * 1e4, "source": "tencent", "_raw": ref_t})
        except Exception as e2:  # noqa: BLE001
            notes.append(f"腾讯行情也没取到({type(e2).__name__})")
    if not buckets and not exchanges:
        raise RuntimeError("涨跌分布与三所成交额都没取到:" + ";".join(notes))
    if not day:
        # 分布那份和腾讯都没给日期:按交易所日历取「今天是交易日且已过 9 点就是今天,否则上一个交易日」,不拿本机的今天硬标
        try:
            from sources.astock_defaults import latest_trading_day
            day = latest_trading_day(9)
            notes.append(f"上游没给数据日,按交易所日历标为 {day}")
        except Exception as e:  # noqa: BLE001
            notes.append(f"上游没给数据日,交易所日历也没取到({type(e).__name__})")
    return {"date": day, "buckets": buckets, "exchanges": exchanges, "notes": notes}


# 中长线看的几条主要指数;两市成交额用上证指数 + 深证综指(都是整个交易所的成交额)
_TREND_INDICES = (("1.000001", "上证指数"), ("0.399001", "深证成指"), ("0.399006", "创业板指"), ("1.000300", "沪深300"),
                  ("1.000905", "中证500"), ("1.000852", "中证1000"), ("1.000688", "科创50"), ("0.899050", "北证50"))
_AMOUNT_SZ = "0.399106"


def _index_daily(secid: str, days: int) -> list[dict]:
    """东财指数日线:[{date, close, amount(元)}],旧 → 新。"""
    params = {"secid": secid, "fields1": "f1,f2,f3", "fields2": "f51,f53,f57", "klt": "101", "fqt": "0", "end": "20500101", "lmt": str(days)}
    d = _push2his_json("/api/qt/stock/kline/get", params=params, headers=_REF, timeout=15)
    ref = last_raw_ref()
    rows = []
    for line in ((d.get("data") or {}).get("klines") or []):
        p = str(line).split(",")
        if len(p) < 3:
            continue
        try:
            rows.append({"date": p[0], "close": float(p[1]), "amount": float(p[2]), "_raw": ref})
        except ValueError:
            continue
    return rows


def market_index_trend(days: int = 300, end: str = "") -> dict:
    """主要指数日线 + 沪深两市成交额,给中长线看「趋势在哪、量能怎样」。

    end(YYYY-MM-DD 或 YYYYMMDD,可空):只用这一天及以前的日线。复盘页盘中看上一个交易日时传它 ——
    不传的话最新一根是今天没收完的那根,「当日涨跌」和页面的业务日就不是同一天。

    {indices: [{code, name, source, rows: [{date, close}]}], amount_rows: [{date, sh, sz, total}](元), failed: [{code, name, error}]}
    指数收盘先取腾讯(北证50 腾讯没有历史,用东财);两市成交额先取东财(含今天),取不到改用 baostock(只到上一个交易日)。
    🔴 盘中最后一根是**截至取数时刻**的未完成日线,收盘前还会变。
    ⚠️ 一条指数取不到不拖垮其余:记进 failed;全部取不到才抛错(那是源坏了,不是"没有数据")。
    """
    days = int(days)
    if not 60 <= days <= 600:
        raise ValueError("days 须在 60~600 之间")
    end = str(end or "").strip()
    if end:
        if len(end) == 8 and end.isdigit():
            end = f"{end[:4]}-{end[4:6]}-{end[6:]}"
        try:
            datetime.strptime(end, "%Y-%m-%d")
        except ValueError:
            raise ValueError("end 须是 YYYY-MM-DD 或 YYYYMMDD") from None
    # 只截掉 end 之后的那几根;多取几根补上,250 日窗口才不会因为截掉今天而凑不满
    keep = (lambda rows: [r for r in rows if str(r["date"])[:10] <= end]) if end else (lambda rows: rows)
    fetch_n = days + 10 if end else days
    from sources.astock_ported import tencent_kline
    indices, failed = [], []
    for secid, name in _TREND_INDICES:
        code = secid.split(".")[1]
        tx = ("sh" if secid.startswith("1.") else "sz") + code
        rows: list[dict] = []
        src, errs = "", list[str]()
        # 🔴 收盘价先走腾讯:稳定、不占东财的请求配额(东财 push2his 被风控时整段断连,10-09 实测 8 条断 5 条)。
        #    北证50 腾讯只给最新 1 根(源函数直接拒),只能走东财。
        if not code.startswith("899"):
            try:
                frame = tencent_kline(tx, period="day", adjust="", count=fetch_n)
                ref = last_raw_ref()
                rows = keep([{"date": str(r["date"]), "close": float(r["close"]), "_raw": ref} for r in frame.to_dict("records")])
                src = "tencent"
            except Exception as e:  # noqa: BLE001  换东财再试
                errs.append(f"腾讯 {type(e).__name__}")
        if not rows:
            try:
                rows = keep(_index_daily(secid, fetch_n))
                src = "eastmoney"
            except Exception as e:  # noqa: BLE001  单条失败如实记下,其余照常
                errs.append(f"东财 {type(e).__name__}: {str(e)[:100]}")
        if rows:
            indices.append({"code": code, "name": name, "rows": rows, "source": src})
        else:
            failed.append({"code": code, "name": name, "error": ";".join(errs) or "上游没回日线"})
    if not indices:
        raise RuntimeError("主要指数日线一条都没取到:" + ";".join(f"{f['name']} {f['error']}" for f in failed)[:300])
    amount_rows: list[dict] = []
    sh: list[dict] = []
    sz: list[dict] = []
    amount_src, errs = "eastmoney", list[str]()
    for secid in ("1.000001", _AMOUNT_SZ):
        try:
            got = keep(_index_daily(secid, 130 + (10 if end else 0)))
        except Exception as e:  # noqa: BLE001  换 baostock
            errs.append(f"东财 {type(e).__name__}")
            sh, sz = [], []
            break
        (sh if secid.startswith("1.") else sz).extend(got)
    if not (sh and sz):
        # 🔴 东财 push2his 被风控时整段断连;baostock 的指数日线也带成交额(只到上一个交易日,收盘后当晚才补今天)
        try:
            from sources.baostock_src import bs_session, _rs_rows
            from sources._http import record_raw, dump_json_bytes
            start = (datetime.now(TZ_SH) - timedelta(days=200)).strftime("%Y-%m-%d")
            got_bs = {}
            with bs_session() as bs:
                for bc in ("sh.000001", "sz.399106"):
                    got_bs[bc] = _rs_rows(bs.query_history_k_data_plus(bc, "date,amount", start_date=start, end_date=_today(), frequency="d", adjustflag="3"))
            ref = record_raw(dump_json_bytes(got_bs), "json", "baostock://query_history_k_data_plus/sh.000001+sz.399106", kind="extracted")
            conv = lambda rows: keep([{"date": r["date"], "close": None, "amount": float(r["amount"]), "_raw": ref} for r in rows if r.get("amount") not in ("", None)])  # noqa: E731
            sh, sz, amount_src = conv(got_bs["sh.000001"]), conv(got_bs["sz.399106"]), "baostock"
        except Exception as e:  # noqa: BLE001  两个源都没有就如实缺
            errs.append(f"baostock {type(e).__name__}: {str(e)[:80]}")
            failed.append({"code": "000001+399106", "name": "沪深两市成交额", "error": ";".join(errs)})
    if sh and sz:
        sz_by = {r["date"]: r for r in sz}
        for r in sh[-130:]:
            z = sz_by.get(r["date"])
            if z:
                amount_rows.append({"date": r["date"], "sh": r["amount"], "sz": z["amount"], "total": r["amount"] + z["amount"], "source": amount_src, "_raw": z["_raw"]})
    return {"indices": indices, "amount_rows": amount_rows, "failed": failed}


def market_margin_history(days: int = 60) -> list[dict]:
    """全市场两融余额(东财两融历史汇总,日级;T 日数据 T+1 才发布,所以最新一条通常是上一个交易日)。

    [{date, rzrqye 两融余额, rzye 融资余额, rqye 融券余额, rzmre 融资买入额, rzjme 融资净买入(元), rzye_float_pct 融资余额占流通市值(%)}],新 → 旧
    """
    days = int(days)
    if not 5 <= days <= 250:
        raise ValueError("days 须在 5~250 之间")
    data = _dc_strict("RPTA_RZRQ_LSHJ", "", page_size=days, sort_columns="DIM_DATE", sort_types="-1")
    ref = last_raw_ref()
    return [{"date": _d10(r.get("DIM_DATE")), "rzrqye": r.get("RZRQYE"), "rzye": r.get("RZYE"), "rqye": r.get("RQYE"), "rzmre": r.get("RZMRE"),
             "rzjme": r.get("RZJME"), "rzye_float_pct": r.get("RZYEZB"), "_raw": ref} for r in data if r.get("DIM_DATE")]


# ---------- v2.3 补洞:南向资金 / 十大股东 / 主营构成 / 停复牌 / 港美股公司资料 / 港股分红 / A-H 对照 ----------
def _dc_strict(report_name: str, filter_str: str, page_size: int = 50, sort_columns: str = "", sort_types: str = "-1") -> list[dict]:
    """数据中心查询,**区分「确实没有」和「请求被拒 / 结构坏了」**:直接用 ``eastmoney_datacenter`` 的同一套检查。
    🔴 以前自己只看 success=false:成功码却 ``result={}`` / ``data=null`` 被当成零条,停复牌写成「0 只」(第四轮审计 B3)。"""
    return eastmoney_datacenter(report_name, "ALL", filter_str, page_size, sort_columns, sort_types)


def _d10(v) -> str:
    return str(v or "")[:10].replace("/", "-")


_SOUTHBOUND = {"all": "006", "sh": "002", "sz": "004"}


def southbound_daily(channel: str = "all", page_size: int = 20) -> list[dict]:
    """南向资金每日成交(港股通):channel = all 南向合计 / sh 港股通(沪) / sz 港股通(深)。
    金额单位**百万港元**:与港交所官方日统计逐项核对一致(2026-10-08 港股通(沪)买入 27,150.21 / 卖出 23,313.78,港交所页面标注 HKD mil)。
    [{date, net_buy, buy, sell, turnover, trades, accum_net_buy, hsi_close, hsi_change_pct}]"""
    if channel not in _SOUTHBOUND:
        raise ValueError("channel 只能是 all / sh / sz")
    rows = _dc_strict("RPT_MUTUAL_DEAL_HISTORY", f'(MUTUAL_TYPE="{_SOUTHBOUND[channel]}")', page_size=page_size, sort_columns="TRADE_DATE")
    return [{"date": _d10(r.get("TRADE_DATE")), "net_buy": r.get("NET_DEAL_AMT"), "buy": r.get("BUY_AMT"), "sell": r.get("SELL_AMT"), "turnover": r.get("DEAL_AMT"),
             "trades": r.get("DEAL_NUM"), "accum_net_buy": r.get("ACCUM_DEAL_AMT"), "hsi_close": r.get("INDEX_CLOSE_PRICE"), "hsi_change_pct": r.get("INDEX_CHANGE_RATE"),
             "channel": channel} for r in rows if r.get("TRADE_DATE")]


def southbound_holding(code: str, page_size: int = 20) -> list[dict]:
    """个股南向持股(港股通合计;源里沪 / 深两个口径回的是同一份合计,只取一份):
    [{date, hold_shares(股), hold_value(港元), hold_ratio(占已发行港股 %), shares_change(股), close(港元)}]。
    hold_ratio 已核对:腾讯 2026-09-30 持股 1,079,451,366 股 ÷ 港股股本 9,092,605,595 = 11.87%,源给 11.86。"""
    from sources._http import norm_hk
    hk = norm_hk(code)
    rows = _dc_strict("RPT_MUTUAL_STOCK_HOLDRANKS", f'(SECUCODE="{hk}.HK")(MUTUAL_TYPE="002")', page_size=page_size, sort_columns="TRADE_DATE")
    out, seen = [], set()
    for r in rows:
        day = _d10(r.get("TRADE_DATE") or r.get("HOLD_DATE"))
        if not day or day in seen:
            continue
        seen.add(day)
        out.append({"date": day, "name": r.get("SECURITY_NAME"), "hold_shares": r.get("HOLD_SHARES"), "hold_value": r.get("HOLD_MARKET_CAP"), "hold_ratio": r.get("HOLD_SHARES_RATIO"),
                    "shares_change": r.get("HOLD_SHARES_CHANGE"), "close": r.get("CLOSE_PRICE")})
    return out


def top10_holders(code: str, free: bool = False, periods: int = 2) -> list[dict]:
    """十大股东(free=False)/ 十大流通股东(free=True),最近 periods 个报告期:
    [{period, rank, name, shares(股), ratio(%), change(源原文:不变 / 新进 / 增减股数), holder_type, updated}]。ratio:十大股东 = 占总股本;十大流通股东 = 占流通股本。"""
    digits, market = norm_ticker(code, stock_only=True)
    rep = "RPT_F10_EH_FREEHOLDERS" if free else "RPT_F10_EH_HOLDERS"
    rows = _dc_strict(rep, f'(SECUCODE="{digits}.{market}")', page_size=max(1, int(periods)) * 10, sort_columns="END_DATE,HOLDER_RANK", sort_types="-1,1")
    ends = sorted({_d10(r.get("END_DATE")) for r in rows if r.get("END_DATE")}, reverse=True)[:max(1, int(periods))]
    return [{"period": _d10(r.get("END_DATE")), "rank": r.get("HOLDER_RANK"), "name": r.get("HOLDER_NAME"), "shares": r.get("HOLD_NUM"),
             "ratio": r.get("FREE_HOLDNUM_RATIO") if free else r.get("HOLD_NUM_RATIO"), "change": r.get("HOLD_NUM_CHANGE"),
             "holder_type": r.get("HOLDER_NEWTYPE") or r.get("HOLDER_TYPE"), "updated": _d10(r.get("UPDATE_DATE")), "share_type": r.get("SHARES_TYPE")}
            for r in rows if _d10(r.get("END_DATE")) in ends]


_MAINOP_TYPE = {"1": "按行业", "2": "按产品", "3": "按地区"}


def main_business(code: str, periods: int = 1) -> list[dict]:
    """主营构成(最近 periods 个报告期):[{period, report_name, split(按行业 / 按产品 / 按地区), item, revenue(元), revenue_ratio(小数), cost(元), profit(元), gross_margin(小数), rank}]"""
    digits, market = norm_ticker(code, stock_only=True)
    rows = _dc_strict("RPT_F10_FN_MAINOP", f'(SECUCODE="{digits}.{market}")', page_size=200, sort_columns="REPORT_DATE,MAINOP_TYPE,RANK", sort_types="-1,1,1")
    ends = sorted({_d10(r.get("REPORT_DATE")) for r in rows if r.get("REPORT_DATE")}, reverse=True)[:max(1, int(periods))]
    return [{"period": _d10(r.get("REPORT_DATE")), "report_name": r.get("REPORT_NAME"), "split": _MAINOP_TYPE.get(str(r.get("MAINOP_TYPE")), f"分类{r.get('MAINOP_TYPE')}"),
             "item": r.get("ITEM_NAME"), "revenue": r.get("MAIN_BUSINESS_INCOME"), "revenue_ratio": r.get("MBI_RATIO"), "cost": r.get("MAIN_BUSINESS_COST"),
             "profit": r.get("MAIN_BUSINESS_RPOFIT"), "gross_margin": r.get("GROSS_RPOFIT_RATIO"), "rank": r.get("RANK")}
            for r in rows if _d10(r.get("REPORT_DATE")) in ends]


def suspensions(date: Optional[str] = None) -> dict:
    """沪深京当日停复牌名单(源要求按日期查):{date, rows:[{code, name, market, start, end, expire, reason, resume_date}]};rows 为空 = 源当日名单里没有股票。"""
    day = date or _today()
    rows = _dc_strict("RPT_CUSTOM_SUSPEND_DATA_INTERFACE", f"(MARKET=\"全部\")(DATETIME='{day}')", page_size=500, sort_columns="SUSPEND_START_DATE")
    return {"date": day, "rows": [{"code": r.get("SECURITY_CODE"), "name": r.get("SECURITY_NAME_ABBR"), "market": r.get("TRADE_MARKET"), "start": str(r.get("SUSPEND_START_TIME") or "")[:16],
                                   "end": str(r.get("SUSPEND_END_TIME") or "")[:16], "expire": r.get("SUSPEND_EXPIRE"), "reason": r.get("SUSPEND_REASON"),
                                   "resume_date": _d10(r.get("PREDICT_RESUME_DATE"))} for r in rows]}


def company_profile_global(symbol: str, market: str = "US") -> dict:
    """港股 / 美股公司画像(东财 F10 公司资料 + 证券资料合并):名称、行业、上市日、成立日、员工、注册地、董事长、财年结束日、港股股本 / 港股通标的(港股)、公司简介与主营(文本)。"""
    pre = "HK" if market == "HK" else "US"
    sc = _secucode(symbol, market)
    org = (_dc_strict(f"RPT_{pre}F10_INFO_ORGPROFILE", f'(SECUCODE="{sc}")', page_size=1) or [{}])[0]
    sec = (_dc_strict(f"RPT_{pre}F10_INFO_SECURITYINFO", f'(SECUCODE="{sc}")', page_size=1) or [{}])[0]
    if not org and not sec:
        return {}
    g = lambda k: org.get(k) if org.get(k) not in (None, "") else sec.get(k)  # noqa: E731
    return {"secucode": sc, "name": g("SECURITY_NAME_ABBR"), "org_name": org.get("ORG_NAME"), "name_en": org.get("ORG_EN_ABBR"), "industry": org.get("BELONG_INDUSTRY"),
            "market_board": org.get("BELONG_MARKET") or sec.get("TRADE_MARKET"), "security_type": sec.get("SECURITY_TYPE"), "listing_date": _d10(g("LISTING_DATE")),
            "found_date": _d10(org.get("FOUND_DATE")), "employees": org.get("EMP_NUM"), "reg_place": org.get("REG_PLACE"), "country": org.get("COUNTRY"), "chairman": org.get("CHAIRMAN"),
            "fiscal_year_end": g("YEAR_SETTLE_DAY"), "hk_shares": org.get("HK_SHARES"), "trade_unit": sec.get("TRADE_UNIT"), "isin": g("ISIN_CODE"),
            "southbound_sh": sec.get("GANGGUTONGBIAODIHU"), "southbound_sz": sec.get("GANGGUTONGBIAODISHEN"), "website": org.get("ORG_WEB"),
            "profile": str(org.get("ORG_PROFILE") or "").strip(), "main_business": str(org.get("MAIN_BUSINESS") or "").strip()}


def global_industry(symbol: str, market: str = "US") -> dict:
    """港美股行业(东财 F10 公司资料,只取行业两列):{secucode, industry(东财的细分行业名), gics_path(港股才有:GICS 四级「一级-二级-三级-四级」)}。
    东财没有这只的公司资料(ETF / 基金多是这样)→ {};美股代码东财没收录 → ValueError(resolve_global_secid)。"""
    pre = "HK" if market == "HK" else "US"
    sc = _secucode(symbol, market)
    org = (_dc_strict(f"RPT_{pre}F10_INFO_ORGPROFILE", f'(SECUCODE="{sc}")', page_size=1) or [{}])[0]
    if not org:
        return {}
    if org.get("SECUCODE") not in (None, sc):
        raise RuntimeError(f"东财公司资料请求 {sc},却返回了 {org.get('SECUCODE')}")
    return {"secucode": sc, "industry": (org.get("BELONG_INDUSTRY") or None), "gics_path": (org.get("INDUSTRY_TYPE") or None)}


def hk_dividends(code: str, page_size: int = 20) -> list[dict]:
    """港股分红派息(东财 F10):[{notice_date, year, kind, plan(源原文,如「每股派港币5.3元」), ex_date, pay_date, book_close}];方案文字原样给,不拆金额。"""
    from sources._http import norm_hk
    rows = _dc_strict("RPT_HKF10_MAIN_DIVBASIC", f'(SECURITY_CODE="{norm_hk(code)}")(IS_BFP="0")', page_size=page_size, sort_columns="NOTICE_DATE,EX_DIVIDEND_DATE", sort_types="-1,-1")
    return [{"notice_date": _d10(r.get("NOTICE_DATE")), "year": r.get("YEAR"), "kind": r.get("REPORT_TYPE"), "plan": r.get("PLAN_EXPLAIN"), "ex_date": _d10(r.get("EX_DIVIDEND_DATE")),
             "pay_date": _d10(r.get("DIVIDEND_DATE")), "book_close": r.get("TRANSFER_END_DATE")} for r in rows]


def ah_pair(code: str, side: str = "A") -> Optional[dict]:
    """A 股 ↔ H 股对照(东财 F10 基本资料 STR_CODEH):side=A 传 A 股代码,side=H 传港股代码;没有对应的另一边 → None。"""
    if side == "A":
        digits, market = norm_ticker(code, stock_only=True)
        flt = f'(SECUCODE="{digits}.{market}")'
    elif side == "H":
        from sources._http import norm_hk
        flt = f'(STR_CODEH="{norm_hk(code)}.HK")'
    else:
        raise ValueError("side 只能是 A / H")
    rows = _dc_strict("RPT_F10_BASIC_ORGINFO", flt, page_size=2, sort_columns="", sort_types="")
    r = rows[0] if rows else {}
    a, h = str(r.get("SECUCODE") or ""), str(r.get("STR_CODEH") or "")
    if not a or not h.upper().endswith(".HK"):
        return None
    return {"a_code": a.split(".")[0], "a_market": a.split(".")[-1], "a_name": r.get("STR_NAMEA") or r.get("SECURITY_NAME_ABBR"), "h_code": h.split(".")[0], "h_name": r.get("STR_NAMEH")}


#: 东财公告栏目「8-K 2.02」(SEC 8-K 的 Item 2.02 经营业绩与财务状况,美国公司发业绩时提交)
US_8K_202 = "012131006"


def us_earnings_8k(symbol: str, max_pages: int = 30) -> dict:
    """美股业绩 8-K 的提交日(东财公告转载 SEC 申报,按栏目「8-K 2.02」筛):
    {symbol, rows: [{date(美东提交日), title, art_code}], pages, total, truncated}。

    东财这个接口按栏目筛不了,只能从新到旧每页 100 份翻,翻完或到 max_pages 为止。苹果这类公司 13 页翻完(2026-10-09 实测
    2013 年以来 56 份);大银行每年上千份债券申报,翻不完的 truncated=True,更早的业绩申报没取到;
    中途某页不满 100 份、而 total_hits 说后面还有,也记 truncated=True(不能当翻完)。
    外国公司(ADR)用 6-K 报业绩、没有 8-K 2.02,这里取不到。"""
    from sources._http import us_ticker_for
    sym = us_ticker_for("eastmoney", symbol)   # BRK.B 在这个接口里静默回 0 条，要写 BRK_B
    rows: list[dict] = []
    total = None
    page = 0
    for page in range(1, max(1, int(max_pages)) + 1):
        d = em_json("https://np-anotice-stock.eastmoney.com/api/security/ann",
                    params={"sr": "-1", "page_size": "100", "page_index": str(page), "ann_type": "U", "client_source": "web", "stock_list": sym}, timeout=20)
        data = d.get("data") if isinstance(d, dict) else None
        if not isinstance(data, dict):
            raise RuntimeError("东财美股公告的返回结构变了(没有 data)")
        items = data.get("list") or []
        total = data.get("total_hits", total)
        for x in items:
            if any(str(c.get("column_code")) == US_8K_202 for c in x.get("columns") or [] if isinstance(c, dict)):
                rows.append({"date": _d10(x.get("notice_date")) or None, "title": x.get("title"), "art_code": x.get("art_code")})
        if isinstance(total, int) and page * 100 >= total:
            return {"symbol": sym, "rows": rows, "pages": page, "total": total, "truncated": False}
        if len(items) < 100:
            return {"symbol": sym, "rows": rows, "pages": page, "total": total, "truncated": isinstance(total, int)}
    return {"symbol": sym, "rows": rows, "pages": page, "total": total, "truncated": True}
