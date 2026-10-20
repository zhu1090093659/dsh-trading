"""**Core 检索层**:全网搜索 + 取网页。任何垂类 AgentOS 都要用,所以属于 Core 而不是某个行业包。

🔴 **为什么不直接给 agent 开联网工具**(这是本层最重要的设计约束):
接进来的大脑(Codex / Claude Code / WorkBuddy 等本机 Agent,或模型 API)各自可能带联网搜索,但产品**刻意不给**:
本机 Agent 关掉全部内置工具、只留受控工具(Codex 另加 `web_search="disabled"`,见 `orchestrator/src/local_agent_runtime.ts`),
模型 API 只收到受控工具表;宪法也写死「取数与解释分阶段:解释阶段只读 evidence,不再联网」。
理由是产品的核心命题——**每个数字都要能追到一份带校验和的 raw 响应**。
agent 若能自由联网,它可以写一个数字说"网上看到的",而没有任何人能核对。证据链就断了。
⇒ 检索**必须走编排器取数这条既有路**:这里去搜、原文落盘、产出带 `raw_ref` 的证据,agent 只读证据。

## 本层与证据链的分工(在这里改错过一次,写清楚)

本层**只取回并携带溯源信息,不负责落盘**;落 raw、算校验和、生成证据是取数 / mapper 层的事。
但"不负责落盘"**不等于可以把溯源信息丢掉** —— `_exa_free()` 曾把上游给的 `raw_ref` 在映射时丢了,
等于在 Core 这一层就把证据链剪断,下游再想追也追不回(Codex 检索层审计 P1)。
⇒ 契约:
- `search()` 每条结果**透传 `raw_ref`**(上游给了就带上)。
- `fetch_page()` 返回 `raw`(未截断的完整正文)与 `raw_sha256`,**调用方据此落盘**;
  `text` 是给人 / 给模型看的截断版,**不是**证据本体。

## 零配置优先,可选升级

| 能力 | 默认(零 key,开箱即用) | 检测到 key 时升级 |
|---|---|---|
| 搜索 | Exa 免 key MCP | `VRA_EXA_API_KEY` / `VRA_TAVILY_API_KEY` / `VRA_FIRECRAWL_API_KEY` |
| 取网页 | `r.jina.ai`(⚠️ 必须带 UA,否则被拒) | 同上;需要真实浏览器 / 登录态时 → CDP(见 `core/cdp.py`) |

⚠️ **配了 key 绝不能让默认路径变得不可用**:自动选通道只会选**已注册**的实现,
带 key 的通道还没接上时照旧走免费通道(曾经写成"有 key 就选 `exa_key`",而那个实现根本没注册,
于是"配了 key 反而报未知通道",与"可选升级"完全相反)。显式传 `provider=` 则仍然当场报错——
那是用户明确指定的东西,静默换掉才是坑。

## 不可信文本纪律

检索回来的一律是**外部不可信文本**。本层只负责取回并标注来源;
脱敏、"线索不是事实"、"帖子里的数字不得当事实"这些纪律在 `sources/textsafe.py`,
由调用方在做成证据时套用。**不要在这里偷偷"清洗"内容** —— 原文要能落盘复核。

⚠️ **拦截页 / 验证码页:默认失败,要取用得显式 opt-in。** "Access denied""请开启 JavaScript"
"登录后查看"这类页面正文非空,与正常页面在结构上无法可靠区分。
一度想"只打标不拒绝",理由是关键词判会误杀正当内容(一篇讲验证码的文章就会中招)——
**但打标会把安全依赖分散给每一个调用方**:下游 mapper 忘了看那个字段,就会落盘一份
"有 URL、有 raw、有校验和"、内容却是登录页的证据,形式上完全合规。
而校验和只能证明**保存下来的拦截页没被改过**,证明不了它是目标内容。
⇒ 默认 `raise`,判错时调用方显式传 `allow_suspect_block=True` —— **默认安全 + 例外可控**,
比"默认放行 + 全员自觉"强(Codex 检索层 r2)。
⚠️ 仍要清楚:关键词只覆盖常见几种,**别指望这里能保证"取到的一定是真内容"**,
"线索不是事实"那条纪律照旧生效。

## 凭据

`_redact()` 对**我们自己配置的 key 按精确值替换**(手里有真实值,含 URL 编码形态;
⚠️ 只覆盖 ≥8 字符的值);对第三方凭据只能靠模式匹配,那是**尽力而为,给不出"绝不泄漏"的保证** ——
所以文档里不写这种保证,调用方也不该假设异常文本一定干净。

URL 分两种语义,**不要合并**:`_request_url()` 发送用(query 完整,否则预签名 URL 直接失效)、
`_record_url()` 记账用(敏感 query 参数只抹值留名)、`_safe_url()` 报错用(连 query 一起剥;
未通过校验的 URL 再加 `host_only=True`,因为那时 path 里都可能躺着凭据)。
"""
from __future__ import annotations

