#!/usr/bin/env python3
"""把 a-stock-data SKILL.md 里带 `<!-- 标记:start -->` 的代码块原样移植成
`.agents/skills/data-access/scripts/sources/astock_ported.py`。

用法:python datasources/port_astock.py <a-stock-data 仓库里的 SKILL.md> [--check]
  --check:只比对、不写文件;生成结果与现有文件不同则退出码 1。

为什么生成而不是手抄:上游这批端点约 2800 行,手抄容易漏掉上游的防御性校验;
生成脚本让「与上游的差别」只剩下面 SUBS 里列出的几处联网入口,升级上游时重跑即可,
差别多了少了在 diff 里一眼可见。改完记得同步 datasources/UPSTREAM.md。
"""
from __future__ import annotations

import ast
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(os.path.dirname(HERE), ".agents", "skills", "data-access", "scripts", "sources", "astock_ported.py")

# 按 SKILL.md 中出现的顺序拼接;helpers 必须在最前(其余块都依赖它)
MARKERS = ["v39-helpers", "v39-tencent-kline", "v39-tdx-package", "v310-tencent-ticks", "v39-sina-reports",
           "v39-etf-shares", "v39-wscn-lives", "v39-cctv-news", "v39-st-list", "v39-sse-e", "v39-chinabond",
           "v39-repo-fixing", "v39-lpr", "v39-macro-calendar", "official-data-core", "v39-futures", "v39-events",
           "v39-cb", "official-data-backups"]
# 没有标记、但上面各块要用的前置定义(市场前缀 / 代码归一化),按「定义了谁」定位代码块
PREREQ_DEFS = ["get_prefix", "norm_ticker"]

# 与上游的全部差别:(标记, 原文, 替换, 必须命中的次数)
SUBS = [
    ("v39-helpers", "        if response.status_code not in allow_status:\n",
     "        _vra_rec(response)  # VRA: 响应原文落盘\n        if response.status_code not in allow_status:\n", 1),
    ("official-data-core", "response = requests.get(", "response = _vra_requests_get(", 1),
    ("official-data-backups", "session.get(", "_vra_call(session.get, ", 2),
    ("official-data-backups", "session.post(", "_vra_call(session.post, ", 2),
]

HEADER = '''"""a-stock-data v{version}({commit})新端点原样移植:v3.8.0 官方数据(指数 / 交易日历 / 两融与北交所备胎)
+ v3.9.0 / v3.10.x(腾讯 K 线与逐笔、通达信盘后包、新浪研报、ETF 份额、华尔街见闻、新闻联播、ST 名单、
上证e互动、中债曲线、回购定盘、LPR、宏观日历、期货与大宗、事件驱动、可转债)。

🔴 本文件由 datasources/port_astock.py 从上游 SKILL.md 生成,勿手改;要改先改生成脚本再重跑。
与上游代码块的差别只有联网入口(业务逻辑一字未动):
1. em_get → sources._http.em:跨进程串行锁 + 代理回退 + 响应落盘(替代上游的进程内节流);
2. _v39_http 拿到响应先落盘(与 sources._http.http_get 同一套 raw/ 契约);
3. 官方指数文件的 requests.get、两融 / 北交所备胎的会话请求同样落盘;
4. baostock 会话用 sources.baostock_src.bs_session(登录登出的打印不进 stdout,否则信封 JSON 会被污染)。
用户给的 A 股代码先经 fetch_endpoint.resolve_symbol(common.norm_ticker)校验;下面的 norm_ticker / get_prefix
是上游原版,只在函数内部再归一化一次。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import _guess_ext as _vra_guess_ext, current_capture as _vra_capture, em as _vra_em  # noqa: E402
from sources.baostock_src import bs_paging_error, bs_session  # noqa: E402,F401

UPSTREAM_VERSION = "{version}"
UPSTREAM_COMMIT = "{commit}"
DATACENTER_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"


def _vra_rec(response):
    """响应原文落盘到当前捕获上下文(与 http_get 同契约),原样返回响应。"""
    cap = _vra_capture()
    if cap is not None:
        body = response.content
        ext = "zip" if body[:2] == b"PK" else _vra_guess_ext(response.headers.get("Content-Type", ""), response.url, body)
        response._vra_raw_ref = cap.record(body, ext, response.url)
    return response


def _vra_call(method, *args, **kwargs):
    return _vra_rec(method(*args, **kwargs))


def _vra_requests_get(*args, **kwargs):
    import requests
    return _vra_rec(requests.get(*args, **kwargs))


def em_get(url, params=None, headers=None, timeout=15, **kwargs):
    """上游 em_get 的签名;实际走产品的东财统一入口(串行锁 + 落盘)。"""
    if kwargs:
        raise TypeError(f"em_get 不支持参数 {{sorted(kwargs)}}")
    return _vra_em(url, params=params, headers=headers, timeout=timeout)


def _rs_to_df(rs):
    """baostock ResultData → DataFrame;错误码转异常,绝不静默返回空表(上游 §6.5 原版)。"""
    import pandas as pd
    if rs.error_code != "0":
        raise RuntimeError(f"baostock 查询失败: {{rs.error_code}} {{rs.error_msg}}")
    rows = []
    while rs.next():
        rows.append(rs.get_row_data())
    why = bs_paging_error(rs)
    if why:  # 翻页失败不抛异常（见 common.bs_paging_error），不查就拿着前 2000 行当完整序列
        raise RuntimeError(f"baostock 翻页失败: {{why}}（只取到 {{len(rows)}} 行）")
    return pd.DataFrame(rows, columns=rs.fields)
'''


