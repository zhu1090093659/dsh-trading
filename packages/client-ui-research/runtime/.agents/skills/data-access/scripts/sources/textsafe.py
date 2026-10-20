"""不可信文本(网页 / 帖子 / 标题 / 摘录)进证据信封前的确定性净化。

市场声音层拿到的是互联网文本:可能夹带对 agent 的指令("忽略以上规则…")、可能含合规 gate 会命中的动作措辞
("目标价 1500"、"建议买入"),也可能有控制字符 / 零宽字符 / 变体选择符,或用空格、繁体把动作词拆开绕过匹配。原则:
  - 原文一字不改地留在 raw/(http 响应落盘),证据 value 只放**净化后的摘录**;
  - 动作措辞替换为标记〔动作词〕:报告引用线索时不会把"目标价"原样抄进去触发 gate,也不会把帖子的动作措辞当成本产品的建议;
    匹配在**规范化形态**上做(NFKC、剥不可见字符、繁→简、汉字之间的空白 / 点线分隔符忽略),替换回写到**原文位置**,
    所以"建 仓" / "建͏仓" / "目️标价" / "目標價"都会被替换,而正常文本的标点与空格不被改动;
  - 剥离控制字符 / 零宽字符 / 不可见组合符,压缩空白,截断到 limit;
  - **不做语义改写、不过滤观点**:线索是什么就是什么,净化只针对"不能原样进提示词"的形态。
    ⚠️ 词表只收"投资动作措辞"(评级 / 仓位 / 买卖建议),**不收裸词"增持 / 减持"**——"控股股东拟增持公司股份"是公司行为事实,
    替换掉会让真正的股东行为线索无法辨认。
GATE_WORDS / TRAD_CHARS 必须与 orchestrator/src/finance/gate_rules.ts 的 PATTERNS、orchestrator/src/gate.ts TRAD_CHARS 逐字一致
(TS 测试 market_voice.test.ts 强制校验)。
"""
from __future__ import annotations

import re
import unicodedata
from urllib.parse import quote

# 与 orchestrator/src/finance/gate_rules.ts 的 PATTERNS 逐字一致
GATE_WORDS = [
    "建仓", "加仓", "减仓", "清仓", "满仓", "空仓", "建议买", "建议卖", "可以买", "可以卖",
    "逢低买", "逢高卖", "抄底", "止损", "止盈", "目标价", "仓位建议", "配置比例", "推荐买", "推荐卖", "建议增持", "建议减持",
]
ACTION_MARK = "〔动作词〕"
# 简 → 繁(只覆盖 GATE_WORDS 用到的、繁简不同的字);与 orchestrator/src/gate.ts TRAD_CHARS 逐字一致
TRAD_CHARS = {"仓": "倉", "减": "減", "满": "滿", "议": "議", "买": "買", "卖": "賣", "评": "評", "级": "級", "损": "損", "标": "標", "价": "價", "荐": "薦"}
_TRAD2SIMP = {t: s for s, t in TRAD_CHARS.items()}
_ZERO_WIDTH = {"​", "‌", "‍", "⁠", "﻿"}  # 零宽空格 / 非连接符 / 连接符 / 词连接符 / BOM
# 不可见的组合 / 选择符:CGJ、蒙文自由变体选择符、变体选择符 VS1–16 / VS17–256(它们是 Mn,不在 Cc/Cf 里)
_INVISIBLE_RANGES = ((0x034F, 0x034F), (0x180B, 0x180D), (0xFE00, 0xFE0F), (0xE0100, 0xE01EF))
# 汉字之间可忽略的分隔符(空白 / 中点 / 下划线 / 星号 / 波浪 / 竖线 / 斜线 / 反斜线 / 加号 / 各种连字符 / 点)。
# ⚠️ 与 orchestrator/src/gate.ts CJK_SEP_CHARS 逐字一致(TS 测试强制);NFKC 已把全角 ／＋～ 折到半角。
CJK_SEP_CHARS = " \t\r\n\u3000\u00b7\u2022\u30fb_*~|/\\+.\u2010\u2011\u2012\u2013\u2014\u2015-"
_SEP = set(CJK_SEP_CHARS)