import hashlib
import os
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Callable, Optional

# 供应商顺序:靠前的优先。没有 key 的项永远可用,是"零配置"的保证。
SEARCH_ENV = (("exa", "VRA_EXA_API_KEY"), ("tavily", "VRA_TAVILY_API_KEY"), ("firecrawl", "VRA_FIRECRAWL_API_KEY"))
PAGE_ENV = (("firecrawl", "VRA_FIRECRAWL_API_KEY"),)
#: 疑似拦截页的标记词(见模块文档:默认拒绝 + 显式 opt-in)。
#: 只在**短正文**上匹配,避免误杀正文里谈到这些词的正常文章。
BLOCK_MARKERS = re.compile(
    r"access denied|forbidden|are you a robot|captcha|verify you are human|enable javascript|"
    r"sign in to continue|请开启\s*javascript|访问被拒绝|人机验证|登录后查看", re.I)
BLOCK_SUSPECT_MAX_CHARS = 600


class RetrievalError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def available_upgrades(env: Optional[dict] = None) -> list[str]:
    """当前环境里配了哪些可升级的 key(只报名字,**不回显 key 本身**)。"""
    e = env if env is not None else dict(os.environ)
    out: list[str] = []
    for name, var in SEARCH_ENV + PAGE_ENV:
        if (e.get(var) or "").strip() and name not in out:   # firecrawl 同时在两张表里,别报两遍
            out.append(name)
    return out


def search(query: str, num_results: int = 8, *, provider: Optional[str] = None,
           env: Optional[dict] = None) -> list[dict]:
    """全网搜索 → [{title, url, snippet, source, fetched_at, raw_ref?}]。

    provider 不指定时按"有 key 且该通道已注册就用它,否则用免费通道"自动选。
    ⚠️ 结果是**不可信文本**:标题与摘要都可能是营销、谣言或提示词注入。调用方必须按
    `sources/textsafe.py` 的规矩脱敏,并且**只当线索不当事实**。
    """
    e = env if env is not None else dict(os.environ)
    chosen = provider or _pick_search(e)
    fn = _SEARCH_IMPL.get(chosen)
    if not fn:
        raise RetrievalError(_redact(f"未知搜索通道 {chosen!r};可用:{sorted(_SEARCH_IMPL)}", e))

    def run() -> list[dict]:
        rows = fn(query, num_results, e)
        if not isinstance(rows, list):
            raise RetrievalError(f"{chosen} 返回的不是列表(通道契约变了?)")
        stamp = _now()
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            url = _record_url(r.get("url"))     # 搜索结果直接进证据 ⇒ 用记账形态
            if not url:                       # 没有可用 URL 就做不成证据(raw_ref 无处可指),丢弃
                continue
            item = {"title": str(r.get("title") or ""), "url": url,
                    "snippet": str(r.get("snippet") or ""), "source": chosen, "fetched_at": stamp}
            if r.get("raw_ref"):              # 🔴 上游给了溯源就必须透传,别在 Core 剪断证据链
                item["raw_ref"] = str(r["raw_ref"])
            out.append(item)
        if rows and not out:
            raise RetrievalError(f"{chosen} 返回了 {len(rows)} 条但没有一条带可用的 http(s) URL(通道异常或被拦截)")
        return out

    return _guard(chosen, run, e)


