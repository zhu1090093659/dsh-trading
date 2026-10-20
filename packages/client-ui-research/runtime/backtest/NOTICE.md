# 第三方代码归属

本目录下的**回测引擎**移植自 [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)，
MIT 协议，`Copyright (c) 2026 Vibe-Trading Contributors`。协议全文见 `LICENSE.upstream`。

移植基线：上游 `main @ 002373ef32800d4f7d70b418eb4e3bf9d030a5bc`（2026-08-26）的 `agent/backtest/`。

## 从上游搬来的

| 文件 | 内容 |
|---|---|
| `models.py` | 持仓 / 成交 / 交易 / 权益的不可变数据类 |
| `constraints.py` | 组合约束 |
| `metrics.py` | 指标（夏普 / 卡玛 / 索提诺 / 最大回撤 / 胜率 / 盈亏比 / 换手 / 相对基准） |
| `validation.py` `rebalance_notes.py` `risk_xray.py` `run_card.py` | 校验、调仓说明、风险 X 光、run card |
| `engines/base.py` | 逐 bar 撮合内核 |
| `engines/china_a.py` | A股规则：T+1 / 涨跌停 / 100 股整手 / 印花税 |
| `engines/global_equity.py` | 美股 · 港股 · 加拿大规则 |
| `engines/_market_hooks.py` | 代码 → 市场分类、币种 |

## 相对上游的改动

移植时只改了两处，均为**移除依赖**，不动算法：

1. **`engines/base.py`** — 事件（RSSHub）与基本面（Tushare）两路增强改成**惰性 import**。
   这两路没有随本产品发行（前者要自建服务、后者要付费 key，而本产品的数据一律走自己的取数层）。
   `config` 没点名就永远不 import；点名了就报清楚的错，**不静默跳过**。
2. **`benchmark.py`** — 删掉 yfinance 兜底（同上），并让原本静默的取数失败出声。

v2.1 起又改了下面这些上游文件（本产品自己的改动，与上游无关）：

- **`metrics.py` `validation.py`** — 没有平仓交易时的胜率、净值没有波动时的夏普和信息比率改为 `None`（无定义），不再写成 0；
  分段检验和重抽样里算不出的段同样是 `None`，不参与均值。
- **`engines/base.py`** — 对照指数按收盘价对齐到策略日期（原来拿收益率序列补 0，停牌日的指数涨跌会丢掉）；
  补充指标改由 `report_data.py` 计算；回撤曲线的高水位从初始资金起算，与最大回撤同口径。
- **`benchmark.py`** — 带回原始收盘价，新增 `align_benchmark_close`（对照在回测首日前没有报价、或尾部断掉太久就不出对照并说明）。
- **`risk_xray.py`** — 新增风险贡献、单只年化波动和相关矩阵。

## 本产品新写的（不属于上游）

| 文件 | 内容 |
|---|---|
| `loader.py` | 把本产品的取数端点接到引擎上 —— 整个移植里唯一的新数据代码 |
| `gate.py` | 回测闸口：判要回测什么 → 需要什么 → 限制是什么 |
| `run.py` | 接线 + 运行期守卫 + 结果呈现 |
| `strategies.py` | 内置策略（也是"策略长什么样"的模板）；RSRS 按光大证券 2017 年公开研报的公式自写，没有搬任何仓库的代码 |
| `cli.py` `stdio_utf8.py` | 回测的 JSON 入口（界面与命令行共用）；把进程输入输出固定为 UTF-8 |
| `report_data.py` `cost_compare.py` `sensitivity.py` | 回测报告的补充指标与图表数据、扣费前后对照、参数敏感度 |
| `kline.py` `event_study.py` `symbol_search.py` | 个股 K 线、事件回看、按代码 / 名称 / 拼音找标的 |
| `portfolio_perf.py` `portfolio_xray.py` `scenario_replay.py` `gics.py` | 持仓收益率、持仓体检、历史情景回放、港美股 GICS 行业 |
| `tests/` | 上面这些文件的测试 |

## 没有搬的

`loaders/`（25+ 数据源）· `optimizers/`（组合优化）· 期货 / 外汇 / 加密 / 印度 / 韩国 / 越南 /
期权 / composite 引擎 · `regime.py` `correlation.py` `factor_costs.py` 等。
数据一律走本产品自己的取数层；其余引擎等对应市场接进来时再说。
