# Agent Note: 金十数据 MCP 连接器 —— 跨市场快讯/资讯工具面与 global 市场数据面

Status: implemented

## Problem

新闻面现状是**按标的**的：`cn/us/hk/crypto_get_news` 与 GUI 新闻面板都按当前标的过滤（2026-09-03 owner 裁决：无相关新闻就返回空，不回退大盘要闻），源也各市场自带（东财快讯/公告、Yahoo、Google News RSS、HKEX、CryptoPanic）。缺的是一类**跨市场快讯**：宏观数据、大宗商品、外汇、地缘事件的实时流，与任何单一标的无关，也不属于任何单一市场。

金十数据（Jin10）以**免费 MCP 服务**提供这类内容（快讯流、财经资讯、本周财经日历，外加现货贵金属/原油/铜、外汇、全球与 A 股指数的报价与分钟 K 线），用户 2026-09-13 给定接入契约并要求「转成本仓的连接器」。上游是标准 MCP（Streamable HTTP + JSON-RPC 2.0，协议 2025-11-25，Bearer Token），与本仓既有 HTTP 连接器形态不同，需要一层协议适配。

## Decision

1. **新包 `@dshtrading/connector-jin10`**（`packages/connector-jin10`）：MCP 客户端（`mcp.ts`：`initialize → notifications/initialized → tools/list / resources/list / resources/read → tools/call`，SSE 单行 `data:` 与直出 JSON 双形态，`mcp-session-id` 有则回带，握手失败不缓存以便补配凭证后重试）+ 解析层（`parse.ts`，坏形状抛错、时间解析失败丢弃该条）+ 取数层（`service.ts`，分页统一 `cursor → next_cursor / has_more`）+ 工具面（`tools.ts`）。
2. **九个市场无关只读工具**：`flash_list` / `flash_search` / `news_list` / `news_search` / `news_get` / `econ_calendar` / `global_instruments` / `global_quote` / `global_klines`。工具名不带 provider 名（与 `symbol_search`、`knowledge_search` 同族），换快讯源不改工具面。纯只读，不命中下单闸门正则（铁律 #3 不涉及）。
3. **归属 base（铁律 #1：base 拥有全部市场无关行）**：行 `dsh-trading-connector-jin10` 插在 `packages/base/cordis.patch.yml` 的 host 平面工具行区（与 `dsh-trading-market-tools` 同款形态），依赖进 `packages/base/package.json`（profile 安装闭包，S3 坑 3）。**不进任何市场 preset**——内容是跨市场的，host 行注册一次全会话/全角色可见。
4. **结果读取按用户契约**：`result.structuredContent` 优先，`result.content[].text` 仅在 structuredContent 缺席时作机器可读兜底；`isError=true` / `status !== 200` / `data === null` 一律抛错（不冒充空数据）；限流文案映射 `TRADING_RATE_LIMITED`（每用户每工具每北京时间自然日 1500 次），未知品种映射 `TRADING_UNSUPPORTED_SYMBOL`。
5. **数据零再分发（铁律 #5）**：快讯只下发标题（从 `【标题】正文` 提取）/时间/链接，资讯下发标题/时间/链接/`id`，`news_get` 额外给上游 `introduction`（导语）；`content` 正文不下发、不落盘、不缓存。与 `cn_get_news`（东财快讯只引 title/showTime/链接）同口径。
6. **凭证 BYOK 且惰性**：`dshtrading.credentials.jin10.token` 优先、`JIN10_MCP_TOKEN` 兜底，每次请求解析（settings 用户层晚于插件 apply 也生效，2026-09-12 hithink 凭证失效根因的同款纪律）；缺凭证报 `TRADING_CREDENTIALS_MISSING` 并给出配置路径。插件不内置密钥。
7. **边界（首轮口径）**：不接按标过滤的 GUI 新闻面板与 `dshtrading.news.sources` 源配置（面板按标过滤，金十快讯无 `relatedCodes`，塞进去只能靠关键词猜标的，属伪造关联）。金十 Token 设置卡片、GUI 快讯面板、global 市场数据面三项于同日续作交付，见下文「续作」节。

## Alternatives considered