def fetch_page(url: str, *, max_chars: int = 4000, provider: Optional[str] = None,
               env: Optional[dict] = None, allow_suspect_block: bool = False) -> dict:
    """取一个网页 → {url, text, raw, raw_sha256, source, fetched_at, truncated, suspect_block,
    final_url_known, requested_url?}。

    ⚠️ `final_url_known=False` 表示**取页通道报不出最终 URL**(如 jina 只返回正文):
    目标若发生重定向,正文其实来自别处,而 `url` 只能记请求地址。
    做成证据时要如实写"出处未经通道确认",**不要当成已确认的出处**。

    `raw` 是**未截断的完整正文**,`raw_sha256` 是它的校验和 —— **调用方负责落盘**;
    `text` 只是截断后的阅读版,不能当证据本体(见模块文档"本层与证据链的分工")。
    ⚠️ `raw` = **取页通道返回的完整正文**,不是目标站的原始 HTTP 字节
    (走 jina 时它已经是 jina 转换过的文本)。证据里要标清这一层,别写成"网页原始响应"。

    默认走 `r.jina.ai`(零 key)。需要真实浏览器渲染或登录态时传 `provider="cdp"`。
    疑似拦截页默认**抛错**;确实要拿到那份内容时显式传 `allow_suspect_block=True`。
    """
    e = env if env is not None else dict(os.environ)
    if not isinstance(max_chars, int) or isinstance(max_chars, bool) or max_chars <= 0:
        raise RetrievalError(_redact(f"max_chars 必须是正整数,收到 {max_chars!r}", e))
    chosen = provider or _pick_page(e)
    fn = _PAGE_IMPL.get(chosen)
    if not fn:
        raise RetrievalError(_redact(f"未知取页通道 {chosen!r};可用:{sorted(_PAGE_IMPL)}", e))
    # 🔴 **校验与清洗必须发生在调用 provider 之前**。原来是先把原始 URL 交给通道、之后才清洗:
    #    `_jina` 会把 `https://user:pass@host/...` 整个拼给 r.jina.ai —— **凭据已经发出去了**,
    #    返回值里再剥也撤不回;`file:` / 换行 URL 同理会先进到通道里(Codex 检索层 r2 P1)。
    target = _request_url(url)          # 发送用:query 完整,预签名 URL 才能真的取到
    if not target:
        # 还没通过校验的 URL 什么都可能是,path 里就可能躺着凭据 ⇒ 只报 scheme+host
        raise RetrievalError(f"不是可取证的 http(s) URL,拒绝:{_safe_url(url, host_only=True)}")
    recorded_request = _record_url(target)

    def run() -> dict:
        got = fn(target, max_chars, e)
        # 通道可以返回 str,也可以返回 (正文, 最终URL) —— 后者用于**发生重定向时如实记出处**。
        # 解析放在 guard 内:畸形返回值(空元组 / 自定义对象的 __str__ 抛异常)也要走统一错误信封与脱敏。
        if isinstance(got, tuple):
            if len(got) != 2:
                raise RetrievalError(f"{chosen} 返回的元组长度应为 2,收到 {len(got)}")
            body, final_url = got[0], _record_url(got[1])
            if not final_url:
                # 🔴 通道选择了元组契约,就表示"最终 URL 有溯源意义"。它非法时**必须失败**,
                #    回退到请求 URL 会把登录页 / 错误页的正文挂到目标地址名下,还配一个合法校验和。
                # 与初始 URL 同一条防线:未通过校验的 URL,path 里就可能躺着凭据 ⇒ 只报 scheme+host
                raise RetrievalError(f"{chosen} 给出的最终 URL 不合法({_safe_url(got[1], host_only=True)}),"
                                     f"拒绝把正文归到请求地址名下")
            final_url_known = True
        else:
            # 通道只返回正文(如 jina)⇒ **它报不出最终 URL**。此时若目标发生了重定向,
            # 正文其实来自别处,而我们只能记请求地址。⚠️ 不要假装知道 —— 把"不知道"如实标出来
            # (`final_url_known: false`),让调用方在证据里写清楚出处未经通道确认(Codex r4 P2)。
            body, final_url, final_url_known = got, recorded_request, False
        if not isinstance(body, str) or not body.strip():
            # 空正文多半是拦截页 / 需登录 / 取错了 —— **宁可当场报错,也不要变成一条"取到了但没内容"的证据**
            raise RetrievalError(f"{chosen} 取回的正文为空:{_safe_url(recorded_request)}")
        suspect = bool(len(body) <= BLOCK_SUSPECT_MAX_CHARS and BLOCK_MARKERS.search(body))
        if suspect and not allow_suspect_block:
            # 默认失败 + 显式 opt-in:只打标会把安全依赖分散给每一个调用方,
            # 下游 mapper 忘了看这个字段,就会落盘一份"有 URL、有 raw、有校验和"但内容是登录页的证据。
            raise RetrievalError(f"疑似拦截 / 登录 / 验证码页({len(body)} 字符):{_safe_url(final_url)};"
                                 f"确需取用请显式传 allow_suspect_block=True")
        out = {"url": final_url, "text": body[:max_chars], "raw": body,
               "raw_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
               "truncated": len(body) > max_chars, "source": chosen, "fetched_at": _now(),
               "suspect_block": suspect, "final_url_known": final_url_known}
        if final_url != recorded_request:
            out["requested_url"] = recorded_request   # 两个都留:要能看出"我要的"和"实际到的"不是一个
        return out

    return _guard(chosen, run, e)


