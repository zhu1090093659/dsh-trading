# Agent Note: 右缘会话竖条——常驻 44px 功能栏，入口三合一竖排

Status: implemented

（承接同日 [右栏退役](2026-08-30-right-rail-retire-hero-fusion.md)。该记录定稿的
「右上浮动簇 + 会话头 utilities 内联」双入口被本篇取代：用户参考同花顺右侧竖排
工具栏裁决——折叠/功能按钮竖排成一根永不隐藏的右缘竖条，点开展开面板、收起后
竖条仍在，后续新功能菜单继续往竖条里加。）

## Problem

2.8 的入口按状态分裂在两处（首页/折叠态走右上浮动簇，会话进行中走会话头内联
按钮），同一对按钮随上下文换位置；且折叠后会话列完全消失，右侧没有任何常驻
锚点，展开入口只是一枚浮在行情上的小按钮。用户要的是交易终端式右缘竖条：
按钮竖排、恒在、可扩展。

## Decision

- **SessionRail（shell.overlay order 60，取代 WindowChrome）**：fixed 贴视口
  右缘全高 44px，`role=toolbar aria-orientation=vertical`。自上而下：折叠/展开
  （aria-pressed 驱动，折叠态图标 scaleX(-1) 镜像提示展开方向）、新会话、分隔
  线、设置；分隔线下方是后续功能页签扩展位。恒挂载恒可见——首页、会话进行中、
  折叠态都是同一入口，不再按状态切换入口面。
- **几何占位复用侧栏轨道（shell-pad.css 规则 8 改写）**：2.7 把侧栏轨道
  `!important` 归零，2.9 起改为常驻 `44px`——rtl 栅格第 1 轨道恰在右缘，天然
  就是竖条的让位区；对话列（380px）与 QuotePane 测量天然以竖条左缘为界。
  退役侧栏列仍 absolute 移出视口保持挂载（官方设置弹层子树，规则不变）。
- **QuotePane 右缘测量补竖条回落**：对话列在场取 children[1] 左缘（已含竖条
  轨道）；退场回落改为 `[data-dshtrading-rail]` 左缘（原回落 frame 右缘会让
  行情延伸到竖条底下），并把竖条纳入 ResizeObserver（observe 初始回调保证
  竖条晚挂载时补测量）。
- **双入口退役**：HeaderCornerActions + 会话头 utilities 槽注册、window-chrome
  浮动簇及其 CSS module 整体删除；`body[data-dshtrading-chat-folded]` 同步
  effect 移入 SessionRail（竖条恒挂载后同步点唯一）。fold-store、locale 键、
  openSettings 程序化 click 官方触发器全部原样沿用。
- **入口收敛后 in-session 右上不再需要内联槽**：竖条在自己的 44px 轨道里，
  与会话头内容零重叠——2.8「内联避免浮层盖日志」的前提（会话列顶到视口右缘）
  已被轨道让位消除。

## Alternatives considered

- 在宿主 ConversationRoot 列内保留 40px rail（2.8 记录已否决一次）：要往宿主
  root 塞自家 DOM（2.3 教训：root 接管是死路），放弃。本次竖条走自家
  shell.overlay 槽 + 轨道让位，不碰宿主 DOM，否决理由不适用。
- 竖条用纯 fixed 浮层、不预留轨道：对话列会延伸到竖条底下，得给宿主列内容
  打 padding 补丁；轨道让位让栅格本身保证边界，放弃。
- 保留会话头内联按钮作会话中入口：与竖条功能完全重复，双入口正是本次要消灭
  的状态分裂，放弃。
- 设置留在左下角浮动钮：竖条是唯一功能栏，功能按钮分散两处违背「后续菜单都
  进竖条」的扩展方向，一并迁入。

## Consequences

- 桌面 trading 壳布局定稿为 [工具详情 | 行情 | 会话列 | 竖条 44px]；折叠语义
  不变（会话列轨道归零 + 整列隐藏），但右缘永远有竖条锚点。
- 后续加功能页签的固定套路：SessionRail 分隔线下加按钮 + 新 store（fold-store
  模式）+ body[data-dshtrading-*] 与 shell-pad.css 轨道联动，面板向左展开。
- 宿主升级风险面变小：会话头 utilities 槽注册模式（conversation scope 回调）
  不再使用；风险点集中到 `[aria-haspopup=dialog]` 触发器选择器（沿用 2.8）。
- 验证：`pnpm -r build` / `pnpm -r test` 全绿（client-ui-trading 53 例）；UI
  实测待 trading-web profile 刷新副本后进行（折叠/展开回环、in-session 竖条
  不遮会话头、QuotePane 右缘不延伸到竖条底下、设置弹层开合）。
