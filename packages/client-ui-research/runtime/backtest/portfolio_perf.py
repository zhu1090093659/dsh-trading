"""组合收益率的 **JSON 入口**：stdin 进 ``{trades: [...]}``（台账里的交易流水原样），stdout 出按币种分开的收益率。

给「我的持仓」页用，不需要模型。按日重放流水得出每天持有多少股，再乘当天收盘价得市值，算两个数：

* **时间加权收益（TWR）**：把每天的涨跌连乘，存取钱的多少和时机不影响它 —— 看「选的这些票本身走得怎么样」。
* **资金加权收益（XIRR）**：把每笔投入、取出和期末市值当现金流解内部收益率 —— 看「我这些钱实际赚了多少」，
  加仓时机会影响它。另给不年化的区间值，不满一年时年化数会把短期涨跌放大。

🔴 不同币种**分开算**：不做汇率换算就不能把人民币和美元的现金流放进同一个内部收益率。
🔴 现金流口径（与持仓页说明一致）：
   - 买入在当天**开头**投入（成交价 × 数量 + 费用），卖出、现金分红在当天**收盘**取出（卖出扣费用）；
   - **期初持仓按当天收盘价计入**，收益率从那天收盘算起 —— 填的每股成本只用于盈亏，不当投入金额
     （迁移来的旧记录日期是迁移当天、成本是多年前的，按成本计入会凭空算出一天的大涨大跌）；
   - 分红按到账日记作取出；除息日到到账日之间收益率会短暂偏低，到账那天补回。
🔴 价格：A 股用**不复权价**，送转按流水里记的换算股数；港美股只有拆股已调整价，按流水里记的送转拆股
   把价格还原成当时的实际价。⇒ 送转拆股没记，那一段的市值就会算错 —— A 股看得出价格断崖时给提醒。
🔴 数据不对的流水（与编排器重放同一套检查）不参与计算；某只取不到价格就整只不算，列进缺口 ——
   不拿成本价或 0 去凑市值。唯一例外是上市前申购的新股：上市前本来没有市价，那几天按成交价计。
🔴 区间从第一笔投入算起。流水比能取到的价格（约 5 年）早时，从有价格那天起算，之前的持仓按当天收盘价计入；
   那时已经卖光的不算，也不取价。
🔴 只给数字，不评好坏、不和指数比输赢。

用法::

    echo '{"trades":[{"id":"t1","symbol":"600519","type":"buy","date":"2026-01-05","shares":100,"price":1500}]}' \\
      | python -m backtest.portfolio_perf
"""

from __future__ import annotations

import json
import math
import re
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

import pandas as pd

from backtest import kline
from backtest.loader import LoaderError, canonical_code, market_of
from backtest.stdio_utf8 import force_utf8_stdio

TRADE_TYPES = ("opening", "buy", "sell", "dividend", "split")
#: 浮点余量，与编排器重放（orchestrator/src/finance/holdings.ts）一致
EPS = 1e-8
MAX_TRADES = 50000
MAX_SYMBOLS = 60
FETCH_WORKERS = 4
#: 取价窗口：与 kline 日线一致（A 股取最近 365×5+2 天，港美股取 5 年），按今天算
PRICE_WINDOW_DAYS = kline.A_SHARE_DAY_SPAN_DAYS
#: 某只最早的价格离窗口起点不到这么多天，算价格被窗口截断（长假、停牌会让第一根晚几天）
WINDOW_SLACK_DAYS = 20
#: 第一笔买入比这只最早的价格早不到这么多天、那根价格又明显晚于窗口起点：多半是上市前申购的新股
PRE_LISTING_DAYS = 60
#: 期末还持有、最新报价比区间最后一天早了超过这么多个交易日 → 提醒这只的期末价格不确定
STALE_TRADING_DAYS = 5
#: 同一组的报价一起断了（或只有一只）时，上面的交易日是从这些报价自己数的，数不出缺了几天。
#: 另按工作日数到截止日：超过这么多个工作日没有新价格也提醒。放宽到两周，春节、国庆休市不误报
STALE_WEEKDAYS = 10
#: 市场 → (币种, 页面上的名字)。分组顺序也按这个来
GROUPS = {"a_share": ("CNY", "A 股 · 人民币"), "hk_equity": ("HKD", "港股 · 港元"), "us_equity": ("USD", "美股 · 美元")}
MARKET_TZ = {"a_share": "Asia/Shanghai", "hk_equity": "Asia/Hong_Kong", "us_equity": "America/New_York"}
#: A 股单日收盘价比前一天低于这个比例（或高于下面那个）而前后 20 天没记送转，像是除权没录。
#: 主板跌停 0.9、创业板 / 科创板 0.8，正常交易日跌不到 0.72
JUMP_DOWN, JUMP_UP, JUMP_WINDOW_DAYS = 0.72, 1.45, 20
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
#: B 股（沪 900、深 200）按美元、港元计价，这里六位代码一律按 A 股人民币算：先拒收（与编排器同一句话，第四轮审计 C1）
_B_SHARE = re.compile(r"(?:900|200)\d{3}\Z")
B_SHARE_UNSUPPORTED = "B 股(900、200 开头)暂不支持:按美元、港元计价,并进人民币合计会算错"