# ---------- URL 与凭据处理 ----------

#: query 里承载凭据的常见参数名(预签名 URL / 分享链接)。**只抹值,保留参数名**。
SENSITIVE_QUERY_KEY = re.compile(
    r"(?i)^(x-amz-|x-goog-|x-ms-|amz-)|^(sig|signature|token|access_token|id_token|refresh_token|"
    r"api_key|apikey|key|auth|authorization|password|passwd|secret|credential|sas|session)$")


def _request_url(value) -> str:
    """**要发出去的那个 URL**:校验协议、拒绝控制字符、剥掉 userinfo,**query 原样保留**。

    🔴 发送用与记账用是两种语义,不能共用一个函数(Codex 检索层 r3 P1):
    我一度用带脱敏的版本去发请求,于是预签名 URL 的 `X-Amz-Signature` 在**真正发出去之前**
    就被改成了 `***`,请求必然 403 —— 然后还可能被判成拦截页。
    ⇒ 发送要**完整可用**,记账才做脱敏(`_record_url`)。
    """
    if not isinstance(value, str):
        return ""
    v = value.strip()
    if not v or any(ch in v for ch in "\n\r\t"):
        return ""
    try:
        p = urllib.parse.urlsplit(v)
        port = p.port                      # 非法端口(`:not-a-port` / `:99999`)在这里抛 ValueError
    except ValueError:
        return ""
    if p.scheme not in ("http", "https") or not p.hostname:
        return ""
    host = f"[{p.hostname}]" if ":" in p.hostname else p.hostname     # IPv6 要补回方括号
    netloc = host + (f":{port}" if port else "")                      # 丢掉 username:password@
    return urllib.parse.urlunsplit((p.scheme, netloc, p.path, p.query, p.fragment))