- **作为 cn 市场的 kit 内新闻源**（照东财/同花顺先例，让 `cn_get_news` 与新闻面板带上金十）：落选——内容跨市场（美联储/原油/霍尔木兹），塞进 cn 后 us/hk/futures 会话拿不到；且面板是 per-symbol 语义，金十条目无关联代码，只能靠中文名关键词猜测标的，违反 2026-09-03「只显示标的相关条目」的裁决精神。
- **逐市场 preset 行**（5 个市场 × 各角色各挂一份）：落选——同一份跨市场内容重复 5 份、角色 × 市场组合爆炸；host 平面单行即可全会话可见（`base/market-tools` 先例）。
- **用 connector-template 生成器建包**：落选——模板面向交易所行情/交易面（`MarketDataService`/`TradeService`/签名/三态闸门/dataplane 注册表），本连接器是 MCP 数据源、无交易面，套模板会留下大量无关骨架且误导后续复制者。
- **引入 `@modelcontextprotocol/sdk`**：落选——只需 5 个 JSON-RPC 方法与 SSE 解析，自实现约 200 行、零新依赖；给 profile 安装闭包再加一层依赖不符合 YAGNI，且 SDK 的会话/重连语义本出口用不上（上游无会话头）。
- **本轮把 `get_quote`/`get_kline` 接进市场路由**（futures 或新 global 市场）：落选——需要先定符号映射、GUI 承载面与 provider 归属（现货黄金/WTI/外汇不属于现有五市场），属独立决策；本轮以只读工具形态交付（`global_instruments` 提供代码名册），路由接入留待下一步。

## Consequences

- 工具清单 +9（全角色、全市场会话可见）。这是 context 成本，换来跨市场快讯/资讯/日历/全球品种行情能力；工具描述里写明元数据边界、翻页与限流语义，避免模型拿 `news_get` 去要正文。
- 出网限制：`global_klines` 在闭市（周末）返回空数组（上游 `status: 200` + `klines: []`），属真实语义而非故障；2026-09-13（周日）实测全品种为空，非空 K 线待交易日复测。工具描述已写明「空 = 窗口内无数据（闭市）≠ 故障」。
- 用户启用路径：设置中心 `credentials.jin10.token`（settings.yaml 可直接写）或环境变量 `JIN10_MCP_TOKEN`；**已装 profile 需刷新**（坑 #15 overrides 行 + 重装 base bundle）才能拿到新行与包。
- 后续步骤（未做）：更多快讯源（财联社等，工具面已 provider 无关）、按标过滤的新闻面板接入（原口径：需要上游给 `relatedCodes` 才算真关联）。global 的 market-group 平权（bundle + kit + `global_get_ticker` 命名族）已于 2026-09-15 交付，见 [global 市场 market-group 平权](./2026-09-15-global-market-group.md)。
## 续作（2026-09-13 同日）：设置卡片 / GUI 快讯面板 / global 市场数据面

首轮 Decision #7 的「边界」三项（设置面板 Token 卡片、GUI 快讯面板、行情路由接入）在同一变更窗口内补齐；「不接按标过滤的新闻面板与 `news.sources` 源配置」的原口径不变（金十快讯无 relatedCodes，塞进按标面板只能靠关键词猜标的 = 伪造关联）。

### 1. 设置中心：金十 MCP Token 卡片

- client-ui-settings 的「交易」设置区在市场 tab 之上新增**市场无关的「市场快讯数据源」卡片**（`TradingSettingsSection.tsx` + 注入动作 `setJin10Token` / `clearJin10Token`），落同一存储键 `dshtrading.credentials.jin10.token`（与「全球」tab 里 jin10 provider 卡的凭据字段同键，非双份数据）；空串保存 = `unset` 回未配置态（工具随之报 `TRADING_CREDENTIALS_MISSING`）。
- 卡片放在 tab 容器层而非某个市场 tab：金十快讯/资讯/日历是跨市场内容（首轮 Decision #3 同款理由）。
- provider 清单登记 `jin10`（`markets: ['global']`，type=public，url `mcp.jin10.com`，env `JIN10_MCP_TOKEN`），凭据字段 `token`（label `field.label.mcpToken`，占位符 `JIN10_MCP_TOKEN`）。

### 2. GUI 快讯面板（中栏「快讯」视图）