class PerfError(ValueError):
    """整次算不了（入参不对）—— 作为 ``ok: false`` 的原因原样给界面。单只的问题进缺口，不走这里。"""


def _r(v: Optional[float], digits: int = 6) -> Optional[float]:
    return round(v, digits) if v is not None and math.isfinite(v) else None


def _round4(v: float) -> float:
    """保留 4 位，五入方向与 JS ``Math.round`` 相同（Python 的 round 是银行家舍入）。"""
    return math.floor(v * 1e4 + 0.5) / 1e4


def _js(v: float) -> str:
    """数字写进说明文字：整数不带 .0（与编排器那边 JS 的写法一致）。"""
    return str(int(v)) if float(v).is_integer() and abs(v) < 1e15 else repr(float(v))


# ---------------------------------------------------------------- 流水:与编排器重放同一套检查

def _str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def _real_day(s: str) -> bool:
    if not _DAY.fullmatch(s):
        return False
    try:
        return date.fromisoformat(s).isoformat() == s
    except ValueError:
        return False


def trade_of(r: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": _str(r.get("id")), "symbol": _str(r.get("symbol")), "name": _str(r.get("name")), "type": _str(r.get("type")),
        "date": _str(r.get("date")), "shares": _num(r.get("shares")), "price": _num(r.get("price")), "fee": _num(r.get("fee")),
        "amount": _num(r.get("amount")), "ratio": _num(r.get("ratio")), "created_at": _str(r.get("created_at")),
    }


def trade_problem(t: Dict[str, Any]) -> Optional[str]:
    """单笔流水自身的字段够不够算（不看前后文）。措辞与编排器 ``tradeProblem`` 相同。"""
    if not t["symbol"]:
        return "没有代码"
    if _B_SHARE.match(t["symbol"]):
        return B_SHARE_UNSUPPORTED
    if t["type"] not in TRADE_TYPES:
        return f"类型「{t['type'] or '空'}」不认识"
    if not _real_day(t["date"]):
        return f"日期「{t['date'] or '空'}」不是有效日期"
    pos = lambda v: v is not None and v > 0  # noqa: E731
    kind = t["type"]
    if kind == "opening":
        if not pos(t["shares"]):
            return "期初持仓要写大于 0 的数量"
        if t["price"] is None:
            return "期初持仓要写每股成本"
    elif kind in ("buy", "sell"):
        word = "买入" if kind == "buy" else "卖出"
        if not pos(t["shares"]):
            return f"{word}要写大于 0 的数量"
        if not pos(t["price"]):
            return f"{word}要写大于 0 的成交价"
        if t["fee"] is not None and t["fee"] < 0:
            return "费用不能是负数"
    elif kind == "dividend":
        if not pos(t["amount"]):
            return "现金分红要写大于 0 的到账金额"
    elif kind == "split" and not pos(t["ratio"]):
        return "送转拆股要写大于 0 的比例(每 1 股变成几股,如 10 转 5 写 1.5)"
    return None


def replay_key(t: Dict[str, Any]) -> Tuple[str, int, str, str]:
    """重放顺序：日期 → 同日先送转 → 录入顺序 → id（与编排器 ``replayOrder`` 相同）。"""
    return (t["date"], 0 if t["type"] == "split" else 1, t["created_at"], t["id"])