def _record_url(value) -> str:
    """**要记进证据 / 日志的那个 URL**:在 `_request_url` 基础上,把 query 里的**敏感参数值**换成 `***`。

    ⚠️ query 的其余部分保留 —— `?id=123`、`?page=2` 常常就是页面身份,整段剥掉会毁掉溯源。
    但预签名 URL 会把凭据放在 `X-Amz-Signature` / `token` 这类参数里,它们会一路进到
    证据、日志和报告 ⇒ **只抹值、留参数名**,两边都顾上。
    """
    base = _request_url(value)
    if not base:
        return ""
    p = urllib.parse.urlsplit(base)
    # 🔴 fragment 同样要脱敏:OAuth implicit flow 就是把 `access_token` 放在 `#` 后面
    #    (`https://h/callback#access_token=SECRET`)。只处理 query 会漏掉整整一类真实场景
    #    (Codex 检索层 r4 P1)。但 `#/page/2` 这种 SPA 路由不含 `=`,要原样留着当页面身份。
    frag = _redact_kv(p.fragment)     # 无 `=` 的路由(`#/page/2`)天然不受影响,不必再加条件
    return urllib.parse.urlunsplit((p.scheme, p.netloc, p.path, _redact_kv(p.query), frag))


def _redact_kv(blob: str) -> str:
    """把键值串里的**敏感值**换成 `***`,参数名与其余键值原样保留。

    🔴 **不能靠"按分隔符切开再逐段判"** —— 分隔符本身有歧义,两次都栽在这上面(Codex r4/r5):
    - `access_token=abc;def`:把 `;` 当分隔符,`def` 就成了"没有 `=` 的独立片段"被原样留下 ⇒ 值的后半段泄漏;
      而 `;` 在值里是合法字符,单看字符判不出它是不是分隔符。
    - `#/callback?access_token=SECRET`(SPA OAuth 回调):按 `&` 切只有一段,
      解析出的键是 `#/callback?access_token`,匹配不上敏感名 ⇒ 整个 token 原样留下。

    ⇒ 改为**扫描"分隔符 + 敏感名 ="**,一旦命中就**从那里一直抹到本段末尾** ——
    宁可多抹一点,也不放过值里夹着奇怪字符的情形。
    """
    if not blob:
        return blob
    segs = blob.split("&")           # `&` 是唯一无歧义的分隔符(值里的 `&` 按规范必须编码)
    out, prev_redacted = [], False
    for seg in segs:
        red = _redact_segment(seg)
        if prev_redacted and "=" not in seg:
            # 上一段被抹了,而这一段没有 `=` —— 多半是没编码的值被 `&` 切开的后半截,一并抹掉
            red = "***"
        out.append(red)
        prev_redacted = red.endswith("***")
    return "&".join(out)


_KEY_AT = re.compile(r"(?:^|[;?,/])([^;?,/=]+)=")
#: 解码视图专用:`&` 与 `#` 在**原串**里已被切走 / 不可能出现在段内,但 `%26` `%23` 解码后会变回来,
#: 所以检测视图的分隔符集合必须更宽(Codex 检索层 r7)。
_KEY_AT_DECODED = re.compile(r"(?:^|[;?,/&#])([^;?,/&#=]+)=")