def _python_blocks(skill: str) -> list[str]:
    return re.findall(r"```python\n(.*?)```", skill, re.S)


def _marker_code(skill: str, marker: str) -> str:
    parts = skill.split(f"<!-- {marker}:start -->")
    if len(parts) != 2:
        raise SystemExit(f"标记 {marker} 出现 {len(parts) - 1} 次(应为 1)")
    section = parts[1].split(f"<!-- {marker}:end -->", 1)[0]
    blocks = re.findall(r"```python\n(.*?)\n```", section, re.S)
    if len(blocks) != 1:
        raise SystemExit(f"标记 {marker} 内有 {len(blocks)} 个代码块(应为 1)")
    return blocks[0]


def _strip_examples(src: str) -> str:
    """去掉教程块里模块级的示例调用(`norm_ticker("SH600519")  # '600519'` 这类),保留定义与注释。"""
    tree = ast.parse(src)
    drop: set[int] = set()
    for node in tree.body:
        if isinstance(node, ast.Expr) and not isinstance(getattr(node, "value", None), ast.Constant):
            drop.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    lines = src.split("\n")
    kept = [line for i, line in enumerate(lines, 1) if i not in drop and line.strip() != "# 用法"]
    return "\n".join(kept).rstrip() + "\n"


def build(skill_path: str) -> str:
    skill = open(skill_path, encoding="utf-8").read()
    m = re.search(r"^version:\s*\"?([0-9.]+)", skill, re.M)
    version = m.group(1) if m else "unknown"
    try:
        commit = subprocess.run(["git", "-C", os.path.dirname(os.path.abspath(skill_path)), "rev-parse", "--short", "HEAD"],
                                capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        commit = "unknown"

    chunks = [HEADER.format(version=version, commit=commit)]
    for name in PREREQ_DEFS:
        hits = [b for b in _python_blocks(skill) if re.search(rf"^def {name}\(", b, re.M)]
        if len(hits) != 1:
            raise SystemExit(f"前置定义 {name} 出现在 {len(hits)} 个代码块里(应为 1)")
        chunks.append(f"# ===== 上游前置定义:{name} =====\n" + _strip_examples(hits[0]))

    used = {i: 0 for i in range(len(SUBS))}
    for marker in MARKERS:
        code = _marker_code(skill, marker)
        for i, (mk, old, new, n) in enumerate(SUBS):
            if mk != marker:
                continue
            hit = code.count(old)
            if hit != n:
                raise SystemExit(f"{marker}:替换 {old.strip()!r} 命中 {hit} 次(应为 {n}),上游代码可能已变,请先核对再改 SUBS")
            code = code.replace(old, new)
            used[i] += 1
        chunks.append(f"# ===== 上游标记块:{marker} =====\n" + code.rstrip() + "\n")
    if not all(used.values()):
        raise SystemExit("有替换规则没用上:" + ", ".join(SUBS[i][0] for i, u in used.items() if not u))

    text = "\n\n".join(chunks)
    tree = ast.parse(text)
    # 顶层名字重复定义会让后一个块静默覆盖前一个块(上游测试是逐块 exec,未必暴露)
    seen: dict[str, int] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            seen[node.name] = seen.get(node.name, 0) + 1
    dup = sorted(k for k, v in seen.items() if v > 1)
    if dup:
        raise SystemExit(f"顶层函数重复定义:{dup}")
    return text


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    text = build(args[0])
    if "--check" in sys.argv:
        current = open(TARGET, encoding="utf-8").read() if os.path.exists(TARGET) else ""
        if current != text:
            print("astock_ported.py 与上游生成结果不一致")
            raise SystemExit(1)
        print("astock_ported.py 与上游生成结果一致")
        return
    with open(TARGET, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"已生成 {os.path.relpath(TARGET, os.path.dirname(HERE))}({text.count(chr(10))} 行)")


if __name__ == "__main__":
    main()