def replay(trades: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]], Dict[str, float]]:
    """按顺序重放股数：返回 (参与计算的流水、跳过的流水和原因、最后每只持有多少股)。

    只管股数，不管成本 —— 收益率要的是每天持有多少、哪天进出多少钱；成本法只影响盈亏，不影响这里。
    """
    held: Dict[str, float] = {}
    valid: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []
    for t in sorted(trades, key=replay_key):
        bad = trade_problem(t)
        if bad:
            skipped.append({"id": t["id"], "symbol": t["symbol"], "why": bad})
            continue
        h = held.get(t["symbol"], 0.0)
        kind = t["type"]
        if kind in ("opening", "buy"):
            held[t["symbol"]] = (0.0 if h <= EPS else h) + t["shares"]
        elif kind == "sell":
            if t["shares"] > h + EPS:
                skipped.append({"id": t["id"], "symbol": t["symbol"],
                                "why": f"卖出 {_js(t['shares'])} 股,超过当时持有的 {_js(_round4(h))} 股(之前的买入或送转可能没录)"})
                continue
            rest = h - t["shares"]
            held[t["symbol"]] = 0.0 if rest <= EPS else rest
        elif kind == "split":
            # 空仓时也照收、不改股数：港美股要靠它把拆股前的价格还原（卖光后拆股、之后又买回）
            held[t["symbol"]] = 0.0 if h <= EPS else h * t["ratio"]
        valid.append(t)
    return valid, skipped, {s: v for s, v in held.items() if v > EPS}


# ---------------------------------------------------------------- 收益率:纯计算

