# indicator_get_values 现场取证（A 交付证据）

交付物：`indicator_get_values`（host 平面，`@dshtrading/indicators/plugin` 注册）。
本文所有数字都是**现场跑出来的**，不是抄文档的：关键日从 `~/.dsh-trading/indicators/chart.json`
（只读）现读，日 K 从 profile 路由的 tencent provider 现取，指标算法跑指标自己的 `computeSource`。

## 0. 复现命令

```bash
cd /Users/zcl/code/.worktrees/dsh-trading/ft-dp-kdas-jin10
pnpm -r build                                    # 依赖包产物（dsh-home / connector-tencent / bot-api / indicators）
DSH_HOME=$HOME/.dsh-trading node spikes/impl-kdas-values/run.mjs > /tmp/kdas-evidence.json
# python 侧复算（同一份日 K，同一 openTime→UTC 日口径）
python3 .agents/skills/weekly-trading-plan/scripts/kdas.py --market cn --symbol 002714.SZ --keys <现场关键日> --klines-file /tmp/<dump>.json --json
# python 侧公开端点路径（不传 --klines-file，联网取腾讯公开 qfq）
python3 .agents/skills/weekly-trading-plan/scripts/kdas.py --market cn --symbol 002714.SZ --keys 20250821,20240924,20260626,20261014 --json
python3 .agents/skills/weekly-trading-plan/scripts/kdas.py --market hk --symbol 00700.HK --keys 20240919,20260423,20260813,20260922,20260929 --json
```

`run.mjs` 跑的是**生产代码**：`packages/indicators/lib/plugin.js` 的 file store（真实
`$DSH_HOME` 路径）、`createIndicatorValuesTool`、`connector-tencent` 的 `TencentRestClient`、
以及桥自己的候选解析实现 `TradingBridge.klines()`（直调同一实现，非 HTTP 传输面）。
它是只读的：不写任何 store；导出的日 K JSON 落在系统临时目录并在结束时删除。

## 1. 现场权威值（chart.json，只读）

- store 路径：`/Users/zcl/.dsh-trading/indicators/custom.json`（`DSH_HOME` 校验：路径含 `.dsh-trading` 才继续，防止误读宿主 `~/.dsh`）
- kdas 实例全局 params：`{"kd1":0,"kd2":0,"kd3":0,"kd4":0,"kd5":0,"kd6":0,"kd7":0,"kd8":0}`
- kdas 实例 `symbolParams` 作用域数：`13` → `hk:00700.HK / cn:002714.SZ / hk:02714.HK / cn:159869.SZ / cn:513050.SH / cn:001201.SZ / cn:517520.SH / us:PURR / us:GOOGL / crypto:XAUTUSDT / crypto:HYPEUSDT / us:AAPL / cn:159915.SZ`
- 本次用到的三个标的的现场覆盖值与「谁生效」：

| 标的 | 现场 symbolParams（非 0 项） | 生效作用域 | 生效关键日 |
|---|---|---|---|
| cn:002714.SZ | `{"kd1":20250821,"kd2":20240924,"kd3":20260626,"kd5":20261014}` | cn:002714.SZ | [20250821,20240924,20260626,20261014] |
| cn:159869.SZ | `{"kd1":20250214,"kd2":20241008,"kd3":20261009,"kd4":20260508,"kd5":20260724,"kd6":20260911}` | cn:159869.SZ | [20250214,20241008,20261009,20260508,20260724,20260911] |
| hk:00700.HK | `{"kd1":20240919,"kd2":20260423,"kd3":20260922,"kd4":20260929,"kd5":20260813}` | hk:00700.HK | [20240919,20260423,20260922,20260929,20260813] |

## 2. 关键日来源与覆盖语义

- `keys_source=symbolParams`：关键日整体取 `symbolParams["${market}:${symbol}"]`（命中即整体替代全局
  params，issue #72 语义，与 GUI 图表同一读法）。
- `keys_source=override`：调用方显式传 `keys` 时走一次性实验参数，`params_scope=override`，并在
  `notes` 里声明它**不是**名册权威值。
