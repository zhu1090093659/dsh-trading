"""管制与准入(第 14 层)mapper。每条证据的 note 都带读法护栏;状态值:on_list / not_on_list / removed / undetermined(undetermined ≠ not_on_list)。"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import today_str  # noqa: E402
from sources.mappers import ev, out  # noqa: E402

POLICY_GUARD = "读法:管制与准入与供需正交,只当打折项、不重排名次;没被点名 ≠ 不受影响(FCC 整类禁令不点名);'被建议列入' ≠ '已列入',只认联邦公报原文;undetermined ≠ 不在名单上"
CN_GUARD = "读法:中方侧只有新发布的公告事件流、看不到现行清单全貌,不能用它的沉默证明某物项不受管制"


def policy_access_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    day = result.get("checked_at") or today_str()
    evs = []
    name = result.get("english_name") or ""
    errs = dict(result.get("errors") or {})
    evs.append(ev(ctx, "policy_english_name", name or "(巨潮未返回)", "text", day, currency="n/a", as_of=day, raw_ref=result.get("english_name_raw_ref") or result.get("errors_raw_ref"),
                  note=f"source=cninfo F001V;aliases={result.get('aliases')};{'无一手英文名 → 美方名单判断不了(undetermined)' if not name else ''};{POLICY_GUARD}"))
    d = result.get("dod_1260h")
    if d:
        # 状态证据指向**决定状态的那份通知**(基线,或改变状态的后续通知);基线信息进 note
        dd, dp, dr = d.get("decision_doc") or d.get("doc"), d.get("decision_date") or d.get("published") or day, d.get("decision_raw_ref") or d.get("raw_ref")
        later = ";".join(f"{x.get('doc')}@{x.get('date')}" for x in (d.get("later_docs") or [])) or "无"
        evs.append(ev(ctx, "policy_1260h_status", d["status"], "status", dp, currency="n/a", as_of=day, record_key=dd, raw_ref=dr,
                      note=f"fr_doc={dd};published={dp};title={str(d.get('decision_title') or d.get('title'))[:80]};url={d.get('decision_url') or d.get('url')};baseline_doc={d.get('doc')}@{d.get('published')};matched={d.get('matched')};reason={d.get('reason')};later_docs={later};search_truncated={d.get('search_truncated')};text_chars={d.get('text_chars')};判定=基线通知全文检索别名+后续通知按日期应用;{POLICY_GUARD}"))
        if d.get("context"):
            evs.append(ev(ctx, "policy_1260h_context", d["context"], "text", dp, currency="n/a", as_of=day, record_key=dd, raw_ref=dr, note=f"fr_doc={dd};通知全文里含别名的规范化片段;{POLICY_GUARD}"))
    b = result.get("bis")
    if b:
        # 状态先行(mentioned / search_hit_unconfirmed / not_mentioned / undetermined);计数只在 mentioned / not_mentioned 时有意义 —— undetermined / unconfirmed 不出 "0 条"(Codex policy-r2)
        evs.append(ev(ctx, "policy_bis_status", b.get("status"), "status", day, currency="n/a", as_of=day, raw_ref=b.get("raw_ref"),
                      note=f"api_count={b.get('api_count')};retrieved={b.get('retrieved')};unconfirmed={len(b.get('unconfirmed') or [])};truncated={b.get('truncated')};联邦公报 BIS 规则按公司英文名精确短语检索并拉原文本地复核;只有 not_mentioned 才能写'未提及',undetermined / search_hit_unconfirmed 都不是阴性;{POLICY_GUARD}"))
        if b.get("status") in ("mentioned", "not_mentioned"):
            evs.append(ev(ctx, "policy_bis_confirmed_mentions_count", len(b.get("mentions") or []), "条", day, currency="n/a", as_of=day, raw_ref=b.get("raw_ref"),
                          note=f"status={b.get('status')};count 只计原文已确认的规则;{POLICY_GUARD}"))
        for m in (b.get("mentions") or [])[:10]:
            evs.append(ev(ctx, "policy_bis_mention", str(m.get("title"))[:200], "text", m.get("date") or day, currency="n/a", as_of=day, record_key=m.get("doc"), raw_ref=m.get("doc_raw_ref") or b.get("raw_ref"),
                          note=f"fr_doc={m.get('doc')};url={m.get('url')};alias={m.get('alias')};context={str(m.get('context'))[:120]};是 BIS 规则原文提及了公司名,不等于列入实体清单,要读原文;{POLICY_GUARD}"))
    f = result.get("fcc")
    if f:
        evs.append(ev(ctx, "policy_fcc_covered_by_name", f["status"], "status", day, currency="n/a", as_of=day, raw_ref=f.get("raw_ref"),
                      note=f"matched={f.get('matched')};entries={f.get('n')};class_bans={f.get('n_class_bans')};as_of={f.get('as_of')};只回答'有没有被点名',整类禁令按非美国产覆盖不点名;{POLICY_GUARD}"))
        evs.append(ev(ctx, "policy_fcc_entries_count", f.get("n"), "条", day, currency="n/a", as_of=day, raw_ref=f.get("raw_ref"), note=f"class_bans={f.get('n_class_bans')};as_of={f.get('as_of')};{POLICY_GUARD}"))
    if result.get("cn_side"):
        evs.append(ev(ctx, "policy_cn_side_status", "not_connected", "status", day, currency="n/a", as_of=day, raw_ref=result.get("cn_side_raw_ref"), note=f"{result['cn_side']};{CN_GUARD}"))
    mo = result.get("mofcom")
    if mo:
        for n in (mo.get("notices") or [])[:8]:
            evs.append(ev(ctx, "policy_mofcom_notice", n["title"], "text", n.get("date") or day, currency="n/a", as_of=day, record_key=n["url"][-60:], raw_ref=mo.get("raw_ref"), note=f"url={n['url']};{CN_GUARD}"))
    reasons = []
    if not name:
        reasons.append("无一手英文名(巨潮 F001V 未返回)→ 1260H / BIS / FCC 判断不了(undetermined),不等于不在名单上")
    if errs:
        reasons.append("端口失败:" + "; ".join(f"{k}={v}" for k, v in errs.items())[:200])
    if d and d.get("status") == "undetermined" and name:
        reasons.append(f"1260H undetermined:{d.get('reason')}")
    status, degraded = ("partial", " | ".join(reasons)) if reasons else ("ok", None)
    return out(evs, extra={"english_name": name, "aliases": result.get("aliases"), "errors": errs, "guard": POLICY_GUARD, "cn_guard": CN_GUARD}, status=status, degraded=degraded)
