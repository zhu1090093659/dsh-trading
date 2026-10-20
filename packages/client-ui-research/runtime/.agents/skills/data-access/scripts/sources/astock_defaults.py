"""给 astock_ported 里「日期 / 交易所必须传」的上游函数补默认值,并按产品端点的用法做筛选。

上游这些函数要求调用方给日期;产品端点约定不带参数也能用(取「最近一个数据已发布的交易日」),
所以在这里补默认值。只有参数为 None(没传)时才补默认,显式传入的值(包括空串、0)原样转给上游校验;筛选只挑行,不改值、不算派生量。
交易日按深交所官方日历(astock_ported.trading_calendar)判断,这次请求的原文同样落盘。
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import TZ_SH  # noqa: E402
from sources import astock_ported as P  # noqa: E402

# 通达信盘后包:取不带市场前缀的代码时,指数与个股可能同号(上证指数 999999 只在沪市),所以默认清单带前缀
TDX_DEFAULT_CODES = ["sh999999", "sz399001", "sz399006", "sh000300", "sh000688", "bj899050"]


def _now() -> datetime:
    return datetime.now(TZ_SH)


def _open_days(year: int, month: int) -> list:
    frame = P.trading_calendar(year, month)
    return [d for d, is_open in zip(frame["date"], frame["is_open"]) if bool(is_open)]


def latest_trading_day(after_hour: Optional[int]) -> str:
    """最近一个数据已发布的交易日(北京时间,'YYYY-MM-DD')。
    after_hour=None:不取今天(当天数据要到下一个交易日才发布,如两融、上交所 ETF 份额);
    after_hour=h:今天是交易日且已过 h 点才取今天(交易所收盘文件一般 17 点前发布);0 = 交易日当天即可(盘中快照)。"""
    now = _now()
    today = now.strftime("%Y-%m-%d")
    days = _open_days(now.year, now.month)
    if after_hour is not None and today in days and now.hour >= after_hour:
        return today
    past = [d for d in days if d < today]
    if not past:  # 月初还没有已过的交易日 → 往上个月找
        prev = now.replace(day=1) - timedelta(days=1)
        past = [d for d in _open_days(prev.year, prev.month) if d < today]
    if not past:
        raise RuntimeError("深交所日历近两个月找不到已过的交易日,日历可能未发布")
    return past[-1]


def _codes(codes) -> list:
    if codes is None:
        return []
    if isinstance(codes, str):
        codes = [c for c in codes.replace(" ", "").split(",") if c]
    return [str(c).strip() for c in codes]


def tdx_daily_package(date=None, codes=None):
    """通达信盘后包。date 缺省 = 最近一个 17 点前已收盘的交易日;codes 缺省 = 主要指数。
    返回筛出的行,attrs 里记全市场各市场条数(全量在落盘的 zip 原文里)。codes 可带 sh/sz/bj 前缀,不带则各市场同号都算。"""
    frame = P.tdx_daily_package(date if date is not None else latest_trading_day(17))
    wanted = _codes(codes) if codes is not None else TDX_DEFAULT_CODES
    if not wanted:
        raise ValueError("codes 为空:不传则取主要指数,要全市场请直接用上游 tdx_daily_package")
    keys = frame["market"].astype(str) + frame["code"].astype(str)
    mask = keys.isin([c.lower() for c in wanted if len(c) == 8]) | frame["code"].astype(str).isin([c for c in wanted if len(c) == 6])
    picked = frame[mask].reset_index(drop=True)
    picked.attrs["market_counts"] = {str(k): int(v) for k, v in frame["market"].value_counts().items()}
    picked.attrs["total_rows"] = int(len(frame))
    picked.attrs["requested_codes"] = wanted
    picked.attrs["unmatched_codes"] = [c for c in wanted if not ((keys == c.lower()).any() or (frame["code"].astype(str) == c).any())]
    return picked


def etf_shares(date=None, exchange="SH", codes=None):
    """ETF 份额。date 缺省:上交所 = 上一个交易日(按日归档);深交所只给最新一天的快照,
    T 日晚为预估、T+1 早为确认值,快照日期何时切到当天不固定,所以先试今天(交易日)、对不上再试上一个交易日。
    显式给 date 时原样交给上游严格校验。"""
    if date is not None:
        frame = P.etf_shares(date, exchange)
    elif str(exchange).upper() == "SZ":
        first, second = latest_trading_day(0), latest_trading_day(None)
        try:
            frame = P.etf_shares(first, exchange)
        except ValueError:
            if second == first:
                raise
            frame = P.etf_shares(second, exchange)
    else:
        frame = P.etf_shares(latest_trading_day(None), exchange)
    wanted = _codes(codes) if codes is not None else []
    if wanted:
        picked = frame[frame["code"].astype(str).isin(wanted)].reset_index(drop=True)
        picked.attrs["total_rows"] = int(len(frame))
        picked.attrs["unmatched_codes"] = [c for c in wanted if c not in set(frame["code"].astype(str))]
        return picked
    return frame


def futures_daily(date=None, exchange="SHFE"):
    return P.futures_daily(date if date is not None else latest_trading_day(17), exchange)


def options_daily(date=None, exchange="SHFE"):
    return P.options_daily(date if date is not None else latest_trading_day(17), exchange)


def futures_position_rank(date=None, exchange="SHFE", symbol=None):
    return P.futures_position_rank(date if date is not None else latest_trading_day(17), exchange, symbol)


def margin_trading_backup(code, market=None, trade_date=None, exchange=None):
    """两融官方备胎(单只):交易所缺省按代码所属市场;日期缺省 = 上一个交易日(两融数据次日发布)。"""
    return P.margin_trading_backup(trade_date if trade_date is not None else latest_trading_day(None),
                                   exchange if exchange is not None else market, code)


def bse_quote_backup(code, trade_date=None):
    """北交所行情官方备胎(单只):日期缺省 = 今天(交易日)或最近一个交易日;上游会拒绝用当前快照冒充别的日子。"""
    return P.bse_quote_backup(trade_date if trade_date is not None else latest_trading_day(0), code)


def cctv_news(date=None, with_content=True):
    """新闻联播每天都播(含节假日):date 缺省 = 北京时间 20 点后取今天,否则取昨天。"""
    if date is None:
        now = _now()
        date = (now if now.hour >= 20 else now - timedelta(days=1)).strftime("%Y-%m-%d")
    return P.cctv_news(date, with_content)


def chinabond_yield_curve(start=None, end=None, curve="all"):
    """中债收益率曲线:start 缺省 = 30 天前。"""
    return P.chinabond_yield_curve(start if start is not None else (_now() - timedelta(days=30)).strftime("%Y-%m-%d"), end, curve)


def macro_calendar(start=None, end=None, country=None, min_importance=1):
    """宏观日历:start 缺省 = 今天(上游默认看 7 天)。"""
    return P.macro_calendar(start if start is not None else _now().strftime("%Y-%m-%d"), end, country, min_importance)


def convertible_bonds(include_delisted=False, stock_code=None):
    """可转债全表;给 stock_code(正股 6 位代码)只留该公司的转债。"""
    frame = P.convertible_bonds(include_delisted)
    if stock_code is not None:
        frame = frame[frame["stock_code"].astype(str) == str(stock_code).strip()].reset_index(drop=True)
    return frame
