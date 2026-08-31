# Agent Note: 修复 PTC 调度器 Symbol 隔离与 client-ui-trading 依赖服务注入

Status: implemented

## Problem

1. **PTC 工具执行报错**：
   在会话中执行代码工具调用（如 `tools.glob` / `tools.bash`）时触发：
   ```
   Cannot read properties of undefined (reading 'prepare')
   ```
   **根因**：`@deepseek-ai/dsh-tools` 中的 `TOOL_RUNTIME_SCHEDULER` 使用单模块局部的 `Symbol(...)` 声明。当 DSH 运行时、Profile 独立依赖或插件环境分别加载不同副本的 `@deepseek-ai/dsh-tools` 时，各模块的 Symbol 内存地址互不相等，导致 `registry[TOOL_RUNTIME_SCHEDULER]` 获取为 `undefined`，进而抛出 `scheduler.prepare` 异常。

2. **Web 启动插件未激活报错**：
   执行 `dsh --profile trading-web` 时报错：
   ```
   web boot: 1 entry did not activate
   @dsh-trading/client-ui-trading: pending (waiting for service: uiWorkspace)
   ```
   **根因**：`client-ui-trading` 的 `inject` 数组中声明了 `uiWorkspace`，但 DSH 官方客户端运行时的会话/工作区服务名为 `workspaces`（`ctx.workspaces`），未提供 `uiWorkspace` 服务，导致 Cordis 依赖等待超时挂起。

## Decision

1. **Symbol.for 全局跨包共享**：
   将所有 `@deepseek-ai/dsh-tools` 副本中的 `TOOL_RUNTIME_SCHEDULER` 统一升级为 `Symbol.for('@deepseek-ai/dsh-tools.scheduler')`，确保在任何包加载拓扑下工具注册表调度器符号一致。
2. **Client UI 服务注入修正**：
   将 `packages/client-ui-trading/src/client/index.ts` 中的 `inject` 由 `['slots', 'locale', 'sessions', 'uiWorkspace']` 修正为 `['slots', 'locale', 'sessions', 'workspaces']`，`startNewSession` 对齐官方 `workspaces.startSession()` 调用。
3. **环境与 Profile 清理**：
   修正 `~/.local/bin/dsh` 软链指向 `/opt/homebrew/bin/dsh`；清理 `trading-web` Profile 中残留的已失效本地源码目录软链接，与全局 NPM 安装包环境完全对齐。

## Consequences

- PTC 模式下 `run_code` 与各类工具链分发准备正常，无 `prepare` 异常。
- `trading-web` Profile 启动时所有插件 100% 正常激活，0 pending，0 报错。
- `pnpm test` 全部 66 个测试文件、482 个用例全部通过。
