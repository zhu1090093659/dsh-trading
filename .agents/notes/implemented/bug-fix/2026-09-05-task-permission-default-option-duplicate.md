# Agent Note: 任务编辑器「会话权限」下拉出现两个 read-only——默认项标签撞车

Status: implemented

## Problem

owner 2026-09-05 实测：任务编辑器「会话权限」下拉出现两个 `read-only`。原因：首选项（value=''，语义是「不显式指定、跟随会话默认」）直接把默认权限值渲染成标签文本，而会话默认恰为 read-only 时，与 `TASK_PERMISSIONS` 全量枚举里的 read-only 文本完全相同——两个选项看起来一模一样，但语义不同（继承 vs 显式指定）。

## Fix

- 新增 locale 键 `tasks.permission.default`（zh「跟随会话默认」/ en "Session default"，contract 键 union + 双词典同步）。
- 首选项标签改为 `跟随会话默认 (read-only)` 拼接当前默认值——语义可读且与枚举项天然区分；其余逻辑零改动。

## Verification

`pnpm build` 绿；`pnpm i18n:check` OK（795 zh keys，中心包先重建）；包测试 216 + 全量 972 passed；typecheck 棘轮 504 = 基线。trading-web 刷新后 CDP 实测下拉 labels = [跟随会话默认 (read-only), read-only, workspace-write, danger-full-access]，无重复。
