"""大宗温度计(注册表第 13 层产业温度计的原材料维度):研究标的上游的原料价格,按产业标签挂载。

两个端点(看板信息源移植第 3 项,2026-08-24):
  - cn_commodity_futures(tag ai_compute):新浪期货连续合约日线(akshare)——沪铜 / 沪锡 / 沪铝 / 沪镍 / 工业硅,
    每个品种给最新收盘 + 1 日 / 约 1 周 / 约 1 月涨跌。这些是 PCB 铜箔、焊料、散热结构件、MLCC 电极的成本输入。
  - dram_spot_thermo(tag storage_memory):DDR5 / DDR4 / NAND TLC 现货均价(GitHub 社区仓对 DRAMeXchange 的每日转录)。

🔴 读法护栏(原样进证据 note,报告里必须与数字同段):
  - 期货价 = **全市场定价,不是本公司采购价**;传导到毛利有季度级滞后 + 长约与套保平滑;单日波动是噪音,看 30 日方向。
  - 工业硅需求由光伏主导,对半导体是**弱信号**,别当半导体景气读。
  - DRAM 序列来自**社区转录的 DRAMeXchange 存档,不是官方一手**,可能有转录误差与停更;
    DRAM 现货是 HBM 的**影子指标**(产能排挤联动),**不是 HBM 价格**——HBM 走年度长约,无公开现货价。

纪律:
  - 逐品种 / 逐数据源隔离失败,全失败才抛;解析不出任何一行 = 结构变了必须抛(不当"没数据")。
  - 资料陈旧(最新日期距今超过阈值)如实标进 note 并降级 partial,绝不外推、绝不用旧值冒充当前。
"""
from __future__ import annotations

import json
import re
import urllib.request
from datetime import datetime, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo

from sources._http import dump_json_bytes, record_raw

# 品种:(中文名, 单位, 用途 = 为什么它对这条产业链重要)
FUTURES = {
    "CU0": ("沪铜", "元/吨", "PCB 铜箔 / 铜缆 / 液冷管路 / 电力电缆"),
    "SN0": ("沪锡", "元/吨", "焊料凸点与 BGA 焊球(所有封装焊接)"),
    "AL0": ("沪铝", "元/吨", "液冷散热器 / 机箱 / 结构件"),
    "NI0": ("沪镍", "元/吨", "MLCC 电极浆料 / 合金"),
    "SI0": ("工业硅", "元/吨", "硅基半导体源头;⚠️ 需求由光伏主导,对半导体是弱信号"),
}
FUT_GUARD = ("读法:期货价是全市场定价不是本公司采购价;传导到毛利有季度级滞后并被长约与套保平滑;"
             "单日波动是噪音,看 30 日方向;工业硅需求由光伏主导,对半导体是弱信号")
DRAM_GUARD = ("读法:序列来自社区转录的 DRAMeXchange 存档,不是官方一手(可能有转录误差与停更);"
              "DRAM 现货是 HBM 的影子指标(产能排挤联动),不是 HBM 价格——HBM 走年度长约无公开现货价")

DRAM_SOURCES: list[dict[str, Any]] = [
    {"key": "DDR5", "url": "https://raw.githubusercontent.com/nlee756525/dram-prices/main/history.json",
     "path": "ddr5", "avg": "session_avg", "product": None},
    {"key": "NAND_TLC", "url": "https://raw.githubusercontent.com/nlee756525/dram-prices/main/history.json",
     "path": "tlc", "avg": "session_avg", "product": None},
    {"key": "DDR4", "url": "https://raw.githubusercontent.com/titled-agent-001/ddr4-pricing-log/main/ddr4-pricing.json",
     "path": "logs", "avg": "session_average", "product": "product"},
]
STALE_DAYS_FUT = 10     # 期货:超过 10 个自然日没有新交易日数据 = 异常(长假最多 9 天)
STALE_DAYS_DRAM = 14    # DRAM 社区仓:周更 / 偶尔停更,超过 14 天视为陈旧
WINDOW_POINTS = 120     # 期货:统计与 raw 共用的窗口(覆盖 30 日回看绰绰有余),保证每个证据数字都能从 raw_ref 复核


class CommodityError(RuntimeError):
    pass


def _sh_today(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(ZoneInfo("Asia/Shanghai"))).strftime("%Y-%m-%d")


_MONEY_RE = re.compile(r"^\$?([0-9]+(?:\.[0-9]+)?)$")


