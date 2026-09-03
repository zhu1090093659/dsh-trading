# Agent Note: 同花顺官方金融数据服务接入与跨市场基本面多层降级治理 (Tiered Fundamentals)

Status: implemented

## Problem

1. **A 股基本面数据获取不稳定且缺乏核心短线数据**：
   - 此前 A 股基本面与财务数据主要通过爬取东方财富 PC_HSF10 网页接口与腾讯行情接口。这些接口缺乏官方文档与 SLA 保障，面临防爬变更风险（曾发生 52 周高低点偏移与超时挂起等问题）；
   - 现有数据源缺乏国内 A 股短线与量化投研最看重的**盘中情绪与资金流数据**（早盘集合竞价匹配量与强弱基准、涨跌停池、炸板率、连板天梯、龙虎榜营业部与机构席位）。
2. **美股商业财报数据与基本面取数割裂**：
   - 美股基本面完全依赖公共 Yahoo Finance 端点，高频请求极易遭遇 HTTP 401/429 访问限制；仓内已有商业级 `connector-fmp`（提供 SEC 官方 10-Q/10-K 报表），但未被基本面工具联动。
3. **缺乏本地缓存机制**：
   - 财务报表为低频更新数据（按季度发布），但此前每次打开标的均重新发起上游网络请求，浪费带宽且增加被限流风险。

## Decision

1. **正式接入同花顺官方金融数据服务 (`@dsh-trading/connector-hithink`)**：
   - 依据 `docs/connector-playbook.md` 新增标准 Cordis 连接器包 `packages/connector-hithink`，直连官方 REST API（`https://fuyao.aicubes.cn`），支持 BYOK 环境变量 `HITHINK_FINANCE_API_KEY`；
   - 遵循统一信封协议 `{code, message, request_id, data}` 与标准 `thscode`（如 `600519.SH`、`000001.SZ`）；
   - 提供行情快照（`getTicker`）、多维估值（`getStockFundamentals`，含市盈率 TTM/MRQ、市净率、市销率、市现率）、涨跌停池（`getLimitUpPool`）、连板天梯（`getLimitUpLadder`）、集合竞价快照（`getAuctionSnapshot`）与标的消歧检索。
2. **系统路由与设置中心注册**：
   - 在 `packages/router` 的 `PROVIDER_VOCABULARY` 中加入 `'hithink'`；
   - 在 `packages/client-ui-settings` 的设置中心控制器中注册同花顺的元数据卡片与 `apiKey` 凭证配置字段；
   - 在 `@dsh-trading/cn` bundle 中挂载 `dsh-trading-cn-dataplane-hithink`。
3. **构建跨市场基本面多层路由与平滑降级体系 (Tiered Fundamentals Failover)**：
   - **A 股 (`packages/kit-cn/src/fundamentals.ts`)**：
     - Tier 1（官方源优先）：检测到 `HITHINK_FINANCE_API_KEY` 时，优先通过官方端点拉取高精估值快照；
     - Tier 2（免密公共保底）：未配置 Key 或网络偶发异常时，自动平滑降级至腾讯/东财接口；
     - 本地缓存：增加内存 LRU 缓存（5 分钟快照缓存、24 小时财报矩阵缓存），避免重复请求。
   - **美股 (`packages/kit-us/src/fundamentals.ts`)**：
     - Tier 1（FMP 优先）：检测到 `FMP_API_KEY` 时，优先从 FMP 商业接口拉取，彻底解决 Yahoo 429 问题；
     - Tier 2（Yahoo 保底）：无 Key 时降级至 Yahoo quote/chart-meta；
     - 增加 5 分钟快照缓存与 24 小时财报缓存。
4. **扩展 Agent 专属短线情绪工具与技能赋能**：
   - 在 `packages/kit-cn` 新增 `cn_get_limit_up_pool` 与 `cn_get_auction_strength` 工具；
   - 在 `.agents/skills/company-analysis/SKILL.md` 中将同花顺纳入 A 级权威金融数据源；
   - 在 `docs/connectors-guide.md` 中更新全景接入指引。
5. **衍生品指标栏布局重构（对齐 Binance/OKX 顶部紧凑流式胶囊）**：
   - 将原先堆叠在 K 线图左下角的竖向大方块彻底移除，完全释放 K 线主图的纵向高度；
   - 将合约指标条（`DerivativesPane`）嵌入顶部行情统计栏（`css.stats`）右侧，采用单行水平胶囊排布（持仓量、资金费率与倒计时、多空比、大户比、主动买卖比），支持点击跳转全景页签与一键发给 Agent。

## Verification

- `packages/connector-hithink`: 构建成功，单测 7 个全部通过（覆盖代码规范化、行情、估值、涨跌停池、竞价及 401/429 错误映射）；
- `packages/kit-cn`: 构建成功，单测 35 个全部通过（覆盖腾讯/同花顺双轨降级、缓存穿透测试与涨跌停/竞价工具）；
- `packages/kit-us`: 构建成功，单测 12 个全部通过；
- `packages/router` & `packages/cn` & `packages/client-ui-settings`: 类型与构建全部通过；
- 全仓质量门禁检验通过。
