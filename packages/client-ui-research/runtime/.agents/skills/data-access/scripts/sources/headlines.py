"""海外科技头条(注册表第 16 层):Techmeme river 时间流 —— 需求侧一手线索,按**产业标签**筛相关。

看板信息源移植第 6 项(2026-08-24)。为什么是 river 不是 RSS:river 是倒序时间线 + 分钟级时间戳,
实测一页 165 条覆盖约 5 天;RSS 只有 15 条(只作兜底,且**兜底时必须出声**,不能让窗口内条目凭空消失)。

🔴 与第 12 层市场声音同一纪律(这是**不可信文本**):
  - 头条是**线索不是事实**:标题里的数字一律不得写成事实,动作措辞(买入 / 目标价)经 textsafe 脱敏;
  - 只作需求侧印证 / 反证,不得单独推出本公司结论;
  - 每条带 时间(北京)/ 来源刊名 / 原标题 / 链接,链接只进附录不进正文。

相关性:**不硬编码任何个人关键词表** —— 从运行目录的 `fetch/_industry.json`(编排器按产业标签门控时写的)
拿到本次命中的标签,再从 `datasources/industry_tags.json` 读该标签的 `headline_keywords`。
标签表缺 headline_keywords → 该标签不贡献关键词;一个关键词都没有 → 不做相关性标注(全部记为 unscored,如实出声),
**绝不退回"全都相关"或"随便挑几条"**。
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from html import unescape
from typing import Optional
from zoneinfo import ZoneInfo

from sources._http import http_text, last_raw_ref
from sources.textsafe import neutralize_actions

RIVER_URL = "https://www.techmeme.com/river"
RSS_URL = "https://www.techmeme.com/feed.xml"
ET_TZ = ZoneInfo("America/New_York")
BJ_TZ = ZoneInfo("Asia/Shanghai")
MAX_ITEMS = 400          # 防爆上限(真正的边界是时间窗口);触顶必须出声
DEFAULT_WINDOW_HOURS = 48
HEADLINE_GUARD = ("读法:海外科技头条是**线索不是事实**,标题里的数字不得写成事实;"
                  "只作需求侧印证 / 反证,不得单独推出本公司结论;相关性按产业标签关键词标注,不是编辑判断")


class HeadlineError(RuntimeError):
    pass


def _repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", ".."))


def active_keywords(out_dir: Optional[str]) -> tuple[dict, list[str], list[str], bool]:
    """→ (关键词表, 命中标签, 告警, 是否已标注)。关键词表 = {"strong": [...], "context": [...], "anchor": [...]}。
    strong 单独命中即算相关;context 是泛词(OpenAI / capex / networking…),**必须与 anchor 共现**才算 —— 否则
    "Startup accelerator expands its networking program" 这种会被误判成算力线索(Codex headlines-r1)。
    scored=False 表示本次没有可用关键词(未标注 unscored ≠ 不相关),调用方据此降级出声。"""
    warns: list[str] = []
    empty: dict = {"strong": [], "context": [], "anchor": []}
    if not out_dir:
        return (empty, [], ["无 out_dir:拿不到本次命中的产业标签,不做相关性标注"], False)
    ind_path = os.path.join(out_dir, "fetch", "_industry.json")
    if not os.path.exists(ind_path):
        return (empty, [], ["运行目录没有 fetch/_industry.json(未经产业门控?):不做相关性标注"], False)
    with open(ind_path, encoding="utf-8") as f:
        tags = list((json.load(f) or {}).get("tags") or [])
    table_path = os.path.join(_repo_root(), "datasources", "industry_tags.json")
    with open(table_path, encoding="utf-8") as f:
        table = (json.load(f) or {}).get("tags") or {}
    # 关键词**按标签分组**:泛词只能与**同一标签**的锚词共现(全局合并会让 A 标签的泛词配上 B 标签的锚词 —— Codex headlines-r2)
    groups: list[dict] = []
    for t in tags:
        td = table.get(t) or {}
        g = {
            "tag": t,
            "strong": sorted({str(k) for k in (td.get("headline_keywords") or []) if str(k).strip()}),
            "context": sorted({str(k) for k in (td.get("headline_context_keywords") or []) if str(k).strip()}),
            "anchor": sorted({str(k) for k in (td.get("headline_anchor_keywords") or []) if str(k).strip()}),
        }
        if not g["strong"]:
            warns.append(f"标签 {t} 没有 headline_keywords,不贡献强词(配置缺口)")
        if g["context"] and not g["anchor"]:
            warns.append(f"标签 {t} 配了泛词却没有锚词:泛词永远不可能命中,按未配置处理(配置缺口)")
        groups.append(g)
    kws: dict = {"groups": groups,
                 "strong": sorted({k for g in groups for k in g["strong"]}),
                 "context": sorted({k for g in groups for k in g["context"]}),
                 "anchor": sorted({k for g in groups for k in g["anchor"]})}
    # scored 的条件:有强词,或(泛词与锚词**同组**都在)。只配泛词不配锚词 = 永远零命中,那不叫"已标注"(Codex headlines-r2)
    scored = any(g["strong"] or (g["context"] and g["anchor"]) for g in groups)
    if tags and not scored:
        warns.append("命中了产业标签但没有可用关键词组合:配置漂移,本次不做相关性标注")
    return (kws, tags, warns, scored)


def _hits(title: str, words: list[str]) -> list[str]:
    """纯 ASCII(含空格的多词)按词边界,其余按子串。"""
    low = title.lower()
    out = []
    for k in words:
        kk = k.lower()
        if re.fullmatch(r"[a-z0-9 ]+", kk):
            if re.search(rf"(?<![a-z0-9]){re.escape(kk)}(?![a-z0-9])", low):
                out.append(k)
        elif kk in low:
            out.append(k)
    return out


def _match(title: str, kws: dict) -> tuple[list[str], list[str]]:
    """→ (命中词, 仅泛词候选词)。strong 命中即算;context 必须与**同标签**的 anchor 共现才算命中;
    只命中泛词的记为候选(context_only)——不算相关,但要留痕,不然真线索会无声消失(Codex headlines-r2)。"""
    hit, cand = [], []
    for g in kws.get("groups") or []:
        st = _hits(title, g.get("strong") or [])
        if st:
            hit.extend(st)
            continue
        ctx = _hits(title, g.get("context") or [])
        if not ctx:
            continue
        anch = _hits(title, g.get("anchor") or [])
        if anch:
            hit.extend(f"{c}+{anch[0]}" for c in ctx)
        else:
            cand.extend(ctx)
    return (sorted(set(hit)), sorted(set(cand)))


def _to_bj(dt: datetime) -> tuple[str, bool]:
    """→ (北京时间 ISO, 是否落在 DST 歧义 / 不存在的小时)。歧义时按 fold=0 取值但**如实标注**(Codex headlines-r1:回拨重复小时无法区分)。"""
    amb = dt.replace(fold=0).utcoffset() != dt.replace(fold=1).utcoffset()
    return (dt.astimezone(BJ_TZ).strftime("%Y-%m-%dT%H:%M:%S+08:00"), amb)


ROW_RE = re.compile(r'<tr[^>]*\bclass="[^"]*\britem\b[^"]*"[^>]*>(.*?)</tr>', re.I | re.S)  # 多 class / 属性换序都要认(Codex headlines-r1)
CITE_RE = re.compile(r"<cite[^>]*>(.*?)</cite>", re.I | re.S)   # cite 可带属性
ANCHOR_RE = re.compile(r"<a\b[^>]*\bhref=\"([^\"]+)\"[^>]*>(.*?)</a>", re.I | re.S)  # href 不必是第一个属性
MIN_TITLE_LEN = 12  # 只滤"仅刊名"这类极短锚点;丢了多少必须计数出声(原来 25 会误杀真短标题)


def _text(html: str) -> str:
    return unescape(re.sub(r"<[^>]+>", "", html)).strip()


def _parse_river(html: str) -> tuple[list[dict], dict]:
    """返回 (条目, 丢条原因计数)。每一类丢弃都计数 —— 静默丢一半是本层最危险的失败模式(Codex headlines-r1)。"""
    out, seen = [], set()
    drops = {"bad_time": 0, "bad_pml": 0, "bad_date": 0, "no_anchor": 0, "short_title": 0, "duplicate": 0, "no_cite": 0}
    rows = ROW_RE.findall(html)
    for row in rows:
        tm = re.search(r"<td[^>]*>\s*(\d{1,2}):(\d{2})\s*([AP])\.?M", row, re.I)   # 美东 H:MM AM/PM
        if not tm:
            drops["bad_time"] += 1
            continue
        pm = re.search(r'pml="(\d{2})(\d{2})(\d{2})', row)                          # 美东日期 YYMMDD
        if not pm:
            drops["bad_pml"] += 1
            continue
        hh, mm, ap = int(tm.group(1)), int(tm.group(2)), tm.group(3).upper()
        if ap == "P" and hh != 12:
            hh += 12
        if ap == "A" and hh == 12:
            hh = 0
        yy, mo, dd = pm.groups()
        try:
            et = datetime(2000 + int(yy), int(mo), int(dd), hh, mm, tzinfo=ET_TZ)
        except ValueError:
            drops["bad_date"] += 1
            continue
        iso, dst_flag = _to_bj(et)
        cite = CITE_RE.search(row)
        if not cite:
            # river 的每一行都有 <cite> 刊名;没有就是结构变了。**按长度猜标题会选到"Read discussion…"这类评论链接**
            # (Codex headlines-r2),宁可丢这一行并计数,也不猜。
            drops["no_cite"] += 1
            continue
        src = _text(cite.group(1)).rstrip(":").strip()
        after = row[cite.end():]          # 标题锚点在 </cite> 之后的第一个
        cands = [(u, _text(t)) for u, t in ANCHOR_RE.findall(after)]
        if not cands:
            drops["no_anchor"] += 1
            continue
        url, title = cands[0]
        if not title or not url:
            drops["no_anchor"] += 1
            continue
        if len(title) < MIN_TITLE_LEN:
            drops["short_title"] += 1
            continue
        if url in seen:
            drops["duplicate"] += 1
            continue
        seen.add(url)
        out.append({"title": title, "source": src[:60], "url": url, "published": iso, "dst_ambiguous": dst_flag})
    drops["candidate_rows"] = len(rows)
    return out, drops


def _parse_rss(xml: str) -> list[dict]:
    import xml.etree.ElementTree as ET
    root = ET.fromstring(xml)
    out = []
    for it in root.iter("item"):
        title = _text(it.findtext("title") or "")  # 与 river 同样去标签、解实体,两条入口给出同样的标题
        link = (it.findtext("link") or "").strip()
        pub = (it.findtext("pubDate") or "").strip()
        iso = ""
        try:
            from email.utils import parsedate_to_datetime
            dt = parsedate_to_datetime(pub)
            # 无时区的 pubDate 会被按**本机时区**解释 → 静默错时;一律当无时间戳(Codex headlines-r1)
            iso = _to_bj(dt)[0] if dt.tzinfo is not None and dt.utcoffset() is not None else ""
        except Exception:  # noqa: BLE001 — 解析失败按"无时间"处理,窗口裁剪时丢弃并计数
            iso = ""
        if title and link:
            out.append({"title": title, "source": "", "url": link, "published": iso, "dst_ambiguous": False})
    return out


def techmeme_headlines(window_hours: int = DEFAULT_WINDOW_HOURS, out_dir: Optional[str] = None,
                       now: Optional[datetime] = None, future_skew_hours: int = 2) -> dict:
    """Techmeme river(失败回退 RSS 并出声)→ 时间窗口裁剪 → 按产业标签关键词标注相关性。"""
    warns: list[str] = []
    degraded = None
    raw_ref = None
    drops: dict = {}
    try:
        html = http_text(RIVER_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=25, ext="html")
        raw_ref = last_raw_ref()
        items, drops = _parse_river(html)
        source_used = "river"
        if not items:
            raise HeadlineError(f"river 页面解析出 0 条(结构变了;HTML {len(html)} 字符;候选行 {drops.get('candidate_rows')})")
        # 接受率异常 = 页面结构部分变化,不能静默(Codex headlines-r1)
        cand = int(drops.get("candidate_rows") or 0)
        accept_rate = (len(items) / cand) if cand else None
        if cand and len(items) < cand * 0.5:
            warns.append(f"river 候选行 {cand} 只解析出 {len(items)} 条(接受率 {len(items) / cand:.0%}),疑似结构部分变化:{ {k: v for k, v in drops.items() if k != 'candidate_rows' and v} }")
        elif any(v for k, v in drops.items() if k not in ("candidate_rows", "duplicate", "no_cite") and v):
            warns.append(f"解析丢弃:{ {k: v for k, v in drops.items() if k not in ('candidate_rows',) and v} }")
    except Exception as e:  # noqa: BLE001 — river 失败回退 RSS,但必须出声(RSS 只有 15 条,窗口会不完整)
        warns.append(f"river 失败,回退 RSS(只有约 15 条,窗口可能不完整):{type(e).__name__}: {str(e)[:140]}")
        xml = http_text(RSS_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=25, ext="xml")
        raw_ref = last_raw_ref()
        items = _parse_rss(xml)
        source_used = "rss"
        degraded = warns[-1]
        if not items:
            raise HeadlineError("river 与 RSS 都解析不出条目(两个入口同时结构变化)") from e
    truncated = len(items) > MAX_ITEMS
    if truncated:
        warns.append(f"条目数 {len(items)} 触及防爆上限 {MAX_ITEMS},已截断(窗口可能不完整)")
        items = items[:MAX_ITEMS]
    now_bj = (now or datetime.now(BJ_TZ)).astimezone(BJ_TZ)
    cutoff = now_bj - timedelta(hours=window_hours)
    upper = now_bj + timedelta(hours=future_skew_hours)   # 窗口要有**上界**:超出的是错时 / 伪造,不能当"最新"(Codex headlines-r1)
    inwin, no_time, future, dst_amb = [], 0, 0, 0
    for it in items:
        if not it.get("published"):
            no_time += 1
            continue
        p = datetime.fromisoformat(it["published"])
        if p > upper:
            future += 1
            continue
        if p >= cutoff:
            if it.get("dst_ambiguous"):
                dst_amb += 1
            inwin.append(it)
    if no_time:
        warns.append(f"{no_time} 条无时间戳(或时间无时区),已丢弃(不猜时间)")
    if future:
        warns.append(f"{future} 条发布时间超出当前时刻 +{future_skew_hours} 小时,已丢弃(错时或伪造)")
    if dst_amb:
        warns.append(f"{dst_amb} 条落在美东夏令时切换的歧义 / 不存在小时,已按 fold=0 换算(时间可能差 1 小时)")
    keywords, tags, kw_warns, scored = active_keywords(out_dir)
    warns.extend(kw_warns)
    for it in inwin:
        it["title_safe"] = neutralize_actions(it["title"])          # 动作措辞脱敏(与市场声音层同一函数)
        hit, context_hits = _match(it["title"], keywords) if scored else ([], [])
        it["matched"] = hit
        it["context_only"] = context_hits                                    # 泛词命中但没锚词:候选,不算相关但留痕
        it["relevant"] = bool(hit) if scored else None               # 未标注 → None(不是 False)
    return {
        "checked_at": now_bj.strftime("%Y-%m-%dT%H:%M:%S+08:00"), "window_hours": window_hours,
        "source_used": source_used, "raw_ref": raw_ref, "fetched_total": len(items), "in_window": len(inwin),
        "tags": tags, "keywords": keywords, "scored": scored, "items": inwin, "warnings": warns, "degraded": degraded,
        "truncated": truncated, "drops": drops, "dst_ambiguous": dst_amb,
        "accept_rate": (len(items) / int(drops["candidate_rows"])) if drops.get("candidate_rows") else None,
        "context_only_total": sum(1 for it in inwin if it.get("context_only")), "guard": HEADLINE_GUARD,
    }