- 连接器 provide `tradingFlashFeed`（`flash-service.ts`；`@dshtrading/api` 新增 `FlashFeedService` 契约 + Context 增强），桥新增 `GET /dshtrading/api/flash?cursor&limit&keyword`（cursor 翻页；keyword 走上游搜索，`hasMore=false`）。
- 面板 = client-ui-trading 内建中栏视图 `flash`（`FlashFeedStage.tsx`，order 5，复用 `NewsFeedPane`；60s 轮询 + 加载更多 + 关键词搜索）。未装连接器 → 桥 `TRADING_NOT_IMPLEMENTED`；未配凭证/上游故障 → 面板显示可操作提示，**不把失败画成「没有快讯」**。2026-09-13 后续：面板迁到右缘竖条容器（见 [闪讯面板归位](./2026-09-13-flash-panel-to-session-rail.md)），并新增金十网页版四级热度筛选（默认 沸+爆）——MCP 无热度字段，热度路径改走网页版接口，见 [金十快讯热度筛选](./2026-09-13-jin10-flash-heat-filter.md)。
- 为什么不新建 client 包（照 client-ui-strategies/knowledge 拆包先例）：快讯面板是壳内能力（与 news 面板同族），单独成包等于给 base 增加一个只服务单一连接器的前端依赖；可选性由错误态表达即可。
- 服务形态：`tradingFlashFeed` 与 `tradingGlobalMarketData` 用 `ctx.reflect.provide`（普通对象）而非 `extends Service`——cordis `context.d.ts` 同名导出 `interface Context`（公共面）与 `class Context`，`Service` 构造签名上的 Context 解析随程序内文件顺序漂移（本包实测 TS2379：解析成窄接口后缺 inject/get/set…）。普通对象零构造签名，无该陷阱（client 半 `tradingStageViews` / `tradingIndicators` 同款先例）。

### 3. global 市场数据面（金十行情接市场路由）

- 新市场 id `global`（与 crypto/us/cn/hk/futures 同级），provider slug `jin10`：`@dshtrading/router` 登记 provider 词汇 + `DEFAULT_MARKETS.global = { provider: 'jin10' }` + 目录占位 `SYMBOL_CATALOG.global = []`（97 个品种代码表经 `quote://codes` 动态注入）。
- 连接器新增 `market-data.ts`（`createJin10GlobalMarketDataService`：get_quote → Ticker、get_kline → Kline、quote://codes → listInstruments、subscribeTicker 轮询 5s）与 `dataplane.ts`（`@dshtrading/connector-jin10/dataplane`）；patch 行 `dsh-trading-global-dataplane-jin10` 归 base——global 无 bundle/kit，没有市场 bundle 会认领它，而连接器行本身也在 base（铁律 #1）。
- **粒度纪律**：上游只有分钟 K 线，且单次上限 100 根、语义是「从 time 往后取 100 根」，本仓最多拼 300 分钟窗口（3 次上游调用）→ GUI 只上 `1m/5m/15m`（`MARKET_INTERVALS.global`），契约层支持 1m–1h 的分钟子集，`1d` 及以上**显式报错**（不换源、不用单日分钟冒充历史）。闭市返回 `klines: []` 照实回空序列（≠ 故障）。
- 交易日模型（近似，与 futures 行同款口径）：周一 06:00 — 周六 05:00（北京时间）；`MARKET_TIMEZONE.global = null`（跨时区连续交易，不做交易日分组与固定时段 x 轴，`SESSION_SPANS` 改 Partial、缺席市场由消费方返回 null）。
- GUI 承载面：market id 进 `MarketId`/`MARKET_IDS`/`MARKET_SERVICE_KEYS`（`tradingGlobalMarketData`）/MARKET_TAB_KEY/MARKET_INDICES（XAUUSD 现货金、USOIL WTI、SPX）/MARKET_INTERVALS/币种 $/侧栏与自选市场列表；自选搜索经既有 `/symbols` 通路动态注入目录，零新代码。
- **agent 工具面留在连接器**（`global_instruments/global_quote/global_klines` 不退役）：`<market>_get_ticker/_get_klines` 由 preset 平面的 `base/research-tools` 按「已安装市场」生成，该列表来自 bundle contribution——global 没有 bundle；而 `base/market-tools` 的账户/盘口族对纯数据市场只会多注册 7 个必然 `TRADING_NOT_IMPLEMENTED` 的工具。故 `MARKETS`、`ORDER_GATE_PATTERN`、`research-tools` 三个清单本轮**不加** global（零假工具）。后续若 owner 要 market-group 平权（bundle + kit + `global_get_ticker` 命名族 + persona 市场列表），按 `2026-09-12-futures-market-group.md` 清单落地。


