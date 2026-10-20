"""海外科技头条(第 16 层)映射:每条一证据(value = 脱敏后标题),口径与第 12 层市场声音一致 —— **线索不是事实**。

- period = 发布日(北京时区换算后取日期);头条**必然有时间戳**(无时间戳的在源层已丢弃),所以 period_basis 恒为 published。
- record_key = 完整 URL 的 sha256(展示链接与身份键分离);raw_ref 指向本次 river / RSS 响应。
- 相关性来自**产业标签关键词**(不是编辑判断也不是模型判断):matched 为空 = 未命中,keywords 为空 = 未标注(unscored),两者不同。
- 状态:窗口内零条 → partial(不是故障:凌晨 / 假日可能真没有);回退 RSS 或触顶截断 → partial 并 degraded 出声。
"""
from __future__ import annotations

import hashlib

from sources.mappers import ev, out
from sources.textsafe import safe_url

MAX_ITEM_EVS = 60      # 单次最多落多少条条目证据(窗口 48h 实测约 70 条;超出**命中优先**保留并出声)
ACCEPT_RATE_MIN = 0.8  # river 解析接受率低于此值 → partial(严重缺数不能以 ok 流向下游)


def _key(url) -> str:
    return "u:" + hashlib.sha256(str(url or "").encode("utf-8")).hexdigest()[:24]


def techmeme_headlines_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    items = list(result.get("items") or [])
    guard = str(result.get("guard") or "")
    day = str(result.get("checked_at") or "")[:10]
    kws = result.get("keywords") or {}
    kw_flat = sorted({*(kws.get("strong") or []), *(kws.get("context") or [])}) if isinstance(kws, dict) else list(kws)
    scored = bool(result.get("scored"))
    tags = result.get("tags") or []
    warns = list(result.get("warnings") or [])
    # 命中数按**完整窗口**算(不是按截断后的保留集 —— Codex headlines-r1:最旧那条命中会被截掉,相关数错报为 0)
    rel_total = sum(1 for it in items if it.get("relevant"))
    items.sort(key=lambda x: str(x.get("published") or ""), reverse=True)
    hits = [it for it in items if it.get("relevant")]
    cands = [it for it in items if not it.get("relevant") and it.get("context_only")]
    rest = [it for it in items if not it.get("relevant") and not it.get("context_only")]
    kept = (hits + cands + rest)[:MAX_ITEM_EVS]   # 命中 > 候选 > 普通未命中(Codex headlines-r3:候选被截掉会只剩汇总计数,线索无声消失)
    hits_dropped = max(0, len(hits) - sum(1 for it in kept if it.get("relevant")))
    cands_dropped = max(0, len(cands) - sum(1 for it in kept if not it.get("relevant") and it.get("context_only")))
    dropped = max(0, len(items) - len(kept))
    if dropped:
        warns.append(f"窗口内 {len(items)} 条,证据只留 {len(kept)} 条(命中 > 候选 > 其它;截断 {dropped} 条,其中命中 {hits_dropped} 条、候选 {cands_dropped} 条)")
    evs = [ev(ctx, "headline_count", len(items), "条", day, currency="n/a", as_of=day,
              note=f"窗口 {result.get('window_hours')} 小时;抓取 {result.get('fetched_total')} 条 → 窗口内 {len(items)} 条;"
                   f"入证据 {len(kept)} 条;命中产业关键词 {rel_total} 条(完整窗口口径);来源入口={result.get('source_used')};"
                   f"标签={','.join(tags) or '无'};关键词数={len(kw_flat)};"
                   f"仅泛词候选 {result.get('context_only_total') or 0} 条(不算相关);解析接受率={result.get('accept_rate')};{guard}",
              raw_ref=result.get("raw_ref"))]
    if scored:
        evs.append(ev(ctx, "headline_relevant_count", rel_total, "条", day, currency="n/a", as_of=day,
                      note=f"完整窗口内命中数(按产业标签关键词标注,不是编辑 / 模型判断);泛词须与锚词共现;"
                           f"关键词={','.join(kw_flat[:12])}{'…' if len(kw_flat) > 12 else ''};{guard}",
                      raw_ref=result.get("raw_ref")))
    for it in kept:
        pub = str(it.get("published") or "")
        d = pub[:10] or day
        matched = it.get("matched") or []
        rel = it.get("relevant")
        cand = it.get("context_only") or []
        rel_txt = ("未标注(本次无产业关键词)" if rel is None
                   else "命中:" + ",".join(matched) if matched
                   else f"候选(泛词 {','.join(cand)} 命中但无锚词共现,不算相关)" if cand
                   else "未命中产业关键词")
        evs.append(ev(ctx, "headline_item", str(it.get("title_safe") or it.get("title") or "")[:200] or "(无标题)", "text", d,
                      currency="n/a", as_of=day, record_key=_key(it.get("url")),
                      note=f"published={pub or 'N/A'};period_basis=published;source={it.get('source') or 'N/A'};"
                           f"relevance={rel_txt};link={safe_url(it.get('url'))};untrusted_text=sanitized;"
                           + ("dst_ambiguous=true(美东夏令时切换歧义,时间可能差 1 小时);" if it.get("dst_ambiguous") else "")
                           + guard,
                      raw_ref=result.get("raw_ref")))
    deg = []
    if result.get("degraded"):
        deg.append(str(result["degraded"]))
    if result.get("truncated"):
        deg.append("抓取条目触及防爆上限")
    if hits_dropped:
        deg.append(f"{hits_dropped} 条命中被证据上限截断")
    if cands_dropped:
        deg.append(f"{cands_dropped} 条仅泛词候选被证据上限截断(线索可能漏看)")
    if not scored:
        deg.append("本次没有可用产业关键词:相关性未标注(unscored),不等于不相关")
    # 解析接受率低 = 页面结构部分变化,严重缺数不能以 ok 状态流向下游(Codex headlines-r2)
    ar = result.get("accept_rate")
    if isinstance(ar, (int, float)) and ar < ACCEPT_RATE_MIN:
        deg.append(f"river 解析接受率仅 {ar:.0%}(候选行 {(result.get('drops') or {}).get('candidate_rows')}),疑似结构部分变化")
    if not items:
        deg.append(f"窗口 {result.get('window_hours')} 小时内零条(凌晨 / 假日可能真没有,不是故障)")
    status = "partial" if deg else "ok"
    return out(evs, extra={"source": "techmeme", "source_used": result.get("source_used"), "window_hours": result.get("window_hours"),
                           "tags": tags, "keywords": kw_flat, "scored": scored, "relevant_count": rel_total,
                           "dropped_items": dropped, "hits_dropped": hits_dropped, "context_only_dropped": cands_dropped,
                           "drops": result.get("drops") or {},
                           "accept_rate": result.get("accept_rate"), "context_only_total": result.get("context_only_total"),
                           "warnings": warns, "guard": guard},
               status=status, degraded=";".join(deg) if deg else None)
