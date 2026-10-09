---
'@dshtrading/client-ui-special-indicators': patch
---

特殊指标：修正「数据滞后」徽标语义与容器边缘自适应。

- 滞后判据改为「上游数据日 vs 预期数据日」：T+1 指标在交易日显示上一交易日数据不再误标滞后；桥 SWR 缓存标记不再驱动徽标（基差撤掉徽标，恒科只认上游自身 stale）。
- 板块双栏/单栏断点由视口宽（@media）改为中栏实际宽（@container）：会话侧栏展开/关闭时布局跟随；卡片补 box-sizing: border-box，消除 26px 右缘越界与横向滚动条。
