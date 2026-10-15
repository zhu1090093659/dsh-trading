# 五类数据面 agent 工具 —— 现场验收记录

验收对象：本次变更（分支 `ft/data-plane-tools`）新增/补齐的 16 个只读 agent 工具调用路径。
复现入口：`spikes/impl-data-plane-tools/run.mjs`（跑生产代码 + 真实数据源，不 mock、不写活数据）。

```bash
export npm_config_store_dir=~/Library/pnpm/store/v11
cd /Users/zcl/code/.worktrees/dsh-trading/ft-data-plane-tools && pnpm -r build

DSH_HOME=$HOME/.dsh-trading \
FINANCE_BASE_URL=http://127.0.0.1:8787 FINANCE_USER=api FINANCE_PW=<profile 行凭据> \
JIN10_TOKEN=<profile 行凭据> \
node spikes/impl-data-plane-tools/run.mjs > /tmp/dp-accept.json

# KDAS 三方对齐的另一路（脚本）
python3 .agents/skills/weekly-trading-plan/scripts/kdas.py --market cn --symbol 002714.SZ --keys 20250821,20240924,20260626,20261014 --json
python3 .agents/skills/weekly-trading-plan/scripts/kdas.py --market hk --symbol 00700.HK --keys 20240919,20260423,20260922,20260929,20260813 --bars 800 --json
```

凭据只从 profile 现场读、经环境变量传入，未进仓库/日志/夹具；脚本不注入 `persistence`、不传
`snapshots`，因此**不写** `~/.dsh-trading/special-indicators/cache.json` 与
`~/.dsh-trading/polymarket/snapshots.json`（核对过两文件 mtime 未变）。

## 1. 16 次调用全部成功（1 次为预期拒绝）

```
ranAt=2026-10-15T13:15:57.359Z  financeConfigured=true
OK  special_indicators_get_snapshot                      137ms
OK  special_indicators_get_sentiment_history days=250     57ms
OK  special_indicators_get_sector_ranking window=20,limit=5  12ms
OK  special_indicators_get_sector_series 801737,days=300  18ms
OK  special_indicators_get_hk_short_top10 limit=10        82ms
OK  indicator_get_values cn:002714.SZ                    250ms
OK  indicator_get_values hk:00700.HK                     115ms
ERR indicator_get_values interval=1w（预期拒绝）            0ms
OK  prediction_fomc_meetings                             783ms
OK  prediction_search_events keyword=fed                  940ms
OK  prediction_event_detail 606422                       263ms
OK  flash_list hot=沸,爆 limit=3                         1402ms
OK  flash_list 无 hot limit=2                             520ms
OK  macro_rates                                          144ms
OK  macro_rates region=美国                                 47ms
OK  econ_calendar limit=3                                 84ms
```

`interval=1w` 的拒绝文案：

```
indicator_get_values: interval "1w" is not supported — the key-day anchored reading is defined on
daily bars only (the indicator decides the trading day from the bar openTime's UTC date, so a
weekly/monthly bar would anchor a whole period, and an intraday bar would anchor the wrong day).
Re-run with interval=1d.
```

## 2. KDAS 三方对齐（同标的、同关键日）

### cn:002714.SZ —— 三方逐条相等

| 关键日 | 工具 `value` | 工具 `anchored_at` | `kdas.py`（公开端点） | 一致 |
|---|---|---|---|---|
| 20240924 | 42.288 | 2024-09-24 | 42.288 (anchored 2024-09-24) | ✓ |
| 20250821 | 44.18 | 2025-08-21 | 44.18 (2025-08-21) | ✓ |
| 20260626 | 39.351 | 2026-06-26 | 39.351 (2026-06-26) | ✓ |
| 20261014 | 39.959 | 2026-10-14 | 39.959 (2026-10-14) | ✓ |

工具侧：`provider=tencent`、`parity=same-source`、`bars=801`（请求 800）、窗口
2023-06-26 → 2026-10-15、`latest_close=39.75`、`as_of=2026-10-15`、`stale=false`、
`keys_source=symbolParams`、`params_scope=cn:002714.SZ`。

图表面（第三方）：GUI 图表与工具走**同一条注册表候选解析**（桥 `/klines` 的候选序把
本市场 active provider 排最前），实测 provider 与末根收盘相同 → `parity=same-source`。
**诚实标注：这是等价路径核对，不是 GUI 像素级实测。**

### hk:00700.HK —— 两边都不等，差异已定位到数据源与复权口径

| 关键日 | 工具 `value`（anchored_at） | `kdas.py`（anchored_at / label） | 差 |
|---|---|---|---|
| 20240919 | 486.802 (2024-09-19) | 492.82 (2024-09-20 / label 2024-09-19) | -6.018 |
| 20260423 | 451.737 (2026-04-23) | 452.118 (2026-04-24 / label 2026-04-23) | -0.381 |
| 20260813 | 437.572 (2026-08-13) | 437.057 (2026-08-14 / label 2026-08-13) | +0.515 |
| 20260922 | 432.451 (2026-09-22) | 427.242 (2026-09-23 / label 2026-09-22) | +5.209 |
| 20260929 | 423.293 (2026-09-29) | 422.251 (2026-09-30 / label 2026-09-29) | +1.042 |

`latest_close=417.8` 两边相等；两组锚定的**是同一根 K 线**（工具 `anchored_at` = 脚本
`anchored_label`，脚本把港股标签减一天以配合图表锚定）。根因是**两个腾讯端点**：

