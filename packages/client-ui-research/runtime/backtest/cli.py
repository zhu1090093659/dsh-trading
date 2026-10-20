"""回测的 JSON 入口 —— 界面与命令行共用这一个。

    echo '{"codes":["600519.SH"],"start":"2022-01-01","end":"2025-12-31",
           "style":"long","strategy":"ma_cross","params":{"fast":20,"slow":60}}' \
      | python -m backtest.cli

stdout 只出一份 JSON。三种结果**分得清**：

    {"ok": true,  "result": {...}}                 跑完了
    {"ok": false, "refused": {reason, remedy}}     闸口拦住了（**这不是错误**，是结论）
    {"ok": false, "error": "..."}                  真出错了

🔴 「被闸口拦住」与「出错了」必须分开：前者是产品在做它该做的事（说清楚这个回测为什么
   不成立），后者是我们的问题。混成一个 error，界面就只能显示"失败了"，
   而用户真正需要看到的是那句"为什么不成立、怎么才能跑"。
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backtest.gate import Plan, plan_backtest  # noqa: E402
from backtest.run import BacktestNotValid, Result, run  # noqa: E402
from backtest.strategies import BUILTIN, Rsrs  # noqa: E402
from backtest.stdio_utf8 import force_utf8_stdio  # noqa: E402
from backtest.loader import INDEX_BASIS, LoaderError, VibeLoader, price_basis  # noqa: E402
from backtest.sensitivity import run_grid  # noqa: E402
from backtest.cost_compare import compare as cost_compare  # noqa: E402


def _public_error(exc: Exception) -> str:
    """Keep actionable validation causes, never return a traceback or local path."""
    message = str(exc)
    message = re.sub(r"https?://\S+", "[远程地址]", message)
    message = re.sub(r"(?:[A-Za-z]:[\\/]|/(?:Users|home|tmp|private|var|opt)/)[^\s，；。]+", "[本地路径]", message)
    message = re.sub(r"(?i)(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+", "[凭据已隐藏]", message)
    return message[:1200]


def _catalog() -> dict:
    """界面要用的选项表 —— **由这里下发，前端不写死一份**。

    写死的那份迟早与真实实现对不上，而对不上的表现是「选了没反应」或者
    「真实存在的选项不在列表里」，两种都看不出是配置漂移。
    """
    from backtest.gate import MARKETS, STYLES
    from backtest.loader import INDEX_BENCHMARKS
    rsrs_warm = Rsrs().warmup_bars
    return {
        # The model assembles this JSON; option labels alone do not tell it that
        # a ticker must be passed as codes: ["AAPL"], not symbol/ticker/code.
        "input_schema": {
            "type": "object", "additionalProperties": False,
            "required": ["codes", "start", "end"],
            "properties": {
                "codes": {"type": "array", "minItems": 1, "items": {"type": "string"},
                          "description": "标的代码数组，例如 AAPL、600519.SH、00700.HK。字段必须叫 codes，不是 symbol。"},
                "start": {"type": "string", "format": "date", "description": "起始日期 YYYY-MM-DD"},
                "end": {"type": "string", "format": "date", "description": "结束日期 YYYY-MM-DD"},
                "style": {"type": "string", "enum": list(STYLES), "default": "swing"},
                "strategy": {"type": "string", "enum": list(BUILTIN), "default": "buy_and_hold"},
                "params": {"type": "object", "description": "所选策略的参数，按 strategies 对应 params 填写；无参数用 {}。"},
                "initial_cash": {"type": "number", "exclusiveMinimum": 0, "default": 1000000},
                "allow_short": {"type": "boolean", "default": False},
            },
        },
        "example_request": {
            "codes": ["AAPL"], "start": "2021-01-01", "end": "2025-12-31", "style": "swing",
            "strategy": "ma_cross", "params": {"fast": 20, "slow": 60}, "initial_cash": 100000,
            "allow_short": False,
        },
        "styles": [
            {"key": s.key, "label": s.label, "holding": s.holding,
             "interval": s.interval, "min_bars": s.min_bars, "why_min": s.why_min}
            for s in STYLES.values()
        ],
        "markets": [
            {"key": m.key, "label": m.label, "can_short": m.can_short,
             "same_day_roundtrip": m.same_day_roundtrip, "price_limit": m.price_limit,
             "lot": m.lot, "fees": m.fees, "currency": m.currency}
            for m in MARKETS.values()
        ],
        "strategies": [
            {"key": "buy_and_hold", "label": "买入持有", "params": {},
             "note": "恒定目标权重的历史对照；不代表未来表现。"},
            {"key": "ma_cross", "label": "均线交叉",
             "params": {"fast": {"default": 20, "label": "快线"}, "slow": {"default": 60, "label": "慢线"}},
             "note": "快线在慢线上方时目标权重为 1，下方为 0；多标的时均分权重。"},
            {"key": "rsi_reversion", "label": "RSI 均值回归",
             "params": {"window": {"default": 14, "label": "窗口"},
                        "buy_below": {"default": 30, "label": "买入线"},
                        "sell_above": {"default": 70, "label": "卖出线"}},
             "note": "RSI 低于下阈值时目标权重为 1，高于上阈值时为 0；中间保留前值，多标的均分。"},
            {"key": "rsrs", "label": "RSRS 择时",
             "params": {"n": {"default": 18, "label": "回归天数"},
                        "m": {"default": 600, "label": "标准化窗口"},
                        "threshold": {"default": 0.7, "label": "阈值"}},
             "note": "光大证券 2017 年研报的阻力支撑相对强度：最近 n 天最高价对最低价回归斜率的标准分高于阈值时目标权重为 1，"
                     "低于负阈值时为 0，中间保留前值，多标的均分；研报参数在沪深300 指数上定，个股不一定成立。"
                     f"前 n+m-1 根日线只用来算指标、不持有（默认 {rsrs_warm} 根），所以区间要比别的策略长：默认参数下"
                     + "、".join(f"{STYLES[k].label}至少 {STYLES[k].min_bars + rsrs_warm} 根日线（约 {round((STYLES[k].min_bars + rsrs_warm) / 245 * 2) / 2:g} 年）"
                                for k in ("swing", "long")) + "。只用于历史回测，不给当天的读数。"},
        ],
        # 不是参数、但每次运行都会有的东西。不写进来，Agent 只看 input_schema 会以为「没有基准、不能画图」，
        # 反过来劝用户另跑一次 ETF 当对照（真机测试里出现过）。
        "outputs": {
            "benchmark": {
                "by_market": [{"market": MARKETS[k].label, "label": s.label}
                              for k, s in INDEX_BENCHMARKS.items() if k in MARKETS],
                "note": "对照基准按标的所在市场自动选，不是参数，不需要也不能另外指定；"
                        "用户要求和这些指数比时直接运行即可。取不到时退回成所测标的自身的等权买入持有，返回的披露里会写明。",
            },
            "charts": {
                "items": ["累计收益：策略对基准", "水下回撤", "月度收益", "年度收益"],
                "note": "界面按本次运行的逐日净值自动画这几张图，放在报告下方，不是参数。"
                        "逐日序列不会交给你：报告里只引用返回的 metrics 和 tables 里的数，不要描述图上没有给你的数。",
            },
            "tables": "返回里有月度收益、年度收益（含基准）、最深几段回撤，以及稳健性检验和邻近参数的敏感度。",
            "cost_compare": "每次都附带扣费前后对照：同一套信号把费用和滑点设为零再跑一遍的总收益、年化、最大回撤、夏普、成交笔数，"
                            "以及 drag（成本吃掉的收益，小数，0.05 = 5 个百分点）。用来说明交易成本有多重，不是能做到的收益。",
            "multiple_codes": "一次运行里的多只标的合成一个等权组合，只给组合的表现；要分别看每只，需要每只单独运行一次。"
                              "不同市场的标的不能放进同一次运行；A股只支持个股，ETF、指数、可转债会被拒绝。",
        },
    }


def _plan_view(p: Plan) -> dict:
    return {"codes": p.codes, "market": p.market.label, "engine": p.market.engine,
            "style": p.style.label, "start": p.start, "end": p.end,
            "currency": p.market.currency,
            "limits": p.limits, "notes": p.notes}


def _robustness(m: dict) -> dict:
    """稳健性检验的概括。重抽样的 1000 个样本值不往外带（太大，也没人看）。"""
    v = m.get("validation") or {}
    out: dict = {}
    bs = v.get("bootstrap")
    if isinstance(bs, dict):
        # n_valid：夏普算得出的样本数（全是同一个收益的样本没有夏普，不计入）。区间和为正比例的分母是它，
        # 不是请求的抽样次数（Codex 审计 2026-10-09 D12）
        out["bootstrap_sharpe"] = {"error": bs["error"]} if "error" in bs else {
            **{k: bs.get(k) for k in ("ci_lower", "ci_upper", "prob_positive", "confidence", "n_bootstrap")},
            "n_valid": bs.get("n_valid", bs.get("n_bootstrap"))}
    wf = v.get("walk_forward")
    if isinstance(wf, dict):
        out["segments"] = {"error": wf["error"]} if "error" in wf else {
            k: wf.get(k) for k in ("n_windows", "windows", "profitable_windows", "consistency_rate")}
    return out


def _result_view(r: Result, charts: bool = False, sensitivity: dict | None = None, costs: dict | None = None) -> dict:
    """``charts=True`` 时附上逐日序列（界面画图用）。它很大，Agent 那条路不带。"""
    m = r.metrics
    keep = ("total_return", "annual_return", "max_drawdown", "sharpe", "calmar", "sortino",
            "win_rate", "profit_loss_ratio", "profit_factor", "trade_count",
            "avg_holding_days", "benchmark_return", "benchmark_ticker", "benchmark_label", "hold_return",
            "excess_return", "information_ratio", "tracking_error", "benchmark_beta",
            "total_turnover", "max_consecutive_loss", "execution_fees", "fill_count",
            # 补充指标（report_data.extended_metrics）
            "annual_volatility", "longest_drawdown_bars", "exposure_time", "avg_gross_exposure",
            "best_day", "worst_day", "best_month", "worst_month", "positive_month_ratio",
            "best_year", "worst_year", "skew", "kurtosis", "var_95", "cvar_95", "ulcer_index",
            "expectancy", "expectancy_pct", "largest_win", "largest_loss", "sqn", "fees_pct_of_initial",
            # 期末卖不出去的持仓完整清单(披露里超过 5 只只列前 5 只)
            "unsettled_positions")
    benchmark_is_self = "benchmark_ticker" not in m
    disclosures = [price_basis(r.plan.market.key),
                   "费率为固定假设，未建模历史费率调整及不同券商差异。",
        "trade_count 是平仓记录数（含部分数量结算），不是买卖成交笔数；fill_count 才是实际执行的成交记录数。",
                   "夏普比率采用零无风险利率；平均持有期按交易 bar 计，不是自然日。无亏损、零回撤、没有平仓交易或净值没有波动时，对应无定义比率（盈亏比、卡玛、胜率、夏普等）显示为未定义，不是 0。"
                   "VaR / CVaR 是历史日收益的 5% 分位与其以下均值；SQN 按每笔平仓盈亏计算；回撤时长按交易日计。"]
    robustness = _robustness(m)
    if robustness or sensitivity:
        disclosures.append(
            "稳健性检验：夏普区间按日收益独立重抽样估计，忽略收益的前后相关；分段检验是把同一条净值切成几段分别看，"
            "不是重新优化参数的样本外检验；参数敏感度只看同一段历史里邻近参数的结果是否稳定，不代表最优参数，也不代表未来表现。")
    if "execution_fees" in m:
        disclosures.append(
            f"execution_fees 是引擎逐笔成交记录中实际扣除的费用合计，单位 {r.plan.market.currency}；"
            "包含回测最后一天平仓的费用（卖不出去、留着按市值计的持仓不扣卖出费用），不包含滑点损耗或独立资金费用；这些费用已计入净值，不应再次扣减收益。"
            "滑点通过引擎成交价格模型反映在净值中，不属于 execution_fees，不代表回测未计滑点。"
        )
    if benchmark_is_self:
        disclosures.append("本次基准是所测标的自身的等权买入持有，不是独立外部基准。")
    else:
        filled = m.get("benchmark_filled_bars")
        disclosures.append(INDEX_BASIS + (
            f"对照有 {filled} 个回测交易日没有自己的报价，沿用前一交易日收盘。" if isinstance(filled, int) and filled > 0 else ""))
    for sym, s in sorted((m.get("stale_price_marks") or {}).items()):
        disclosures.append(
            f"{sym} 在 {s['from']} 至 {s['to']} 之间有 {s['bars']} 个交易日超过补齐上限仍没有报价（停牌或数据源缺行），"
            "持仓按最后一个收盘价估值；这几天的净值、回撤和下单规模不反映它的真实涨跌。")
    # 期末卖不出去的持仓并成一条（披露条数和单条长度都有上限，不能一只一条）
    unsettled: dict[str, list[str]] = {}
    for sym, reason in sorted((m.get("unsettled_positions") or {}).items()):
        unsettled.setdefault(reason, []).append(sym)
    if unsettled:
        parts = [f"{'、'.join(syms[:5])}{f' 等 {len(syms)} 只' if len(syms) > 5 else ''}（{reason}）"
                 for reason, syms in unsettled.items()]
        disclosures.append(
            f"回测最后一天有 {sum(map(len, unsettled.values()))} 只持仓没有平仓：{'；'.join(parts)}。"
            "这些持仓按最后一天收盘价计入期末净值、没扣卖出费用；胜率、盈亏比、交易次数等按平仓记录算的指标不含它们。")
    turnover = m.get("total_turnover")
    if isinstance(turnover, (int, float)) and turnover < 1:
        disclosures.append(
            f"总换手率为 {turnover}；该值低于 1，收益差异可能包含未投入现金的影响，不能只归因于策略信号。"
        )
    # 运行后才发现的限制必须进入服务端强制披露；静态口径仍在 plan.notes。
    # 不截断：超出下游披露契约时明确拒绝报告，不能悄悄丢掉风险提示。
    disclosures.extend(note for note in r.notes if note not in r.plan.notes)
    disclosures = list(dict.fromkeys(disclosures))
    report = r.report or {}
    view = {
        "strategy": r.strategy,
        "plan": _plan_view(r.plan),
        # 只挑界面要用的,并**原样透传** —— 不在这里做换算或四舍五入,
        # 免得同一个数在报告与界面上不一致
        "metrics": {k: m[k] for k in keep if k in m},
        # 基准是**等权买入持有这几只标的本身**,除非 metrics 里带了 benchmark_ticker
        "benchmark_is_self": benchmark_is_self,
        "benchmark": None if r.benchmark is None else {
            "ticker": r.benchmark.code, "label": r.benchmark.note, "endpoint": r.benchmark.endpoint,
            "rows": r.benchmark.rows, "first_bar": r.benchmark.first_bar, "last_bar": r.benchmark.last_bar,
        },
        "required_disclosures": disclosures,
        "missing": r.missing,
        "provenance": [
            {"code": p.code, "endpoint": p.endpoint, "rows": p.rows,
             "first_bar": p.first_bar, "last_bar": p.last_bar, "note": p.note,
             "price_basis": p.price_basis or price_basis(p.market)}
            for p in r.provenance.values()
        ],
        # 月度 / 年度表与最深 5 段回撤：数值读自引擎写出的 equity.csv
        "tables": {k: report[k] for k in ("monthly", "yearly", "drawdowns") if k in report},
        "robustness": robustness,
        "sensitivity": sensitivity,
        # 扣费前后对照（cost_compare.py）：不计成本那次的几个数 + 成本吃掉多少
        "cost_compare": costs,
    }
    if charts and report.get("charts"):
        # 放在 ui_only 下：编排层交给 Agent 前会整块去掉（逐日序列太大，对写报告也没用）
        view["ui_only"] = {"charts": report["charts"]}
    return view


def main() -> None:
    # 🔴 **必须在打任何 JSON 之前**：中文 Windows 的管道默认 GBK，
    #    含 \xa0 会当场崩、其余中文会变成 Node 按 UTF-8 读不懂的字节（上游 issue #27）。
    force_utf8_stdio()
    raw = sys.stdin.read()
    try:
        req: dict[str, Any] = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"入参不是合法 JSON:{exc}"}, ensure_ascii=False))
        return

    if not isinstance(req, dict):
        print(json.dumps({"ok": False, "error": "入参必须是 JSON 对象"}, ensure_ascii=False))
        return
    if req.get("action") == "catalog":
        print(json.dumps({"ok": True, "catalog": _catalog()}, ensure_ascii=False))
        return

    try:
        plan = plan_backtest(
            codes=req.get("codes") or [],
            start=str(req.get("start") or ""),
            end=str(req.get("end") or ""),
            style=str(req.get("style") or "swing"),
            initial_cash=req.get("initial_cash", 1_000_000),
            allow_short=bool(req.get("allow_short")),
        )
        if not isinstance(plan, Plan):
            # 闸口拦住 ≠ 出错。把 reason / remedy 原样交给界面。
            return print(json.dumps(
                {"ok": False, "refused": {"reason": plan.reason, "remedy": plan.remedy}},
                ensure_ascii=False))

        key = str(req.get("strategy") or "buy_and_hold")
        if key not in BUILTIN:
            return print(json.dumps(
                {"ok": False, "error": f"没有这个策略:{key}(可用:{', '.join(BUILTIN)})"},
                ensure_ascii=False))
        strategy = BUILTIN[key](**(req.get("params") or {}))

        # 🔴 引擎会往 stdout 打整份 metrics JSON —— 不接住的话,
        #    我们这份 JSON 前面会多出一坨,调用方 parse 直接失败。
        buf = io.StringIO()
        with tempfile.TemporaryDirectory(prefix="vra-backtest-") as scratch:
            with contextlib.redirect_stdout(buf):
                loader = VibeLoader(out_dir=Path(scratch) / "data")
                result = run(plan, strategy, run_dir=Path(scratch) / "main", loader=loader)
                # 扣费前后对照放在网格前面：只多跑一次，不该被网格的时间上限挤掉
                costs = cost_compare(plan, key, req.get("params") or {}, loader, Path(scratch) / "free", result.metrics)
                # 同一份已缓存的数据上重跑邻近参数；只对两参数的内置策略做
                grid = run_grid(plan, key, req.get("params") or {}, loader, Path(scratch) / "grid")
                view = _result_view(result, charts=req.get("charts") is True, sensitivity=grid, costs=costs)
        print(json.dumps({"ok": True, "result": view}, ensure_ascii=False))

    except BacktestNotValid as exc:
        # 运行期守卫拦下的,与闸口同一类结论(数据到手后才知道的那部分)
        print(json.dumps({"ok": False, "refused": {"reason": str(exc), "remedy": "按上面的说明调整参数再试"}},
                         ensure_ascii=False))
    except (ValueError, TypeError, LoaderError) as exc:
        print(json.dumps({"ok": False, "error": _public_error(exc)}, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        # These two messages are the engine's explicit data-failure contract.
        known_data_failure = isinstance(exc, RuntimeError) and str(exc).startswith(
            ("没有取到可用于回测的数据；", "回测数据不完整（"))
        error = _public_error(exc) if known_data_failure else f"回测内部执行失败（{type(exc).__name__}），本次没有生成有效结果。"
        print(json.dumps({"ok": False, "error": error}, ensure_ascii=False))


if __name__ == "__main__":
    main()
