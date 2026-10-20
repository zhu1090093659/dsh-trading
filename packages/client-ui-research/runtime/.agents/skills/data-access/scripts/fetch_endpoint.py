#!/usr/bin/env python3
"""通用取数器:按 datasources/registry.json 里的端点定义取数,统一产出契约信封(fetch/<endpoint_id>.json)+ raw 落盘。

用法:python fetch_endpoint.py --endpoint <id> --symbol <code> [--args '{"k":v}'] [--out-dir RUN] [--timeout 15]
流程:读注册表 → 解析代码(按端点 market / symbol_kind)→ 导入 sources.<module> 的函数 → with capture() 调用(raw 自动落盘)
      → mappers.<mapper>(result, ctx) 产出 evidence / extra / missing → 状态与退出码(0 ok / 2 partial / 3 failed)。
端点级守卫:enabled=false 或需鉴权而环境变量缺失 → failed + 明确原因(不静默);上游函数抛 DataNotAvailable → failed(该日无数据)。
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import traceback
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import atomic_write_json, finish, lib_versions, norm_ticker, now_iso, record_error, redact_text, result_skeleton  # noqa: E402
from sources._http import DataNotAvailable, assert_us_ticker, capture, norm_hk  # noqa: E402
from core.stdio_utf8 import force_utf8_stdio

REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
REGISTRY_PATH = os.path.join(REPO_ROOT, "datasources", "registry.json")


def load_registry(path: str = REGISTRY_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        reg = json.load(f)
    reg["_by_id"] = {e["id"]: e for e in reg["endpoints"]}
    return reg


def resolve_symbol(ep: dict, symbol: str) -> tuple[str, str]:
    """按端点的 symbol_kind 归一化:cn6 → (6 位, SH|SZ|BJ);us → (TICKER, US);hk → (5 位, HK);none → ("MARKET", 市场);raw → (原样, 市场)。"""
    kind = ep.get("symbol_kind", "cn6")
    if kind == "cn6":
        return norm_ticker(symbol, stock_only=ep.get("stock_only", True))
    if kind == "us":
        return assert_us_ticker(symbol), "US"
    if kind == "hk":
        return norm_hk(symbol), "HK"
    if kind == "none":
        return "MARKET", ep.get("market", ["CN"])[0]
    if kind == "global":  # 美股 ticker 或港股代码(4-5 位数字 / .HK 后缀)自动判别
        sym = str(symbol).strip()
        if sym.upper().endswith(".HK") or (sym.isdigit() and len(sym) in (4, 5)):
            return norm_hk(sym), "HK"
        return assert_us_ticker(sym), "US"
    if kind == "raw":  # 原样透传(指数 / ETF / 期权标的 / 带前缀写法),市场取端点声明
        sym = str(symbol).strip()
        if not sym or sym == "MARKET":
            raise ValueError("该端点需要 --symbol(原样透传)")
        return sym, ep.get("market", ["CN"])[0]
    raise ValueError(f"未知 symbol_kind {kind}")


def main() -> None:
    # 🔴 **必须在打任何 JSON 之前**：中文 Windows 的管道默认 GBK，
    #    含 \xa0 会当场崩、其余中文会变成 Node 按 UTF-8 读不懂的字节（上游 issue #27）。
    force_utf8_stdio()
    p = argparse.ArgumentParser(description="通用取数器(registry 驱动)")
    p.add_argument("--endpoint", required=True)
    p.add_argument("--symbol", default="MARKET")
    p.add_argument("--args", default="{}", help="传给源函数的额外参数 JSON")
    p.add_argument("--out-dir", default=None)
    p.add_argument("--timeout", type=int, default=15)
    p.add_argument("--registry", default=REGISTRY_PATH)
    a = p.parse_args()

    reg = load_registry(a.registry)
    ep = reg["_by_id"].get(a.endpoint)
    if not ep:
        res = result_skeleton(a.endpoint, str(a.symbol), "")
        record_error(res, "registry", a.endpoint, KeyError(f"注册表无端点 {a.endpoint}"))
        finish(res, a.out_dir)
        return
    try:
        symbol, market = resolve_symbol(ep, a.symbol)
    except ValueError as e:
        res = result_skeleton(ep["id"], str(a.symbol), "")
        record_error(res, "input", "symbol", e)
        finish(res, a.out_dir)
        return
    res = result_skeleton(ep["id"], symbol, market)
    res["extra"]["endpoint"] = {"layer": ep.get("layer"), "source": ep.get("source"), "compliance": ep.get("compliance"), "title": ep.get("title")}
    if not ep.get("enabled", True):
        record_error(res, ep.get("source", "?"), ep["id"], RuntimeError(f"端点默认禁用({ep.get('disabled_reason', '见 registry')})"))
        finish(res, a.out_dir)
        return
    need = ep.get("auth_env")
    if need and not os.environ.get(need):
        where = ";桌面版可在「接入 AI」页填 SEC 联系方式(英文姓名和邮箱)" if need == "VRA_SEC_CONTACT" else ""
        record_error(res, ep.get("source", "?"), ep["id"], RuntimeError(f"端点需要环境变量 {need}(未设置{where})"))
        finish(res, a.out_dir)
        return
    try:
        cli_args = json.loads(a.args or "{}")
        if not isinstance(cli_args, dict):
            raise ValueError("--args 必须是 JSON 对象")
        # 注册表 args = 端点默认参数(值为 null 的是占位符,丢弃让函数默认值生效);--args 覆盖
        extra_args = {k: v for k, v in (ep.get("args") or {}).items() if v is not None}
        extra_args.update(cli_args)
    except ValueError as e:
        record_error(res, "input", "args", e)
        finish(res, a.out_dir)
        return

    mod_name, fn_name = ep["module"], ep["function"]
    mm_name = ep.get("mapper_module", "mappers")
    try:
        # 模块名含点 → 绝对导入(测试 / 外部扩展包);否则 sources.<module>
        mod = importlib.import_module(mod_name if "." in mod_name else f"sources.{mod_name}")
        fn = getattr(mod, fn_name)
        mappers = importlib.import_module(mm_name if "." in mm_name else f"sources.{mm_name}")
        mapper = getattr(mappers, ep["mapper"])
    except Exception as e:  # noqa: BLE001
        record_error(res, "loader", f"{mod_name}.{fn_name}", e)
        finish(res, a.out_dir)
        return

    ctx: dict[str, Any] = {"script": ep["id"], "symbol": symbol, "market": market, "source": ep.get("source", mod_name),
                           "endpoint": ep.get("endpoint_label", fn_name), "as_of": None, "timeout": a.timeout, "ep": ep, "args": extra_args}
    try:
        with capture(a.out_dir, ctx["source"], ctx["endpoint"]) as cap:
            call_args = dict(extra_args)
            if ep.get("symbol_kind", "cn6") != "none":
                call_args[ep.get("symbol_param", "code")] = symbol
            if ep.get("pass_market"):
                call_args["market"] = market
            if ep.get("pass_timeout"):
                call_args["timeout"] = a.timeout
            if ep.get("pass_out_dir"):
                # 少数端点要读**编排器在本次运行里写好的**产物(如产业门控结果 fetch/_industry.json)来决定筛选口径。
                # 只读、且只读编排器自己的确定性产物;端点必须在注册表显式声明 pass_out_dir。
                call_args["out_dir"] = a.out_dir
            result = fn(**call_args)
            ctx["raw_ref"] = cap.last_raw_ref
            ctx["raws"] = cap.raws
            mapped = mapper(result, ctx)  # mapper 也在 capture 内:extracted() / record_raw() 仍能落盘
        res["extra"]["raw_binding"] = "single" if len(cap.raws) <= 1 else "per_row_or_last"  # 多请求端点:行级证据带各自 raw,其余默认最后一次响应
        res["evidence"].extend(mapped.get("evidence", []))
        res["extra"].update(mapped.get("extra", {}))
        res["missing"].extend(mapped.get("missing", []))
        res["primary_source"] = ctx["source"]
        res["used_sources"].append(ctx["source"])
        status = mapped.get("status")
        if status is None:
            status = "ok" if res["evidence"] and not res["missing"] else ("partial" if res["evidence"] else "failed")
        res["status"] = status
        if status != "ok" and mapped.get("degraded"):
            res["extra"]["degraded"] = mapped["degraded"]
        if not res["evidence"] and status == "failed":
            record_error(res, ctx["source"], ctx["endpoint"], RuntimeError(mapped.get("reason", "源返回空,无证据")))
    except DataNotAvailable as e:
        record_error(res, ctx["source"], ctx["endpoint"], e)
        res["extra"]["degraded"] = "该日 / 该标的无数据(非错误)"
    except Exception as e:  # noqa: BLE001
        record_error(res, ctx["source"], ctx["endpoint"], e)
        res["extra"]["traceback_tail"] = redact_text(traceback.format_exc()[-600:])
    res["extra"]["raw_files"] = [r.get("raw_ref") for r in ctx.get("raws", []) if r.get("raw_ref")]
    res["extra"]["provenance"] = lib_versions(*ep.get("libs", []))
    res["fetched_at"] = now_iso()
    finish(res, a.out_dir)


if __name__ == "__main__":
    main()