- 名册里没有该标的覆盖 → 落回全局 params（本次全 0）→ `lines: []` + `blocked_reason`
  （不给数，只报缺什么）。

## 3. 原始读数（真实返回）

### 3.1 `cn:002714.SZ`（原始返回，含取数耗时）

```json
{
 "market": "cn",
 "symbol": "002714.SZ",
 "interval": "1d",
 "id": "kdas",
 "title": "KDAS",
 "keys_source": "symbolParams",
 "keys": [
  20250821,
  20240924,
  20260626,
  20261014
 ],
 "params": {
  "kd1": 20250821,
  "kd2": 20240924,
  "kd3": 20260626,
  "kd4": 0,
  "kd5": 20261014,
  "kd6": 0,
  "kd7": 0,
  "kd8": 0
 },
 "params_scope": "cn:002714.SZ",
 "provider": "tencent",
 "parity": "same-source",
 "parity_note": "Same registry resolution as the GUI chart route: the bridge /klines candidate order also puts this market's active provider first, so both read the same provider.",
 "bars": 801,
 "bars_requested": 800,
 "window_first_bar": "2023-06-26",
 "window_last_bar": "2026-10-15",
 "as_of": "2026-10-15",
 "stale": false,
 "stale_note": "Newest daily bar is 0 day(s) old (stale above 7); a market holiday can legitimately exceed this.",
 "latest_close": 39.75,
 "lines": [
  {
   "key": "KDAS_24-09-24",
   "key_day": 20240924,
   "anchored_at": "2024-09-24",
   "value": 42.288,
   "bars_since": 496,
   "latest_close": 39.75,
   "distance_pct": -6,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_25-08-21",
   "key_day": 20250821,
   "anchored_at": "2025-08-21",
   "value": 44.18,
   "bars_since": 276,
   "latest_close": 39.75,
   "distance_pct": -10.03,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-06-26",
   "key_day": 20260626,
   "anchored_at": "2026-06-26",
   "value": 39.351,
   "bars_since": 74,
   "latest_close": 39.75,
   "distance_pct": 1.01,
   "side": "价格在上",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-10-14",
   "key_day": 20261014,
   "anchored_at": "2026-10-14",
   "value": 39.959,
   "bars_since": 2,
   "latest_close": 39.75,
   "distance_pct": -0.52,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  }
 ],
 "nearest_support": {
  "key": "KDAS_26-06-26",
  "key_day": 20260626,
  "value": 39.351,
  "distance_pct": 1.01
 },
 "nearest_resistance": {
  "key": "KDAS_26-10-14",
  "key_day": 20261014,
  "value": 39.959,
  "distance_pct": -0.52
 },
 "notes": [
  "Values come from the indicator's own computeSource executed in the Node vm sandbox (same source the chart renders).",
  "Key days were read live from the chart roster (symbolParams for this market:symbol, else the global params)."
 ],
 "elapsed_ms": 357
}
```

### 3.2 `hk:00700.HK`（原始返回）

