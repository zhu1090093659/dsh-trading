# Agent Note: 右侧栏拖拽调宽失效——d0dc77e 删了 data-dshtrading-chat 写入方，规则 3 门控变死

Status: implemented

## Problem

用户报告右侧边栏（对话列）无法通过拖拽改变宽度。手柄（ChatResizeHandle）在
场、可按下，松手后列宽纹丝不动；localStorage 里 `dshtrading.chat.width.v1`
却已被写成 720（CHAT_WIDTH_MAX）——拖拽事件链路活着，栅格消费链路死了。

## Root Cause（git 历史实证）

宽度链路设计为三段：ChatResizeHandle 拖拽写 body 内联
`--dshtrading-chat-user-w` → shell-pad.css 规则 3 把它折算进轨道变量
`--dshtrading-chat-w` → 栅格四轨道排布。规则 3 的选择器是：

```css
body[data-dshtrading-chat='on'] div:has(> [data-shell-overlay]) { ... }
```

而 `body[data-dshtrading-chat]` 的唯一写入方是 QuotePane 里的一行 effect。
d0dc77e（2026-09-02 主题适配重构）重写 QuotePane 几何测量时把该 effect 连同
`chatOn` 推导一起删除，同时删掉了旧规则 3（无会话 display:none），但没有同步
删改规则 3 的门控选择器。此后门控永不匹配：`--dshtrading-chat-w` 恒为规则 1
的 380px 回落值，用户拖拽值成为无人消费的死变量。QuotePane 头注释「本组件把
该状态写到 body[data-dshtrading-chat]」同期失真。

## Decision

1. **规则 3 去门控**：`--dshtrading-chat-w: var(--dshtrading-chat-user-w, 380px)`
   无条件生效。不再恢复属性写入方——手柄本身管变量的完整生命周期（挂载写入
   持久值、退场移除），折叠态由规则 9 的 `!important` 压住；属性门控在这套
   生命周期下是冗余状态，删掉比修好更稳（少一个可失联的跨组件约定）。
2. **注释同步**：QuotePane 头注释改为描述真实链路（折叠开关驱动显隐、宽度
   由手柄+规则 3 消费），并留 d0dc77e 废弃线索。

## Verification（宿主 HTTP + 无头 Chrome CDP 实测，2026-09-04）

trading-web profile 刷新新构建后：CDP Input.dispatchMouseEvent 真实拖拽手柄
向右 120px——栅格轨道 720px→620px 实时跟随，松手 `dshtrading.chat.width.v1`
落库 620；双击复位 380；location.reload 后轨道仍 380（持久化生效）。三态
（拖拽中/松手/刷新）grid-template-columns 与 store 值逐一比对一致。
附带发现：拖拽过程中 browser-use 的 IPC 读状态会超时，属宿主指针捕获期间的
自动化工具现象，非产品缺陷（松手后读取 0.00s 返回）。

## Impact

- 影响面：仅 shell-pad.css 规则 3 与 QuotePane 注释；无契约/安全面变更。
- 桌面壳要吃到本修复需随下一次 desktop release 重新打包。
- 教训：删状态写入方时，必须全仓检索该状态的读取方（CSS 选择器也算读取方）。
