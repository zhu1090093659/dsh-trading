# Agent Note: 「发给 Agent」快照升级——K 线全序列 + 指标逐柱数值 + 取数位置随消息内联

Status: implemented

## Problem

「发给 Agent」落地语义只填入快照摘要（现价/涨跌/昨收 + 十字线读数当根 K 线 OHLCV + 已开指标**标题**）+ 图表截图（[2026-09-02 记录](2026-09-02-watchlist-agent-visibility-and-send-to-agent.md)、[2026-09-04 入口统一](2026-09-04-unified-send-to-agent-entry.md)）。owner 2026-09-05 实测两个缺口：

1. **序列不在场**：用户选日 K，Agent 收到的只有「当根」读数——日 K 的每一根 K 线数据都不在消息里。Agent 对着截图觉得没用（视觉输入难读数），只能自己再去抓标的行情，抓取口径（数据源/周期/条数）还未必与用户所见图表一致。
2. **指标只有名字没有数值**：快照列「已开启指标：MA、MACD」，但指标算出的逐柱数值（含参数结果如 MA5/DEA）不在场——Agent 要么瞎猜、要么自己复算一套参数对不上的。

## Decision

1. **新数据段追加在快照之后**（新纯函数 `compose-quote-data.ts`，与 `compose-quote.ts` 同款「词典注入可测」范式）：快照摘要（人读）之后空一行，接「【图表数据】」段（机器读），一并在 composer 草稿里交付；只填不发语义不变（owner 2026-09-02 裁决沿用）。
2. **内联 CSV 数据块**：```csv 围栏，每根 K 线一行——`time,open,high,low,close,volume` + 已开指标全部 output 数值列（与 K 线逐条对齐，warm-up 未就绪 = 空单元格；output key 跨组撞名时列头以「指标名.key」消歧）。日线类周期 time 落日期、盘中周期落到时分（本地时区，locator 行标注 `UTC±n`）。
3. **取数位置（locator）**：段首给 `market · symbol · interval · 共N根 · 首末日期范围 · 时区`，并给两条工具指引——复取走 `<market>_get_klines`（各市场连接器统一注册，附同参数 symbol/interval/limit），复算走 `<market>_get_indicators`（kit 与部分连接器注册，文案以「若已挂载」措辞兜底未注册的数据源）。Agent 因此**可直接用内联数据分析**，也可按同参数复核或取更长历史——解决「收到截图后自己瞎找行情」。
4. **体积护栏**：内联行数默认上限 300（保留最近 N 根），超出时明示「内联最近 300 根（共 N 根）」并把复取 limit 指到全量 N——日 K 750 根全量内联约 80KB 草稿，composer 可用性与 token 成本都不可接受；截断行 + locator 保证 Agent 永远知道去哪拿全量。
5. **i18n**：新增 `compose.data.*` 7 键（contract 键 union + zh/en 词典同步，占位符对齐），`compose-quote-data.ts` 缺省回落 zh 常量（文件头 `i18n-allow:` 豁免，与 compose-quote.ts 同款）。
6. **测试**：新 `test/compose-quote-data.test.ts` 6 例（全列/截断对齐/列名消歧/无指标省略/空序列/zh 缺省文案），时区敏感断言走同源 helper 与本地时区时间构造。pnpm test 216 全绿、i18n:check 过（dsh-i18n 中心包按「先源包后中心包」重建后漂移消除）。

## Alternatives considered

- **全量 750 根无截断内联**：忠实「每一根都发」，但日 K 场景草稿 ~80KB，composer 卡顿、token 浪费在 Agent 极少用到的远期历史上；有 locator + 复取指引在，截断不损失可及性。落选（上限是单常量，owner 可随时调大）。
- **只给位置不内联数据**：消息最轻，但 Agent 每次分析都要多一轮工具调用（时延 + 数据源口径漂移风险）；owner 的痛点恰是「Agent 收到截图后自己瞎抓」。内联 + 位置双保险胜出。
- **指标只发最新一根读数**：体积最小，但趋势/背离类分析需要序列形态；逐柱数值列与 K 线同表对齐，边际成本 ~8 字符/柱。落选。
- **数据作为文件附件**：conversation face 只暴露 `createDraftImages`（图片），非图片附件无官方通道；DOM hack 违反 2026-09-02 铁律。CSV 文本块经 `setDraft` 是文档化路径。落选。

## Consequences

- 「发给 Agent」草稿 = 快照摘要 + 数据段（K 线序列未就绪 `klines === null` 时整段省略，快照兜底）；草稿体积显著变大属预期行为，用户发送前仍可整段删改。
- 指标数值列 = 前端注册表 compute 的输出（与图表渲染完全同源同参数）；Agent 侧 `<market>_get_indicators` 复算走路由数据源，两者在 warm-up 与数据源差异下可能有细微出入——locator 已给出复取参数，差异可解释。
- 内联上限 300 是 `compose-quote-data.ts` 单常量（`DEFAULT_MAX_ROWS`，入参可覆写）；调大只影响草稿体积，不破坏任何断言。
- dsh-i18n 中心包维护契约再次确认：源包词典改动必须「先重建源包、再重建 dsh-i18n、再跑 `pnpm i18n:check`」（audit 读 lib 产物），本次漂移告警即由此而来，按契约消除。
- 宿主若未来开放非图片草稿附件，CSV 数据块可迁移为附件形态，locator 文案不受影响。
