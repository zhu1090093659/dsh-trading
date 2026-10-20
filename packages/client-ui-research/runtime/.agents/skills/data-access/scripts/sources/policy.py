"""管制与准入(注册表第 14 层):美方名单**状态**(1260H 中国军事企业清单 / BIS 实体清单规则 / FCC Covered List)+ 中方反制侧**事件流**(商务部出口管制公告)。

移植自 产业挖掘-Scan-claude_V2/tools/policy_access.py(2026-08-23),读法护栏原样带过来:
  - 这根轴与供需正交:不改变产能 / 订单,改变的是"谁被允许卖到美国" → **只当打折项,不重排名次**;
  - **判定以联邦公报通知全文检索为准**,不以抽取出的实体列表为准(抽漏一条就把"在名单上"判成"不在名单上",假阴性最危险);
  - **没有一手英文名(巨潮 F001V)只能说 undetermined,不能说 not_on_list**;
  - 没被点名 ≠ 不受影响:FCC 那几条整类禁令按"非美国产"覆盖,根本不点公司名;
  - 媒体常把"被建议列入"写成"已列入",两者法律后果完全不同 → 只认联邦公报原文与 FCC 官网;
  - 两侧口径不对称:美方三个端口是全量名单状态,中方端口只是新发布的公告事件流 → **不能用中方侧的沉默证明某物项不受管制**。
零鉴权:联邦公报 API / 巨潮 companyOverview(要 Referer);FCC 与商务部经 r.jina.ai(免 key,20/min,要 curl 风格 UA)。
"""
from __future__ import annotations

import html
import json
import re
import unicodedata
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

from sources._http import http_get, record_raw

FR_API = "https://www.federalregister.gov/api/v1/documents.json"
CNINFO_OVERVIEW = "http://www.cninfo.com.cn/data20/companyOverview/getCompanyIntroduction?scode={code}"
FCC_URL = "https://www.fcc.gov/supplychain/coveredlist"
MOFCOM_URL = "http://exportcontrol.mofcom.gov.cn/articleList.shtml?columnID=15&num=1"
JINA = "https://r.jina.ai/"
JINA_HEADERS = {"User-Agent": "curl/8.4.0", "Accept": "text/plain"}  # 浏览器 UA 会触发 Cloudflare 挑战
MIN_ALIAS_LEN = 8  # 去后缀短名 < 8 字符不单独用(撞别家)
FR_MAX_PAGES = 5
BIS_CONFIRM_MAX = 5  # 最多拉 5 份 BIS 规则原文做本地复核
_SUFFIX_RE = re.compile(r",?\s*(Co\.?,?\s*Ltd\.?|Company Limited|Corporation|Corp\.?|Inc\.?|Limited|Ltd\.?|Group Co\.?,?\s*Ltd\.?|Group)\s*$", re.I)
_SUFFIX_TOKEN_RE = re.compile(r"\b(co|ltd|company|corporation|corp|inc|limited|group|holdings?)\b", re.I)


class PolicyError(RuntimeError):
    pass


