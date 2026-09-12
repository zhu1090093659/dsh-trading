# Agent Note: 新增期货市场分组（同花顺期货数据源承载）

Status: implemented
Issue: #97

## Problem

同花顺官方金融数据 API 开放国内期货模块（品种目录、日K、当日分时、跨资产代码表）。owner 决策（2026-09-12）：在 crypto/us/cn/hk 之外新增「期货」市场分组，由同花顺承载行情数据。

## Decision

1. **上游能力边界（实测见 spikes/impl-hithink-kline-futures/EVIDENCE/）**：期货只有日K（默认最近 100 根，`start/end` 窗口可更长）与当日分时点（分时点为 price/volume 序列，非 OHLC；**非交易时段 price 可为 null**）；无实时快照端点；文档示例合约 CU2601.SHF 实测 `code=3001 Target not found`（已交割），检索返回的主力连续形（如 `RB00.SHF`）有完整数据。
2. **最小可用市场（数据面切片）**：
   - `connector-hithink` 新增 `HiThinkFuturesMarketDataService`：getTicker = 分时末点优先、失败/空价回落日K收盘（subscribeTicker 10s 轮询）；getKlines = 1d 直连、分钟周期由当日分时聚合（仅当日，不冒充历史）、1w/1M 日K聚合；listInstruments = 带 query 走 `/api/meta/tickers/search?asset_type=futures`、无 query 走代码表（过滤 last_trade_date 已过期合约）；futures-dataplane 注册 `(futures, hithink)`。
   - 新增 `packages/futures` bundle（installer + host 面数据行，复刻 cn 模式）与 `packages/kit-futures`（futures-risk-checklist + 与其他市场 kit 同款的共享技能目录 indicator-authoring/trading-strategy-paradigms/knowledge-curation/trading-notes-setup；base role-skill 白名单按 `[<market>-risk-checklist, 共享技能…]` 生成，少一项即 apply 期 fail-fast；kitRow 生成器按 `@dshtrading/kit-<market>` 命名约定要求该包存在）。
   - **preset 面与 host 面入口分离**（合并审查修正）：preset 行挂新入口 `@dshtrading/connector-hithink/futures-plugin`（isolate 组内直接 provide `tradingFuturesMarketData`），host 面 `cordis.patch.yml` 保留 `futures-dataplane`（注册 `(futures, hithink)` 进共享注册表，GUI 行情桥）。两面同挂 dataplane 会触发 router 的重复注册响亮失败。
   - base：`MARKETS`/`ORDER_GATE_PATTERN`/market-tools/research-tools union 扩 futures；persona 市场枚举文案同步。router：`DEFAULT_MARKETS.futures = hithink`。api：Context 增强 `tradingFuturesMarketData`。
   - client-ui-trading：页签/自选/存储校验/添加轮换/下单卡槽位接入；时段模型近似（日盘三节 + 夜盘统一 21:00-23:00，**品种夜盘收市差异（23:00/01:00/02:30）不区分**，周六凌晨 <03:00 归周五夜盘尾）；手输推断 = 品种 1-3 字母 + 3-4 位数字（后缀集 SHF/DCE/CZC/INE/GFE/CFE，实测出现 .CFE 后补）；币种 CNY。
   - client-ui-settings：MARKET_TABS 加 futures（hithink 卡片 markets 含 futures）；desktop build-runtime 两清单纳入 `@dshtrading/futures`（runtime 产物随构建重生成）。
3. **期货无实盘交易面**（A 股期货执行走本地 MiniQMT 等账户侧，铁律 #3）：`futures_place_order` 工具不存在，闸门正则扩展仅为预防性收口；新闻面：上游无期货新闻端点，newsRegistry 未注册 futures 聚合器，GUI 新闻页签空态（fetchNews 错误已被 catch 兜住）。

## 补充实证（verify profile，2026-09-12）