def _norm_date(s: object) -> Optional[str]:
    """'2026-08-24' 或 '8/21/2026' → ISO;都不是就 None(不猜)。"""
    s = str(s or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        try:
            datetime.fromisoformat(s)
            return s
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if not m:
        return None
    mo, dd, yy = (int(x) for x in m.groups())
    try:
        return datetime(yy, mo, dd).strftime("%Y-%m-%d")
    except ValueError:
        return None


def _norm_price(v: object) -> Optional[float]:
    if isinstance(v, (int, float)):
        return float(v)
    m = _MONEY_RE.match(str(v or "").strip().replace(",", ""))
    return float(m.group(1)) if m else None


def _pct(new: float, old: float) -> Optional[float]:
    return round((new / old - 1) * 100, 2) if old else None


def _days_between(a: str, b: str) -> int:
    return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).days


def _valid_point(d: object, v: object, today: str) -> Optional[tuple[str, float]]:
    """行级校验(Codex commodity-r1):日期必须真实且不晚于今天;价格必须是有限正数。任一不合格 → 丢这一行(不让整品种失败,也不让 inf / 负值 / 未来日进证据)。"""
    ds = _norm_date(d)
    if not ds or ds > today:
        return None
    try:
        fv = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    import math
    if not math.isfinite(fv) or fv <= 0:
        return None
    return (ds, fv)


def _back(series: list[tuple[str, float]], days: int, slack: int) -> Optional[tuple[str, float, int]]:
    """回看基点:在 [days-slack, days+slack] 里取**距目标最近**的历史点,返回 (基点日, 值, 实际跨度)。
    只往更早方向找会漏掉合格基点(Codex commodity-r3:周更序列 08-15 距今 6 天在 7±3 内,却因"必须 ≤ 目标日"被排除,
    退到 08-08 的 13 天又超容差 → 该指标凭空消失)。窗口内一个点都没有 → 返回最近的更早点供调用方记 skipped_windows。"""
    if len(series) < 2:
        return None
    latest_d = series[-1][0]
    inwin = [(d, v, _days_between(d, latest_d)) for d, v in series[:-1] if abs(_days_between(d, latest_d) - days) <= slack]
    if inwin:
        return min(inwin, key=lambda x: (abs(x[2] - days), -x[2]))  # 距目标最近;并列取更早的那个(跨度更足)
    older = [(d, v, _days_between(d, latest_d)) for d, v in series[:-1] if _days_between(d, latest_d) > days + slack]
    return older[-1] if older else None


# 窗口容差用**加法**不用倍数(Codex commodity-r2:2 倍容差下 60 天变化仍会被标成"约 30 日",note 写了实际跨度也消不掉字段名与展示标签的误导)
SPAN_SLACK = {7: 3, 30: 5}  # 7 日窗口最多认到 10 天,30 日窗口最多认到 35 天;超出 → 不生成该指标,记进 skipped_windows


def _stats(series: list[tuple[str, float]], today: str, stale_days: int) -> dict:
    latest_d, latest_v = series[-1]
    prev = series[-2] if len(series) >= 2 else None
    age = _days_between(latest_d, today)
    st: dict = {
        "date": latest_d, "price": latest_v, "n_points": len(series), "age_days": age, "stale": age > stale_days,
        "span": f"{series[0][0]}..{latest_d}", "skipped_windows": [],
    }
    if prev is not None:
        st["chg1_pct"] = _pct(latest_v, prev[1])
        st["chg1_basis"] = prev[0]
        st["chg1_gap_days"] = _days_between(prev[0], latest_d)  # 周更序列上"上一点"可能是 7 天前,如实标
    for days, key in ((7, "chg7"), (30, "chg30")):
        b = _back(series, days, SPAN_SLACK[days])
        if not b:
            continue
        bd, bv, gap = b
        if abs(gap - days) > SPAN_SLACK[days]:
            st["skipped_windows"].append({"window_days": days, "basis_date": bd, "actual_gap_days": gap})
            continue
        st[f"{key}_pct"] = _pct(latest_v, bv)
        st[f"{key}_basis"] = bd
        st[f"{key}_gap_days"] = gap
    return st


