"""按代码 / 名称 / 拼音找标的的 **JSON 入口**：stdin 进 ``{query}`` 或 ``{queries: [...]}``，stdout 出候选。

给四个页面共用的搜索框和自选批量粘贴用，不需要模型。走东财搜索框同款联想接口（取数层
``sources.eastmoney.suggest_rows``），它本身认中文名、拼音首字母和代码：「gzmt」「茅台」「600519」都能到贵州茅台。

🔴 只留本产品能处理的三地标的：沪深京 A 股（含科创板、创业板）、沪深场内基金（ETF / LOF）、
   港股、美股。指数、板块、期货、期权、债券、场外基金、新三板、其他国家的股票一律不进候选。
🔴 港股只留 00001–09999：按港交所《Stock Code Allocation Plan》（2026-03-12 版），
   10000–29999 是衍生权证、47000–48999 是界内证、49500–69999 是牛熊证、80000–89999 是人民币柜台，
   这些不是股票本身，搜「腾讯」时不该把一串「腾讯法兴七三购A」排进来。
🔴 输出的代码是界面和台账用的规范形（``600519`` / ``00700.HK`` / ``BRK.B``），与前端 ``normalizeMarketSymbol`` 一致。
🔴 批量模式只在能唯一确定时才替用户选（代码完全一致、名称完全一致、拼音完全一致、或者只有一个候选）；
   有歧义就把候选交回去让用户点，不猜。

用法::

    echo '{"query":"gzmt"}' | python -m backtest.symbol_search
    echo '{"queries":["茅台","txkg","AAPL"]}' | python -m backtest.symbol_search
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from backtest.stdio_utf8 import force_utf8_stdio

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".agents" / "skills" / "data-access" / "scripts"))

MAX_QUERY_LEN = 30
MAX_BATCH = 30
DEFAULT_LIMIT = 8
MAX_LIMIT = 20
#: 向接口要的条数比最终给的多：期货、期权、板块等会被筛掉，要多留余量
FETCH_COUNT = 20

#: 东财 SecurityTypeName → 是否是本产品认的 A 股 / 场内基金（MktNum 为 0 深/京、1 沪）
A_TYPES = {"沪A": "股票", "深A": "股票", "京A": "股票", "科创板": "股票", "创业板": "股票", "基金": "场内基金"}
US_MKTS = {"105", "106", "107"}
HK_MKT = "116"

_US_TICKER = re.compile(r"^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$")


class SearchError(ValueError):
    """入参不对，或接口不通（错误文字会原样显示在搜索框下面）。"""


def normalize_code(text: str) -> Optional[str]:
    """把一段文字按「代码」理解成规范形；认不出返回 None。和前端 normalizeMarketSymbol 同一套规则。"""
    raw = text.strip()
    if not raw:
        return None
    m = re.match(r"^(?:sh|sz|bj)(\d{6})$", raw, re.I) or re.match(r"^(\d{6})\.(?:sh|sz|bj)$", raw, re.I)
    if m:
        return m.group(1)
    if re.fullmatch(r"\d{6}", raw):
        return raw
    m = re.match(r"^hk[:.]?(\d{1,5})$", raw, re.I) or re.match(r"^(\d{1,5})\.hk$", raw, re.I)
    digits = m.group(1) if m else (raw if re.fullmatch(r"\d{1,5}", raw) else None)
    if digits:
        return f"{digits.zfill(5)}.HK"
    m = re.match(r"^us([A-Z][A-Za-z0-9]{0,9}(?:[.-][A-Za-z0-9]{1,4})?)$", raw) or \
        re.match(r"^us[:.]([a-z][a-z0-9]{0,9}(?:[.-][a-z0-9]{1,4})?)$", raw, re.I)
    ticker = (m.group(1) if m else raw).upper()
    return ticker if _US_TICKER.match(ticker) else None


def _match_of(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """东财一行 → 本产品的候选；不是三地可处理的标的返回 None。"""
    code = str(row.get("Code") or "").strip()
    name = str(row.get("Name") or "").strip()
    mkt = str(row.get("MktNum") or "")
    stype = str(row.get("SecurityTypeName") or "")
    pinyin = str(row.get("PinYin") or "").upper()
    if not code or not name:
        return None
    if mkt in ("0", "1") and re.fullmatch(r"\d{6}", code) and stype in A_TYPES:
        return {"symbol": code, "name": name, "market": "CN", "kind": A_TYPES[stype], "board": stype, "pinyin": pinyin}
    if mkt == HK_MKT and re.fullmatch(r"\d{5}", code) and 1 <= int(code) <= 9999:
        return {"symbol": f"{code}.HK", "name": name, "market": "HK", "kind": "港股", "board": "港股", "pinyin": pinyin}
    if mkt in US_MKTS:
        ticker = code.upper().replace("_", ".")   # 东财把 BRK.B 写成 BRK_B
        if _US_TICKER.match(ticker):
            return {"symbol": ticker, "name": name, "market": "US", "kind": "美股", "board": "美股", "pinyin": pinyin}
    return None


def _clean_query(q: Any) -> str:
    if not isinstance(q, str):
        raise SearchError("搜索词要是文字")
    q = q.strip()
    if not q:
        raise SearchError("搜索词是空的")
    if len(q) > MAX_QUERY_LEN:
        raise SearchError(f"搜索词太长（最多 {MAX_QUERY_LEN} 个字）")
    return q


def search(query: str, limit: int = DEFAULT_LIMIT) -> List[Dict[str, Any]]:
    """一次联想：去重后按接口原顺序给前 limit 个。接口不通抛 SearchError。"""
    from sources.eastmoney import suggest_rows   # 延迟导入：入参校验不需要联网层
    try:
        rows = suggest_rows(query, FETCH_COUNT)
    except Exception as exc:  # noqa: BLE001 — 网络 / 风控 / 返回不是 JSON，统一成一句能看懂的话
        raise SearchError(f"名称搜索暂时不通（{type(exc).__name__}），可以直接输入代码：600519 / 00700.HK / AAPL") from exc
    out: List[Dict[str, Any]] = []
    seen = set()
    for row in rows:
        m = _match_of(row)
        if m and m["symbol"] not in seen:
            seen.add(m["symbol"])
            out.append(m)
    return out[:limit]


def resolve(query: str, matches: List[Dict[str, Any]]) -> Dict[str, Any]:
    """批量粘贴时替用户选一个：只有能唯一确定才选，否则交回候选。

    某条规则命中多个时（「中国平安」A 股和港股同名、「ndsd」两地宁德时代），只把命中的那几个交回去，
    接口顺带联想出来的无关标的（一串美股债券 ETF）不再列给用户。
    """
    code = normalize_code(query)
    upper = query.upper()
    rules = (
        ("代码一致", lambda m: code is not None and m["symbol"] == code),
        ("名称一致", lambda m: m["name"] == query),
        ("拼音一致", lambda m: bool(m["pinyin"]) and m["pinyin"] == upper),
    )
    for why, hit in rules:
        hits = [m for m in matches if hit(m)]
        if len(hits) == 1:
            return {"pick": hits[0], "reason": why}
        if len(hits) > 1:
            return {"pick": None, "reason": f"{why}的有 {len(hits)} 个，请选一个", "matches": hits}
    if not matches and code is not None and not re.fullmatch(r"[A-Z]+", code):
        # 搜索索引里偶尔没有（如 BRK.B），但长得明确就是代码（6 位数字 / 港股 / 带股份类别的美股），按原样用
        market = "HK" if code.endswith(".HK") else "CN" if re.fullmatch(r"\d{6}", code) else "US"
        return {"pick": {"symbol": code, "name": "", "market": market, "kind": "", "board": "", "pinyin": ""},
                "reason": "搜索里没有，按代码原样使用，请核对"}
    if len(matches) == 1:
        m = matches[0]
        # 北交所老代码（43/83/87 开头）搜出来是迁移后的 920 号段，说清楚换了号
        moved = code is not None and re.fullmatch(r"\d{6}", code) and m["market"] == "CN" and m["symbol"] != code
        return {"pick": m, "reason": f"代码已变更：{code} → {m['symbol']}" if moved else "只有一个候选"}
    if not matches:
        return {"pick": None, "reason": "没找到"}
    return {"pick": None, "reason": f"有 {len(matches)} 个可能，请选一个"}


def build(req: Dict[str, Any]) -> Dict[str, Any]:
    if "queries" in req:
        qs = req["queries"]
        if not isinstance(qs, list) or not qs:
            raise SearchError("queries 要是非空列表")
        if len(qs) > MAX_BATCH:
            raise SearchError(f"一次最多查 {MAX_BATCH} 个名称")
        items = []
        for raw in qs:
            q = _clean_query(raw)
            matches = search(q, DEFAULT_LIMIT)
            # code：这段文字如果当代码理解是什么（纯字母没搜到时，界面可以让用户确认「就按美股代码加」）
            # resolve 收窄了候选时，它给的 matches 覆盖前面的完整列表
            items.append({"query": q, "code": normalize_code(q), "matches": matches, **resolve(q, matches)})
        return {"items": items, "source": "东财搜索联想"}
    q = _clean_query(req.get("query"))
    limit = req.get("limit", DEFAULT_LIMIT)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
        raise SearchError(f"limit 要是 1 到 {MAX_LIMIT} 的整数")
    return {"query": q, "matches": search(q, limit), "source": "东财搜索联想"}


CATALOG = {
    "description": "按代码、中文名或拼音首字母找 A 股 / 场内基金 / 港股 / 美股，给出规范代码。"
                   "批量模式只在能唯一确定时替你选，有歧义就列出候选。不含指数、期货、期权、权证和牛熊证。",
    "parameters": {
        "query": "一个搜索词，如 gzmt / 茅台 / 600519 / 腾讯 / AAPL",
        "limit": f"最多返回几个候选（1–{MAX_LIMIT}，默认 {DEFAULT_LIMIT}）",
        "queries": f"批量模式：搜索词列表（最多 {MAX_BATCH} 个），与 query 二选一",
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
        result = build(req)
    except SearchError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
