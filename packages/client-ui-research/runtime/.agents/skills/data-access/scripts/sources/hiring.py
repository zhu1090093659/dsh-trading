"""招聘信号(注册表第 17 层):产业**锚点公司**的公开在招岗位 —— 需求侧与技术路线的领先信号。

看板信息源移植第 7 项(2026-08-24)。为什么招聘算领先信号:招聘往往比财报早几个月暴露战略 ——
在哪扩、招什么方向、招到哪个阶段(出现产线 / 量产 / 质检 / 夜班岗 ≈ 离量产更近)。

数据源:公司官方 ATS 的**公开 job board API**(零鉴权、无登录、只读岗位不碰简历):
  - Greenhouse `boards-api.greenhouse.io/v1/boards/<slug>/jobs`
  - Ashby     `api.ashbyhq.com/posting-api/job-board/<slug>`
⛔ NVIDIA / Coherent / Lumentum / Marvell / Micron 等走 Workday,需要 host+tenant+site 三段配置、
   且各家不同,**不是零配置**,本层不收(缺就如实写"未接入",不拿别的公司顶替)。

🔴 读法护栏(原样进证据 note,报告里必须与数字同段):
  - 岗位数是**招聘意图不是产能**,受招聘节奏 / HR 批次 / 冻结与解冻影响,单点数字几乎没有意义,看**变化**;
  - 这些是**锚点公司**(产业链上下游 / 需求侧),**不是本公司**的数据,不得写成本公司的经营事实;
  - 不同 ATS 的"岗位"口径不同(有的按 requisition 有的按 posting),**只在同一家公司内部比较**,不跨公司比大小。

纪律:逐家隔离失败(某家 slug 失效不影响别家),全失败才抛;解析不出岗位数组 = 结构变了必须抛;
      锚点清单来自 `industry_tags.json` 的 `hiring_anchors`(与温度计同一处配置),标签没配 → 如实"未配置"。
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from sources._http import record_raw

GREENHOUSE = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
ASHBY = "https://api.ashbyhq.com/posting-api/job-board/{slug}"
BJ_TZ = ZoneInfo("Asia/Shanghai")
HIRING_GUARD = ("读法:岗位数是招聘意图不是产能,受招聘节奏与 HR 批次影响,单点数字意义有限、看变化;"
                "这些是产业链锚点公司不是本公司数据;不同 ATS 口径不同,只在同一家公司内部比较,不跨公司比大小")

# 角色桶。**桶名只说"标题命中了什么词",不说"公司在干什么"**(Codex hiring-r2:叫"量产制造"会被读成量产信号,
# 但 manufacturing / test engineer / operations 在研究型公司未必是量产)。code 是 ASCII 短码 —— record_key 要能过
# 温度计历史序列的形状约束 `^[A-Za-z0-9:._x-]{1,32}$`(现在 bucket 不进序列,但别埋雷)。
ROLE_BUCKETS = {
    "mfg":     {"label": "制造 / 运营相关标题命中", "kw": ["manufacturing", "production", "process engineer", "test engineer", "industrial", "supply chain", "operations engineer", "yield"]},
    "optical": {"label": "光与互连相关标题命中", "kw": ["optical", "photonic", "photonics", "silicon photonics", "laser", "transceiver", "interconnect", "serdes", "signal integrity"]},
    "hw":      {"label": "封装与硬件相关标题命中", "kw": ["packaging", "hardware engineer", "asic", "physical design", "thermal", "power delivery", "board design"]},
    "infra":   {"label": "算力与基础设施相关标题命中", "kw": ["data center", "datacenter", "infrastructure", "cluster", "gpu", "accelerator", "compute platform"]},
}
# "量产临近"这类推断**不能**只靠标题词:需要产线 / 良率 / 夜班 / 质检等组合证据 —— 护栏里写明,判定也查。
BUCKET_GUARD = "桶名只表示标题命中了哪类词,不表示公司在做该事;「量产临近」需产线 / 良率 / 夜班 / 质检等组合证据,不能由标题词推断"


class HiringError(RuntimeError):
    pass


def _sh_today(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(BJ_TZ)).strftime("%Y-%m-%d")


def _repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", ".."))


def active_anchors(out_dir: Optional[str]) -> tuple[list[dict], list[str], list[str], list[str]]:
    """(锚点清单, 命中标签, 告警)。锚点来自 industry_tags.json 的 hiring_anchors(与温度计同一处配置)。"""
    warns: list[str] = []
    if not out_dir:
        return ([], [], ["无 out_dir:拿不到本次命中的产业标签,不取招聘信号"], [])
    ind = os.path.join(out_dir, "fetch", "_industry.json")
    if not os.path.exists(ind):
        return ([], [], ["运行目录没有 fetch/_industry.json(未经产业门控?):不取招聘信号"], [])
    with open(ind, encoding="utf-8") as f:
        tags = list((json.load(f) or {}).get("tags") or [])
    with open(os.path.join(_repo_root(), "datasources", "industry_tags.json"), encoding="utf-8") as f:
        table = (json.load(f) or {}).get("tags") or {}
    by_key: dict = {}
    skipped: list[str] = []
    for t in tags:
        got = (table.get(t) or {}).get("hiring_anchors") or []
        if not got:
            warns.append(f"标签 {t} 没有 hiring_anchors:该标签的锚点未接入(不是零岗位)")
        for a in got:
            if not all(a.get(k) for k in ("ats", "slug", "name")):
                skipped.append(f"{a.get('ats') or '?'}:{a.get('slug') or '?'}")
                warns.append(f"标签 {t} 有锚点缺 ats / slug / name,已跳过")
                continue
            if a["ats"] not in ("greenhouse", "ashby"):
                # 跳过也要计入"应有锚点",否则覆盖率会显示 1/1 把配置缺失掩盖掉(Codex hiring-r3)
                skipped.append(f"{a['ats']}:{a['slug']}")
                warns.append(f"锚点 {a.get('name')} 的 ats={a['ats']} 不在白名单(只支持 greenhouse / ashby;Workday 系需三段配置),未接入")
                continue
            key = (a["ats"], a["slug"])
            if key in by_key:
                by_key[key]["tags"].append(t)          # 同一锚点被多个标签引用 → 聚合 tags(不只留第一个 —— Codex hiring-r2)
            else:
                by_key[key] = {**a, "tags": [t]}
    return (list(by_key.values()), tags, warns, sorted(set(skipped)))


def _get(url: str, timeout: int = 20) -> bytes:
    """只取原始字节 —— **不在这里解析**。JSON 坏掉时那份响应正是最该留证的东西,
    在这里 json.loads 会让它在 record_raw 之前就抛掉(Codex hiring-r3 抓到:上一版"先落盘"名不副实)。"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def _titles(ats: str, payload: object) -> list[str]:
    """→ 岗位标题列表。结构不符 = 结构变了,抛(不当"零岗位")。"""
    if ats == "greenhouse":
        jobs = (payload or {}).get("jobs") if isinstance(payload, dict) else None
        if not isinstance(jobs, list):
            raise HiringError("Greenhouse 响应缺 jobs 数组(结构变了)")
        return [str(j.get("title") or "") for j in jobs if isinstance(j, dict)]
    if ats == "ashby":
        jobs = (payload or {}).get("jobs") if isinstance(payload, dict) else None
        if not isinstance(jobs, list):
            raise HiringError("Ashby 响应缺 jobs 数组(结构变了)")
        return [str(j.get("title") or "") for j in jobs if isinstance(j, dict)]
    raise HiringError(f"未知 ATS:{ats}")