### 4. 桌面壳启动实测抓出的两个 loader 契约坑（同批修复）

真实宿主（packaged 桌面壳）首次挂载本连接器时**整棵树加载失败、host 退出码 1**，两条根因都在「patch 行的 name 决定 loader 读哪个模块」这一契约上：

- **根入口未重导出 `inject`**：patch 行 `name: '@dshtrading/connector-jin10'` 解析到 `lib/index.js`，而 loader 只从该入口读 `name/inject/Config/apply`。`src/plugin.ts` 里 `export const inject = ['tools']` 有，但 `src/index.ts` 只重导出了 `{ apply, Config, name }` → unbundle 产物把「无模块引用的导出」丢掉（`lib/plugin.js` 的聚合 export 里没有 inject）→ 宿主 `cannot get property "tools" without inject`。**修**：入口重导出 `inject`；并加回归断言「根入口重导出 name/inject/Config/apply」。
- **数据面行未导出 `Config`**：patch 行不带 `config:` 时，loader 只认**该模块**导出的 schema 补默认值；`dataplane.ts` 当时只 `import type { Config }`，于是 `apply(ctx, undefined)` → `Cannot read properties of undefined (reading 'enabled')`。**修**：`export { Config } from './plugin.js'`（与主行共用同一份 schema，避免默认值漂移）+ `apply(ctx, config?: Partial<Config>)` 对 undefined 给缺省。
- 教训写进 `docs/guides/connector-playbook.md` §4.2：包内单测直接 `apply(fakeCtx, config)` 不会暴露 loader 元信息缺失——真实宿主启动是这类改动的必要验证面（本轮正是桌面壳启动抓出的）。

## Verification

- 单测 50 例全绿（`pnpm --filter @dshtrading/connector-jin10 test`）：握手顺序与一次握手、会话头回带、缺凭证不发请求且补配后可重试、401/429/5xx/JSON-RPC error/坏形状映射、structuredContent 优先与文本兜底、限流与未知品种文案识别、解析层（标题提取/东八区时间/分页字段/正文丢弃/坏条目丢弃）、工具渲染与参数透传、插件注册与重名不覆盖、apply→工具 execute 的真实链路（打桩 fetch + 设置中心凭证）。
- 出网验证 `JIN10_TOKEN=... node spikes/impl-jin10-mcp/verify.mjs`：13/13 通过（约 1–3s；闭市时段上游响应偏慢），跑的是构建产物 `lib/index.js`，覆盖 `quote://codes` 资源 → 快讯两页翻页 → 快讯搜索 → 资讯列表/搜索/详情 → 财经日历 → XAUUSD 报价 → 分钟 K 线 → 缺凭证与非法 code 两条错误语义；原始证据 `spikes/impl-jin10-mcp/EVIDENCE/`（含 `recon.mjs` 的 8 工具/资源原始响应）。
- `pnpm -r build` 全绿；`node scripts/typecheck-gate.mjs` 棘轮通过（新 tsconfig 入基线，0 错）；`packages/base/test` 46 例全绿。
- 续作门禁（2026-09-13）：`pnpm -r build` 全绿；`pnpm test` 181 文件 / 1511 例全绿（新增 market-data/dataplane/bridge-flash/flash-service 四组用例）；`node scripts/typecheck-gate.mjs` 棘轮通过（473/473，基线未上调）；`pnpm i18n:check` OK（992 zh keys）。
- 续作出网验证（2026-09-13 周日闭市，走 profile 刷新后的安装副本）：`--dump-config` 见 `dsh-trading-connector-jin10` 与 `dsh-trading-global-dataplane-jin10` 两行；`getTicker('xauusd')` → `{symbol: 'XAUUSD', name: '现货黄金', price: 4348, prevClose: 4316.48, changePercent: 0.73, volume: 241084}`（周末 = 上一交易日快照）；`listInstruments()` → 97 品种；`getKlines('XAUUSD', '5m', 20)` → `[]`（上游 `klines: []`，与首轮已知限制同款）；`'1d'` → `TRADING_UNKNOWN` 显式报错；未登记代码 → `TRADING_UNSUPPORTED_SYMBOL`。
- 未做的验证：分钟 K 线拼窗口与本地聚合的**真实**数据路径（周末上游回空，需交易日复测）；真实客户端（桌面壳/CLI）挂载后的 UI 呈现（设置卡片、快讯面板、全球市场行情/图表）由用户实测。
