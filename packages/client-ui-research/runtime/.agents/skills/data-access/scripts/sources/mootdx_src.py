"""通达信(mootdx,TCP 7709,零鉴权)源:财务快照(37 字段)/ F10 文本。
2026-09 起公开服务器的 K 线 / 五档 / 逐笔普遍返回空(上游 #52),这三个端点已于 2026-10-10 删除(K 线用 tx_kline、逐笔用 tx_ticks);
财务与 F10 正常。移植自 a-stock-data SKILL.md §6.1 / §6.2 + 客户端选服逻辑(规避 0.11.x BESTIP 空串 bug)。
海外网络通常全部超时;结果以 extracted_ 前缀落盘。"""
from __future__ import annotations

import os
import socket
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import norm_ticker, quiet_stdout  # noqa: E402
from sources._http import dump_json_bytes, record_raw  # noqa: E402

_TDX_SERVERS = [("119.97.185.59", 7709), ("124.70.133.119", 7709), ("116.205.183.150", 7709), ("123.60.73.44", 7709), ("116.205.163.254", 7709), ("121.36.225.169", 7709),
                ("123.60.70.228", 7709), ("124.71.9.153", 7709), ("110.41.147.114", 7709), ("124.71.187.122", 7709)]
_CLIENTS: dict = {}


def _probe(ip: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def _validate(client) -> bool:
    """真实取数验活(TCP 握手通过 ≠ 能取数):财务快照与 F10「最新提示」正文都要取到才算活。
    不能拿 K 线验活:2026-09 起公开服务器的 K 线 / 盘口 / 逐笔普遍返回空,财务与 F10 仍正常(上游 #52),拿 K 线验会把正常服务器全判死。"""
    try:
        cats = client.F10C(symbol="000001")
        if not any(isinstance(c, dict) and c.get("name") == "最新提示" for c in cats or []):
            return False
        text = client.F10(symbol="000001", name="最新提示")
        if not isinstance(text, str) or not text.strip():
            return False
        df = client.finance(symbol="000001")
        return df is not None and not df.empty
    except Exception:  # noqa: BLE001
        return False


def tdx_client():
    """顺序探测候选服务器并真实取数验活;全部失败回退 bestip / 裸 factory;仍失败抛 RuntimeError。"""
    if "finance" in _CLIENTS:
        return _CLIENTS["finance"]
    from mootdx.quotes import Quotes
    with quiet_stdout():
        for attempt in range(2):  # 服务器偶发 reset,整体再试一轮
            for ip, port in _TDX_SERVERS:
                if not _probe(ip, port):
                    continue
                try:
                    c = Quotes.factory(market="std", server=(ip, port))
                    if _validate(c):
                        _CLIENTS["finance"] = c
                        return c
                except Exception:  # noqa: BLE001
                    continue
        for kwargs in ({"bestip": True}, {}):
            try:
                c = Quotes.factory(market="std", **kwargs)
                if _validate(c):
                    _CLIENTS["finance"] = c
                    return c
            except Exception:  # noqa: BLE001
                continue
    raise RuntimeError("所有 mootdx 服务器均无法取到数据(TCP 可达但返回空 / 被 reset);海外网络通常全部超时,请走国内代理。")


def _records(df) -> list[dict]:
    if df is None or getattr(df, "empty", True):
        return []
    idx_name = getattr(df.index, "name", None)
    d = df.reset_index(drop=(idx_name in df.columns)) if idx_name else df
    out = []
    for rec in d.to_dict("records"):
        out.append({k: (v.isoformat() if hasattr(v, "isoformat") else (None if (isinstance(v, float) and v != v) else v)) for k, v in rec.items()})
    return out


def tdx_finance(code: str) -> dict:
    """财务快照(37 字段季报:liutongguben/zongguben/eps/bvps/roe/profit/income/...)"""
    digits, _ = norm_ticker(code, stock_only=True)
    with quiet_stdout():
        rows = _records(tdx_client().finance(symbol=digits))
    record_raw(dump_json_bytes(rows), "json", f"tdx://finance/{digits}", kind="extracted")
    return rows[0] if rows else {}


def tdx_f10(code: str, categories: Optional[list] = None) -> dict:
    """F10 文本资料:{类别: 文本}。默认取服务器 F10C 实际提供的全部类别(2026-09 起只剩「最新提示」一类,
    内含互动问答 / 最新公告 / 最新报道 / 大宗交易 / 融资融券 / 风险提示等小节);显式点名但服务器没有的类别记为取数失败。"""
    digits, _ = norm_ticker(code, stock_only=True)
    out = {}
    with quiet_stdout():
        c = tdx_client()
        offered = [str(x["name"]) for x in (c.F10C(symbol=digits) or []) if isinstance(x, dict) and x.get("name")]
        for cat in categories or offered:
            if cat not in offered:
                out[cat] = f"[取数失败] 服务器未提供该类别(当前只有:{'、'.join(offered) or '无'})"
                continue
            try:
                text = c.F10(symbol=digits, name=cat)
                # 类别不存在时 mootdx 不报错而是返回 dict,当文本用会静默写进别的东西
                out[cat] = text if isinstance(text, str) else f"[取数失败] 返回的不是文本({type(text).__name__})"
            except Exception as e:  # noqa: BLE001
                out[cat] = f"[取数失败] {e}"
    record_raw(dump_json_bytes(out), "json", f"tdx://F10/{digits}", kind="extracted")
    return out
