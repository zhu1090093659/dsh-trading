"""事件回看要的三张东财个股历史表：回购方案（带首次公告日）、龙虎榜历次上榜、限售解禁历次。

现有端点各缺一样，所以另起这三个：
- `share_buyback`（上游原样移植，不改）只有最新公告日和计划起止，没有方案**首次公告**那天；
- `em_dragon_tiger` 默认只看近 30 天、一页 50 条；
- `em_lockup_expiry` 的历史只取最近 15 条。

都走上游同一套严格翻页（`astock_ported._em_event_rows`）：翻页中途出错、回了别的股票、出现重复行都抛错，
不把一部分当全部。这只股票确实没有这类记录时返回空表（不是失败）。
单位照源、写在列名里：_10k = 万股，金额列是元，_pct 是 %。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources import astock_ported as P  # noqa: E402

_PROGRESS = {"001": "董事会预案", "002": "股东大会通过", "003": "股东大会否决",
             "004": "实施中", "005": "停止实施", "006": "完成实施"}
BUYBACK_COLUMNS = ["code", "name", "first_notice", "progress", "progress_code", "plan_start", "plan_end",
                   "amount_lower", "amount_upper", "price_cap", "done_amount", "done_shares", "latest_notice"]
DRAGON_COLUMNS = ["code", "name", "date", "reason", "close", "change_pct", "turnover_pct",
                  "net_buy", "buy_amt", "sell_amt", "deal_amount_ratio_pct"]
LOCKUP_COLUMNS = ["code", "name", "date", "type", "able_shares_10k", "total_ratio_pct", "holders"]


def _code(code) -> str:
    return P.norm_ticker(code, stock_only=True)


@P._v39_contract
def buyback_history(code, limit=500):
    """个股历次回购方案，一个方案一行，按首次公告日倒序。

    first_notice = 东财 DIM_DATE：方案第一次公告那天（它的前一个交易日 DIM_TRADEDATE 是董事会决议日，
    plan_start 是计划起始日，常在股东大会之后，比首次公告晚几周）。金额单位 元，done_* 是已回购部分。
    """
    limit = P._v39_limit(limit)
    digits = _code(code)
    rows = P._em_event_rows("RPTA_WEB_GETHGLIST_NEW", f'(DIM_SCODE="{digits}")', "DIM_DATE,REPURCODE", "-1,1",
                            limit, narrowed=True, equal={"DIM_SCODE": digits})
    out = [{"code": r["DIM_SCODE"], "name": r.get("SECURITYSHORTNAME"), "first_notice": P._em_day(r.get("DIM_DATE")),
            "progress": _PROGRESS.get(r.get("REPURPROGRESS")), "progress_code": r.get("REPURPROGRESS"),
            "plan_start": P._em_day(r.get("REPURSTARTDATE")), "plan_end": P._em_day(r.get("REPURENDDATE")),
            "amount_lower": P._v39_num(r.get("REPURAMOUNTLOWER")), "amount_upper": P._v39_num(r.get("REPURAMOUNTLIMIT")),
            "price_cap": P._v39_num(r.get("REPURPRICECAP")),
            "done_amount": P._v39_num(r.get("REPURAMOUNT")), "done_shares": P._v39_num(r.get("REPURNUM")),
            "latest_notice": P._em_day(r.get("UPDATEDATE"))} for r in rows]
    return P._v39_frame(out, "eastmoney", P.DATACENTER_URL + "?reportName=RPTA_WEB_GETHGLIST_NEW", BUYBACK_COLUMNS)


@P._v39_contract
def dragon_tiger_history(code, limit=2000):
    """个股历次上龙虎榜，一条上榜理由一行（同一天因几条理由上榜就有几行），按上榜日倒序。

    reason 是交易所的上榜理由原文；net_buy / buy_amt / sell_amt 是龙虎榜席位合计（元），
    按「3 日累计偏离」这类理由上榜的是那几天的合计。不取东财自编的「成功率」说明。
    """
    limit = P._v39_limit(limit)
    digits = _code(code)
    rows = P._em_event_rows("RPT_DAILYBILLBOARD_DETAILSNEW", f'(SECURITY_CODE="{digits}")', "TRADE_DATE,TRADE_ID", "-1,1",
                            limit, narrowed=True, equal={"SECURITY_CODE": digits})
    out = [{"code": r["SECURITY_CODE"], "name": r.get("SECURITY_NAME_ABBR"), "date": P._em_day(r.get("TRADE_DATE")),
            "reason": r.get("EXPLANATION"), "close": P._v39_num(r.get("CLOSE_PRICE")),
            "change_pct": P._v39_num(r.get("CHANGE_RATE")), "turnover_pct": P._v39_num(r.get("TURNOVERRATE")),
            "net_buy": P._v39_num(r.get("BILLBOARD_NET_AMT")), "buy_amt": P._v39_num(r.get("BILLBOARD_BUY_AMT")),
            "sell_amt": P._v39_num(r.get("BILLBOARD_SELL_AMT")),
            "deal_amount_ratio_pct": P._v39_num(r.get("DEAL_AMOUNT_RATIO"))} for r in rows]
    return P._v39_frame(out, "eastmoney", P.DATACENTER_URL + "?reportName=RPT_DAILYBILLBOARD_DETAILSNEW", DRAGON_COLUMNS)


@P._v39_contract
def lockup_history(code, limit=500):
    """个股历次限售解禁（含已经排期、还没到的），一批一行，按解禁日倒序。

    able_shares_10k 是实际可上市流通的股数（万股）；total_ratio_pct 是它占总股本的比例（%，源给小数，这里 ×100）。
    源里另有「占流通股比例」和「解禁数量」两列，但历史批次和未来批次的分母对不上（2026-10-09 核对中芯国际四批），不取。
    """
    limit = P._v39_limit(limit)
    digits = _code(code)
    rows = P._em_event_rows("RPT_LIFT_STAGE", f'(SECURITY_CODE="{digits}")', "FREE_DATE,FREE_SHARES_TYPE", "-1,1",
                            limit, narrowed=True, equal={"SECURITY_CODE": digits})
    out = []
    for r in rows:
        ratio = P._v39_num(r.get("TOTAL_RATIO"))
        holders = P._v39_num(r.get("BATCH_HOLDER_NUM"))
        out.append({"code": r["SECURITY_CODE"], "name": r.get("SECURITY_NAME_ABBR"), "date": P._em_day(r.get("FREE_DATE")),
                    "type": r.get("FREE_SHARES_TYPE"), "able_shares_10k": P._v39_num(r.get("ABLE_FREE_SHARES")),
                    "total_ratio_pct": None if ratio is None else round(ratio * 100, 4),
                    "holders": None if holders is None else int(holders)})
    return P._v39_frame(out, "eastmoney", P.DATACENTER_URL + "?reportName=RPT_LIFT_STAGE", LOCKUP_COLUMNS)