def _redact_segment(seg: str) -> str:
    for m in _KEY_AT.finditer(seg):
        if SENSITIVE_QUERY_KEY.search(urllib.parse.unquote_plus(m.group(1))):
            return seg[:m.end()] + "***"     # 从敏感名的 `=` 之后一直抹到段尾
    # 🔴 分隔符本身可以被百分号编码:`#/callback%3Faccess_token=SECRET`、
    #    `?redirect=%2Fcallback%3Faccess_token=SECRET` —— `%3F` 不是 `?`,上面的扫描看不见
    #    (Codex 检索层 r6)。⇒ 在**解码视图**上再检测一次。
    #    ⚠️ 只用来**检测**,绝不输出解码后的串(那会改变 URL 身份);命中就从原串**第一个 `=`**
    #    起整段抹掉 —— 位置回映射太脆,宁可在"涉及编码"这种少数情形下多抹。
    if "%" in seg:
        view = seg
        # 解到稳定,**但最多 5 轮**(防病态输入)。⚠️ 措辞要准:这不是"无限解到稳定" ——
        # 六重及以上编码仍可绕过。这是同一根因的更深层变体,作为已知边界接受,别写成"已完全覆盖"。
        for _ in range(5):
            nxt = urllib.parse.unquote_plus(view)
            if nxt == view:
                break
            view = nxt
        if any(SENSITIVE_QUERY_KEY.search(urllib.parse.unquote_plus(m.group(1)))
               for m in _KEY_AT_DECODED.finditer(view)):
            head, sep, _ = seg.partition("=")
            return f"{head}{sep}***" if sep else "***"
    return seg


def _safe_url(value, *, host_only: bool = False) -> str:
    """给**错误消息**用的 URL:连 query 一起剥掉 —— 报错时溯源不重要,别把签名参数写进日志。

    ⚠️ `host_only=True` 用于**还没通过校验**的 URL:此时它可以是任何东西,
    path 里就可能直接躺着凭据(`ftp://h/private/sk-live-SECRET`),所以连 path 都不显示。
    通过校验之后的 URL 才显示 path —— 那时形态已经受限,而 path 对排障很有用(r3 P2)。
    """
    try:
        p = urllib.parse.urlsplit(str(value or ""))
        host = p.hostname or ""
    except ValueError:
        return "<无法解析的 URL>"
    if not p.scheme:
        return "<无 scheme 的 URL>" if host_only else str(value or "")[:80]
    return f"{p.scheme}://{host}" if host_only else f"{p.scheme}://{host}{p.path}"[:80]


def _guard(channel: str, run, env: dict):
    """在 Core 边界统一包装通道异常。

    🔴 不能指望每个 provider 自律:第三方通道很可能把 key 放在请求 URL 或请求头里,
    异常对象一路带着完整 URL 冒泡,然后被日志、诊断包、甚至报告记下来。
    ⚠️ **`RetrievalError` 也要脱敏** —— provider 自己抛的这一类曾原样放行(它同样可能拼了 key)。
    """
    try:
        return run()
    except RetrievalError as ex:
        raise RetrievalError(_redact(str(ex), env)) from None
    except Exception as ex:  # noqa: BLE001 — 边界统一收口
        raise RetrievalError(f"{channel} 通道失败({type(ex).__name__}):{_redact(str(ex), env)[:200]}") from None


def _redact(text, env: Optional[dict] = None) -> str:
    """两档脱敏,强度不同,别混为一谈:

    1. **我们自己配置的 key:按真实值精确替换**(含 URL 编码形态)。手里就有那串值,
       不受写法(`X-Api-Key`、`api key:`、放在 path 里、带引号)影响。
       ⚠️ 边界:**只覆盖 ≥8 字符的配置值**(更短的值全局替换会把正常文本打得稀烂),
       也覆盖不到通道自己做过其它变形(base64 等)的情形 —— 所以是"这一档强"不是"无条件可靠"。
    2. **第三方凭据:模式匹配,尽力而为。** 正则 denylist 永远能被绕过
       (`credential sk-xxx`、userinfo、非 http 协议的 query…),所以**不承诺"绝不泄漏"**。
    """
    try:
        t = str(text)
    except Exception:  # noqa: BLE001 — 自定义对象的 __str__ 也可能抛
        return "<无法转为文本的错误>"
    e = env if env is not None else dict(os.environ)
    for _name, var in SEARCH_ENV + PAGE_ENV:
        val = (e.get(var) or "").strip()
        if len(val) >= 8:                 # 太短的值(测试占位)全局替换会把正常文本打得稀烂
            for form in (val, urllib.parse.quote(val, safe=""), urllib.parse.quote_plus(val)):
                t = t.replace(form, "***")
    t = re.sub(r"://[^/@\s]+:[^/@\s]+@", "://***:***@", t)                       # URL userinfo
    t = re.sub(r"(?i)([a-z0-9\-_]*(?:api[_\- ]?key|token|secret|password|authorization)[a-z0-9\-_]*)"
               r"\s*[:=]\s*\"?[^\"\s,;]+\"?", r"\1=***", t)
    t = re.sub(r"(?i)bearer\s+\S+", "bearer ***", t)
    return re.sub(r"(https?://[^\s?#]+)\?[^\s]*", r"\1?…", t)


