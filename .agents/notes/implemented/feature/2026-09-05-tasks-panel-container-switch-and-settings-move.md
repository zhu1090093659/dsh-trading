# Agent Note: 定时任务改对话列容器切换页签 + 设置入口迁左栏底部

Status: implemented

## Problem

owner 2026-09-05 实测 [2.9 竖条版定时任务](2026-09-04-sidebar-scheduled-tasks.md)两个体验问题：

1. **悬浮面板**：点竖条时钟弹出 `position: fixed` 圆角投影卡片（right:56px 浮在对话/行情之上）——浮层盖住底层内容，不是「独占一处」的稳定界面。owner 先要求改成独占侧边栏，看到「并排新列」的实现后进一步澄清：**定时任务应与 Agent 对话共用同一个右侧容器，点击切换、二选一**，不要两个独立容器并存。
2. **设置入口错位**：设置齿轮在右缘竖条，而左侧自选面板才是常驻主侧栏——齿轮应沉到左栏底部。

## Decision

1. **容器切换（非并排非悬浮）**：任务面板与官方对话共用栅格第 2 轨（对话列）。激活时 shell-pad.css 新规则 11 隐去对话列全部直接子节点（hero 融合容器/对话流/composer 同列一起隐），`.tasksPanel` fixed 原位覆盖——`right = var(--dshtrading-sidebar-w)`（竖条预留 44px）、`width = var(--dshtrading-chat-user-w)`（用户拖拽宽度，回落 380px）。两个 var 都定义在宿主 frame、经 overlayLayer 继承到竖条子树（ChatResizeHandle 同款继承链），**面板几何恒等于对话列矩形**（实测 x/width 逐像素重合）。栅格轨道零改动，QuotePane 测量不受影响。
2. **宽度用 `--dshtrading-chat-user-w` 而非轨宽 var**：折叠态轨宽被压 0，若吃轨宽会让「折叠 + 任务」组合下面板消失；user-w 让任务面板在任何折叠态都保持用户所选宽度。该组合下面板浮在市场区右缘，QuotePane 右界兜底改测 `[data-dshtrading-tasks-panel]` 左缘（`fallbackRight`），市场区不与面板重叠。
3. **切换语义补齐**：竖条「+ 新会话」与任务执行历史「打开会话」都自动 `setTasksOpen(false)`——发起/进入会话即切回对话视图；时钟按钮再点还原。ChatResizeHandle 在任务态隐藏（`body[data-dshtrading-tasks-open]` CSS 门控，不进 React 状态）——对话列不在场，拖宽手柄无锚点。
4. **设置入口迁左栏底部**：齿轮自右缘竖条移除，`openSettings` 注入面从 SessionRail 移交 MarketDock（程序化 click 退役列内官方触发器的实现不变）。展开态 = MarketSidebar 底部沉底栏（图标 + 文案 + 更新徽点），折叠态 = 44px 竖条 `margin-top: auto` 沉底。更新徽点轮询 effect（30 分钟轮询 + `dshtrading-update-available` 事件同步）随之从 SessionRail 移入 MarketDock——两态恒挂载，是徽点单一同步点。
5. **QuotePane 重测缺口顺手补**：纯轨道位移（折叠/开合）不触发 ResizeObserver、body 属性突变时 grid transition 尚未推进——MutationObserver attributeFilter 补 `data-dshtrading-tasks-open`，并监听 frame `transitionend`（propertyName = grid-template-columns）过渡结束补一次重测（同时修复折叠滑动期间中栏矩形停旧值的既有缺口）。

## Alternatives considered

- **并排独占列（第一版实现，已撤）**：撑宽第一轨道 `44px + 360px` 给任务面板让出专属轨道，对话列被推开。实现干净、无覆盖，但与对话是**两个容器并存**——owner 明确否决：「共享同一个容器，采用切换的逻辑」。
- **隐藏整条对话列轨道 + 面板悬浮补位**：折叠同款 `--dshtrading-chat-w: 0px` + 面板覆盖市场区。轨道开关会引发 QuotePane/拖拽手柄连锁重测，且「隐轨 + 浮板」本质仍是覆盖。落选——`> *` 隐内容保轨道的方案零栅格改动。
- **任务面板进对话列内做 tab（hero 同款页签）**：要在官方对话列 DOM 里塞页签头，得 portal + 官方结构耦合，违反「不改宿主源码、官方 slot 之外不 hack」的既有纪律；竖条按钮本就是页签开关，无需再造页签 UI。

## Consequences

- 任务面板宽度跟随对话列拖拽宽度（拖拽在任务态禁用，切回对话拖完再切，宽度即生效）。
- 「折叠 + 任务」组合：任务面板以用户宽度浮于市场区右缘、QuotePane 让位——视觉成立但栅格未让位，后续若要「任务激活时禁用折叠」在此处加门控。
- 右缘竖条结构变为：折叠/新会话/分隔线/定时任务；设置入口唯一落在左栏底部（退役列内的官方触发器仍由 `openSettings` 程序化唤起，老部署不受影响）。
- 更新徽点轮询归属 MarketDock：若未来竖条再加「需要徽点」的页签，应把轮询上提到共享 store 而非复制 effect。

## Verification

- `pnpm build` 绿；`node scripts/typecheck-gate.mjs` 61 tsconfig / 504 错 = 基线（棘轮通过）；`pnpm test` 972 passed / 2 skipped。
- trading-web profile 刷新后实例实测（headless Chrome + CDP）：时钟开 → 面板 x=1176/w=380 与对话列逐像素重合、列子节点全部 display:none；时钟关 → 面板卸载、对话还原。左栏展开态底部「⚙ 设置」、折叠态竖条沉底齿轮、点击唤起官方设置弹层，均截图验证。