```json
{
 "market": "hk",
 "symbol": "00700.HK",
 "interval": "1d",
 "id": "kdas",
 "title": "KDAS",
 "keys_source": "symbolParams",
 "keys": [
  20240919,
  20260423,
  20260922,
  20260929,
  20260813
 ],
 "params": {
  "kd1": 20240919,
  "kd2": 20260423,
  "kd3": 20260922,
  "kd4": 20260929,
  "kd5": 20260813,
  "kd6": 0,
  "kd7": 0,
  "kd8": 0
 },
 "params_scope": "hk:00700.HK",
 "provider": "tencent",
 "parity": "same-source",
 "parity_note": "Same registry resolution as the GUI chart route: the bridge /klines candidate order also puts this market's active provider first, so both read the same provider.",
 "bars": 800,
 "bars_requested": 800,
 "window_first_bar": "2023-07-19",
 "window_last_bar": "2026-10-15",
 "as_of": "2026-10-15",
 "stale": false,
 "stale_note": "Newest daily bar is 0 day(s) old (stale above 7); a market holiday can legitimately exceed this.",
 "latest_close": 417.8,
 "lines": [
  {
   "key": "KDAS_24-09-19",
   "key_day": 20240919,
   "anchored_at": "2024-09-19",
   "value": 486.802,
   "bars_since": 510,
   "latest_close": 417.8,
   "distance_pct": -14.17,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-04-23",
   "key_day": 20260423,
   "anchored_at": "2026-04-23",
   "value": 451.737,
   "bars_since": 121,
   "latest_close": 417.8,
   "distance_pct": -7.51,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-08-13",
   "key_day": 20260813,
   "anchored_at": "2026-08-13",
   "value": 437.572,
   "bars_since": 45,
   "latest_close": 417.8,
   "distance_pct": -4.52,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-09-22",
   "key_day": 20260922,
   "anchored_at": "2026-09-22",
   "value": 432.451,
   "bars_since": 17,
   "latest_close": 417.8,
   "distance_pct": -3.39,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-09-29",
   "key_day": 20260929,
   "anchored_at": "2026-09-29",
   "value": 423.293,
   "bars_since": 12,
   "latest_close": 417.8,
   "distance_pct": -1.3,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  }
 ],
 "nearest_support": null,
 "nearest_resistance": {
  "key": "KDAS_26-09-29",
  "key_day": 20260929,
  "value": 423.293,
  "distance_pct": -1.3
 },
 "notes": [
  "Values come from the indicator's own computeSource executed in the Node vm sandbox (same source the chart renders).",
  "Key days were read live from the chart roster (symbolParams for this market:symbol, else the global params)."
 ],
 "elapsed_ms": 131
}
```

### 3.3 `cn:159869.SZ`（原始返回节选：读数行与关键区间信息）

```json
{
 "market": "cn",
 "symbol": "159869.SZ",
 "provider": "tencent",
 "parity": "same-source",
 "bars": 800,
 "bars_requested": 800,
 "window_first_bar": "2023-06-27",
 "window_last_bar": "2026-10-15",
 "latest_close": 1.037,
 "lines": [
  {
   "key": "KDAS_24-10-08",
   "key_day": 20241008,
   "anchored_at": "2024-10-08",
   "value": 1.246,
   "bars_since": 491,
   "latest_close": 1.037,
   "distance_pct": -16.77,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_25-02-14",
   "key_day": 20250214,
   "anchored_at": "2025-02-14",
   "value": 1.298,
   "bars_since": 405,
   "latest_close": 1.037,
   "distance_pct": -20.11,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-05-08",
   "key_day": 20260508,
   "anchored_at": "2026-05-08",
   "value": 1.112,
   "bars_since": 108,
   "latest_close": 1.037,
   "distance_pct": -6.74,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-07-24",
   "key_day": 20260724,
   "anchored_at": "2026-07-24",
   "value": 1.094,
   "bars_since": 54,
   "latest_close": 1.037,
   "distance_pct": -5.21,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-09-11",
   "key_day": 20260911,
   "anchored_at": "2026-09-11",
   "value": 1.062,
   "bars_since": 19,
   "latest_close": 1.037,
   "distance_pct": -2.35,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  },
  {
   "key": "KDAS_26-10-09",
   "key_day": 20261009,
   "anchored_at": "2026-10-09",
   "value": 1.045,
   "bars_since": 5,
   "latest_close": 1.037,
   "distance_pct": -0.77,
   "side": "价格在下",
   "truncated": false,
   "ineffective": false,
   "note": ""
  }
 ],
 "nearest_support": null,
 "nearest_resistance": {
  "key": "KDAS_26-10-09",
  "key_day": 20261009,
  "value": 1.045,
  "distance_pct": -0.77
 },
 "elapsed_ms": 75
}
```

## 4. 三方对齐（同一标的、同一关键日）

口径一：`indicator_get_values`（工具，走 profile 路由的 tencent provider）。
口径二：`kdas.py --klines-file <工具/桥同一份日 K>`（python 参考实现，去掉取数差异后只比算法）。
口径三：图表面代理 —— 桥 `TradingBridge.klines()` 直调（GUI 图表取数走的就是这条候选解析），
它报告的 `provider` 与日 K 就是图表实际拿到的那一份；**这是代理不是 GUI 实测**（见 §7 缺口 1）。

