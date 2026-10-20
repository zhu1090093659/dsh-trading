#!/usr/bin/env python3
"""由 registry.json 生成 datasources/CATALOG.md(端点目录:按层分组,含市场 / 源 / 合规级 / 代码类型 / 阶段 / 备注)。每次改注册表后重跑。"""
from __future__ import annotations

import json
import os
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
reg = json.load(open(os.path.join(HERE, "registry.json"), encoding="utf-8"))
by_layer: "OrderedDict[str, list]" = OrderedDict()
for e in reg["endpoints"]:
    by_layer.setdefault(e.get("layer", "其他"), []).append(e)
lines = [f"# 数据源端点目录(registry v{reg['version']},共 {len(reg['endpoints'])} 个)", "",
         "由 `datasources/gen_catalog.py` 从 `registry.json` 生成,勿手改。调用方式:`.venv/bin/python .agents/skills/data-access/scripts/fetch_endpoint.py --endpoint <id> --symbol <代码> [--args '<JSON>'] --out-dir <运行目录>`;"
         "legacy 端点为 Phase 0 的独立脚本。合规级:cn-public = 国内公开网页接口;S = 官方政府数据;B = 非官方 / 个人研究;C = 仅个人研究(CBOE 条款);rss-public = 公开 RSS。",
         "symbol_kind:cn6 = A 股 6 位码;us = 美股 ticker;hk = 港股 5 位;global = 美股 / 港股自动判别;raw = 原样透传(指数 / 关键词 / 期权标的);none = 不需要标的。", ""]
for layer, eps in by_layer.items():
    lines += [f"## {layer}({len(eps)})", "", "| id | 标题 | 市场 | 源 | 合规 | symbol_kind | 阶段 | 鉴权 / 备注 |", "|---|---|---|---|---|---|---|---|"]
    for e in eps:
        st = ", ".join(f"{k}:{v}" for k, v in (e.get("stages") or {}).items()) or "-"
        note = "; ".join(x for x in [f"env {e['auth_env']}" if e.get("auth_env") else "", "禁用" if not e.get("enabled", True) else "", "关键" if e.get("critical") else "", str(e.get("notes") or "")] if x)
        lines.append(f"| `{e['id']}` | {e.get('title', '')} | {'/'.join(e.get('market', []))} | {e.get('source', '')} | {e.get('compliance', '')} | {e.get('symbol_kind', '')} | {st} | {note.replace('|', '/')} |")
    lines.append("")
open(os.path.join(HERE, "CATALOG.md"), "w", encoding="utf-8").write("\n".join(lines))
print("CATALOG.md:", len(reg["endpoints"]), "endpoints,", len(by_layer), "layers")
