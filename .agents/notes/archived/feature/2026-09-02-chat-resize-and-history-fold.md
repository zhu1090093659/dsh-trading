# Agent Note: 右侧栏改进——对话列拖拽调宽 + 历史会话默认三条折叠

Archived: 2026-09-04
Status: implemented

## Problem

两处体验缺口（owner 2026-09-02 提出改进）：

1. **对话列宽度不可调**：2.4 四轨道栅格把官方对话列移到右缘后，宿主自带的列宽拖拽手柄在 rtl 翻转下物理坐标错位（inline left 按 LTR 计算），被 shell-pad.css 规则 4/5 隐藏——列宽从此钉死 380px，长会话/窄行情屏下无法自行分配空间。
2. **历史会话列表无分层**：HomeHistory 融合容器把当前工作区全部会话平铺（>10 条时整板拉长、目标行淹没），缺少「最新优先、其余收纳」的信息层级。

## Decision

1. **对话列拖拽调宽**（新 `ChatResizeHandle.tsx` + `chat-resize-handle.module.css` + `chat-width-store.ts`）：
   - 手柄 = shell.overlay 新条目（`dshtrading-chat-resize-handle`，order 61），fixed 贴对话列左缘骑缝（`right: calc(44px + var(--dshtrading-chat-w) - 4px)`，组件挂 overlayLayer 子树继承 frame 上的轨道变量，零测量）；
   - 宽度持久化 `dshtrading.chat.width.v1`（`chatWidthStore`，夹紧 [320, 720] px、取整、默认 380）；拖拽直写 body 内联 `--dshtrading-chat-user-w`（shell-pad.css 规则 3 引用为 `--dshtrading-chat-w: var(--dshtrading-chat-user-w, 380px)`），**不进 React 状态**——指针移动只驱栅格重排不触重渲染，松手才落 store；
   - 拖拽期 `body[data-dshtrading-chat-resizing='on']` 关宿主轨道 transition（规则 10，滑入动画毁跟手性）+ 全局 col-resize/禁选中；`setPointerCapture` 随手柄监听 move/up/cancel，宽度起点取 store 快照、位移取 clientX 差值（不硬编码竖条宽）；
   - 附加交互：双击复位默认宽；焦点态 ←/→ 微调（±20px，Shift ±60，role=separator 惯例）；无当前会话或会话列折叠时组件退场（对话列不在场无锚点）。
2. **历史会话默认三条折叠**（`HomeHistory.tsx`）：`historyRows`（已按 updatedAt 降序）默认只渲染最新 3 条（`VISIBLE_ROWS = 3`），其余收进页脚「展开其余 N 条」toggle（复用 chevron 旋转语言，aria-expanded）；**展开态不持久化**——每次回首页复位收起（「默认」语义，区别于面板本体 open 态的持久化）；页脚只在条数 > 3 时渲染。locale 新键 `browser.showMore`/`browser.showLess`/`chat.resize`（zh/en + contract.ts）。
3. **测试**：`chat-width-store.test.ts` 3 例（夹紧取整 / set 夹紧+持久化契约 / 订阅收夹紧后快照）；全量 646 通过、build 全绿。

## Alternatives considered

- **宽度进 React 状态（store 驱动重渲染）**：pointermove 每帧重渲染手柄组件只为写一个 CSS 变量——拖拽 60fps 下纯浪费；body 内联变量 + 松手落库路径更短。代价：store 与 body 变量存在挂载期同步点（组件 effect 写一次），由「组件是唯一写者」纪律兜住。
- **用 `clientX - innerWidth` 绝对定位算宽度**：要硬编码 44px 竖条宽，竖条改动即漂移；快照+差值只依赖拖拽起点，几何全交给 CSS。
- **展开态持久化（照抄面板 open 态模式）**：「默认只展示最新三条」要求每次进入都是收起态，持久化会让默认只生效一次——否决。
- **折叠做成 max-height + overflow 滚动**：列表容器已有 40vh 滚动，两层滚动嵌套易出现双滚动条；显式条数截断 + 页脚 toggle 信息层级更清晰。

## Consequences

- 对话列宽度跨会话持久；中栏行情（QuotePane RO 重测量）与 hero 融合容器（scrollBody RO 重拼）对宽度变化自动跟随，无需各自感知。
- 规则 9（折叠态 `--dshtrading-chat-w: 0px !important`）仍压过用户宽度——折叠语义不变；折叠/展开动画走宿主 transition（拖拽期才关）。
- **验证记录**：pnpm build / test 全绿（646，新增 3）；trading-web profile 副本经硬链接原地直达（lib 六文件 inode 一致，免 install）；实页（localhost:3081）确认新 bundle 生效（body userW 由组件写入 380px）、CSS 联动链实测通过（模拟 chat=on 下 userW 500/320 → 对话列宽 500/320px）、首页/行情/竖条无回归、零 console 报错。**拖拽手势与历史折叠渲染未能在实机走完**：该实例（00:17 重启）会话服务对全部官方入口（竖条新会话、退役列官方新建/工作区行、Cmd+K）均静默无效，current 恒为 undefined——与本次改动无关（宿主自有按钮同样失败、报错为零、改动未触会话链路），待实例恢复正常后按「开会话 → 拖对话列左缘 → 回首页看历史折叠」三步复验。
- 观察到实例级异常一处（会话打不开），非本次引入，留待 owner 复现排查（重启实例大概率自愈）。