- **设置中心凭证从未到达 hithink 连接器的根因**：cn/futures 两个 dataplane 原实现只在 apply 期从 `process.env` 快照 Key；而用户在设置-交易配置的 Key 存于 `dshtrading.credentials.hithink.apiKey`（settings.yaml），tushare/fmp/finnhub 等商业连接器均读 router `getCredential`。修复：凭证解析惰性到每次请求（`HiThinkRestOptions.apiKeyProvider`，settings 优先、env 兜底），与注册表「热切换」语义一致（首个截图轮实测 Missing X-api-key → 惰性化后全通）。
- **宿主全链路实测（一次性 verify profile + 桥 API + headless 截图）**：cn 600519.SH 日K 3 根真实数据（原 NOT_IMPLEMENTED 已修）、cn ticker 1275.16/prevClose 1285.13、futures RB00.SHF ticker 3000/3020 与日K、`/markets` 含 `futures:hithink`、cn 新闻流正常；GUI 左栏「期货」页签渲染（截图留 /tmp/trading-verify-ui.png，验证后 verify profile 已删除）。
- 桌面壳在跑实例仍持旧代码：用户侧生效需合并后重建桌面 runtime 或刷新 profile 并重启实例。

## Verification

- `pnpm build` 全绿；`pnpm test` 173 文件 / 1434 用例通过；CI 同款 `pnpm -r test`、`pnpm i18n:check`、`node scripts/typecheck-gate.mjs` 均绿（棘轮总错误 481→473，client-ui-settings 20→12）。
- 真实网络端到端（构建产物直连上游）：RB00.SHF 日K 3 根、ticker price=3000/prevClose=3020（分时 null 回落路径实证）、全量名册过滤后 1195 合约、检索「螺纹钢」命中 5 条；A 股侧 600519.SH 日K/周K见 #96 note。
- 遗留复验项：交易时段（周一盘中）分时价格是否实时填充、ticker 新鲜度需在交易日复验；desktop runtime 产物重生成与 profile 刷新在合并后走 `scripts/refresh-trading-web-profile.sh` 与 build-runtime 流程。

## 审查修正（2026-09-12 PR #98 合并前）

- **kit-futures 技能目录补齐**：base 的 role-skill 白名单按 `[<market>-risk-checklist, 共享技能…]` 生成（trader/instrument-researcher/risk-reviewer 三套），kit-futures 只带 futures-risk-checklist 时 `providerForSkills` 在 apply 期 fail-fast，三个角色的 kit provider 被整行跳过。现补齐 4 个共享技能资产（sync-skills 的 `trading-*`/`indicator-*`/`knowledge-*` 路由加入 futures），以 composePresets 端到端验证四套白名单可解析。
- **preset 面与 host 面入口分离**：原 preset 行挂 `futures-dataplane`，与 bundle patch 的 host 面同名行对同一 `(futures, hithink)` 注册两个实例，触发 router 的重复注册响亮失败。新增 `@dshtrading/connector-hithink/futures-plugin`（preset 隔离组内直接 provide），host 面保留 dataplane 注册表行；以真实 Cordis 注册表复现旧行为抛错并验证新入口隔离生效。
- **五市场类型补全**：`MARKET_INDICES`/`MARKET_INTERVALS`/`TAB_KEY`/`MARKET_LABEL_KEY`/`CatalogMarket`（含 `SYMBOL_CATALOG.futures` 空种子）/`searchAllMarkets` 补 futures；台账面维持 4 市场边界（`HOLDINGS_MARKETS`、bridge 写入校验、`isHoldingMarket` 守卫），修 typecheck 棘轮 +18 与客户端类型回归。
- **手输推断**：主力连续码为 2 位数字（`RB00.SHF`，upstream 检索实测形态），推断正则由 3-4 位放宽到 2-4 位（三处实现）。
- **设置页**：`dshtrading.market.tab` slot 的 `owner: never` 使组件 props 坍缩为 never（既有 20 处 TS2349 债的根因），改回 `MarketTabOwnerProps` 后 props 恢复真实类型并修掉两处浮现错误；新闻源保存提示不再被 resolved 刷新清空；侧栏市场轮换提示补期货。
- **棘轮基线**：`scripts/typecheck-baseline.json` 纳入 `packages/futures` 与 `packages/kit-futures`（0 错），client-ui-settings 由 20 降至 12。

## 关联发现（不属本变更，待 owner 裁决）

`packages/kit-cn/assets/skills/cn-risk-checklist.md` 等四个技能文件自 81f239f 起为 59 字节「指针文本」（内容 = 自身相对路径，git 与 profile 安装副本一致），kit `readFile` 直出该路径串——cn-risk-checklist/knowledge-curation/trading-notes-setup/trading-strategy-paradigms 的技能正文疑似长期缺失（正文全仓检索无命中）。kit-futures 的技能文件为完整正文，不受影响。