```
fqkline    (脚本用的公开端点)  2024-09-19 → o379.6 h389.8 l376.6 c388.8  v25801963
hkfqkline  (连接器/图表用的)   2024-09-19 → o369.8 h380.0 l366.8 c379.0  v25801963   ← 工具侧
```

成交量逐值相等、价格系统性更高（`fqkline` 是**后复权**口径），两端口径在**当日**收敛
（2026-10-15 两边都是 o415.0 h422.6 l414.0 c417.8）。故结论：

- **cn 与图表同源同值；hk 工具与图表同源同值，与脚本那条公开端点路径不同源**。
- 差异是复权口径 + 端点，不是算法差；技能文档已按此更正为「港股以图表/工具读数为准，
  脚本路径只用于交叉核对算法；要比数值就用 `--klines-file` 把工具读到的日 K 传进去」。
- 工具出参已带 `provider` 与 `parity`，`hk` 这一层异源在返回里可见。

### fail-closed 分支（两边一致，均不给数）

`keys=20220103`（早于窗口起点，2023-07-19）→ 两边 `truncated` 且 `value=null`；
`keys=20991231`（晚于最后一根）→ 两边 `ineffective` 且 `value=null`。窗口根数不足同样不给数，
只回 `blocked_reason`。详见 `spikes/impl-kdas-values/EVIDENCE.md`。

## 3. 与本地快照/缓存同期条目一致性

### 特殊指标 vs `~/.dsh-trading/special-indicators/cache.json`（只读，mtime 未变 12:40:52Z）

| 对照项 | 缓存条目写入时刻 | 结论 |
|---|---|---|
| `/api/sentiment/snapshot?market=cn&methodology=3` | 12:40:17Z | score 26.29 / date 2026-10-14 / expected_data_date 2026-10-14 / stale false / methodology_version 3 —— **逐字段 SAME** |
| `/api/hk-short/snapshot` | 12:40:15Z | data_date / short_data_date / data_version `d3e8c35a736b41f2` / n_days 98 / top10[0].code —— **逐字段 SAME** |
| `/api/sectors/ranking?window=20` | 12:40:24Z | 前 5 条逐字段（code/name/type/chg_pct/latest_margin/latest_close）**全 SAME** |
| `/api/sentiment/history?...&methodology=3&days=250` | 12:36:24Z | points 250 / first 2025-09-24 / last 2026-10-14 / expected_data_date —— **SAME** |
| `/api/snapshot`（基差） | **10-12 07:12Z（缓存条目更旧）** | 工具 `last_dt=2026-10-15 14:59:59` vs 缓存 `2026-10-12 14:59:59` —— **DIFF，原因是缓存条目陈旧（差 3 天），不是数据不一致**；工具出参 `expected_data_date=2026-10-15` 且标了它是从 `products[].last_dt` 派生的日内行情时间 |

缓存里另有 10-12 写入的 `.../days=750` 与 `/api/v2/sectors/801737?days=300` 条目，工具侧读的是
新鲜值，差异同样属「缓存条目更旧」。工具**不注入 persistence**，故本次未刷新该文件。

### 预测市场 vs `~/.dsh-trading/polymarket/snapshots.json`（只读，mtime 未变 12:45:02Z）

工具 `observedAt=2026-10-15T13:15:58.816Z`，快照 `observedAt=2026-10-15T12:45:02.872Z`（**同一天，相差 31 分钟**）。
3 场会议 × 5 档 = 15 档全部对上 id，无缺档：**same=8，diff=7，missing=0，max|Δ|=0.0150**。

差异 7 档全是 0.0005–0.015（≈半个价差量级），方向成对（`no_change` +0.015 与 `inc_25` −0.010
互为镜像），与「快照 31 分钟前、市场自己动了」一致；无系统性偏移、无缺档、无编造。
`changeSincePrevious` 在工具侧首次取数时全部省略（**缺失 ≠ 0**），第二次取数才出现 Δ=0。

## 4. 门禁与构建（本次变更，HEAD 见交付说明）

```
pnpm -r build                                    → exit 0
pnpm --filter @dshtrading/indicators test         → 15 files / 177 tests passed
pnpm --filter @dshtrading/connector-jin10 test    → 11 files / 102 tests passed
pnpm --filter @dshtrading/connector-polymarket test → 6 files / 71 tests passed
pnpm --filter @dshtrading/client-ui-special-indicators test → 10 files / 96 tests passed
node scripts/tool-contract-gate.mjs               → ✓（冻结 166，本次 --update added=8 / removed=0 / changed=0）
pnpm test:audit                                   → 通过（无新增测试债）
node scripts/typecheck-gate.mjs                   → 371 / 基线 387，未超基线
```

（完整门禁 `pnpm gates:all` 的现场复跑结论与 HEAD sha 见会话交付说明；上表为本次四项变更的
受影响门禁。）

## 5. 未做与诚实标注

- **GUI 图表的 KDAS 读数未做像素级实测**：用「与桥 `/klines` 同候选解析 + 同 `computeSource`」的
  等价路径核对（provider/根数/末根收盘逐值一致）。像素级验证需要桌面壳在环，本次未做。
- **本机当前运行中的 trading-web 实例仍是旧副本**：本次交付对它的生效需要
  `pnpm build` + `scripts/refresh-profile.sh trading-web`（该脚本会停掉运行中的实例），
  未执行——按任务边界「不擅自重启服务」处理。
- **`kdas.py` 公开端点路径的 hk 数值与工具不等**（见 §2），已定位为端点/复权口径差异，
  技能文档已更正；未改脚本本身（它保留为降级与算法交叉核对路径）。
- 特殊指标与预测市场两条 `stale` 语义不可横向比较（前者上游声明、后者 CDN 缓存状态）。
