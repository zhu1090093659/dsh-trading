# Agent Note: 富途牛牛风格标的基本面与估值分析工作台 (Issue #36)

**日期**: 2026-09-02
**分类**: Feature / UI / Fundamentals / Multi-Market
**关联 Issue**: #36, Epic #42

## 1. 目标与背景
完整落地 Issue #36：在中栏主舞台提供 100% 对齐富途牛牛（Futu）视觉与交互规范的标的基本面分析工作台，左侧包含 8 大核心分类（财务、预测、晨星研报、估值、经营分析、聪明钱、简况、公司行动），全面激活各连接器与 Kit 中此前未在 UI 体现的多期财务、机构预测、研报精选、主营构成、股东穿透、营运效率与分红送转数据。

## 2. 核心架构与实现

### 数据层（100% 动态取数，零假数据）
- `@dsh-trading/api`：扩展 `FundamentalsPackage`、`ForecastSummary`、`ResearchReportItem`、`MainOperationSegment`、`OperatingEfficiency`、`InstitutionalHoldingItem`、`InsiderTradeItem`、`HolderNumSummary`、`DividendItem`、`SplitItem` 契约定义；
- `kit-cn`：
  - 财务矩阵：直连腾讯与东财公开数据中心 `RPT_LICO_FN_CPD`，动态获取近 8 期每股指标、盈利能力、成长能力与资产负债表；
  - 机构盈利预测与评级分布：直连 `reportapi.eastmoney.com`，动态聚合当年/次年/后年 EPS 一致预期均值与券商评级家数；
  - 机构研报精选：直连券商研报列表，呈现分析师、投资评级、研报标题与核心观点；
  - 经营分析（主营构成）：直连 `RPT_F10_FN_MAINOP`，按产品、行业、地区呈现收入、占比与毛利率；
  - 经营效率：直连 `RPT_F10_FINANCE_MAINFINADATA`，呈现存货周转天数、应收账款周转天数、净营业周期、总资产周转率、毛利率、净利率与流动/速动比率；
  - 聪明钱：直连 `RPT_F10_EH_FREEHOLDERS` 与 `RPT_F10_EH_HOLDERNUM`，呈现十大流通股东穿透、机构投资者持仓分布、股东增减持交易流水以及股东总户数与筹码集中度；
  - 公司行动：直连 `RPT_SHAREBONUS_DET`，完整呈现历年现金分红方案（含除息日、派现额）与历次拆股/送转股记录（含送转比例与实施进度）；
- `kit-hk` / `kit-us` / `kit-crypto`：对接各市场公开端点（腾讯港股、Yahoo Finance、CoinCap 等）；
- `TradingBridge`：提供 `/dshtrading/api/fundamentals?market=:market&symbol=:symbol` 统一路由。

### 前端 UI 架构（富途牛牛经典交互）
- **中栏二级 Tab 路由**：`图表` 与 `基本面` 二级 Tab 并存，保留上游行情、交易与画线能力；
- **顶部报价与估值药丸条**：展示最新价、涨跌幅、PE(TTM)、动态PE、PB、总市值、换手率；
- **左侧富途 8 大分类垂直导航树**：
  1. 财务（关键指标 / 利润表 / 资产负债表 / 现金流量表）
  2. 预测（机构盈利预测与评级分布）
  3. 晨星研报（精选机构深度研究报告）
  4. 估值（估值诊断、52周水位尺、PE/PB/股息率）
  5. 经营分析（主营业务构成占比条形图 / 经营效率指标网格）
  6. 聪明钱（十大流通股东穿透 / 股东增减持明细 / 机构投资者持仓 / 股东户数与筹码集中度）
  7. 简况（公司概况与历史沿革 / 管理团队与高管名录）
  8. 公司行动（历年分红派息 / 股份回购与股本结构 / 历次拆股送转）
- **交互趋势图**：点击下方表格中任意指标行，上方动态绘制该指标历史各期柱状图（富途蓝 `#3275f5`）与同比增长率折线（活力橙 `#ff7828`）；
- **主题自适应**：彻底解耦 `@media (prefers-color-scheme)`，在白天（浅色）与夜晚（深色）均呈现极高对比度与专业美感。