RECORD_KEY_MAX = 32   # 与温度计历史序列的形状约束一致(hiring_open_roles 进序列,键太长会静默不可比)


BUCKET_SUFFIX_MAX = max(len(c) for c in ("mfg", "optical", "hw", "infra")) + 1   # ":optical" = 8


def record_key_for(ats: str, slug: str, bucket: str = "") -> str:
    """`ats:slug`(可选 `:桶码`)。**基础键要给桶后缀预留空间** —— 只保基础键不超限,追加桶码后照样会越界
    (Codex hiring-r4:slug 29 字符 + ":optical" = 37)。超限一律用稳定短哈希,原 slug 仍写在 note 里。"""
    import hashlib
    budget = RECORD_KEY_MAX - BUCKET_SUFFIX_MAX
    base = f"{ats}:{slug}"
    if len(base) > budget:
        base = f"{ats}:{hashlib.sha256(slug.encode()).hexdigest()[:12]}"
        if len(base) > budget:   # 连 ats 本身都太长(理论情形):整体哈希
            base = hashlib.sha256(f"{ats}:{slug}".encode()).hexdigest()[:budget]
    key = f"{base}:{bucket}" if bucket else base
    assert len(key) <= RECORD_KEY_MAX, key
    return key


def _bucket(titles: list[str]) -> dict:
    """标题关键词分桶(纯 ASCII 词边界);**按岗位计数**,一个岗位可进多个桶,互不排斥。"""
    out = {k: 0 for k in ROLE_BUCKETS}
    for t in titles:
        low = t.lower()
        for code, spec in ROLE_BUCKETS.items():
            if any(re.search(rf"(?<![a-z0-9]){re.escape(k)}(?![a-z0-9])", low) for k in spec["kw"]):
                out[code] += 1
    return out


