"""宏观源:人民银行社会融资规模增量(月度,亿元)/ 国家统计局 PMI。移植自 a-stock-data SKILL.md §11.1 / §11.2。官方网页解析,零鉴权;依赖 pandas(+xlrd/openpyxl)。"""
from __future__ import annotations

import io
import os
import re
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import http_get  # noqa: E402

_UA = {"User-Agent": "Mozilla/5.0"}
PBC_BASE = "https://www.pbc.gov.cn"
PBC_INDEX = f"{PBC_BASE}/diaochatongjisi/116219/116319/index.html"
NBS_INDEX = "https://www.stats.gov.cn/sj/zxfb/"


def _macro_get(url: str, timeout: int = 30) -> str:
    r = http_get(url, headers=_UA, timeout=timeout, ext="html")
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return r.text


def _abs_pbc(href: str) -> str:
    return href if href.startswith("http") else PBC_BASE + href


def pboc_social_financing(year: Optional[int] = None) -> list[dict]:
    """社融增量统计表(仅支持 2021 年起版式):[{month:'YYYY-MM', afre_total, rmb_loans, fx_loans, entrusted_loans, trust_loans, undiscounted_bankers_acceptance, corporate_bonds, government_bonds, equity_financing, abs_by_depository, loans_written_off}] 单位亿元"""
    import pandas as pd
    idx = _macro_get(PBC_INDEX)
    years = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*(\d{4})年统计数据\s*</a>""", idx)
    if not years:
        raise RuntimeError("人民银行索引页未找到「XXXX年统计数据」链接,页面结构可能已变更")
    table = {int(y): href for href, y in years}
    target = max(table) if year is None else int(year)
    if target not in table:
        raise ValueError(f"人民银行无 {target} 年数据,可选年份: {sorted(table, reverse=True)[:8]}")
    ypage = _macro_get(_abs_pbc(table[target]))
    topics = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*(社会融资规模)\s*</a>""", ypage)
    if not topics:
        raise RuntimeError(f"{target} 年页未找到「社会融资规模」专题链接")
    tpage = _macro_get(_abs_pbc(topics[0][0]))
    books = re.findall(r"""href=["']([^"']+\.xlsx?)["']""", tpage)
    if not books:
        raise RuntimeError(f"{target} 年社融专题页未找到 xls/xlsx 附件")
    xr = http_get(_abs_pbc(books[0]), headers=_UA, timeout=60, ext="xlsx" if books[0].endswith("xlsx") else "xls")
    xr.raise_for_status()
    raw = pd.read_excel(io.BytesIO(xr.content), header=None)
    start = next((i for i in range(len(raw)) if str(raw.iloc[i, 0]).strip() == "月份"), None)
    if start is None:
        raise RuntimeError(f"{target} 年社融表没有独立的「月份」表头单元格;本端点仅支持 2021 年起版式")
    cols = ["month", "afre_total", "rmb_loans", "fx_loans", "entrusted_loans", "trust_loans", "undiscounted_bankers_acceptance", "corporate_bonds", "government_bonds", "equity_financing",
            "abs_by_depository", "loans_written_off"]
    df = raw.iloc[start + 3:].copy().iloc[:, :len(cols)]
    df.columns = cols
    df = df[df["month"].astype(str).str.match(r"^\d{4}\.\d{1,2}$", na=False)].copy()
    for c in cols[1:]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    def _month_label(v):
        m = re.match(r"^(\d{4})\.(\d{1,2})$", str(v).strip())
        if not m:
            return None
        ys, ms = m.group(1), m.group(2)
        if len(ms) == 1:
            ms += "0"  # Excel 吃掉 2026.10 的尾零 → 2026.1;1 月始终写作 .01
        return f"{ys}-{int(ms):02d}"

    df["month"] = [_month_label(v) for v in df["month"]]
    df = df[df["month"].notna()]
    df = df[df["month"].str.startswith(f"{target}-")].dropna(subset=["afre_total"]).reset_index(drop=True)
    if df.empty:
        raise RuntimeError(f"社融表解析后无有效月份({target} 年),格式可能已变更")
    return [{k: (None if (isinstance(v, float) and v != v) else v) for k, v in rec.items()} for rec in df.to_dict("records")]


def nbs_pmi() -> dict:
    """最新 PMI:{title, period:'YYYY-MM', manufacturing_pmi, non_manufacturing_pmi, composite_pmi, pmi_large, pmi_medium, pmi_small, source_url};三主指标解析不到 → 抛错。"""
    idx = _macro_get(NBS_INDEX)
    links = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>\s*([^<]{6,80}?)\s*</a>', idx)
    hit = next(((u, t) for u, t in links if "采购经理指数" in t), None)
    if not hit:
        raise RuntimeError("国家统计局最新发布页未找到「采购经理指数」条目")
    href, title = hit
    url = href if href.startswith("http") else NBS_INDEX + href.lstrip("./")
    html = _macro_get(url)
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.S)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[\s　\xa0]+", "", text)

    def grab(pat):
        m = re.search(pat, text)
        return float(m.group(1)) if m else None

    ym = re.search(r"(\d{4})年(\d{1,2})月", title)
    large = medium = small = None
    combined = re.search(r"大、中、小型企业PMI分别为([\d.]+)%、([\d.]+)%和([\d.]+)%", text)
    if combined:
        large, medium, small = (float(x) for x in combined.groups())
    else:
        m_ms = re.search(r"中、小型企业PMI分别为([\d.]+)%和([\d.]+)%", text)
        if m_ms:
            medium, small = (float(x) for x in m_ms.groups())
        for name, pat in (("large", r"大型企业PMI为([\d.]+)%"), ("medium", r"中型企业PMI为([\d.]+)%"), ("small", r"小型企业PMI为([\d.]+)%")):
            m = re.search(pat, text)
            if m:
                v = float(m.group(1))
                if name == "large":
                    large = v
                elif name == "medium" and medium is None:
                    medium = v
                elif name == "small" and small is None:
                    small = v
    result = {"title": title.strip(), "period": f"{ym.group(1)}-{int(ym.group(2)):02d}" if ym else None, "manufacturing_pmi": grab(r"(?<!非)制造业采购经理指数（PMI）为([\d.]+)%"),
              "non_manufacturing_pmi": grab(r"非制造业商务活动指数为([\d.]+)%"), "composite_pmi": grab(r"综合PMI产出指数为([\d.]+)%"), "pmi_large": large, "pmi_medium": medium, "pmi_small": small,
              "source_url": url}
    absent = [k for k in ("manufacturing_pmi", "non_manufacturing_pmi", "composite_pmi") if result[k] is None]
    if absent:
        raise RuntimeError(f"PMI 正文措辞可能已变更,无法解析 {absent};请核对页面:{url}")
    return result
