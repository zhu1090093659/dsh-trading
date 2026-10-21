#!/usr/bin/env python3
"""KDAS 关键日 Anchored VWAP 复算（与 DSH Trading 自定义指标 `kdas` 同算法）。

指标口径（源：~/.dsh-trading/indicators/custom.json，2026-09-13 读取）：
  每条关键日 kd（YYYYMMDD）= 自「第一根交易日 >= kd 的 K 线」起算的成交量加权均价线：
      TP = (high + low + close) / 3 ;  AVWAP = Σ(TP × volume) / Σ(volume)
  最多 8 条；锚点之前不渲染；读数保留 3 位小数。默认含当日未完成日 K（该根量能仍在累积，
  读数随盘中变动）；只算已完成日 K 时加 --drop-last。

用法：
  python3 kdas.py --market cn --symbol 002714.SZ --keys 20250821,20240924,20260905,20260825,20260317,20260625,20260512
  python3 kdas.py --market hk --symbol 00700.HK --keys 20251001,20250407,20240923,20260422,20260805,20260830 --klines-file /tmp/hk00700.json
可选：--bars N（默认 900）、--drop-last（只算已完成日 K 时剔除最后一根）、--json

关键日必须取自 indicator_list → custom[kdas].symbolParams["<market>:<symbol>"]（权威现场值），
不要引用任何文档里的旧关键日。本脚本只读复算，不写指标参数。
"""

import argparse
import json
import sys
import urllib.request

TENCENT_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},day,,,{bars},qfq"


def tencent_code(market: str, symbol: str) -> str:
    s = symbol.strip().upper()
    if market == "hk":
        digits = "".join(ch for ch in s.split(".")[0] if ch.isdigit())
        return "hk" + digits.zfill(5)
    code, _, suffix = s.partition(".")
    if suffix in ("SH", "SZ", "BJ"):
        return suffix.lower() + code
    if code.startswith(("6", "5", "9")):
        return "sh" + code
    if code.startswith(("0", "1", "2", "3")):
        return "sz" + code
    if code.startswith(("4", "8")):
        return "bj" + code
    raise SystemExit(f"无法推断 {symbol} 的交易所前缀（cn），请写全 600519.SH / 002714.SZ 形式")


def fetch_tencent(market: str, symbol: str, bars: int):
    url = TENCENT_URL.format(code=tencent_code(market, symbol), bars=bars)
    with urllib.request.urlopen(url, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    node = payload.get("data", {}).get(tencent_code(market, symbol), {})
    rows = node.get("qfqday") or node.get("day") or []
    if not rows:
        raise SystemExit(f"公开端点未返回日 K（{market} {symbol}）；改用工具取数 + --klines-file")
    # 腾讯行序：[date, open, close, high, low, volume]
    out = []
    for r in rows:
        try:
            date, o, c, h, l, v = r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])
        except (IndexError, TypeError, ValueError):
            continue
        # 图表 KDAS 用 openTime 的 UTC 日做「交易日」判定；港股日 K 的 openTime 落在 HKT 零点
        # （即前一日 16:00Z），故港股需回退一天才能与图表锚定结果一致。
        day = date if market == "cn" else _shift_day(date, -1)
        out.append({"date": date, "day": day, "open": o, "close": c, "high": h, "low": l, "volume": v})
    return out