| 标的 | 关键日 | 工具 value | kdas.py value | 工具 anchored_at | kdas.py anchored_at | 工具 bars_since | kdas.py bars_since | 工具 distance_pct | kdas.py distance_pct | 一致 |
|---|---|---|---|---|---|---|---|---|---|---|
| cn:002714.SZ | 20240924 | 42.288 | 42.288 | 2024-09-24 | 2024-09-24 | 496 | 496 | -6 | -6 | ✓ |
| cn:002714.SZ | 20250821 | 44.18 | 44.18 | 2025-08-21 | 2025-08-21 | 276 | 276 | -10.03 | -10.03 | ✓ |
| cn:002714.SZ | 20260626 | 39.351 | 39.351 | 2026-06-26 | 2026-06-26 | 74 | 74 | 1.01 | 1.01 | ✓ |
| cn:002714.SZ | 20261014 | 39.959 | 39.959 | 2026-10-14 | 2026-10-14 | 2 | 2 | -0.52 | -0.52 | ✓ |
| cn:002714.SZ | 供数源 | 工具 provider=`tencent`、bars=801、末根收盘=39.75 | 桥直调 provider=`tencent`、bars=801、末根收盘=39.75 | — | — | — | — | — | — | ✓ |
| cn:159869.SZ | 20241008 | 1.246 | 1.246 | 2024-10-08 | 2024-10-08 | 491 | 491 | -16.77 | -16.77 | ✓ |
| cn:159869.SZ | 20250214 | 1.298 | 1.298 | 2025-02-14 | 2025-02-14 | 405 | 405 | -20.11 | -20.11 | ✓ |
| cn:159869.SZ | 20260508 | 1.112 | 1.112 | 2026-05-08 | 2026-05-08 | 108 | 108 | -6.74 | -6.74 | ✓ |
| cn:159869.SZ | 20260724 | 1.094 | 1.094 | 2026-07-24 | 2026-07-24 | 54 | 54 | -5.21 | -5.21 | ✓ |
| cn:159869.SZ | 20260911 | 1.062 | 1.062 | 2026-09-11 | 2026-09-11 | 19 | 19 | -2.35 | -2.35 | ✓ |
| cn:159869.SZ | 20261009 | 1.045 | 1.045 | 2026-10-09 | 2026-10-09 | 5 | 5 | -0.77 | -0.77 | ✓ |
| cn:159869.SZ | 供数源 | 工具 provider=`tencent`、bars=800、末根收盘=1.037 | 桥直调 provider=`tencent`、bars=800、末根收盘=1.037 | — | — | — | — | — | — | ✓ |
| hk:00700.HK | 20240919 | 486.802 | 486.802 | 2024-09-19 | 2024-09-19 | 510 | 510 | -14.17 | -14.17 | ✓ |
| hk:00700.HK | 20260423 | 451.737 | 451.737 | 2026-04-23 | 2026-04-23 | 121 | 121 | -7.51 | -7.51 | ✓ |
| hk:00700.HK | 20260813 | 437.572 | 437.572 | 2026-08-13 | 2026-08-13 | 45 | 45 | -4.52 | -4.52 | ✓ |
| hk:00700.HK | 20260922 | 432.451 | 432.451 | 2026-09-22 | 2026-09-22 | 17 | 17 | -3.39 | -3.39 | ✓ |
| hk:00700.HK | 20260929 | 423.293 | 423.293 | 2026-09-29 | 2026-09-29 | 12 | 12 | -1.3 | -1.3 | ✓ |
| hk:00700.HK | 供数源 | 工具 provider=`tencent`、bars=800、末根收盘=417.8 | 桥直调 provider=`tencent`、bars=800、末根收盘=417.8 | — | — | — | — | — | — | ✓ |

结论：cn 与 hk 的 `value` / `anchored_at` / `bars_since` / `distance_pct` 与 python 参考实现
**逐条完全相等**（同一份日 K 输入），且工具报告的 `provider` 与桥直调的 `provider` 相同、
`latest_close` 相同、`bars` 相同。