def irr_log(flows: List[Tuple[date, float]]) -> Optional[float]:
    """内部收益率的**对数年增长率** x（年化收益 = e^x − 1）。flows 里投入为负、取出和期末市值为正。

    在对数空间里解：几天之内亏一成，年化会贴着 −100%（如 −99.999999%），直接解年化收益率会在 −1 附近
    失去精度、甚至找不到根；解 x 就没有这个问题，区间收益 e^(x·天数/365) − 1 也不丢精度。
    解不出（没有正负两种现金流、全在同一天、或找不到根）返回 None。
    """
    flows = [(d, v) for d, v in flows if abs(v) > EPS]
    if not any(v < 0 for _, v in flows) or not any(v > 0 for _, v in flows):
        return None
    t0 = min(d for d, _ in flows)
    ts = [((d - t0).days / 365.0, v) for d, v in flows]
    span = max(t for t, _ in ts)
    if span <= 0:
        return None
    bound = min(1000.0, 700.0 / span)   # e^(x·t) 不溢出

    def npv(x: float) -> float:
        return sum(v * math.exp(-x * t) for t, v in ts)

    # 从 0 往两边找第一个变号的区间（多个根时取离 0 最近的那个），再二分
    steps = [0.0, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0]
    pts = sorted({max(-bound, min(bound, s * k)) for s in steps for k in (1, -1)})
    best: Optional[Tuple[float, float]] = None
    for a, b in zip(pts, pts[1:]):
        fa, fb = npv(a), npv(b)
        if fa == 0:
            return a
        if fa * fb < 0 and (best is None or min(abs(a), abs(b)) < min(abs(best[0]), abs(best[1]))):
            best = (a, b)
    if best is None:
        return None
    lo, hi = best
    flo = npv(lo)
    for _ in range(200):
        mid = (lo + hi) / 2
        fm = npv(mid)
        if hi - lo < 1e-13 or fm == 0:
            break
        if (fm < 0) == (flo < 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return (lo + hi) / 2


def xirr(flows: List[Tuple[date, float]]) -> Optional[float]:
    """年化内部收益率（XIRR）。解不出返回 None。"""
    x = irr_log(flows)
    return math.expm1(x) if x is not None else None


def _close_on(ser: pd.Series, d: pd.Timestamp) -> Optional[float]:
    """d 当天或之前最近一个收盘价（停牌、非交易日沿用前一个）。"""
    i = ser.index.searchsorted(d, side="right")
    return float(ser.iloc[i - 1]) if i > 0 else None


def perf_for_group(trades: List[Dict[str, Any]], closes: Dict[str, pd.Series], *, split_adjusted: bool,
                   as_of: date, names: Dict[str, str], window: Optional[pd.Timestamp] = None,
                   later_splits: Sequence[Dict[str, Any]] = ()) -> Dict[str, Any]:
    """一个币种的收益率。trades = 这个币种里参与计算、且取到了价格的流水（已按重放顺序排好）。

    window = 取价窗口的起点（默认按今天算，见 ``window_start``）：用来分辨某只最早的价格是被窗口截断了，还是那时还没上市。
    later_splits = 截止日之后才记的送转拆股：不改截止日的股数，但港美股的拆股已调整价是按今天调整的，
    还原成截止日前的实际价也要乘上它们（Codex 审计 2026-10-09 D7）。
    """
    notes: List[str] = []
    warnings: List[str] = []
    window = window_start() if window is None else window
    first_price = {s: ser.index[0] for s, ser in closes.items()}
    mine = {s: [t for t in trades if t["symbol"] == s] for s in closes}
    # 第一笔买入比这只最早的价格早：价格被取价窗口截断的，整组从有价格那天起算；
    # 上市前申购的新股（最早的价格明显晚于窗口起点、离第一笔买入不到两个月）上市前按成交价计市值，不推后整组
    start = pd.Timestamp(min(t["date"] for t in trades))
    pre_listing: Dict[str, pd.Timestamp] = {}
    for s, ts in mine.items():
        first_in = next((t for t in ts if t["type"] in ("opening", "buy")), None)
        if first_in is None or pd.Timestamp(first_in["date"]) >= first_price[s]:
            continue
        if (first_price[s] > window + pd.Timedelta(days=WINDOW_SLACK_DAYS) and _deal_price(first_in) is not None
                and (first_price[s] - pd.Timestamp(first_in["date"])).days <= PRE_LISTING_DAYS):
            pre_listing[s] = first_price[s]
        else:
            start = max(start, first_price[s])
    end_cap = pd.Timestamp(as_of)
    before = [t for t in trades if pd.Timestamp(t["date"]) < start]
    held: Dict[str, float] = {}
    for t in before:   # 起算日之前的流水只用来得出当时持有多少股
        _apply(held, t)
    held_at_start = any(n > EPS for n in held.values())
    in_window = [t for t in trades if start <= pd.Timestamp(t["date"]) <= end_cap]
    n_before = sum(1 for t in before if t["type"] != "split")
    if before and held_at_start:
        notes.append(f"流水比能取到的价格早，从 {start.date()} 起算；那天之前的持仓按当天收盘价计入，更早的盈亏没算进来")
    elif n_before:
        notes.append(f"有 {n_before} 笔流水早于能取到的价格（从 {start.date()} 开始），那时已经卖光，没算进收益率")
    if not held_at_start:
        # 区间从第一笔投入算起：之前空仓的日子不摊进区间和年化
        firsts = [pd.Timestamp(t["date"]) for t in in_window if t["type"] in ("opening", "buy")]
        if not firsts:
            if n_before:
                raise PerfError(f"这一组的买卖都早于能取到的价格（从 {start.date()} 开始），那时已经卖光，算不了收益率")
            raise PerfError("这一组只有分红或送转，没有买入或期初持仓，算不了收益率")
        start = min(firsts)
        early = [t for t in in_window if pd.Timestamp(t["date"]) < start]
        for t in early:   # 空仓时的分红、送转：不改股数，也没有本金可比
            _apply(held, t)
        k = sum(1 for t in early if t["type"] == "dividend")
        if k:
            notes.append(f"第一笔买入（{start.date()}）之前有 {k} 笔分红到账，那时没有持仓，没算进收益率")
        in_window = [t for t in in_window if pd.Timestamp(t["date"]) >= start]
    for s, fp in sorted(pre_listing.items()):
        if fp > start:
            notes.append(f"{names.get(s) or s} {fp.date()} 之前没有收盘价（多半还没上市），那之前按成交价计市值")
    final: Dict[str, float] = {}
    for t in trades:
        _apply(final, t)
    if in_window and not any(n > EPS for n in final.values()):
        # 全卖光了：算到最后一笔流水那天，不把之后空仓的日子摊进年化
        end_cap = min(end_cap, max(pd.Timestamp(t["date"]) for t in in_window))
    days = set(pd.Timestamp(t["date"]) for t in in_window)
    for ser in closes.values():
        days.update(ser.index[(ser.index >= start) & (ser.index <= end_cap)])
    dates = sorted(days)
    if not dates:
        raise PerfError("没有落在计算区间里的日子")

    # 港美股：价格是拆股已调整的，乘上「这天之后记的送转比例」还原成当时的实际价
    splits = {s: [(pd.Timestamp(t["date"]), t["ratio"]) for t in ts if t["type"] == "split"] for s, ts in mine.items()}
    restore = {s: v + [(pd.Timestamp(t["date"]), t["ratio"]) for t in later_splits if t["symbol"] == s] for s, v in splits.items()}
    # 🔴 只还原**行情里已经实施**的拆股：日期晚于这只最新一根行情的，取到的价格还没按它调整，
    #    乘上去会把历史市值放大（下个月才一拆二，期末市值从 10000 变 20000）——审计第二轮，D7 修复引入
    for s, v in restore.items():
        ser = closes.get(s)
        last = ser.index.max() if ser is not None and len(ser) else None
        restore[s] = [(sd, r) for sd, r in v if last is not None and sd <= last]
        if split_adjusted and last is not None:
            for sd, _ratio in v:
                if sd > last:
                    notes.append(f"{names.get(s) or s} {sd.date()} 的拆股在行情里还没实施（最新行情到 {last.date()}），不参与价格还原")

    def price(s: str, d: pd.Timestamp) -> float:
        p = _close_on(closes[s], d)
        if p is None:
            if s in pre_listing:
                return _pre_listing_price(mine[s], splits[s], d)
            raise PerfError(f"{s} 在 {d.date()} 之前没有价格")  # 起算日已按最早价格推后，到这里说明是程序错
        if split_adjusted:
            for sd, ratio in restore[s]:
                if sd > d:
                    p *= ratio
        return p

    by_day: Dict[pd.Timestamp, List[Dict[str, Any]]] = {}
    for t in in_window:
        by_day.setdefault(pd.Timestamp(t["date"]), []).append(t)

    v_prev = 0.0
    index = 1.0
    orphan = 0   # 清仓以后才到账的分红笔数
    no_fee = 0   # 没填费用、按 0 算的买卖笔数（填了 0 的不算：有的券商确实免佣）
    invested = proceeds = dividends = fees = 0.0
    flows: List[Tuple[date, float]] = []
    series: Dict[str, List[Any]] = {"dates": [], "value": [], "twr_index": [], "net_flow": []}
    for i, d in enumerate(dates):
        inflow = outflow = 0.0
        if i == 0:
            for s, n in held.items():   # 起算日之前就有的持仓：按当天收盘价计入
                if n > EPS:
                    inflow += n * price(s, d)
        for t in by_day.get(d, []):
            kind = t["type"]
            if kind == "opening":
                inflow += t["shares"] * price(t["symbol"], d)
            elif kind == "buy":
                no_fee += 1 if t["fee"] is None else 0
                fee = t["fee"] or 0.0
                inflow += t["shares"] * t["price"] + fee
                fees += fee
            elif kind == "sell":
                no_fee += 1 if t["fee"] is None else 0
                fee = t["fee"] or 0.0
                got = t["shares"] * t["price"] - fee
                outflow += got
                proceeds += got
                fees += fee
            elif kind == "dividend":
                outflow += t["amount"]
                dividends += t["amount"]
            _apply(held, t)
        value = sum(n * price(s, d) for s, n in held.items() if n > EPS)
        base = v_prev + inflow
        if base > EPS:
            index *= (value + outflow) / base
        elif outflow > EPS:
            orphan += sum(1 for t in by_day.get(d, []) if t["type"] == "dividend")   # 没有本金可比，时间加权里算不进去
        invested += inflow
        if inflow > EPS:
            flows.append((d.date(), -inflow))
        if outflow > EPS:
            flows.append((d.date(), outflow))
        series["dates"].append(str(d.date()))
        series["value"].append(_r(value, 4))
        series["twr_index"].append(_r(index, 8))
        series["net_flow"].append(_r(inflow - outflow, 4))
        v_prev = value

    end = dates[-1]
    span = (end - start).days
    twr = index - 1.0
    x = irr_log(flows + [(end.date(), v_prev)])
    if orphan:
        # 只说笔数不说金额：说明文字在隐私模式下遮不到
        notes.append(f"有 {orphan} 笔分红在清仓以后才到账，没有本金可比，时间加权收益里没算；资金加权和区间盈亏里算了")
    if no_fee:
        # 同上，只说笔数
        notes.append(f"有 {no_fee} 笔买卖没填费用，按 0 算：费用合计偏少，收益率可能偏高；补上费用后会更准")
    if span == 0:
        notes.append(f"流水从 {start.date()} 才开始，还没有下一个交易日可比，收益率从下一个交易日起才有变化")
    elif span < 365:
        notes.append(f"区间只有 {span} 天，不满一年：不给年化数字（短期涨跌年化后会被放大），看区间收益")
    warnings += _jump_warnings(trades, closes, start, end, names) if not split_adjusted else []
    # 🔴 期末还拿着、报价却早断了：之后一直沿用最后那个价格，期末市值和收益率里这一只其实不知道
    #    （停牌或来源没更新都可能）。以前只要取到过一个价格就当完整，Codex 审计第三轮 D2
    stale: List[Dict[str, Any]] = []
    for s, n in sorted(held.items()):
        if n <= EPS:
            continue
        last = closes[s].index.max()
        lag = sum(1 for d in dates if d > last)
        # 🔴 计算日期来自流水和取到的报价：整组报价一起断了，这些日子里数不出缺口（只有一只、后面又到了一笔分红，
        #    也只多出一天）。另按工作日数到截止日（期末还拿着时就是 as_of），第四轮审计 D1
        weekdays = len(pd.bdate_range(last + pd.Timedelta(days=1), end_cap)) if end_cap > last else 0
        if lag > STALE_TRADING_DAYS or weekdays > STALE_WEEKDAYS:
            stale.append({"symbol": s, "last_price_date": str(last.date()), "trading_days_after": lag, "weekdays_after": weekdays})
            # 只说日期和天数不说金额：提醒文字在隐私模式下遮不到
            gap = f"之后 {lag} 个交易日（到 {end.date()}）" if lag > STALE_TRADING_DAYS else f"到 {end_cap.date()} 已经 {weekdays} 个工作日没有新价格，"
            warnings.append(f"{names.get(s) or s} 的收盘价只取到 {last.date()}，{gap}"
                            "一直按这个价格估值——可能停牌，也可能是来源没更新；期末市值和收益率里这一只不确定")
    return {
        "start": str(start.date()), "end": str(end.date()), "span_days": span,
        "twr": _r(twr), "twr_annualized": _r((1 + twr) ** (365.0 / span) - 1) if span >= 365 and twr > -1 else None,
        "xirr": _r(math.expm1(x)) if x is not None and span >= 365 else None,
        "mwr_period": _r(math.expm1(x * span / 365.0)) if x is not None else None,
        "invested": _r(invested, 2), "proceeds": _r(proceeds, 2), "dividends": _r(dividends, 2), "fees": _r(fees, 2),
        "trades_without_fee": no_fee,
        "end_value": _r(v_prev, 2), "gain": _r(v_prev + proceeds + dividends - invested, 2),
        "notes": notes, "warnings": warnings, "stale_prices": stale, "ui_only": {"series": series},
    }


def window_start() -> pd.Timestamp:
    """取价窗口的起点：比这天早的价格取不到。"""
    return pd.Timestamp(date.today() - timedelta(days=PRICE_WINDOW_DAYS))


def _deal_price(t: Dict[str, Any]) -> Optional[float]:
    """这笔流水自带的每股价格（买入、卖出的成交价，期初持仓的每股成本）；没有或不大于 0 时 None。"""
    p = t["price"] if t["type"] in ("opening", "buy", "sell") else None
    return p if p is not None and p > 0 else None


def _pre_listing_price(ts: List[Dict[str, Any]], splits: List[Tuple[pd.Timestamp, float]], d: pd.Timestamp) -> float:
    """上市前（还没有收盘价）的某天：用 d 当天或之前最后一笔成交价，再除以那笔之后到 d 记的送转比例。"""
    last: Optional[Dict[str, Any]] = None
    for t in ts:
        if pd.Timestamp(t["date"]) > d:
            break
        if _deal_price(t) is not None:
            last = t
    if last is None:
        raise PerfError(f"{ts[0]['symbol']} 在 {d.date()} 之前没有价格")
    p = float(last["price"])
    for sd, ratio in splits:
        if pd.Timestamp(last["date"]) < sd <= d:
            p /= ratio
    return p


def _apply(held: Dict[str, float], t: Dict[str, Any]) -> None:
    s, h = t["symbol"], held.get(t["symbol"], 0.0)
    if t["type"] in ("opening", "buy"):
        held[s] = (0.0 if h <= EPS else h) + t["shares"]
    elif t["type"] == "sell":
        rest = h - t["shares"]
        held[s] = 0.0 if rest <= EPS else rest
    elif t["type"] == "split":
        held[s] = h * t["ratio"]


def _jump_warnings(trades: List[Dict[str, Any]], closes: Dict[str, pd.Series], start: pd.Timestamp, end: pd.Timestamp,
                   names: Dict[str, str]) -> List[str]:
    """A 股不复权价出现断崖、持有中、前后 20 天又没记送转 —— 多半是除权没录，那一段市值会算错。"""
    out: List[str] = []
    for s, ser in closes.items():
        mine = [t for t in trades if t["symbol"] == s]
        split_days = [pd.Timestamp(t["date"]) for t in mine if t["type"] == "split"]
        w = ser[(ser.index >= start) & (ser.index <= end)]
        for prev_d, d in zip(w.index, w.index[1:]):
            ratio = float(w[d]) / float(w[prev_d]) if float(w[prev_d]) > 0 else 1.0
            if JUMP_DOWN <= ratio <= JUMP_UP:
                continue
            held: Dict[str, float] = {}
            for t in mine:
                if pd.Timestamp(t["date"]) < d:
                    _apply(held, t)
            if held.get(s, 0.0) <= EPS:
                continue
            if any(abs((sd - d).days) <= JUMP_WINDOW_DAYS for sd in split_days):
                continue
            out.append(f"{names.get(s) or s} {d.date()} 价格比前一天{'跌' if ratio < 1 else '涨'}了 {abs(ratio - 1) * 100:.0f}%，"
                       f"像是送转 / 拆股除权，但流水里前后 {JUMP_WINDOW_DAYS} 天没有送转记录；没记的话这天之后的市值和收益率会算错")
    return out


# ---------------------------------------------------------------- 取价与组装

def _closes(code: str, out_dir: Path) -> Tuple[Optional[pd.Series], Optional[str], Optional[Dict[str, Any]]]:
    """一只的日收盘价：A 股不复权，港美股拆股已调整。返回 (序列, 取不到的原因, 来源信息)。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        got = kline.build({"symbol": code, "period": "day", "adjust": "none", "charts": True}, out_dir)
    except (kline.KlineError, LoaderError) as exc:
        return None, str(exc), None
    s = got["ui_only"]["series"]
    ser = pd.Series(s["close"], index=pd.to_datetime(s["dates"]), dtype="float64").dropna()
    ser = ser[ser > 0]
    if ser.empty:
        return None, "一根有效收盘价都没有", None
    return ser, None, {"source": got["source"], "fetched_at": got["fetched_at"], "adjust": got.get("adjust")}


def _parse(req: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], date]:
    trades = req.get("trades")
    if not isinstance(trades, list):
        raise PerfError("trades 要是流水列表")
    if len(trades) > MAX_TRADES:
        raise PerfError(f"一次最多算 {MAX_TRADES} 笔流水")
    if not all(isinstance(t, dict) for t in trades):
        raise PerfError("trades 里每一项都要是对象")
    as_of = req.get("as_of")
    if as_of is None:
        day = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    elif isinstance(as_of, str) and _real_day(as_of):
        day = date.fromisoformat(as_of)
    else:
        raise PerfError("as_of 要是 YYYY-MM-DD")
    return [trade_of(t) for t in trades], day


def build(req: Dict[str, Any], out_dir: Path) -> Dict[str, Any]:
    trades, as_of = _parse(req)
    valid, skipped, _held = replay(trades)
    gaps: List[Dict[str, str]] = []
    code_of: Dict[str, Tuple[str, str]] = {}   # 流水里的写法 → (规整代码, 市场)
    for t in valid:
        if t["symbol"] in code_of:
            continue
        try:
            code = canonical_code(t["symbol"])
            code_of[t["symbol"]] = (code, market_of(code))
        except LoaderError as exc:
            gaps.append({"symbol": t["symbol"], "reason": f"代码认不出：{exc}"})
    valid = [t for t in valid if t["symbol"] in code_of]
    # 截止日之后记的送转拆股：截止日的持仓股数不用它，港美股价格还原要用（见 perf_for_group）
    later_splits = [t for t in valid if t["type"] == "split" and t["date"] > as_of.isoformat()]
    valid = [t for t in valid if t["date"] <= as_of.isoformat()]
    # 取价窗口之前就已卖光、之后再没有流水的：区间里不持有，对收益率没有影响，不取价（也不占只数上限）
    win = window_start()
    last_day: Dict[str, str] = {}
    held_end: Dict[str, float] = {}
    for t in valid:   # 已按重放顺序排好：最后一次写进去的就是最晚那天
        last_day[t["symbol"]] = t["date"]
        _apply(held_end, t)
    dormant = {s for s, d in last_day.items() if pd.Timestamp(d) < win and held_end.get(s, 0.0) <= EPS}
    symbols = sorted(set(last_day) - dormant)
    by_market = {m: [s for s in symbols if code_of[s][1] == m] for m in GROUPS}
    names = {}
    for t in valid:
        if t["name"]:
            names[t["symbol"]] = t["name"]

    # 只数上限按组算：超了的那一组说明原因、不取价，别的组照算
    to_fetch = [s for ss in by_market.values() if len(ss) <= MAX_SYMBOLS for s in ss]
    fetched: Dict[str, Tuple[Optional[pd.Series], Optional[str], Optional[Dict[str, Any]]]] = {}
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futs = {s: pool.submit(_closes, code_of[s][0], out_dir / f"p{i}") for i, s in enumerate(to_fetch)}
        for s, f in futs.items():
            fetched[s] = f.result()

    groups: List[Dict[str, Any]] = []
    sources: Dict[str, Dict[str, Any]] = {}
    for market, (currency, label) in GROUPS.items():
        mine = by_market[market]
        asleep = sum(1 for s in dormant if code_of[s][1] == market)
        if not mine and not asleep:
            continue
        if not mine or len(mine) > MAX_SYMBOLS:
            groups.append({"market": market, "currency": currency, "label": label, "symbols": [], "excluded": [], "ok": False,
                           "reason": f"这一组的买卖都早于能取到的价格（约 5 年前），那时已经卖光，算不了收益率" if not mine
                           else f"这一组近 5 年有流水或还持有的有 {len(mine)} 只，一次最多算 {MAX_SYMBOLS} 只，算不了"})
            continue
        closes: Dict[str, pd.Series] = {}
        excluded: List[Dict[str, str]] = []
        for s in mine:
            ser, why, src = fetched[s]
            if ser is None:
                excluded.append({"symbol": s, "name": names.get(s, ""), "reason": f"价格没取到，这只没算进收益率：{why}"})
            else:
                closes[s] = ser
                sources[s] = src or {}
        group: Dict[str, Any] = {"market": market, "currency": currency, "label": label,
                                 "symbols": [{"symbol": s, "name": names.get(s, "")} for s in closes], "excluded": excluded}
        use = [t for t in valid if t["symbol"] in closes]
        if not use:
            group["ok"] = False
            group["reason"] = "这一组的价格都没取到，算不了"
        else:
            try:
                group.update(perf_for_group(use, closes, split_adjusted=market != "a_share", as_of=as_of, names=names,
                                            later_splits=[t for t in later_splits if t["symbol"] in closes]))
                group["ok"] = True
            except PerfError as exc:
                group["ok"] = False
                group["reason"] = str(exc)
            if asleep:
                group["notes"] = group.get("notes", []) + [f"有 {asleep} 只在 {win.date()} 之前就已卖光（早于能取到的价格），没算进收益率"]
            group["notes"] = group.get("notes", []) + [MARKET_NOTES[market]]
            today = datetime.now(ZoneInfo(MARKET_TZ[market])).date()
            if group.get("ok") and group.get("end") == today.isoformat() and any(ser.index[-1].date() == today for ser in closes.values()):
                group["notes"].append("最后一天的价格是今天的：交易时段内取数时它还没收盘，收盘后数字会变")
        groups.append(group)
    return {"as_of": as_of.isoformat(), "groups": groups, "skipped": skipped, "gaps": gaps, "notes": list(METHOD_NOTES) if groups else [],
            "sources": sorted({src.get("source", "") for src in sources.values() if src.get("source")})}


#: 各组共用的口径说明（结果顶层给一份，界面只显示一次）
METHOD_NOTES = (
    "买入算当天开头投入，卖出、现金分红算当天收盘取出；期初持仓按当天收盘价计入，收益率从那天收盘算起",
    "分红按到账日记作取出：除息日到到账日之间收益率会短暂偏低，到账那天补回；没记分红就只算到价格涨跌",
)
MARKET_NOTES = {
    "a_share": "A 股用不复权价，送转按流水里记的比例换算股数",
    "hk_equity": "港股价格是拆股已调整价，按流水里记的送转拆股还原成当时的实际价；拆股没记会让拆股前的市值算错",
    "us_equity": "美股价格是拆股已调整价，按流水里记的送转拆股还原成当时的实际价；拆股没记会让拆股前的市值算错",
}


def _strip_ui(result: Dict[str, Any]) -> Dict[str, Any]:
    for g in result["groups"]:
        g.pop("ui_only", None)
    return result


CATALOG = {
    "description": "按交易流水算组合收益率：时间加权（TWR）与资金加权（XIRR），按币种分开。"
                   "A 股用不复权价、港美股用拆股已调整价并按流水里的送转还原。只给数字，不评好坏。",
    "parameters": {
        "trades": "交易流水列表（台账 trade 原样）：symbol / type(opening|buy|sell|dividend|split) / date / shares / price / fee / amount / ratio",
        "as_of": "算到哪天，YYYY-MM-DD（默认今天）",
        "charts": "true 时附逐日市值与收益指数序列（界面画图用）",
    },
}


def main() -> None:
    force_utf8_stdio()
    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"入参不是合法 JSON：{exc}"}, ensure_ascii=False))
        return
    if not isinstance(req, dict):
        print(json.dumps({"ok": False, "error": "入参必须是对象"}, ensure_ascii=False))
        return
    if req.get("action") == "catalog":
        print(json.dumps({"ok": True, "catalog": CATALOG}, ensure_ascii=False))
        return
    try:
        with tempfile.TemporaryDirectory(prefix="vra-perf-") as scratch:
            result = build(req, Path(scratch))
    except PerfError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return
    if req.get("charts") is not True:
        result = _strip_ui(result)
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