def hiring_anchor_signal(out_dir: Optional[str] = None, now: Optional[datetime] = None) -> dict:
    """按产业标签取锚点公司公开在招岗位:总数 + 角色桶。逐家隔离失败,全失败才抛。"""
    today = _sh_today(now)
    anchors, tags, warns, skipped = active_anchors(out_dir)
    if not anchors:
        # 没有可用锚点不是故障(标签未配置 / 未经门控):如实返回空,由 mapper 降级出声
        return {"today": today, "tags": tags, "items": [], "errors": [], "warnings": warns,
                "anchors_expected": len(skipped), "anchors_ok": 0, "anchors_failed": list(skipped),
                "guard": HIRING_GUARD, "bucket_guard": BUCKET_GUARD}
    items, errors = [], []
    failed = list(skipped)          # 白名单跳过的也算"应有但没拿到"
    for a in anchors:
        url = (GREENHOUSE if a["ats"] == "greenhouse" else ASHBY).format(slug=a["slug"])
        raw_ref = None
        try:
            body = _get(url)
            # **先落盘再解析**(Codex hiring-r2/r3):结构变化时最需要复核的就是这份响应,任何解析都要在落盘之后
            raw_ref = record_raw(body, "json", url)
            titles = _titles(a["ats"], json.loads(body))
            items.append({"name": a["name"], "slug": a["slug"], "ats": a["ats"], "tags": a.get("tags") or [],
                          "role": a.get("role") or "", "open_roles": len(titles), "buckets": _bucket(titles),
                          # 200 但零岗位:分不清"真没在招"与"slug 已废弃",首次观测标 unverified(Codex hiring-r2),
                          # 由 mapper 写进 note、判定禁止据此推"招聘冻结"
                          "zero_unverified": len(titles) == 0, "raw_ref": raw_ref})
        except Exception as e:  # noqa: BLE001 — 逐家隔离
            failed.append(f"{a['ats']}:{a['slug']}")
            errors.append(f"{a['name']}({a['ats']}/{a['slug']}): {type(e).__name__}: {str(e)[:140]}"
                          + (f";raw_ref={raw_ref}" if raw_ref else ";raw_ref=无(传输层就失败)"))
    if not items:
        raise HiringError("锚点招聘信号全部失败:" + "; ".join(errors))
    return {"today": today, "tags": tags, "items": items, "errors": errors, "warnings": warns,
            "anchors_expected": len(anchors) + len(skipped), "anchors_ok": len(items), "anchors_failed": failed,
            "guard": HIRING_GUARD, "bucket_guard": BUCKET_GUARD}