## 5. kdas.py 公开端点路径（不传 --klines-file）的差异与原因

cn（`--market cn`）与工具完全一致：

```json
{
 "source": "tencent-public(qfq)",
 "bars": 641,
 "first_bar": "2024-02-22",
 "last_bar": "2026-10-15",
 "last_bar_label": "2026-10-15",
 "last_close": 39.75,
 "lines": [
  {
   "key_day": 20250821,
   "anchored_at": "2025-08-21",
   "anchored_label": "2025-08-21",
   "value": 44.18,
   "distance_pct": -10.03,
   "bars_since": 276
  },
  {
   "key_day": 20240924,
   "anchored_at": "2024-09-24",
   "anchored_label": "2024-09-24",
   "value": 42.288,
   "distance_pct": -6,
   "bars_since": 496
  },
  {
   "key_day": 20260626,
   "anchored_at": "2026-06-26",
   "anchored_label": "2026-06-26",
   "value": 39.351,
   "distance_pct": 1.01,
   "bars_since": 74
  },
  {
   "key_day": 20261014,
   "anchored_at": "2026-10-14",
   "anchored_label": "2026-10-14",
   "value": 39.959,
   "distance_pct": -0.52,
   "bars_since": 2
  }
 ]
}
```

hk（`--market hk`）**不一致，且原因已定位**：

```json
{
 "source": "tencent-public(qfq)",
 "bars": 900,
 "first_bar": "2023-02-21",
 "last_bar": "2026-10-15",
 "last_bar_label": "2026-10-14",
 "last_close": 417.8,
 "lines": [
  {
   "key_day": 20240919,
   "anchored_at": "2024-09-20",
   "anchored_label": "2024-09-19",
   "value": 492.82,
   "distance_pct": -15.22,
   "bars_since": 509
  },
  {
   "key_day": 20260423,
   "anchored_at": "2026-04-24",
   "anchored_label": "2026-04-23",
   "value": 452.118,
   "distance_pct": -7.59,
   "bars_since": 120
  },
  {
   "key_day": 20260813,
   "anchored_at": "2026-08-14",
   "anchored_label": "2026-08-13",
   "value": 437.057,
   "distance_pct": -4.41,
   "bars_since": 44
  },
  {
   "key_day": 20260922,
   "anchored_at": "2026-09-23",
   "anchored_label": "2026-09-22",
   "value": 427.242,
   "distance_pct": -2.21,
   "bars_since": 16
  },
  {
   "key_day": 20260929,
   "anchored_at": "2026-09-30",
   "anchored_label": "2026-09-29",
   "value": 422.251,
   "distance_pct": -1.05,
   "bars_since": 11
  }
 ]
}
```

差异不是复权口径，是**交易日标签偏移**：`kdas.py` 的公开端点路径假设港股日 K 的
`openTime` 落在 HKT 零点（= 前一日 16:00Z），于是把日期标签整体减一天
（见其 `fetch_tencent` 里 `day = date if market == "cn" else _shift_day(date, -1)`）。
本仓 tencent connector 对港股日 K 走 `hkfqkline/get`，并把日期映射成**该交易日的 UTC 零点**
（`klineDateToEpochMs`，见 `packages/connector-tencent/src/rest.ts`），因此不需要也不应减一天。
证据（同一次运行）：hk 公开端点路径 `last_bar=2026-10-15 / last_bar_label=2026-10-14`，
而工具/桥的窗口末根是 `2026-10-15`；两边 `last_close` 都是 417.8（同一批数据，只是标签差一天）。
标签差一天使锚点落在晚一根 K 上，于是 value 从 486.802 变成 492.82、452.118/451.737 同理。
决策含义：**以图表/工具读数为准**（图表用的就是仓内 provider 的口径）；用 kdas.py 的公开端点
路径复核港股时，要么补 `--klines-file`，要么把关键日整体减一天再读。

## 6. fail-closed 分支对齐

两边都必须不给数，且必须说清是哪一种不给数：

### keys=20220103（keys_source=override）

工具：
```
key_day=20220103 value=null truncated=true ineffective=true side=锚点截断
```

