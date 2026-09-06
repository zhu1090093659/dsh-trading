# Agent Note: 恢复 DSH 原生轨迹视图（会话列 [对话|轨迹] 页签）

Status: implemented

## Problem

富途壳上线时（[2026-08-30-trading-gui-futu-shell.md](../architecture/2026-08-30-trading-gui-futu-shell.md)）以 CSS 藏末位 tab 的方式把宿主原生轨迹视图退役。实战暴露了反向需求：排查「预设 persona 是否注入系统提示词」这类问题时，轨迹视图的 request 级系统提示词面板是唯一自证入口；2026-09-06 预设方法论铁律验收与「创建后切预设 persona 不跟随」缺陷定位都靠它取证。owner 裁决恢复。

## Decision

删除 `packages/client-ui-trading/src/client/shell-pad.css` 规则 6（`div:has(> [data-shell-overlay]) > div:nth-child(2) [role='tablist'] > button:last-child { display: none }`），原位留注释说明名册顺序与恢复日期。conversation.view 名册恢复完整渲染 [对话(order 0), 轨迹(order 10)]；slot 目录本身不动（当初就是因 slot 遮蔽不能除名才走 CSS 隐藏，恢复同理只需摘 CSS）。

## Alternatives considered

从名册摘除 trajectory 注册或遮蔽 slot：2026-08-30 已论证不可行（同名 id 撞注册、遮蔽不能除名），不重复。把隐藏做成设置开关：一个二态开关要跨 client 状态与 CSS 注入两层，收益抵不过维护面——直接恢复常驻。

## Consequences

会话列页签条重新渲染（tabs.length>1 即显示）；旧会话若存储过 trajectory 视图，宿主 `resolveActiveView` 本就回落 chat，无迁移负担。左栏市场页签同名 role 的误伤面随规则删除一并消失。定向验证：trading-web profile 刷新 client-ui-trading 副本 + 桌面壳重启后，会话列出现 [对话|轨迹] 双页签，轨迹页可展开 request 系统提示词。原退役决策记录保留在历史 note，并补指向本记录的裁决更新。
