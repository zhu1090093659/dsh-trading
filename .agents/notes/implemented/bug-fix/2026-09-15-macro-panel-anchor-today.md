# Agent Note: 宏观面板首屏锚定今天 + 整周上限 250→400

Status: implemented
Superseded in part 2026-11-07: 首屏锚定已移除、日历改为整周倒序，见
[2026-11-07-macro-calendar-descending.md](2026-11-07-macro-calendar-descending.md)；整周
上限 250→400 一节仍是现行事实。

## Problem

用户 2026-09-15 晚反馈：「宏观经济数据只有昨天 9.14 的，今天的没有」。排查证据：

- **数据链路全程正常**：金十 MCP `list_calendar` 直连实测返回整周 254 条（9-14~9-19，
  9-15 有 52 条且中国 8 月数据带公布值）；宿主桥 `/dshtrading/api/macro/calendar` 同样
  含 9-15（70 条）。面板组件解析、排序、G3 过滤均无日期过滤逻辑。
- **真实体感成因（首屏错位）**：日历列表按公布时间**升序**铺开整周，打开面板视口停在
  列表开头 = 周一 9-14（16 行 G3 条目约占满一屏），今天 9-15 的 35 条在折叠线以下，
  需要手动滚动才能看到——看起来就是「只有 9.14 的数据」。CDP 截图复现实证。
- **伴生缺陷（截尾丢周尾）**：客户端/桥/连接器三处上限 250，而整周条目已到 254，
  `capItems` 按上游原序保头部 250，实际把周五晚间与周六 9-19（3 条）静默裁掉
  （桥返回 by-day 9-18:23 vs 上游 36、9-19:0 vs 3 实证）。周数据量增长会越裁越多。

## Decision

- **首屏锚定今天（2026-11-07 已退役）**：`MacroPanel` 曾以 `calendarAnchorDate`（纯函数，
  本地时区口径；优先今天，今天无条目 → 第一条未公布条目，全部已公布 → 最后一条）在首次
  日历数据就绪后把锚定行滚到列表顶部，用来补偿当时升序排列的首屏错位。日历改为整周倒序
  后该机制连同 `localDateKeyOf`、`calListRef`、`data-dshtrading-cal-date` 一并移除，理由见
  [整周倒序记录](2026-11-07-macro-calendar-descending.md)。
- **上限 250 → 400**：`MacroPanel CALENDAR_LIMIT`、桥 `MAX_MACRO_CALENDAR_LIMIT`、
  连接器 `MACRO_CALENDAR_MAX` 三处同值抬到 400（连接器原注释「超出 400」与值 250
  本就不一致，顺势修正）。400 仍是防炸护栏而非翻页——上游一页即整周（254/整周），
  提到 400 余量充足；桥 401 校验语义不变（实测 limit=401 → 400）。

## Alternatives considered

- **倒序排列（最新在上）**：当时以「日历语义是时间轴读周、与金十网页版习惯相反」为由
  放弃；2026-11-07 用户裁决改为整周倒序并移除锚定，见
  [整周倒序记录](2026-11-07-macro-calendar-descending.md)。
- **「今天」高亮/分隔条**：视觉噪音，锚定后首屏即今天，YAGNI。
- **每次轮询/切地区都重锚**：会把用户手动调好的滚动位置拽回去，只在首次数据就绪
  锚定一次。
- **上限取消**：无上限防炸护栏违背桥侧参数校验契约，保留 400。

## Consequences

- 「打开即见当天数据」的目标 2026-11-07 起由整周倒序承担（首屏是最新日期，不再滚动定位）。
- 整周 254 条全量下 reach 客户端（payload ~44KB），周尾不再被静默裁掉。
- 回归：`macro-panel.smoke.test.tsx` 覆盖双源状态、地区筛选与行序；锚定那一组用例已
  随机制退役替换为顺序断言。
- 桌面壳仍需按 profile 刷新契约重挂副本才能吃到本修复（本轮只刷新验证 trading-web）。
- 2026-09-16 桌面壳核验：桌面宿主与 CLI 共用 `~/.dsh-trading/profiles/trading-web` 的
  @dshtrading 副本，刷新后随桌面壳重启即生效（CDP 实证宏观面板 + 锚定滚动均正常）；
  桌面加载的 dsh-web-frontend 壳 bundle 不含交易 UI 属正常形态，勿以壳 bundle 判功能有无
  （插件客户端模块 /plugins/??…@dshtrading/client-ui-trading/client.js 才是交易 UI 载体）。
  另：单 profile 双活会争任务台账锁——CLI 验证实例存续期间桌面会话 task ledger 降级
  （LedgerLockedError），收口为单实例后随下次桌面壳重启恢复。
  （以上为 2026-09-16 当时核验；其中的锚定滚动此后已退役。）

## Verification

- `pnpm build` 全仓绿；`i18n-audit --check` 绿；client-ui-trading 15 测、connector-jin10
  83 测全绿。
- trading-web 刷新副本重启后：桥 `limit=400` 返回整周 254 条（含 9-19）。
- 2026-09-16 当时核验：CDP 截图实测面板打开 scrollTop=1041、首屏即 9-15 中国 8 月数据；
  该锚定滚动已于 2026-11-07 退役。
