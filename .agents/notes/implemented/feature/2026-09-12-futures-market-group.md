# Agent Note: 新增期货市场分组（同花顺期货数据源承载）

Status: implemented
Issue: #97

## Problem

同花顺官方金融数据 API 开放国内期货模块（品种目录、日K、当日分时、跨资产代码表）。owner 决策（2026-09-12）：在 crypto/us/cn/hk 之外新增「期货」市场分组，由同花顺承载行情数据。

## Decision

1. **上游能力边界（实测见 spikes/impl-hithink-kline-futures/EVIDENCE/）**：期货只有日K（默认最近 100 根，`start/end` 窗口可更长）与当日分时点（分时点为 price/volume 序列，非 OHLC；**非交易时段 price 可为 null**）；无实时快照端点；文档示例合约 CU2601.SHF 实测 `code=3001 Target not found`（已交割），检索返回的主力连续形（如 `RB00.SHF`）有完整数据。
2. **最小可用市场（数据面切片）**：
   - `connector-hithink` 新增 `HiThinkFuturesMarketDataService`：getTicker = 分时末点优先、失败/空价回落日K收盘（subscribeTicker 10s 轮询）；getKlines = 1d 直连、分钟周期由当日分时聚合（仅当日，不冒充历史）、1w/1M 日K聚合；listInstruments = 带 query 走 `/api/meta/tickers/search?asset_type=futures`、无 query 走代码表（过滤 last_trade_date 已过期合约）；futures-dataplane 注册 `(futures, hithink)`。
   - 新增 `packages/futures` bundle（installer + host 面数据行，复刻 cn 模式）与 `packages/kit-futures`（futures-risk-checklist 技能随包分发；kitRow 生成器按 `@dshtrading/kit-<market>` 命名约定要求该包存在）。
   - base：`MARKETS`/`ORDER_GATE_PATTERN`/market-tools/research-tools union 扩 futures；persona 市场枚举文案同步。router：`DEFAULT_MARKETS.futures = hithink`。api：Context 增强 `tradingFuturesMarketData`。
   - client-ui-trading：页签/自选/存储校验/添加轮换/下单卡槽位接入；时段模型近似（日盘三节 + 夜盘统一 21:00-23:00，**品种夜盘收市差异（23:00/01:00/02:30）不区分**，周六凌晨 <03:00 归周五夜盘尾）；手输推断 = 品种 1-3 字母 + 3-4 位数字（后缀集 SHF/DCE/CZC/INE/GFE/CFE，实测出现 .CFE 后补）；币种 CNY。
   - client-ui-settings：MARKET_TABS 加 futures（hithink 卡片 markets 含 futures）；desktop build-runtime 两清单纳入 `@dshtrading/futures`（runtime 产物随构建重生成）。
3. **期货无实盘交易面**（A 股期货执行走本地 MiniQMT 等账户侧，铁律 #3）：`futures_place_order` 工具不存在，闸门正则扩展仅为预防性收口；新闻面：上游无期货新闻端点，newsRegistry 未注册 futures 聚合器，GUI 新闻页签空态（fetchNews 错误已被 catch 兜住）。

## Verification

- `pnpm build` 全绿；`pnpm test` 1428 用例全通过。
- 真实网络端到端（构建产物直连上游）：RB00.SHF 日K 3 根、ticker price=3000/prevClose=3020（分时 null 回落路径实证）、全量名册过滤后 1195 合约、检索「螺纹钢」命中 5 条；A 股侧 600519.SH 日K/周K见 #96 note。
- 遗留复验项：交易时段（周一盘中）分时价格是否实时填充、ticker 新鲜度需在交易日复验；desktop runtime 产物重生成与 profile 刷新在合并后走 `scripts/refresh-trading-web-profile.sh` 与 build-runtime 流程。

## 关联发现（不属本变更，待 owner 裁决）

`packages/kit-cn/assets/skills/cn-risk-checklist.md` 等四个技能文件自 81f239f 起为 59 字节「指针文本」（内容 = 自身相对路径，git 与 profile 安装副本一致），kit `readFile` 直出该路径串——cn-risk-checklist/knowledge-curation/trading-notes-setup/trading-strategy-paradigms 的技能正文疑似长期缺失（正文全仓检索无命中）。kit-futures 的技能文件为完整正文，不受影响。
