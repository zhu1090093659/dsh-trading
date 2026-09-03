# Agent Note: 中心化 i18n 语言包 — en + 简体中文（zh-CN）双语交易 GUI

Status: implemented

## Problem

交易 GUI 文案双语现状不完整：4 个 UI 包壳层文案已走宿主 `@deepseek-ai/dsh-client-locale`
（typed register zh/en 词典），但约 64 个 client 文件硬编码中文——最大的
FundamentalsStage（约 130 键，文件头甚至注明「暂不进 locale 词典」的 owner 旧决策）、
NewsFeedPane 相对时间/来源名、MarkerTooltip、toolview 富卡片、compose-quote 的
agent 上下文文案；`亿/万/万亿` 数值单位是 zh-only 格式化。且键位对齐无门禁，
zh 改 en 漏改无法机器发现。

## Decision

1. **中心化语言包插件 `packages/dsh-i18n`**（范式对标 dsh-web 同名包）：
   宿主半 no-op；浏览器半 `ctx.locale.addLanguage({ id: 'zh-CN', label: '简体中文',
   fallback: 'zh' })` + 逐命名空间 untyped `register(ns, 'zh-CN', dict)`。
   宿主内置 zh/en 由源包持有，本包只承载**额外语言**（后续加 ru/de = import
   词典模块 + PACKAGES/LANGUAGES 各一行）。词典构建期直接 import 各源包
   `src/client/locales.ts`——**zh-CN ≡ zh 零拷贝零漂移**，这是与 dsh-web ru 包
   手抄词典的最大差异（那边靠 audit 查漂移，这边结构性消除漂移）。
   base/cordis.patch.yml insert 行 `dsh-trading-dsh-i18n`（铁律 #1，共享行 base 拥有）。
2. **词典抽离 `src/client/locales.ts` 纯数据模块 + `./locales` exports 子路径**：
   4 个 UI 包的词典从 `client/index.ts` 函数体抽为独立模块（typed register 编译期
   键位校验保留），node 半 tsdown entry 加 `src/client/locales.ts`，产物
   `lib/client/locales.js`。dsh-i18n 与 audit 脚本都从这一份吃。
3. **硬编码全量提取**：FundamentalsStage（约 179 个 t() 调用，覆盖旧「暂不进词典」
   决策）、NewsFeedPane（相对时间 6 键 + 数据源显示名 9 键）、MarkerTooltip、
   QuoteStage 信号 reason/标记开关、TvChart 买卖标记（markerTexts prop）、
   toolview 富卡片（订单/自选卡）、market-status 指数名（nameKey 词典键）、
   settings 的 provider 显示名/凭证字段标签/占位符（controller 数据表存词典键，
   渲染处 t() 解析）、strategies toolview 指标标签复用 sv.metrics.*、
   knowledge `未分类` 哨兵改 ASCII `untagged`（纯数据值非文案）。
   compose-quote（发给 Agent 的上下文文本）走 `QuoteMessageCopy` 注入面：
   默认 zh 常量保兼容，QuoteStage 用 `compose.*` 词典键注入 en 文案。
4. **数值单位 locale-aware**：`fundamentals.scale` 作**词典哨兵键**（zh 值 '万'、
   en 值 'B'，不在 UI 渲染）——`t` 不携带 active locale 元数据，从词典值判定
   zh/en 单位制，天然随语言切换响应。`formatScaled`/`fmtCompact`/OrderbookPane
   `compactAmount` 全部双制（zh 亿/万亿/万，en B/M/K）。
4b. **host 数据面文案（策略/选股器）词典化**（实测补遗）：内置策略/选股器的
   name/summary/参数 label/结果列 label/reason 模板是 `@dsh-trading/strategies`
   纯库的数据值。方案 = **词典键约定 + 视图查表 miss 回退数据值**，host 纯库
   零 locale 依赖：`StrategySignal`/`TradeRecord`/`ScreenerMatch` 加可选
   `reasonKey`/`reasonParams`（结构化插值参数与语言无关），视图层 helpers
   （strategyName/paramLabel/screenerColumnLabel/exitReasonText…）按约定键查
   `dshtrading.strategies` 词典，miss 回退 def 自带值——自定义策略（用户 author，
   单语）自动走回退。词典新增 70 键×2（6 策略 + 5 选股器的 name/summary/param/
   col/reason 模板 + momentum cause 枚举子键）。
   **坑：ScreenerDefinition.id 已含 `scr.` 前缀**（如 `scr.ma-bull-align`），
   键约定直接用 `<id>.name`（不要拼 `scr.${id}` —— 会变成 `scr.scr.*` 永远
   miss，回退 zh 原文，en 下选股器卡全中文的实测根因）。momentum 的 exit
   `{cause}` 槽用稳定枚举键（momentumNegative/belowBaseline），视图渲染前先
   过 `strat.momentum-12m.cause.*` 词典。