def _is_invisible(ch: str) -> bool:
    if ch in _ZERO_WIDTH:
        return True
    cp = ord(ch)
    if any(a <= cp <= b for a, b in _INVISIBLE_RANGES):
        return True
    return unicodedata.category(ch) in ("Cc", "Cf")


def _is_mark(ch: str) -> bool:
    """组合附加符(U+0301 等)/ 环绕符:只在匹配规范形里剥(输出文本不动,越南语等正常附加符不受影响)。"""
    return unicodedata.category(ch) in ("Mn", "Me")


def _is_cjk(ch: str) -> bool:
    return bool(ch) and ("㐀" <= ch <= "鿿" or "豈" <= ch <= "﫿")


def strip_control(text: str) -> str:
    """去掉控制字符、零宽字符与不可见组合 / 选择符(保留换行 / 制表,随后由空白压缩统一处理)。"""
    return "".join(ch for ch in text if ch in ("\n", "\t") or not _is_invisible(ch))


def canonical_chars(text: str) -> tuple[str, list[int]]:
    """匹配用规范形:剥不可见字符、繁→简、汉字之间的分隔符忽略。返回 (规范串, 规范串每个字符对应的原文下标)。"""
    kept: list[tuple[str, int]] = [(_TRAD2SIMP.get(ch, ch), i) for i, ch in enumerate(text) if not (_is_invisible(ch) or _is_mark(ch))]
    out: list[str] = []
    idx: list[int] = []
    j = 0
    while j < len(kept):
        ch, i = kept[j]
        if ch in _SEP:
            k = j
            while k < len(kept) and kept[k][0] in _SEP:
                k += 1
            prev = out[-1] if out else ""
            nxt = kept[k][0] if k < len(kept) else ""
            if not (_is_cjk(prev) and _is_cjk(nxt)):
                for t in range(j, k):
                    out.append(kept[t][0])
                    idx.append(kept[t][1])
            j = k
            continue
        out.append(ch)
        idx.append(i)
        j += 1
    return "".join(out), idx


def canonical_for_match(text: str) -> str:
    return canonical_chars(unicodedata.normalize("NFKC", str(text or "")))[0]


def neutralize_actions(text: str) -> str:
    """动作措辞 → 〔动作词〕:在规范形上找(按词长降序,避免"减持评级"被短词先咬一半),替换回写到原文位置。"""
    canon, idx = canonical_chars(text)
    taken = [False] * len(canon)
    spans: list[tuple[int, int]] = []
    for w in sorted(GATE_WORDS, key=len, reverse=True):
        start = 0
        while True:
            p = canon.find(w, start)
            if p < 0:
                break
            if not any(taken[p:p + len(w)]):
                for t in range(p, p + len(w)):
                    taken[t] = True
                spans.append((idx[p], idx[p + len(w) - 1] + 1))
            start = p + 1
    out = text
    for a, b in sorted(spans, reverse=True):
        out = out[:a] + ACTION_MARK + out[b:]
    return out


def sanitize_untrusted(text, limit: int = 300) -> str:
    t = unicodedata.normalize("NFKC", str(text or ""))
    t = strip_control(t)
    t = re.sub(r"\s+", " ", t).strip()
    t = neutralize_actions(t)
    return t[:limit]


def safe_url(url, limit: int = 300) -> str:
    """链接只向模型暴露**校验过形态**的 http(s) URL:剥控制 / 空白 / 不可见字符,非 ASCII 与危险字符百分号编码,截断。
    不是 http(s) 的一律返回空串(远端 IRI 不能直接携带可读指令进提示词)。"""
    u = strip_control(unicodedata.normalize("NFKC", str(url or "")))
    u = re.sub(r"\s+", "", u)
    if not re.match(r"^https?://[^/\s]+", u, re.I):
        return ""
    return quote(u, safe="/:?&=#%+-._~@$,;*")[:limit]  # ()[]!'<> 不放行:它们能从 Markdown 链接里逃出来
