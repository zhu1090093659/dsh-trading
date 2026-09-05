# Agent Note: 资产抽屉令牌契约修复与双主题视觉重构

Status: implemented

## Problem

统一资产台账交付后用户实测（issue #65 评论区反馈截图）：亮色宿主下抽屉内容区是暗色孤岛、表格正文（账户/标的/数量/价格/市值列）几乎不可读。根因不是配色审美而是**契约违约**：tokens.css 只定义了 bg-base/bg-surface/bg-subtle/border-default/text-primary/accent 一族双主题令牌，而 trade-drawer.module.css（继承自 9fa98d2 初版并随 #65 扩展）与 order-panel.module.css 引用了一批**不存在的旧变量名**（--dsw-futu-bg-card/bg-secondary/bg-tertiary/--dsw-futu-primary），全部落到硬编码暗色 fallback；同一批 CSS 里又混用「存在的」text-primary（亮色模式下取暗色值）——暗字落暗底，正文隐身。

## Decision

- **trade-drawer.module.css 整文件重写**：全部颜色/圆角/阴影只引用 tokens.css 存在的双主题令牌（亮 :root + body[data-ds-dark-theme] 暗色自动切换）；随重构做视觉升级——数字列右对齐（TSX 加 .num，财务表规范）、表头 sticky、行 hover、来源徽章/过滤 chips 胶囊化、待确认横幅左琥珀粗边 + 主按钮、汇总顶栏 hero 数字层级、对话框阴影圆角与聚焦环、细滚动条、prefers-reduced-motion 降级。
- **语义色局部变量**：模拟盘琥珀与非方向语义绿（实盘徽章）不是 tokens.css 的方向语义（红涨绿跌会随 colorMode 翻转），以模块内 --twd-* 局部变量承载并按暗色标记双模式取值；order-panel 的实盘绿/琥珀同款处理（--opn-*）。
- **order-panel.module.css 最小对齐**：不存在的 bg-card 引用改 bg-surface/bg-base，固定色改局部双模式变量；不做重设计。
- TSX 内联样式收敛：fills 时间列、balances 资产列内联 style 改类；编辑/删除按钮组加 .actionCell 间距。

## Alternatives considered

- **给缺失变量在 tokens.css 补定义**：等于把暗色 fallback 固化成第二套变量 vocabulary，双主题要再写一遍暗色映射，令牌面越养越大；否决，统一到既有词汇。
- **只修 fallback 色值不改设计**：能救可读性但用户明确要视觉优化，且数字左对齐/无 hover 等问题仍在；否决。

## Consequences

- 抽屉/下单面板在亮暗双主题下与宿主连贯，无主题孤岛；暗色文字对比度由 tokens.css 暗色块统一保证（#f0f2f5 on #131722）。
- 新增约束（纪律性）：client-ui-trading 的组件 CSS 禁止引用 tokens.css 之外的 --dsw-futu-* 变量名；codegraph/ review 时按本 Note 校对。
- 验证：client-ui-trading build + 250 tests 绿；trading-web profile 无头 CDP 实测亮色（持仓/汇总）与暗色（持仓）四张截图，正文可读性、徽章、横幅、数字右对齐全部确认；汇总顶栏 select 与总资产数字重叠的已知打磨项随本次 flex/gap 重排一并消除。
