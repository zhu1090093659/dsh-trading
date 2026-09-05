# Agent Note: 资产面板三版视觉升级——殿堂级卡片语言、权益 hero 条与可逆对话框动效

Status: implemented

## Problem

二版侧栏化后资产面板信息正确但视觉平密：卡片无层级锚点、涨跌/多空只有裸文字
色、无总资产常驻视图（总资产藏在汇总页签）、空态只有一行灰字、对话框瞬现瞬失、
关闭图标/加号/展开箭头用文本字符充当图标。owner 要求把资产界面打磨到「殿堂级
交易艺术」效果。验证过程中还发现一个二版遗留致命 bug：`HoldingsPanel.tsx` 引用
`HOLDINGS_BASE_CURRENCIES` 但从未导入，点「汇总」页签即 ReferenceError 且无错误
边界兜底，整棵 React 树被卸载（`pnpm build` 不做类型检查所以全绿未拦住）。

## Decision

- **权益 hero 条**：持仓页签顶部常驻总资产条（`aggregation.totalBase`，复用汇总
  聚合结果，零新增数据面）；20px 级 mono 粗体数字是全面板唯一主视觉，accent 微
  渐变底 + hairline 边框，汇总页签大卡保持原有形态同语言。
- **方向语义 pill 化且不写死色值**：涨跌/多空文字色仍由 TSX `directionColor` 注入
  （跟随用户红涨/绿涨色板），pill 底/边用 `color-mix(in srgb, currentColor x%,
  transparent)` 派生——任何色板/主题下自动成套，CSS 不引入第四种语义色。
- **卡片语言**：来源脊线（3px 圆头竖条，琥珀=模拟/绿=实盘/蓝=真实导入）+ hover
  抬升 1px + shadow-sm；代码/数值全部 mono + tabular-nums；卡片脚部虚线分隔，
  市值 label/value 分离，PnL 收进 pill；市场标签变 bg-subtle 小方签。
- **图标契约**：`icons.tsx` 新增 `IconClose`/`IconPlus`/`IconChevronRight`（outline
  stroke 同族），替换 `×`/`+`/`▾▸` 文本字符；空态复用 `IconWallet`（EmptyHint
  组件，全部页签同一契约）；汇总展开 caret 用 chevron rotate(90°) 承载两态。
- **可逆动效（Law 3）**：对话框 enter（中心缩放+淡入）与 leave 同路径可逆，
  `useDelayedUnmount` 播完退场动画再卸载（编辑对话框用 ref 快照保持退场期内容
  稳定、重开会话按 initial 重置草稿）；新增 Escape 关闭；页签内容 160ms 淡入
  （body 挂 key）；staged 横幅脉冲圆点。全部动效 `prefers-reduced-motion` 退化
  为短淡入无位移。
- **汇总页签崩溃修复**：补 `HOLDINGS_BASE_CURRENCIES` 导入（from
  `holdings-types.ts`）。教训：`pnpm build`（tsdown/rolldown）不做类型检查，
  client 产物验证必须点遍全部页签，`tsc --noEmit` 已单独跑通。

## Alternatives considered

- **Pill 底色写死 up/down token（--dsw-futu-up-bg）**：与用户可切换的红涨/绿涨
  色板（`color-mode.ts`）冲突，绿涨模式下底色反直觉，弃。
- **总资产条做成可点击跳汇总的复合条**：面板 380px 宽内导航动线已由页签承担，
  加跳转会制造两个「去汇总」入口，弃。
- **引入图标库依赖**：包内已有 `icons.tsx` 矢量族（Law 2：同族复用），外部依赖
  违反包体纪律，弃。
- **React error boundary 兜底汇总页签**：治标不治本质（未导入符号照样崩），
  且为整棵树加全局边界超出本次范围，弃（导入修复 + tsc 门禁已闭环）。

## Consequences

- 双主题（亮/暗）、红涨/绿涨色板、330px 窄宽（posFoot 允许 wrap）下截图验证
  通过；Escape 关闭对话框且面板保留；汇总页签崩溃回归通过。宿主重启后台账
  清空（「暂无数据」空态）为既有内存态行为，与本次无关。
- 全部颜色/圆角/阴影仍走 `--dsw-futu-*` 双主题令牌，局部 `--hp-*` 仅琥珀/绿/
  error 语义——令牌契约不变。
- 后续任何 client-ui 产物改动建议在 CI 或门禁中补 `tsc --noEmit`（本次为人工
  执行），避免同类「build 全绿、运行即崩」。