5. **audit 门禁 `scripts/i18n-audit.mjs`**（自 dsh-web 移植改）：zh/en 键位双向
   对齐、`{placeholder}` 对齐、client 文件 CJK 扫描（行尾/文件头 `i18n-allow:`
   豁免）、dsh-i18n 中心包覆盖与漂移检查。root `pnpm i18n:check` / `i18n:report`。
   豁免仅限两类：**数据谓词**（数据源中文枚举/占位名匹配，如 `\(A股\)`、`'新进'`、
   `'公告'` 关键词）与 **locale 数据常量**（zh 单位字面量、语言自述名）。
   UI 文案不允许豁免。维护契约写入 `packages/dsh-i18n/AGENTS.md`：
   改 zh 键 = 同变更内改 locales.ts + contract union + 重建源包 + `pnpm i18n:check`。

## Gotchas（实测踩到）

- **audit 读 lib 产物**：dsh-i18n client 半 import 源包 `lib/client/locales.js`——
  源包词典改动后必须先重建源包再重建 dsh-i18n，否则 drift 报警（这正是门禁价值，
  但 CI 里 build 顺序要保证）。`pnpm --filter './packages/client-ui-*'` glob filter
  实测漏包，显式 `pnpm -r build` 稳妥。
- **`{{provider}}` 双括号笔误**：settings 词典 2 处 `{{provider}}` 是既有 bug
  （SDK 插值是单括号 `{name}`），en 下渲染出 `{Binance}`，本次顺手修正。
- **settings 包 PropsLocale 的 t 座位**：本包独立编译下 PropsRuntime 的 SlotMap
  merge 不完全（`dshtrading.market.tab` 由本包 contract/slots.ts 声明），组件 t
  解析为 never（main 基线 20 处 TS2349 的根因）。本次修法：MarketProviderPanel
  解构改名 `t: tProp` + 本地 `const t = tProp as PanelT` 遮蔽；并给 settings 补了
  `contract/locale-keys.ts`（从 locales.ts 派生键 union + LocaleNamespaceMap augment
  + 显式 import locale/client 与 slots 的 type-only 链）。**augment 生效的充要条件：
  程序内有对被 augment 模块的 type-only import**（`import type {} from ...`）——
  strategies/knowledge 的 contract 无 import 也成立是因为 augment 目标模块经
  其它 import 链被解析；settings 单独文件需要显式引。
- **locales.ts 的 zh 标注**：settings 词典原来 `Record<string, string>`（无键
  union），augment 需要 `Extract<keyof typeof zh, string>` 落具体键——已补
  `SettingsLocaleKey` union（机械生成 98 键）。
- **profile 装载**：bundle patch 行引用包名 → profile dependencies 必须有
  `@dsh-trading/dsh-i18n`（file: 协议），`refresh-trading-web-profile.sh` 只刷新
  @dsh-trading/* 副本不更新 package.json，新包要手工加依赖行再 install。
- **typecheck 棘轮**：四包 locales 抽取触发 t 类型面重排，顺带清了部分既有债
  （549 → 528，净降 21）；settings 仍有 20 处既有 never 座位债（非本轮范围）。

## Validation

- `pnpm build`（51 产物）+ `pnpm test`（104 文件 780 测试）+ typecheck-gate
  （528 ≤ 基线 528）+ `pnpm i18n:check`（4 namespaces, 586 zh keys, 21 exemptions,
  83 host-half warnings——host 半是 agent 面文案，本轮范围外只 warn）全绿。
- trading-web profile 实测（browser-use 真实 Chrome）：Settings → General → Language
  出现「简体中文」选项；zh-CN ↔ English 双向切换，验证——交易壳全链（页签/工具栏/
  状态栏/自选）、FundamentalsStage 全部 8 大分类导航 + 估值页签标签、en 数值单位
  `Vol33.75M` ↔ zh `量3374.67万`、新闻/设置页签、策略页（Quantitative 策略卡/
  参数 label/Run Backtest 后 Trade Log 的 exitReason en 模板 "Close (…) falls
  below the 10-bar low (…)"；Screener 5 张选股器卡/参数/动态列头）双语全链。
  残留：仅数据面中文（股票名、公告标题、指数值），属数据非文案。
- 遗留：settings 独立编译的 PropsRuntime merge 债（7 处 TS2349，运行时无害，
  t 座位由框架注入）；agent 面文案（工具 description/skills markdown/knowledge
  工具输出）owner 裁决本轮不含。

## Files

- 新增：`packages/dsh-i18n/`（插件 + 测试 + AGENTS.md + cordis.patch.yml）、
  `scripts/i18n-audit.mjs`、`packages/*/src/client/locales.ts`（4 包）、
  `packages/client-ui-settings/src/client/contract/locale-keys.ts`
- 修改：4 UI 包词典抽取与硬编码提取、base/cordis.patch.yml（insert 行）、
  root package.json（i18n:check/i18n:report）、typecheck-baseline.json（549→528）