def norm_text(s: str) -> str:
    """匹配用规范形:NFKC、标签 / 实体 → 空格、法律后缀与标点折叠(Co., Ltd. / Co. Ltd / Co.,Ltd / Company Limited → 'co ltd')、空白折叠、小写。
    换行 / NBSP / 跨行公司名都折成单空格,所以 'Zhongji\\nInnolight Co.,Ltd.' 也能命中。"""
    t = unicodedata.normalize("NFKC", html.unescape(str(s or "")))
    t = re.sub(r"<[^>]+>", " ", t)
    t = t.replace(" ", " ")
    t = re.sub(r"company\s+limited", " co ltd ", t, flags=re.I)
    t = re.sub(r"[.,;:'\"()\[\]{}/\\|—–\-]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip().lower()
    return t


def html_to_text(raw: str) -> str:
    """全文检索用:去标签时补空格,避免 '</p>Zhongji' 粘连;保留换行供取原句。"""
    t = html.unescape(raw)
    t = re.sub(r"<br\s*/?>|</p>|</div>|</li>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = t.replace(" ", " ")
    return re.sub(r"[ \t]+", " ", t)


def _fr_search(page: int = 1, **conditions) -> dict:
    """联邦公报文档检索(零鉴权,每页 20)。0 结果时 API 不带 results 键(实测)。"""
    q = [("per_page", "20"), ("order", "newest"), ("page", str(page))]
    for f in ("title", "publication_date", "document_number", "raw_text_url", "html_url", "agencies"):
        q.append(("fields[]", f))
    for k, v in conditions.items():
        for x in (v if isinstance(v, (list, tuple)) else [v]):
            q.append((k, x))
    r = http_get(FR_API + "?" + urllib.parse.urlencode(q), timeout=40, ext="json")
    if r.status_code >= 400:
        raise PolicyError(f"联邦公报 API HTTP {r.status_code}")
    d = r.json()
    if not isinstance(d, dict) or "count" not in d:
        raise PolicyError("联邦公报 API 响应缺少 count(契约可能已变)")
    if d.get("count") == 0 and "results" not in d:
        d["results"] = []
    if not isinstance(d.get("results"), list):
        raise PolicyError("联邦公报 API 响应缺少 results 列表(契约可能已变)")
    d["_raw_ref"] = getattr(r, "_vra_raw_ref", None)
    return d


def _fr_search_all(conditions: dict[str, str], max_pages: int = FR_MAX_PAGES) -> tuple[list, int, bool, Optional[str]]:
    """翻页取全(最多 max_pages 页);返回 (results, api_count, truncated, first_raw_ref)。"""
    out, raw, count = [], None, 0
    for p in range(1, max_pages + 1):
        d = _fr_search(page=p, **conditions)
        raw = raw or d.get("_raw_ref")
        count = int(d.get("count") or 0)
        out.extend(d["results"])
        if len(out) >= count or not d["results"]:
            break
    return out, count, len(out) < count, raw


def cn_english_name(code: str) -> tuple[str, Optional[str]]:
    """巨潮法定英文名称(F001V)。取不到返回空串——**不猜**;非 JSON / 结构漂移 → 抛(不当作"没有英文名")。"""
    r = http_get(CNINFO_OVERVIEW.format(code=code), headers={"Referer": "http://www.cninfo.com.cn/"}, timeout=20, ext="json")
    raw = getattr(r, "_vra_raw_ref", None)
    if r.status_code >= 400:
        raise PolicyError(f"巨潮 companyOverview HTTP {r.status_code}")
    try:
        d = r.json()
    except Exception as e:  # noqa: BLE001
        raise PolicyError(f"巨潮 companyOverview 响应不是 JSON:{type(e).__name__}") from e
    if not isinstance(d, dict) or not isinstance(d.get("data"), dict) or not isinstance(d["data"].get("records"), list):
        raise PolicyError("巨潮 companyOverview 结构漂移(缺 data.records)")
    for rec in d["data"]["records"]:
        for rows in (rec or {}).values():
            for row in (rows or []):
                n = (row or {}).get("F001V") or ""
                if n and re.search(r"[A-Za-z]{4,}", n):
                    return n.strip(), raw
    return "", raw


def aliases_of(english_name: str) -> list[str]:
    """全名 + 去掉公司后缀的短名(≥ MIN_ALIAS_LEN 才用);去重保序。"""
    out: list[str] = []
    for a in [english_name.strip(), _SUFFIX_RE.sub("", english_name.strip()).strip(" ,.")]:
        if a and len(a) >= MIN_ALIAS_LEN and a.lower() not in [x.lower() for x in out]:
            out.append(a)
    return out


def _find_norm(text_norm: str, alias: str) -> Optional[int]:
    """规范形里按 token 边界找别名;返回位置或 None。"""
    a = norm_text(alias)
    if not a:
        return None
    m = re.search(r"(?<![a-z0-9_])" + re.escape(a) + r"(?![a-z0-9_])", text_norm)
    return m.start() if m else None


def match_entity(text: str, aliases: list[str]) -> dict:
    """实体匹配(三态):全名命中 → on;短名命中且 40 字符窗口内有公司后缀 token 或括号别名 → on;短名命中但无法确认同一性 → ambiguous;都无 → off。
    返回 {state: on|off|ambiguous, alias, context}。"""
    tn = norm_text(text)
    if not aliases:
        return {"state": "ambiguous", "alias": None, "context": None}
    full = aliases[0]
    pos = _find_norm(tn, full)
    if pos is not None:
        return {"state": "on", "alias": full, "context": tn[max(0, pos - 40):pos + len(norm_text(full)) + 60]}
    for a in aliases[1:]:
        pos = _find_norm(tn, a)
        if pos is None:
            continue
        # 短名只认**括号别名** "(Innolight)"(通知里官方给的简称);其余形态("Acme Innolight Holdings" / "Innolight Holdings Corp")
        # 都不能证明同一实体 → ambiguous → undetermined(Codex policy-r1:短名撞别家)。全名的不同写法由 norm_text 覆盖。
        paren = bool(re.search(r"\(\s*" + re.escape(a) + r"\s*\)", text, re.I))
        if paren:
            return {"state": "on", "alias": a, "context": tn[max(0, pos - 40):pos + len(norm_text(a)) + 60]}
        return {"state": "ambiguous", "alias": a, "context": tn[max(0, pos - 40):pos + len(norm_text(a)) + 60]}
    return {"state": "off", "alias": None, "context": None}


def _doc_text(doc: dict) -> tuple[str, Optional[str]]:
    r = http_get(doc["raw_text_url"], timeout=60, ext="html")
    if r.status_code >= 400:
        raise PolicyError(f"联邦公报文档 {doc.get('document_number')} 全文 HTTP {r.status_code}")
    text = html_to_text(r.text)
    if len(text) < 2000:
        raise PolicyError(f"联邦公报文档 {doc.get('document_number')} 全文异常短({len(text)} 字符)")
    return text, getattr(r, "_vra_raw_ref", None)


def fetch_1260h(aliases: list[str]) -> dict:
    """1260H 现行状态重建:基线 = 最新一版**完整指定通知**(标题含 designation 且不含 removal / correction / amend);
    之后发布的 removal / addition / correction 通知按日期依次应用;任何后续通知拉不到或分不清 → undetermined(禁止 not_on_list)。"""
    results, count, truncated, search_raw = _fr_search_all({"conditions[agencies][]": "defense-department", "conditions[term]": "Chinese military companies", "conditions[publication_date][gte]": "2023-01-01"})
    docs = [x for x in results if "chinese military compan" in (x.get("title") or "").lower()]
    docs.sort(key=lambda x: x.get("publication_date") or "", reverse=True)
    is_full = lambda t: bool(re.search(r"designation", t, re.I)) and not re.search(r"removal|correction|amend|addition|deletion", t, re.I)
    baseline = next((x for x in docs if is_full(x.get("title") or "")), None)
    if not baseline:
        raise PolicyError("联邦公报里找不到 1260H 完整指定通知(检索格式可能已变)")
    later = [x for x in docs if (x.get("publication_date") or "") > (baseline.get("publication_date") or "") and x is not baseline]
    text, raw = _doc_text(baseline)
    base = {"doc": baseline["document_number"], "published": baseline["publication_date"], "title": baseline["title"], "url": baseline["html_url"], "raw_ref": raw, "text_chars": len(text),
            "later_docs": [{"doc": x.get("document_number"), "date": x.get("publication_date"), "title": x.get("title")} for x in later], "search_truncated": truncated,
            # decision_* = 最终决定状态的那份通知(默认基线;后续通知改变状态时换成它),状态证据用它
            "decision_doc": baseline["document_number"], "decision_date": baseline["publication_date"], "decision_title": baseline["title"], "decision_url": baseline["html_url"], "decision_raw_ref": raw}
    if not aliases:
        return {**base, "status": "undetermined", "matched": None, "context": None, "reason": "无一手英文名"}
    m = match_entity(text, aliases)
    status = {"on": "on_list", "off": "not_on_list", "ambiguous": "undetermined"}[m["state"]]
    reason = "基线通知全文检索别名" if m["state"] != "ambiguous" else "短名命中但无法确认同一性"
    # 应用后续通知(按日期升序):removal 命中 → 移出;addition / designation 命中 → 列入;correction / 其它 → 无法判定
    for x in sorted(later, key=lambda y: y.get("publication_date") or ""):
        try:
            t2, raw2 = _doc_text(x)
        except Exception as e:  # noqa: BLE001
            return {**base, "status": "undetermined", "matched": m.get("alias"), "context": m.get("context"), "reason": f"后续通知 {x.get('document_number')} 全文拉不到({type(e).__name__}),无法重建现行状态"}
        m2 = match_entity(t2, aliases)
        if m2["state"] == "off":
            continue
        if m2["state"] == "ambiguous":
            return {**base, "status": "undetermined", "matched": m2.get("alias"), "context": m2.get("context"), "reason": f"后续通知 {x.get('document_number')} 命中短名但无法确认同一性"}
        title = (x.get("title") or "").lower()
        if "removal" in title or "deletion" in title:
            status, reason = "removed", f"后续通知 {x.get('document_number')}({x.get('publication_date')})移出"
        elif "addition" in title or "designation" in title:
            status, reason = "on_list", f"后续通知 {x.get('document_number')}({x.get('publication_date')})列入"
        else:
            return {**base, "status": "undetermined", "matched": m2.get("alias"), "context": m2.get("context"), "reason": f"后续通知 {x.get('document_number')} 类型无法判定({x.get('title')})"}
        m = m2
        base.update({"decision_doc": x.get("document_number"), "decision_date": x.get("publication_date"), "decision_title": x.get("title"), "decision_url": x.get("html_url"), "decision_raw_ref": raw2})
    return {**base, "status": status, "matched": m.get("alias"), "context": (m.get("context") or "")[:200] or None, "reason": reason}


def fetch_bis_mentions(aliases: list[str]) -> dict:
    """BIS 规则:联邦公报 term 精确短语检索 → 拉原文本地复核(最多 BIS_CONFIRM_MAX 份)。
    status: mentioned(≥ 1 份原文确认)/ search_hit_unconfirmed(检索有命中但原文未确认)/ not_mentioned / undetermined。"""
    if not aliases:
        return {"status": "undetermined", "mentions": [], "api_count": 0, "retrieved": 0, "truncated": False, "raw_ref": None}
    hits, raw, seen, api_count, truncated = [], None, set(), 0, False
    for a in aliases[:2]:
        res, cnt, trunc, rr = _fr_search_all({"conditions[agencies][]": "industry-and-security-bureau", "conditions[term]": f'"{a}"'}, max_pages=2)
        raw = raw or rr
        api_count = max(api_count, cnt)
        truncated = truncated or trunc
        for x in res:
            if x.get("document_number") in seen:
                continue
            seen.add(x.get("document_number"))
            hits.append({"date": x.get("publication_date"), "title": x.get("title"), "doc": x.get("document_number"), "url": x.get("html_url"), "alias": a, "raw_text_url": x.get("raw_text_url")})
    hits.sort(key=lambda x: x["date"] or "", reverse=True)
    confirmed, unconfirmed = [], []
    for h in hits[:BIS_CONFIRM_MAX]:
        try:
            t, doc_raw = _doc_text(h)
            m = match_entity(t, aliases)
            if m["state"] == "on":
                confirmed.append({**h, "context": (m.get("context") or "")[:200], "doc_raw_ref": doc_raw})
            else:
                unconfirmed.append(h)
        except Exception as e:  # noqa: BLE001
            unconfirmed.append({**h, "error": f"{type(e).__name__}"})
    status = "mentioned" if confirmed else ("search_hit_unconfirmed" if hits else "not_mentioned")
    return {"status": status, "mentions": confirmed[:10], "unconfirmed": unconfirmed[:10], "api_count": api_count, "retrieved": len(hits), "truncated": truncated or len(hits) > BIS_CONFIRM_MAX, "raw_ref": raw}


def snapshot(name: str, payload: dict) -> Optional[str]:
    """非传输层的状态证据(中方侧未接入 / 错误汇总)以 extracted_ 快照落盘,不借用别的端口的 raw(Codex policy-r1)。"""
    return record_raw(json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8"), "json", f"policy://{name}", kind="extracted")


def fetch_fcc_covered(aliases: list[str]) -> dict:
    """FCC Covered List(经 r.jina,按 ### Covered List 分节切,去重,区分整类禁令与点名实体)。"""
    r = http_get(JINA + FCC_URL, headers=JINA_HEADERS, timeout=60, ext="md")
    raw = getattr(r, "_vra_raw_ref", None)
    if r.status_code >= 400:
        raise PolicyError(f"FCC Covered List(jina)HTTP {r.status_code}")
    if re.search(r"Just a moment|Enable JavaScript and cookies|cf-challenge|Attention Required", r.text, re.I):
        raise PolicyError("FCC(jina)返回 Cloudflare 挑战页(HTTP 200 但无正文)")
    body = r.text.split("Markdown Content:", 1)[-1]
    start = body.find("### Covered List")
    if start < 0:
        raise PolicyError("FCC 页面结构变了:找不到 `### Covered List` 分节")
    body = body[start:]
    section, rows, seen = "", [], set()
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("### "):
            section = line[4:].strip()
            continue
        if not line.startswith("|") or set(line) <= set("| -"):
            continue
        cells = [re.sub(r"\*\*|\[([^\]]*)\]\([^)]*\)", r"\1", c).strip() for c in line.strip("|").split("|")]
        if not cells or not cells[0] or cells[0].lower() in ("entity", "covered equipment or services") or len(cells) < 2:
            continue
        if not section.startswith("Covered List"):
            continue
        key = cells[0][:80]
        if key in seen:
            continue
        seen.add(key)
        rows.append({"entry": cells[0][:200], "since": cells[1][:40], "kind": "整类·非美国产" if re.search(r"foreign[- ]produced|produced in a foreign country", cells[0], re.I) else "点名实体"})
    if not rows:
        raise PolicyError("FCC Covered List 解析出 0 条——结构可能变了,不当作空名单")
    # 逐 entry 匹配(不拼接 blob):全名规范形相等或 token 边界命中 → on;短名只接受规范形相等 / 带公司后缀的命中;有歧义 → undetermined
    matched, state = None, "off"
    if aliases:
        for x in rows:
            m = match_entity(x["entry"], aliases)
            if m["state"] == "on":
                matched, state = x["entry"], "on"
                break
            if m["state"] == "ambiguous" and state == "off":
                matched, state = x["entry"], "ambiguous"
    asof = (re.search(r"\(([A-Z][a-z]+ \d{1,2}, \d{4})\)", body) or [None, ""])[1]
    status = "undetermined" if not aliases else {"on": "on_list", "off": "not_on_list", "ambiguous": "undetermined"}[state]
    return {"status": status, "matched": matched, "n": len(rows), "n_class_bans": sum(1 for x in rows if x["kind"].startswith("整类")), "as_of": asof, "raw_ref": raw}


def fetch_mofcom_notices(limit: int = 8) -> dict:
    """商务部出口管制公告事件流(经 r.jina,解析 markdown 链接;标题含 管制 / 公告 / 清单 / 出口 / 管控 / 两用物项 才留)。"""
    r = http_get(JINA + MOFCOM_URL, headers=JINA_HEADERS, timeout=40, ext="md")
    raw = getattr(r, "_vra_raw_ref", None)
    if r.status_code >= 400:
        raise PolicyError(f"商务部公告(jina)HTTP {r.status_code}")
    out, seen = [], set()
    for m in re.finditer(r"\[([^\]\n]{8,})\]\((https?://[^)\s]+)\)", r.text):
        title, link = m.group(1).strip(), m.group(2).strip()
        if not any(x in title for x in ("管制", "公告", "清单", "出口", "管控", "两用物项")) or title in seen:
            continue
        seen.add(title)
        d = re.search(r"(20\d\d)[-./年](\d{1,2})[-./月](\d{1,2})", title + " " + link)
        out.append({"title": title[:160], "url": link, "date": f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}" if d else ""})
        if len(out) >= limit:
            break
    if not out:
        raise PolicyError("商务部公告列表解析出 0 条——页面结构可能变了")
    return {"notices": out, "raw_ref": raw}


CN_SIDE_NOTE = ("中方侧未接入:商务部出口管制公告列表(exportcontrol.mofcom.gov.cn)为 JS 渲染,零配置抓不到真实公告(经 r.jina 只拿到导航链接;"
                "主站政策发布页抓到的是政策解读非管制公告)。中方侧沉默不能证明某物项不受管制;要查中方清单请人工核商务部公告原文。")


def policy_access(code: str, with_fcc: bool = True, with_mofcom: bool = False, now: Optional[datetime] = None) -> dict:
    """管制与准入状态快照。美方三个端口各自隔离失败;1260H 与 BIS 都失败 → 抛。中方侧默认不接(抓不到真公告,只给护栏说明)。"""
    now = now or datetime.now(timezone.utc)
    errors = {}
    try:
        name, name_raw = cn_english_name(code)
    except Exception as e:  # noqa: BLE001
        name, name_raw = "", None
        errors["english_name"] = f"{type(e).__name__}: {str(e)[:120]}"
    aliases = aliases_of(name) if name else []
    out = {"code": code, "english_name": name, "english_name_raw_ref": name_raw, "aliases": aliases, "checked_at": now.strftime("%Y-%m-%d"), "errors": errors}
    for key, fn in (("dod_1260h", lambda: fetch_1260h(aliases)), ("bis", lambda: fetch_bis_mentions(aliases))):
        try:
            out[key] = fn()
        except Exception as e:  # noqa: BLE001
            errors[key] = f"{type(e).__name__}: {str(e)[:120]}"
    if with_fcc:
        try:
            out["fcc"] = fetch_fcc_covered(aliases)
        except Exception as e:  # noqa: BLE001
            errors["fcc"] = f"{type(e).__name__}: {str(e)[:120]}"
    if with_mofcom:
        try:
            out["mofcom"] = fetch_mofcom_notices()
        except Exception as e:  # noqa: BLE001
            errors["mofcom"] = f"{type(e).__name__}: {str(e)[:120]}"
    else:
        out["cn_side"] = CN_SIDE_NOTE
        out["cn_side_raw_ref"] = snapshot("cn_side_not_connected", {"status": "not_connected", "note": CN_SIDE_NOTE, "checked_at": out["checked_at"]})
    if errors:
        out["errors_raw_ref"] = snapshot("errors", {"errors": errors, "checked_at": out["checked_at"]})
    if "dod_1260h" not in out and "bis" not in out:
        raise PolicyError("美方名单两个主端口(1260H / BIS)全部失败:" + "; ".join(f"{k}={v}" for k, v in errors.items()))
    return out
