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
- **慢与坏要分得开**：官方页是懒加载的，`waitForPluginPanel` 观察 `[data-global-panel]`——出现即撤掉说明文案，
  超过 `PANEL_TIMEOUT_MS`（8 秒）仍未出现就换成 `plugins.timeout` 文案并给出重试按钮，重试重新走一次借壳；
  官方页迟到时仍然接管分区，用户不必自己重开。此前只有一句常驻的「正在打开插件管理…」，官方页静默缺席时
  分区永远转圈。
- **矩形就是分区自身**：插件分区与其它设置分区同宽（2026-11-07 用户口径）。此前铺到弹层右缘并把设置壳
  弹层放宽到 `min(1200px, 100vw - 48px)`，用户反馈"宽度比别的分区大很多、不统一"，整套放宽判据
  （`findShellPanel` / `data-dshtrading-plugin-host-panel`）随之下线。官方页在窄容器里会把工具栏收成图标，
  那是它自己的断点行为。
- **层级**：借壳面板 `z-index: 1100`，必须高于设置壳 overlay（1000）——低一个数量级会被整块盖住，分区露出
  空白而 `[data-global-panel]` 的 DOM 明明有内容。插件弹层抬到 1200，抬升判据跳过含
  `[data-dshtrading-plugin-anchor]` 的容器：那是设置壳自己的遮罩，抬它就是把借壳面板盖住。
  容器标记用 `data-dshtrading-plugin-anchor`，**不与 body 状态标志同名**——同名属性会让
  `querySelector('[data-dshtrading-plugin-host]')` 把 body 一起挑出来。
- **官方弹层要抬到借壳面板之上**：官方把插件管理的弹层（添加插件 / 安装流程）渲染在自己那块
  `position: fixed` 的容器里，层叠值低于借壳写在 `[data-global-panel]` 上的 1001，借壳后面板内容整块
  盖住弹层——点「添加插件」看着没反应，其实弹层已经开了。借壳期间按结构判据（body 直接子元素 + 内含
  `[role="dialog"]` + 自身 fixed + z 低于面板）把它抬到 1002，detach 时还原；不认官方 CSS 哈希类名。
- **官方只读的「内置插件」分区不再出现**：官方那条 `settings.section` id 是 `plugins`（只读清单），与本仓
  「插件」整页说的是同一份插件列表，两个入口用户分不清该点哪个。宿主没有卸载 section 的面，所以按导航项文案
  （`内置插件` / `Built-in plugins`）在设置弹层里把它摘掉——判据用文案而不是结构或顺序，官方调顺序不会误伤
  别的入口，最坏情况是文案改名后没摘掉（多一个入口）；设置弹层重开时 MutationObserver 继续摘。
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

- `pnpm --filter @dshtrading/client-ui-settings test`：39 例全绿，其中 `test/plugins-section.test.ts` 12 例钉住
  四个借壳分支（打开/卸载/layout 缺席/面板未注册）、注册面（分区 id、order、组件）与四条等待用例
  （已在 DOM / 懒加载完成 / 超时后迟到 / 取消后不再回报）。
- 2026-11-07 Mygo 实机（automation 通道 + 窗口级截图）：冷启动后首次点开，`[data-global-panel]` 81ms 出现、
  官方页内容 677ms 就位，分区容器子节点归零（说明文案退场）；连续三次冷启动同一结果。
- 实机 trading-web：设置导航 5 项 → 6 项；点「插件」后 `body[data-dshtrading-plugin-host='on']`
  与 `[data-global-panel]` 同时就位，官方整页渲染在分区矩形内（内置插件配置 / 实验性插件 / 已安装插件）。
  - 1600x813：弹层 800 → 1200（x=200，居中不溢出），官方页 564 → 964，`添加插件` 恢复完整标签。
  - 780x473：弹层 732（x=24），官方页 496x347、右缘 732 < 756，不溢出，工具栏按官方断点收成图标。
  - Before/After 截图在 `.local/acceptance/plugins-section-2026-11-06/`（本机不入库）。
