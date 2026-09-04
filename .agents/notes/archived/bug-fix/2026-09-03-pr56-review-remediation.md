# PR #56 评审整改（H1/M1-M3/L1-L7/H2）——2026-09-03

Archived: 2026-09-04

## 背景

四子代理 findings-first 评审 PR #56（feat/i18n-zh-cn）：1 High 合并风险（分支落后 main 5 提交）、1 High 门禁缺口（i18n audit 未接 CI）、3 Medium 功能 bug、7 Low。owner 指示全部修复后合并 main。

## 整改清单

### H1 分支落后 main（合并前置）

`git merge origin/main`（merge commit 28259c4），三文件冲突逐一保双方语义：

- `index.ts`：保留分支 locales.ts 字典抽取，弃 main 内联 dictionaries()；**补回 #54 新增的 19 个 derivatives 键**（predicted/countdown/analyze/perpSource/hint.* 等，zh+en）——merge 时 main 侧字典整体被弃，键丢了 locale-contract 之外的任何门禁都抓不到，靠 tsc TS2741（`quote.tab.derivatives` 缺键）才暴露一处，其余靠 t() miss 回退静默降级。
- `DerivativesPane.tsx`：保 main 入口化语义（onOpenStage/onAnalyze/hint/fmtCountdown）+ 分支 numLocale。
- `QuoteStage.tsx`：kError 行合流 viewTab（d82167a TDZ 语义）+ loadFailedColon 词典插值。

### M1 en 单位模板金额错 100 倍（已抽验）

`fund.unit.yiCny: '¥{n}00M'` 是字符串拼接陷阱：调用点传 `(v/1e8).toFixed(2)`，en 模板把「亿数值」直接拼上 00M → ¥1.5亿 显示成 ¥1.5000M（真实 ¥150M）。**教训：占位符对齐审计抓不到模板值语义错误**。修法：数值侧换算——组件加 `yiCny/wanCny/holdersWan` helper 按 numLocale 除 1e8|1e6 / 1e4|1e3，词典模板只挂单位后缀（'¥{n}亿' / '¥{n}M'）。同法修 wanCny/holders（去掉 en 的 "w" 中文网络黑话，L4 顺手）。

### M2 财务矩阵绕过 numLocale

`FundamentalsStage` 三处直调 `formatVal`（默认 locale='zh'）：财务矩阵 1376 行、主营构成 826/833 行。矩阵那处在模块级 `GroupFragment` 里够不到组件内的 fv，借道 `formatValue` prop 贯通。

### M3 「发给 Agent」消息中英混杂

`compose-quote.ts` 硬编码 `fmtCompact(volume, 'zh')` + 全角 `（），`。`QuoteMessageCopy` 加 `deltaWrap: [string, string]`（词典值 `'（|）'` 用 `|` 哨兵拆对）、`prevSep`、`volumeLocale` 三字段；QuoteStage 传 numLocale。**en 语境发给 LLM 的量化语境不再混亿/万**（量纲误读风险）。测试：fill-composer en copy 用例 + `not.toMatch(/[（），、]/)`。

### H2 audit 门禁接 CI

ci.yml 在 `pnpm -r build` 后加 `pnpm i18n:check`（audit 读各包 lib 产物，必须 build 后——与 AGENTS.md「audit 读 lib 产物须先重建源包」一致）。

### L5 audit 引擎三处修复 + 11 例单测

1. **行级豁免只认注释**：`scanCjk` 原来对 raw line 做 `includes('i18n-allow:')`，字符串字面量里的标记能豁免自己的 CJK。改为只认 stripComments 返回的 comment span。
2. **deriveNamespace 双引号崩溃**：register 字面量正则只认单引号，双引号让整个门禁 crash（fail-closed 但脆）。两种引号都收。
3. **regex 字面量状态机修复**（评审 residual risk 实证为真）：`stripComments` 不建模 regex，`/x\/\/y/` 里的 `\/\/` 被读成行注释，把行内后续真字符串 comment-blank → **CJK 漏检**（可复现）。加 code 态 regex 消费（按前驱字符判定除号 vs regex，`\\` 跳过、`[...]` 字符类内不终止、未终止行尾恢复）。
4. `scripts/i18n-audit.test.mjs`：11 例覆盖 stripComments/scanCjk/deriveNamespace/diffKeySets/diffPlaceholders 纯函数（audit 引擎此前零覆盖）。

### L6 契约测试

- `client-ui-strategies/test/locale-contract.test.ts`：双 fixture（锯齿 + 长趋势，单 fixture 触不发全部 6 范式）驱动引擎，断言每个发出的 reasonKey 在 zh+en 词典且 reasonParams 覆盖模板占位符——此前这条不变量无任何东西钉住，违反时 en 下静默显示中文。附 strategyName/screenerName/exitReasonText（momentum {cause} 枚举预翻译）单测。
- `dsh-i18n/test/apply.spec.ts`：补 register-throw 隔离、清理逆序 + disposed 双调用守卫、失败注册不留 disposer、PACKAGES 字典身份（toBe 而非键数）四组用例。

### L7 破模块环 + t() 去重

`ScreenerPane ↔ StrategyView` 互引（渲染期安全但打包重排会 TDZ，本仓 d82167a 前科）：8 个查表 helper 抽到 `strategy-locale.ts` 第三模块，统一 `translateOr`（t 单次调用 + miss 比对），ScreenerPane 每行 2–4 次 t() 降为 1 次。StrategyView re-export 4 个保持兼容。

### 类型债清偿（merge 引入 64 → 57）

merge 把 main 的 #54/#55 代码带进来，但分支基线 57 是对 #54 之前的树算的。除 locales 缺键（TS2741）外，i18n × #54 交互型错误全部真修：

- `DerivativesPane` funding cell：exactOptionalPropertyTypes 下 `sub: a || b || undefined` 把 undefined 摊进字面量类型 → IIFE 归并 string|undefined 再条件展开。
- `QuoteStage` deltaWrap 解构加默认值；`onAnalyze={cond ? fn : undefined}` 改条件 spread（exactOptionalPropertyTypes 惯例）。
- `fill-composer`：`deps.conversation` 可选，早退守卫后绑定非可选局部 `conversation` 替代后续裸访问。

剩余 57 个为两代共有的长-standing 棘轮债（index.ts 31 个等），未动——棘轮语义本来就只要求不升。

## 全量门禁

`pnpm build` 51 包全绿；typecheck-gate 528=528（棘轮通过）；`pnpm i18n:check` 4 ns 683 keys OK；`pnpm test` 107 文件 828 测试全绿。

## 评审 Questions 的处置

- audit 不进 CI：确认为遗漏（PR 描述自称 gate），已接（H2）。
- `ProviderMeta.label` 改词典键：仓内消费方已全改，PR 描述补了 consumer-visible rename 说明。
- README 标语改动：owner 知情，已单独提交 a94fb4d 随分支走。
- compose-quote 文件级 i18n-allow：ZH_COPY 兼容常量保留文件级豁免（注释已说明），未拆模块——收益不抵改动面。