def _pick_search(e: dict) -> str:
    for name, var in SEARCH_ENV:
        if (e.get(var) or "").strip() and f"{name}_key" in _SEARCH_IMPL:
            return f"{name}_key"          # 只选**已注册**的;否则配了 key 反而不可用
    return "exa_free"


def _pick_page(e: dict) -> str:
    for name, var in PAGE_ENV:
        if (e.get(var) or "").strip() and f"{name}_key" in _PAGE_IMPL:
            return f"{name}_key"
    return "jina"


# ---------- 通道实现 ----------

def _exa_free(query: str, n: int, _e: dict) -> list[dict]:
    """免 key 的 Exa MCP —— 产品既有实现(市场声音层已实战),这里只是把它提升为 Core 通道。"""
    from core.exa_client import exa_search      # Core → Core(客户端已从 sources/ 拆出,不反向依赖行业目录)
    return [{"title": r.get("title", ""), "url": r.get("url", ""),
             "snippet": r.get("highlights", "") or r.get("text", "") or r.get("snippet", ""),
             "raw_ref": r.get("raw_ref")}      # 🔴 必须带上:丢了它就等于在 Core 剪断证据链
            for r in exa_search(query, num_results=n)]


def _jina(url: str, max_chars: int, _e: dict) -> str:
    """r.jina.ai:零 key 读任意网页。⚠️ **必须带 UA**,不带会被拒(2026-08-23 实测)。"""
    import urllib.request
    req = urllib.request.Request(f"https://r.jina.ai/{url}",
                                 headers={"User-Agent": "Mozilla/5.0 (vibe-research-agent)", "Accept": "text/plain"})
    with urllib.request.urlopen(req, timeout=30) as response:
        content = response.read(4_000_001)
    if len(content) > 4_000_000:
        raise ValueError("网页读取响应超过 4 MB，请缩小读取范围")
    return content.decode("utf-8", "replace")


def _cdp_page(url: str, max_chars: int, _e: dict) -> tuple[str, str]:
    from core.cdp import fetch_rendered
    return fetch_rendered(url)              # (正文, 最终URL)


#: 有 key 的通道**先留占位**:接哪家、按什么配额与合规级,要和端点注册表一起定,
#: 不在这里凭空写死。没配 key 的路径完全不受影响(零配置仍然可用)。
_SEARCH_IMPL: dict[str, Callable[[str, int, dict], list[dict]]] = {"exa_free": _exa_free}
#: 取页通道:返回正文 str,或 (正文, 最终URL) —— 后者让重定向后的出处能如实记账。
_PAGE_IMPL: dict[str, Callable[[str, int, dict], object]] = {"jina": _jina, "cdp": _cdp_page}


def register_search_provider(name: str, fn: Callable[[str, int, dict], list[dict]]) -> None:
    """让 DomainPack / 用户插件注册自己的搜索通道(如带 key 的 Exa、Tavily、行业专有检索)。"""
    _SEARCH_IMPL[name] = fn


def register_page_provider(name: str, fn: Callable[[str, int, dict], object]) -> None:
    _PAGE_IMPL[name] = fn