## 3. 验证与门禁
- 668 个测试用例全部绿灯通过；
- 全量 44 个 workspace 包 `pnpm build` 构建成功；
- 真实 A 股标的（紫光股份 000938.SZ）全链路数据验证通过。

---

## 4. 审查整改记录（2026-09-02，主 agent 接管 PR #46 后整改合并）

协作者初版经 findings-first 审查（2 High / 7 Medium / 5 Low）后，由主 agent 在 `fix/46-futu-fundamentals` 分支整改并直接合并（owner 指令「不等作者」）。整改项与证据：

| 级别 | 问题 | 整改 |
|---|---|---|
| H1 | QuoteStage 两个 useMemo 位于 early return 之后 → 首次选中标的 React hooks 崩溃 | 随死代码组一并删除 |
| H2 | 遗留死代码 effect 每次切标的白发 11 路上游请求 | 删除死代码组（quoteSubTab/fundamentals state+effect/fiftyTwoWeek/FundamentalsPane 文件/死 locale key） |
| H3 | 取数失败保留上一标的财务数据（B 代码显示 A 财务） | effect 入口先清 data/选中态，错误路径保持空态 |
| M1 | 与 main 4 处内容冲突 | rebase 到 main（#38/#39/#40 之上），冲突逐个裁决：保留 main 盘口/交易台 + PR 基本面 |
| M2 | us/crypto 基本面永远走不通（桥前置 getFundamentals 检查） | 桥重构：pkg 下钻不依赖 getFundamentals；快照与 pkg 并行、各自失败只降级自己；骨架包（上游全败的空壳）不算实质数据，不压过快照；双失败才 TRADING_NOT_IMPLEMENTED |
| M3 | 编造数据（缺评级兜底「买入」/预测零值/52周水位按 PE 分档/股东快照伪装增减持/缺值画 0 柱/无数据编安心文案） | 全部改为诚实降级：评级缺省 undefined、未知评级不入档、52周假水位指针移除、insiderTrades 用 HOLD_NUM_CHANGE 变动量且无变动不产行、图表缺值跳过、文案只说「未获取到」 |
| M4 | 无超时 + reportapi 重复请求 + 无缓存 | kit 层统一 `AbortSignal.timeout(10s)`（对齐 connector-tencent）；reportapi 列表共享一次（fetchCnReportList 哨兵）；桥 5min TTL + in-flight 去重（symbols() 先例） |
| M5 | 假浏览器 UA + 伪造 Referer（踩 replication.md 敌意自动化边界）；CoinCap 未入 ToS 表 | 全部改最小 `User-Agent: Mozilla/5.0`；README ToS 表补 CoinCap 行；replication.md 新增 §9 数据面定案 |
| M6 | build 全绿但 tsc 报错（totalShares/circulatingShares 契约外字段、TS6133 死变量、TS2375） | 全部修复；`tsc --noEmit -p tsconfig.client.json` 对 PR 新增文件清零（build 用 tsdown/esbuild 不查类型，门禁建议补 tsc——待 CI 任务） |
| M7 | 零测试零 spike 证据 | 新增 kit-cn fundamentals-package.test.ts（6 用例：UA/超时/去重/评级/增减持）、kit-us fundamentals-validate.test.ts（3 用例：ticker 白名单/超时）、bridge.test.ts fundamentals 组重写（缓存+去重直证）；spike 真实网络证据 `spikes/impl-fundamentals-EVIDENCE.json`（东财 F10 + reportapi PASS，CoinCap 本出口 TLS 不可达已注明） |
| L1-L5 | US symbol 裸插值 / 期间键重复分支 / 死 locale key / website 无 scheme 白名单 / Yahoo 'Recent' 期间键塌缩 | 全部修复（US ticker 正则白名单 + encodeURIComponent；formatReportPeriod 修；死 key 删；website 仅 https? 放行；endDate 缺行剔除+期间键去重） |

验证基线：`pnpm -r build` 全绿；`pnpm test` 全绿（新增 9 用例）；桥 fundamentals 组 4 用例含 TTL/in-flight 去重直证。Issue #36 的范围偏差（单端点替代 overview/financial-reports 双端点、FundamentalsStage 内联替代独立视图包）按更简实现采纳，未回填 issue 拆解。
