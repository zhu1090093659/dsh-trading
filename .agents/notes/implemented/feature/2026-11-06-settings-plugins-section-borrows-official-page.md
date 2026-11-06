# Agent Note: 插件管理入口落在设置壳的插件分区（借壳官方整页）

Status: implemented

## Problem

trading-web 的魔改布局里，官方插件管理整页（`@deepseek-ai/dsh-client-ui-plugin-manager`）注册在
`sidebar.panellist` 的 `plugins` 行，点开占掉布局主面板。本仓用 rtl 重排宿主三栏后，官方侧栏被压成
右缘 1px 占位（[shell-pad.css](../../../../packages/client-ui-trading/src/client/shell-pad.css) 的四轨道接管），
那一行没有可点的几何；设置壳里只有官方的只读「内置插件」分区（`ui-settings-plugin-inventory`），
完整管理器（安装/启停/卸载/更新）在 GUI 里不可达。

## Decision

- **入口落在设置壳**：`@dshtrading/client-ui-settings` 注册 `settings.section` 分区 `dshtrading-plugins`
  （order 15，与官方 `ui-settings-plugins` 同席位）。**id 不复用 `plugins`**：list 槽同优先级重复注册会抛错，
  而官方那条由 `configForms.whileServed` 门控、随时可能注册；实测复用 id 时本包注册直接失效、导航里两项都没有。
- **零重写**：分区不实现任何插件管理逻辑，只把官方整页借过来显示——`ctx.get('layout').selectPanel('plugins')`
  选中官方 main 面板，宿主随即给主面板写 `[data-global-panel]`（`dsh-client-ui-layout`：`"data-global-panel": panelId !== null || void 0`），
  `plugins-section.module.css` 把该节点 fixed 到分区矩形，四个 CSS 变量由 `plugins-host.ts` 用 ResizeObserver 跟随。
  官方页的列表、安装对话框、注册表探测、启停与更新全部原样。
- **两条退化路径都落 `body[data-dshtrading-plugin-host='unavailable']`**：layout 服务缺席、`selectPanel` 抛错
  （宿主没注册该面板）。分区显示说明文案而不是留成空白。
- **矩形铺到弹层右缘**：设置壳的内容列有固定宽度（1600 视口下仍只有 564px），只放宽面板不够。
  借壳态给设置壳的**弹层**打 `data-dshtrading-plugin-host-panel`（CSS 放宽到 `min(1200px, 100vw - 48px)`），
  矩形以分区容器左上角为起点、以弹层边界减 24px 为右下界。
  挑弹层是两层判据：先锁铺满视口的 overlay，再取它里面最宽且自身没铺满视口的子元素（蒙层宽高都等于
  overlay，按这条排除）。改错对象立刻露馅——改 overlay 宽度会让弹层在容器里重新居中而整体偏左，
  改一个 static 中间层会让弹层宽过视口而溢出，两种都实测过。
  容器标记用 `data-dshtrading-plugin-anchor`，**不与 body 状态标志同名**——同名属性会让
  `querySelector('[data-dshtrading-plugin-host]')` 把 body 一起挑出来。
- **侧栏那一行不处理**：魔改布局下 `sidebarCol` 宽 1px / 高 0，官方 `plugins` 行几何为 0，天然不可见。
  左栏底部的设置齿轮不变（[设置入口迁左栏底部](2026-09-05-tasks-panel-container-switch-and-settings-move.md) 的结论照旧），
  本记录只在设置壳内部加一节。与 [npm 内置插件管理器](2026-09-08-npm-embed-usage-plugin-manager-model-capabilities.md)
  那条历史决策也不冲突——那条是内嵌第三方实现，本记录是复用宿主自带的官方页。

## Consequences

- 官方页的响应式按容器宽度生效：宽视口下内容区 764px（工具栏是完整标签），视口窄于 768px 时仍会
  收缩成图标按钮——那是官方页自己的断点行为，不是本仓的。
- 宿主升级要重新核两个锚点：`[data-global-panel]`（layout 在 `panelId !== null` 时写）与 `PANEL_ID = 'plugins'`。
  任一改名，分区落到 unavailable 而不是白屏。
- 官方页自身的 `pluginChanges` / `pluginNavigation` 两套导航动作照旧注册（整页未被遮蔽），借壳只改它的显示位置。

## 验证

- `pnpm --filter @dshtrading/client-ui-settings test`：33 例全绿，其中 `test/plugins-section.test.ts` 6 例钉住
  四个借壳分支（打开/卸载/layout 缺席/面板未注册）与注册面（分区 id、order、组件）。
- 实机 trading-web：设置导航 5 项 → 6 项；点「插件」后 `body[data-dshtrading-plugin-host='on']`
  与 `[data-global-panel]` 同时就位，官方整页渲染在分区矩形内（内置插件配置 / 实验性插件 / 已安装插件）。
  - 1600x813：弹层 800 → 1200（x=200，居中不溢出），官方页 564 → 964，`添加插件` 恢复完整标签。
  - 780x473：弹层 732（x=24），官方页 496x347、右缘 732 < 756，不溢出，工具栏按官方断点收成图标。
  - Before/After 截图在 `.local/acceptance/plugins-section-2026-11-06/`（本机不入库）。