def cn_commodity_futures(symbols: str = "CU0,SN0,AL0,NI0,SI0", now: Optional[datetime] = None) -> dict:
    """新浪期货连续合约日线(akshare):逐品种隔离失败,全失败才抛。DataFrame 非传输层原文 → record_raw(kind=extracted)。"""
    import akshare as ak

    today = _sh_today(now)
    out, errors = [], []
    for sym in [s.strip().upper() for s in symbols.split(",") if s.strip()]:
        name, unit, use = FUTURES.get(sym, (sym, "元/吨", "未标注用途"))
        try:
            df = ak.futures_zh_daily_sina(symbol=sym)
            dates, closes = list(df["date"].tolist()), list(df["close"].tolist())
            if len(dates) != len(closes):
                raise CommodityError(f"{sym}:date / close 列长度不一致(接口结构变了)")
            rows, dropped = [], 0
            for d, c in zip(dates, closes):
                p = _valid_point(str(d)[:10], c, today)
                if p:
                    rows.append(p)
                else:
                    dropped += 1
            if not rows:
                raise CommodityError(f"{sym}:{len(dates)} 行里没有一行是合法(日期 + 有限正数收盘)(接口结构变了或品种下线)")
            rows.sort(key=lambda x: x[0])
            # raw 与统计**同一窗口**(Codex commodity-r1:只存 60 行却按全序列写 n_points / span,raw_ref 复核不了)
            rows = rows[-WINDOW_POINTS:]
            raw_ref = record_raw(dump_json_bytes({"symbol": sym, "source": "akshare futures_zh_daily_sina", "window_points": len(rows),
                                                  "dropped_rows": dropped, "rows": rows}),
                                 "json", f"akshare://futures_zh_daily_sina/{sym}", kind="extracted")
            st = _stats(rows, today, STALE_DAYS_FUT)
            out.append({"symbol": sym, "name": name, "unit": unit, "use": use, "raw_ref": raw_ref, "dropped_rows": dropped, **st})
        except Exception as e:  # noqa: BLE001 — 逐品种隔离
            errors.append(f"{sym}: {type(e).__name__}: {str(e)[:140]}")
    if not out:
        raise CommodityError("期货温度计全部失败:" + "; ".join(errors))
    return {"today": today, "items": out, "errors": errors, "guard": FUT_GUARD}


def dram_spot_thermo(now: Optional[datetime] = None) -> dict:
    """DDR5 / NAND TLC / DDR4 现货均价(GitHub 社区仓转录的 DRAMeXchange)。逐源隔离,全失败才抛。"""
    today = _sh_today(now)
    cache: dict[str, tuple[dict, Optional[str]]] = {}
    out, errors = [], []
    for src in DRAM_SOURCES:
        try:
            if src["url"] not in cache:
                req = urllib.request.Request(src["url"], headers={"User-Agent": "Mozilla/5.0"})
                body = urllib.request.urlopen(req, timeout=30).read()
                payload = json.loads(body)
                if not isinstance(payload, dict):
                    raise CommodityError("社区仓返回的不是 JSON 对象(结构变了)")
                cache[src["url"]] = (payload, record_raw(body, "json", src["url"]))
            payload, raw_ref = cache[src["url"]]
            rows = payload.get(src["path"])
            if not isinstance(rows, list) or not rows:
                raise CommodityError(f"社区仓缺 {src['path']} 序列或为空(结构变了)")
            series, dropped = [], 0
            for r in rows:
                p = _valid_point(r.get("date"), _norm_price(r.get(src["avg"])), today)
                if p:
                    series.append(p)
                else:
                    dropped += 1
            if not series:
                raise CommodityError(f"{src['key']}:{len(rows)} 行里没有一行是合法(日期不晚于今天 + 有限正数均价)(字段名变了)")
            series.sort(key=lambda x: x[0])
            product = str(payload.get(src["product"]) or "") if src["product"] else ""
            out.append({"key": src["key"], "product": product or "规格未在数据中标明(以社区仓 README 为准)",
                        "unit": "美元/颗", "source_url": src["url"], "raw_ref": raw_ref, "dropped_rows": dropped,
                        **_stats(series, today, STALE_DAYS_DRAM)})
        except Exception as e:  # noqa: BLE001 — 逐源隔离
            errors.append(f"{src['key']}: {type(e).__name__}: {str(e)[:140]}")
    if not out:
        raise CommodityError("DRAM 温度计全部失败:" + "; ".join(errors))
    return {"today": today, "items": out, "errors": errors, "guard": DRAM_GUARD}
