"""招聘信号(第 17 层)映射:每个锚点公司一条总数证据 + 每个非零角色桶一条证据;护栏原样进 note。

口径:
  - 锚点是**产业链上下游 / 需求侧公司,不是本公司** → 全市场证据 symbol="MARKET"、公司放 record_key(与大宗同规矩)。
  - 岗位数是**意图不是产能**,单点意义有限;`history_fields` 让温度计历史序列在下次运行给出跨运行 delta。
  - 标签没配锚点 / 未经门控 → 没有条目:降 partial 并写明"**未接入 ≠ 零岗位**"。
"""
from __future__ import annotations

from sources.hiring import ROLE_BUCKETS, record_key_for
from sources.mappers import ev, out


def hiring_anchor_signal_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    today = str(result.get("today") or "")
    guard = str(result.get("guard") or "")
    bguard = str(result.get("bucket_guard") or "")
    items = result.get("items") or []
    expected = int(result.get("anchors_expected") or 0)
    okn = int(result.get("anchors_ok") or 0)
    failed = result.get("anchors_failed") or []
    evs = []
    for it in items:
        rk = record_key_for(it["ats"], it["slug"])   # 超长 slug 用短哈希,保证 record_key 能进历史序列
        ictx = {**ctx, "symbol": "MARKET", "market": "US"}
        tagtxt = ",".join(it.get("tags") or [])
        base = f"{it['name']}({it.get('role') or '锚点'};{it['ats']} 公开 job board)当前公开在招岗位数"
        zero = ("⚠️ 本次为 0:分不清「确实没在招」与「slug 已废弃 / 迁移」,**未经核实的零值**,"
                "不得据此推「招聘冻结 / 收缩」,需连续多期确认;" if it.get("zero_unverified") else "")
        evs.append(ev(ictx, "hiring_open_roles", it["open_roles"], "个", today, currency="n/a", as_of=today,
                      record_key=rk, raw_ref=it.get("raw_ref"),
                      note=f"{base}(slug={it['slug']});产业标签={tagtxt};{zero}锚点覆盖 {okn}/{expected} 家"
                           + (f"(缺:{','.join(failed)})" if failed else "") + f";{guard}"))
        for code, n in (it.get("buckets") or {}).items():
            if not n:
                continue
            label = (ROLE_BUCKETS.get(code) or {}).get("label", code)
            evs.append(ev(ictx, "hiring_role_bucket", n, "个", today, currency="n/a", as_of=today,
                          record_key=record_key_for(it["ats"], it["slug"], code),   # 含桶后缀一起限长
                          raw_ref=it.get("raw_ref"),
                          note=f"{it['name']}(slug={it['slug']})标题命中「{label}」的岗位数(纯标题关键词、按岗位计数);"
                               f"占其 {it['open_roles']} 个在招岗位;锚点覆盖 {okn}/{expected} 家"
                               + (f"(缺:{','.join(failed)})" if failed else "")
                               + f";{bguard};{guard}"))
    errors = result.get("errors") or []
    warns = list(result.get("warnings") or [])
    deg = []
    if errors:
        deg.append(f"锚点覆盖 {okn}/{expected}(缺 {','.join(failed)}):" + "; ".join(errors)[:180])
    elif failed:
        # 白名单跳过(如 Workday)不产生 errors,但覆盖率确实缩水了,一样要出声(Codex hiring-r3)
        deg.append(f"锚点覆盖 {okn}/{expected}:{','.join(failed)} 未接入(**未接入 ≠ 零岗位**)")
    if any(it.get("zero_unverified") for it in items):
        deg.append("有锚点返回 0 岗位且未经核实(可能是 slug 废弃),不得读成招聘冻结")
    if not items:
        deg.append("本次没有可用锚点(标签未配置 hiring_anchors 或未经产业门控):**未接入 ≠ 零岗位**")
    # 有任何降级理由(锚点缺失 / 未经核实的零值 / 无锚点)一律 partial —— 别让"看着 ok"的信封把问题带过去。
    # **没有条目一律 partial 不是 failed**:产业门控没命中标签是真实状态,不是数据源故障;
    # 真正的抓取全失败由源层抛 HiringError 表达(Codex hiring-r5)。
    status = "partial" if deg or not items else "ok"
    return out(evs, extra={"source": "ats-public(greenhouse/ashby)", "tags": result.get("tags") or [],
                           "anchors_expected": expected, "anchors_ok": okn, "anchors_failed": failed,
                           "errors": errors, "warnings": warns, "guard": guard, "bucket_guard": bguard},
               status=status, degraded=";".join(deg) if deg else None)