kdas.py --klines-file（同一份日 K）：
```
key_day=20220103 value=null truncated=true note="锚点被截断（窗口起点晚于关键日），请加大 --bars 或补更早日 K"
```

两边都不给数：✓；分支 = 关键日未生效（晚于最新一根）

### keys=20000103（keys_source=override）

工具：
```
key_day=20000103 value=null truncated=true ineffective=true side=锚点截断
```

kdas.py --klines-file（同一份日 K）：
```
key_day=20000103 value=null truncated=true note="锚点被截断（窗口起点晚于关键日），请加大 --bars 或补更早日 K"
```

两边都不给数：✓；分支 = 关键日未生效（晚于最新一根）

### keys=20991231（keys_source=override）

工具：
```
key_day=null value=null truncated=false ineffective=true side=未生效
key_day=20991231 value=null truncated=false ineffective=true side=未生效
```

kdas.py --klines-file（同一份日 K）：
```
key_day=20991231 value=null truncated=false note="未生效（关键日晚于最新 K 线）"
```

两边都不给数：✓；分支 = 关键日未生效（晚于最新一根）

## 7. 沙箱耗时实测

- cn:002714.SZ：runSourceInVmSandbox 实测 1ms（bars=801、线数=4）；工具整次调用（含取数）357ms
- cn:159869.SZ：runSourceInVmSandbox 实测 2ms（bars=800、线数=6）；工具整次调用（含取数）75ms
- hk:00700.HK：runSourceInVmSandbox 实测 1ms（bars=800、线数=5）；工具整次调用（含取数）131ms

`runSourceInVmSandbox` 默认 100ms 只作死循环熔断（其模块头注与 `validate.test.ts` 的注入注释
都这么说），本工具显式给 2000ms：实测合法计算 1–2ms，余量留给 CI 并发抖动与更长序列
（窗口 800 根 × 最多 8 条线）。

## 8. 门禁命令与结果

```bash
pnpm --filter @dshtrading/indicators build     # ✔ Build complete
pnpm --filter @dshtrading/indicators test      # Test Files 15 passed / Tests 177 passed（含本工具 15 例）
pnpm -r build && node scripts/typecheck-gate.mjs
# [typecheck-gate] tsc --noEmit 完成：72 个 tsconfig，总错误数 371（基线总错误数 387）→ ✓ 未超基线
pnpm test:audit                                # 测试卫生门禁：通过（无新增测试债）
node scripts/tool-contract-gate.mjs --update   # 新增工具显式登记（T5），冻结面 156 → 158
```

新测试：`packages/indicators/test/values-tool.test.ts`（15 例，BDD 标题带角色前缀、
0 mock（行情服务用注入缝普通对象替身）、0 sleep、合成日 K 手算期望值）。

## 9. 缺口与未验证项

1. **GUI 图表读数未做 GUI 实测**：本次没有驱动桌面壳点开图表读像素/十字线。给出的通道是
   桥 `TradingBridge.klines()` 直调（同一候选解析实现）+ 指标自身 `computeSource` 复算，
   它是**代理**：能证明「供数 provider 与日 K 相同、算法相同」，不能证明渲染层没有额外变换。
2. **分钟/周线口径未验证**（也不该验证）：工具显式拒绝非 `1d`（周线 `openTime` 锚定口径不成立），
   这一点由单测守着，没有现场用例。
3. **`bars_requested=800` 但 cn:002714.SZ 实收 801 根**：connector 侧 `getKlines` 已按
   `TENCENT_KLINE_MAX_BARS=800` 裁剪请求，上游仍回了 801 行。工具如实回带实际根数
   （`bars=801`）与窗口首末日期，不假设「要多少就是多少」；这是 provider/上游的行为，不在本工具内修。
4. **`keys` 覆盖参数的下界**：`keys` 拒绝区间外（<20000101）的取值并显式报错——指标本身的
   `computeSource` 也会丢弃这些值（参数 schema 下界即 0/20000101 口径），报错比静默「无读数」诚实；
   代价是无法用它构造「早于 2000 年」的截断用例，截断用例改用区间内的早期日期（如 20220103）。
