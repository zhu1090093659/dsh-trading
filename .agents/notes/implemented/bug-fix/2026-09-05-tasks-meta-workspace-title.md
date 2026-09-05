# Agent Note: 定时任务工作区下拉显示 UUID——宿主显示名字段是 title 不是 name

Status: implemented

## Problem

owner 2026-09-05 实测：任务编辑器「工作区」下拉整列显示 UUID（`8491df8e-722b-…`），只有「默认（最近工作区）」是人话。真实名字（dsh-trading / cowork 等）宿主明明有——对话头的工作区选择器就显示正常。

## Root cause

宿主 `WorkspaceRegistry.list()` 返回的 `Workspace` 实体（`@deepseek-ai/dsh-workspace`）显示名字段是 **`title`**（创建时默认 `basename(path)`，必填），根本没有 `name` 字段。桥接面 `WorkspaceDirectoryLike` 却只声明/透传 `name?` → `meta()` 映射出 `{id}` 无名字 → 客户端 `workspace.name ?? workspace.id` 回落显示 UUID。典型的「Like 面字段名与宿主实体不对表」。

## Fix

- `WorkspaceDirectoryLike.list()` 投影面纳入 `title?`（name 留作潜在别名面优先）；`meta()` 映射 `item.name ?? item.title`，无名才省略字段。
- 客户端零改动（`name ?? id` 回落语义不变）；runner 校验只用 id，不受影响。
- 回归测试：`tasks-service.test.ts` 新增 meta 工作区名映射用例（title 透传 / name 优先 / 无名省略三断言）。

## Verification

`pnpm build` 绿；typecheck 棘轮 504 = 基线；全量 `pnpm test` 972 passed（其中一次运行出现 client-ui-updater 既有 flake——macOS 临时目录 rename EACCES，隔离复跑该文件与任务面文件均绿，与本修复无关）；trading-web profile 刷新后 CDP 实测下拉选项为真实工作区名（auto-update / dsh-web / cowork / dsh-trading / DNA 等 10 项）。
