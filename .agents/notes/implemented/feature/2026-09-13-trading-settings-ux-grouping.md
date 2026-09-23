# Agent Note: 交易设置界面分组化与统一保存交互

Status: implemented

## Problem

设置 →「交易」是一页平铺堆叠：涨跌配色与市场快讯数据源两个等权 fieldset 之后才是市场
tab 栏，每个市场面板里又依次是行情提供方卡片网格、「保存/放弃」、CryptoPanic key 的
「保存/放弃」、新闻公告数据源的「保存」。同一屏出现三组同名按钮，用户无法判断哪一组属
于哪块；全局项与市场项视觉权重相同，tab 栏夹在全局卡片之间，作用域不清；「当前」徽标
直接显示原始 provider id（`okx`）而非本地化名称；凭证抽屉展开会把整行网格卡拉伸。

## Decision

1. **页面分两组**：`TradingSettingsSection` 输出「通用」（涨跌配色、市场快讯数据源，
   市场无关、即时生效）与「市场数据源」（市场 tab 切换 + 当前市场面板）。组标题 + 一句
   说明承担层级，市场 tab 栏收进「市场数据源」组内并改成分段控件。
2. **每市场一个 draft + 一条操作栏**：`MarketProviderPanel` 拆成「行情提供方」与
   「新闻公告数据源」两个子分区（分隔线表达层级），把 provider 选择、CryptoPanic key、
   新闻/公告源三个 draft 都提到面板层，底部一条 sticky 操作栏统一「保存/放弃」并显示
   「有未保存的更改」。API 凭证仍在卡片内独立即时保存——凭据按 provider 全局共享，
   语义不同于市场路由选择。
3. **当前 provider 本地化**：`current` 徽标经 `PROVIDER_LABELS` 解析为显示名，未覆盖
   默认时补「默认」标签。
4. **凭证抽屉可逆动效**：抽屉常挂载，用 `grid-template-rows: 0fr → 1fr` 加
   `visibility` 过渡，展开与收起走同一条路径；`prefers-reduced-motion` 下关闭过渡。
   卡片网格改 `align-items: start`，展开不再拉伸同行卡片。
5. **词典与门禁**：新增 zh/en 键（组标题、子分区标题/说明、未保存提示、状态 chip 等），
   `SettingsLocaleKey` union 同步，重建 `@dshtrading/client-ui-settings` 与
   `@dshtrading/dsh-i18n`。

## Alternatives considered

- **保留三组保存按钮、只补标签**：落选——仍是三个动作与三套 dirty 状态，没有解决
  「哪块属于哪」的核心问题。
- **把各市场 draft 提到 section 统一保存**：落选——section 通过 `dshtrading.market.tab`
  插槽渲染各市场面板，面板对 section 不透明；跨市场统一会破坏插槽契约。每个市场面板
  才是正确的 draft 归属边界。
- **凭证编辑移到网格下方整宽抽屉**：本轮不做——改动面大，且凭证按 provider 全局共享、
  与路由选择生命周期不同，卡片内独立保存成立；只修网格对齐消除拉伸。
- **操作栏不放 sticky、回归文档流**：落选——us 市场有约 9 个 provider，保存按钮会落在
  首屏之外，反而不如常驻操作栏自然。

## Consequences

- 设置命名空间、写动作、插槽注册、revision-fenced mutation 全部不变；纯 UI 层重构。
- 未保存状态由面板统一计算，切换勾选/选择立即反映在底层操作栏；「恢复默认源」保留为
  新闻子分区的即时动作（清除 market 覆盖）。
- 验证：`pnpm --filter @dshtrading/client-ui-settings build` 通过、包内 6 例单测全绿、
  `node scripts/i18n-audit.mjs --check` OK、`node scripts/typecheck-gate.mjs`
  （472 ≤ 基线 473）。用独立 `DSH_HOME` + 桌面运行时启动的 trading-web 实例做无头
  Chrome 截图：深色/浅色、凭证抽屉开与收（120ms 中间态高度 12px 证明反向过渡）、
  滚动到底、900px 窄窗（无横向溢出），控制台零异常；ArrowRight roving tabindex
  焦点移入下一市场 tab。
- 未覆盖：真实桌面壳刷新后的实例由用户实测；本变更未触碰宿主 profile 副本与运行中服务。

## 0.1.7 cohort 迁移（2026-09-23）：settingsScope → configForms + locale 合并宿主前移

0.1.7 官方把客户端设置读写面整体换代为 `configForms`，本节记录本包随 cohort 的接线变更
（UI 结构、词典、写动作语义均不变）：

- 绑定：`ctx.settingsScope.bind<T>({ namespace: 'dshtrading' })` →
  `ctx.configForms.get<T>('dshtrading')`（软服务 inject `settingsScope` → `configForms`）。
  `ConfigForm` 的 `getSnapshot()` 与 `mutate(ops, revision?)` 契约与旧 `SettingsScope` 同形
  （status/value/base/user/revision/writable/mode + revision-fenced path ops），控制器
  `projectSnapshot` 只换类型名。类型 `SettingsScope`/`SettingsScopeSnapshot` →
  `ConfigForm`/`ConfigFormSnapshot`。
- 只读 shim：0.1.7 的 `dsh-client-store` `SnapshotStore` 已含 `update/set`，本包只用
  getSnapshot+subscribe 的面，改为包内 `TradingSettingsStore`（不再对外声称完整
  SnapshotStore，避免补一堆用不到的写桩）。
- locale：`LocaleNamespaceMap` 的声明宿主由 `@deepseek-ai/dsh-client-locale/client`
  迁至 `@deepseek-ai/dsh-client-ui-slots`，本包 `contract/locale-keys.ts` 的合并目标跟着走。
  否则 `dshtrading.settings` 不进键联合，`register/bind/PropsLocale` 全报错——是本次
  4 处增量 tsc 错误的主因。
- 词典键收窄后 `TranslateNS<'dshtrading.settings'>` 只收字面量键：动态拼接键
  （`'market.' + slug`）与面板内部的 `PanelT`（string 键）在边界单点断言，值域仍由
  词典测试兜底。
- 门禁：`packages/client-ui-settings/tsconfig.client.json` 由基线 11 清到 0，typecheck
  棘轮总错误数 475 → 464（`node scripts/typecheck-gate.mjs` 通过）；包内 6 例单测全绿。
