"""申万研究所源:行业分类变迁史(StockClassifyUse_stock.xls),消除行业前视偏差。移植自 a-stock-data SKILL.md §6.7。依赖 pandas + xlrd。"""
from __future__ import annotations

import io
import os
import sys
import time
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import norm_ticker, today_str  # noqa: E402
from sources._http import http_get, insecure_tls_allowed  # noqa: E402

SW_URL = "https://www.swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls"
_CACHE = None
#: 握手偶发失败时的重试次数与退避(秒);**只重试,不降低校验强度**
SSL_RETRIES = 3
SSL_RETRY_SLEEP = 0.6


def sw_industry_history():
    """全表 DataFrame:code / start_date / industry_code / l1_code / l2_code(每只股票每次行业调整一行),进程内缓存。"""
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    import pandas as pd
    import requests
    # 🔴 这里的 SSLError **多半不是站点的问题,是本机流量被代理接管**(2026-08-26 实测定位:
    #    该域名解析到 198.18.0.238 —— RFC 2544 基准网段,即 Clash 这类代理的 fake-IP;
    #    代理有时能正确转发 TLS、有时不能,表现为同一分钟内时好时坏、50/50 随机)。
    #    ⇒ 两件事:① **先重试**(实测成功率 50% → 87.5%)
    #             ② 报错时**先提代理**,别一上来就让用户设 VRA_ALLOW_INSECURE_TLS ——
    #                那是拿永久关掉证书校验去换一个环境问题,而且换不回来。
    tls_verified = True
    last_ssl: Optional[Exception] = None
    for attempt in range(SSL_RETRIES):
        try:
            r = http_get(SW_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=60, ext="xls")
            last_ssl = None
            break
        except requests.exceptions.SSLError as e:
            last_ssl = e
            if attempt + 1 < SSL_RETRIES:
                time.sleep(SSL_RETRY_SLEEP * (attempt + 1))  # 换一条连接,可能命中发全链的那台
    if last_ssl is not None:
        # 重试 SSL_RETRIES 次都失败才认为是真的证书问题。降级仍然只在显式开关下发生,并在结果里明示。
        if not insecure_tls_allowed():
            raise RuntimeError(
                f"申万站点证书校验连续 {SSL_RETRIES} 次失败({type(last_ssl).__name__})。"
                "最常见原因是**本机流量经代理**(VPN / Clash 之类会用自己的证书接管 TLS):"
                "先确认代理是否在跑、该域名走的哪条规则,或临时关掉代理重试。"
                "确属站点证书链问题、且你接受风险时,才设 VRA_ALLOW_INSECURE_TLS=1 降级(仅研究用)"
            ) from last_ssl
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        r = http_get(SW_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=60, ext="xls", verify=False)
        tls_verified = False
    r.raise_for_status()
    df = pd.read_excel(io.BytesIO(r.content))
    df.attrs["tls_verified"] = tls_verified
    df = df.rename(columns={"股票代码": "code", "计入日期": "start_date", "行业代码": "industry_code", "更新日期": "update_date"})
    missing = {"code", "start_date", "industry_code"} - set(df.columns)
    if missing:
        raise RuntimeError(f"申万表结构变了,缺列 {sorted(missing)};实际列={list(df.columns)}")
    df["code"] = df["code"].astype(str).str.zfill(6)
    df["industry_code"] = df["industry_code"].astype(str).str.zfill(6)
    df["l1_code"] = df["industry_code"].str[:2] + "0000"
    df["l2_code"] = df["industry_code"].str[:4] + "00"
    df["start_date"] = pd.to_datetime(df["start_date"], errors="coerce")
    _CACHE = df.sort_values(["code", "start_date"]).reset_index(drop=True)
    return _CACHE


def sw_industry(code: str, as_of: Optional[str] = None) -> dict:
    """某股在 as_of(默认今天)的申万行业 + 全部变迁记录:{code, as_of, current:{industry_code,l1_code,l2_code,since}|None, history:[...], table_rows, table_stocks}"""
    import pandas as pd
    digits, _ = norm_ticker(code, stock_only=True)
    as_of = as_of or today_str()
    df = sw_industry_history()
    sub = df[df["code"] == digits]
    # 🔴 历史和当前归属共用同一个截止日:as_of 之后才计入的记录不进变迁史和次数(查历史时点不能带进之后的调整)。
    #    计入日期缺的记录无法判断先后,留着(since 为空,映射层照样标出)
    cur_rows = sub[sub["start_date"] <= pd.Timestamp(as_of)]
    upto = sub[(sub["start_date"] <= pd.Timestamp(as_of)) | sub["start_date"].isna()]
    hist = [{"industry_code": r.industry_code, "l1_code": r.l1_code, "l2_code": r.l2_code, "since": r.start_date.strftime("%Y-%m-%d") if pd.notna(r.start_date) else ""} for r in upto.itertuples(index=False)]
    current = None
    if not cur_rows.empty:
        r = cur_rows.iloc[-1]
        current = {"industry_code": r["industry_code"], "l1_code": r["l1_code"], "l2_code": r["l2_code"], "since": r["start_date"].strftime("%Y-%m-%d")}
    return {"code": digits, "as_of": as_of, "current": current, "history": hist, "table_rows": int(len(df)), "table_stocks": int(df["code"].nunique()), "tls_verified": df.attrs.get("tls_verified", True)}