def normalize_rows(raw):
    """接受：工具输出（openTime/open/high/low/close/volume）、腾讯行、或 {date,o,h,l,c,v} 字典。"""
    import datetime as dt

    rows = []
    for item in raw:
        if isinstance(item, dict):
            key = item.get("date")
            if key is None and item.get("openTime") is not None:
                key = dt.datetime.fromtimestamp(item["openTime"] / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
            if key is None and item.get("time") is not None:
                key = str(item["time"])[:10]
            o = item.get("open"); h = item.get("high"); l = item.get("low"); c = item.get("close")
            v = item.get("volume", 0)
        elif isinstance(item, (list, tuple)) and len(item) >= 6:
            key, o, c, h, l, v = item[0], item[1], item[2], item[3], item[4], item[5]
        else:
            continue
        try:
            label = str(key)[:10]
            rows.append({"date": label, "day": label, "open": float(o), "high": float(h),
                         "low": float(l), "close": float(c), "volume": float(v)})
        except (TypeError, ValueError):
            continue
    rows.sort(key=lambda r: r["day"])
    return rows


def _shift_day(date: str, days: int) -> str:
    import datetime as dt
    d = dt.date.fromisoformat(str(date)[:10]) + dt.timedelta(days=days)
    return d.isoformat()


def daynum(date: str) -> int:
    return int(date.replace("-", "").replace("/", "")[:8])


def kdas_lines(rows, keys):
    """复刻指标算法：锚点 = 第一根 daynum >= kd 的 K 线；锚点起 TP×V 的加权均价。"""
    lines = []
    for kd in keys:
        anchor = next((i for i, r in enumerate(rows) if daynum(r["day"]) >= kd), None)
        if anchor is None:
            lines.append({"key_day": kd, "anchored_at": None, "value": None, "bars_since": 0,
                          "truncated": False, "note": "未生效（关键日晚于最新 K 线）"})
            continue
        if anchor == 0 and daynum(rows[0]["day"]) > kd:
            # 窗口起点已晚于关键日：真锚点不在数据内，任何数值都是错的 → 拒绝输出（fail-closed）
            lines.append({"key_day": kd, "anchored_at": rows[0]["date"], "value": None,
                          "bars_since": len(rows), "truncated": True,
                          "note": "锚点被截断（窗口起点晚于关键日），请加大 --bars 或补更早日 K"})
            continue
        acc_a = acc_v = 0.0
        for r in rows[anchor:]:
            v = r["volume"] if r["volume"] > 0 else 0.0
            acc_a += (r["high"] + r["low"] + r["close"]) / 3.0 * v
            acc_v += v
        value = acc_a / acc_v if acc_v > 0 else None
        lines.append({"key_day": kd, "anchored_at": rows[anchor]["date"],
                      "anchored_label": rows[anchor]["day"], "truncated": False, "note": "",
                      "value": round(value, 3) if value is not None else None,
                      "bars_since": len(rows) - anchor})
    return lines


def main() -> int:
    ap = argparse.ArgumentParser(description="KDAS 关键日 Anchored VWAP 复算")
    ap.add_argument("--market", choices=["cn", "hk"], required=True)
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--keys", required=True, help="逗号分隔的 YYYYMMDD（取自 indicator_list 现场值）")
    ap.add_argument("--klines-file", help="日 K JSON（工具输出或腾讯行）；给出则不联网")
    ap.add_argument("--bars", type=int, default=900, help="联网取数根数上限（默认 900）")
    ap.add_argument("--drop-last", action="store_true",
                    help="保守开关：只算已完成日 K 时用，剔除最后一根")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    keys = []
    for tok in args.keys.split(","):
        tok = tok.strip()
        if not tok or tok == "0":
            continue
        if len(tok) != 8 or not tok.isdigit():
            raise SystemExit(f"关键日格式应为 YYYYMMDD：{tok}")
        if int(tok) not in keys:
            keys.append(int(tok))
    if not keys:
        raise SystemExit("未提供有效关键日（kd 全为 0 时 G3 不可判：需先指定关键日）")

    if args.klines_file:
        with open(args.klines_file, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict):
            raw = raw.get("data") or raw.get("klines") or []
        rows = normalize_rows(raw)
        source = f"file:{args.klines_file}"
    else:
        rows = fetch_tencent(args.market, args.symbol, args.bars)
        source = "tencent-public(qfq)"
    if args.drop_last and rows:
        rows = rows[:-1]
    if not rows:
        raise SystemExit("无可用日 K")

    lines = kdas_lines(rows, keys)
    last = rows[-1]
    close = last["close"]
    for ln in lines:
        if ln["value"] is None:
            ln["side"] = "锚点截断" if ln.get("truncated") else "未生效"
            ln["distance_pct"] = None
        else:
            ln["side"] = "价格在上" if close >= ln["value"] else "价格在下"
            ln["distance_pct"] = round((close - ln["value"]) / ln["value"] * 100.0, 2)
    effective = [ln for ln in lines if ln["value"] is not None]
    above = sorted([ln for ln in effective if ln["value"] <= close], key=lambda x: -x["value"])
    below = sorted([ln for ln in effective if ln["value"] > close], key=lambda x: x["value"])

    result = {
        "market": args.market, "symbol": args.symbol, "source": source,
        "bars": len(rows), "first_bar": rows[0]["date"], "last_bar": last["date"], "last_bar_label": last["day"],
        "last_close": close, "keys": keys, "lines": lines,
        "nearest_support": above[0] if above else None,
        "nearest_resistance": below[0] if below else None,
        "discipline": "默认含当日未完成日 K（该根量能累积中，读数随盘中变动）；--drop-last 只算已完成日 K。KDAS 是执行层（买点分层），破位只触发复核假设，不自动清仓。",
        "parity_note": "cn 与图表同源（routed=tencent）；hk 用腾讯公开源属异源复算（图表走 futu），差异可能来自复权口径——决策卡在线上时以图表读数为准，或改用 --klines-file 传 futu 日 K。",
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print(f"KDAS 复算 · {args.market}:{args.symbol} · 源={source}")
    print(f"日 K：{len(rows)} 根（{rows[0]['date']} → {last['date']}）  最新收盘 {close}  锚定标签制：{last['day']}")
    print(f"{'关键日':<10}{'锚定于':<12}{'KDAS':>12}{'价距%':>9}  位置")
    for ln in sorted(lines, key=lambda x: (x["value"] is None, x["value"] or 0)):
        v = "—" if ln["value"] is None else f"{ln['value']:.3f}"
        d = "—" if ln["distance_pct"] is None else f"{ln['distance_pct']:+.2f}"
        print(f"{ln['key_day']:<10}{(ln['anchored_at'] or '—'):<12}{v:>12}{d:>9}  {ln['side']}")
    ns, nr = result["nearest_support"], result["nearest_resistance"]
    print("最近下方线（支撑）：" + (f"{ns['key_day']} → {ns['value']:.3f}（{ns['distance_pct']:+.2f}%）" if ns else "无"))
    print("最近上方线（压力）：" + (f"{nr['key_day']} → {nr['value']:.3f}（{nr['distance_pct']:+.2f}%）" if nr else "无"))
    truncated = [ln for ln in lines if ln.get("truncated")]
    if truncated:
        print("警告：" + "；".join(f"{ln['key_day']} " + ln["note"] for ln in truncated))
    print("注意：" + result["parity_note"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
