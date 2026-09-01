# Agent Note: 宿主 cohort 全量 non-strict `get(key, false)` 整改（cordis 4.0.2 strict-get 根因收尾）

Status: implemented

## Problem

trading-web boot 持续崩溃：`plugin tree failed to load: failed to apply loader entry (cordis:include): loader entries failed to apply`，逐条为各市场 dataplane（bybit/ccxt/alpaca/longbridge/tiger…）`service "tradingXxxMarketData" has been registered at <Include>`。此前仅 connector-okx 单点修复过（diag 探针实证根因），其余 43 个文件仍是 strict `get`。

### 根因

宿主 SDK cohort `cordis@4.0.2`：`ctx.get(key)` 默认 `strict=true`，要求 providing fiber 已激活（state === 2）。loader 顺序挂载兄弟插件时，其服务 fiber 尚 pending —— **apply 期旁查兄弟服务必然 undefined**。strict 路径在旁查失败时抛错，导致整棵插件树 apply 失败。此前 okx diag 探针实证：同一 ctx，`reg.strict=undef reg.ns=found`（strict 查不到、非严格能找到）。

### 本轮实证（收尾）

- 全仓枚举 10 个跨包服务 key（tradingMarketDataRegistry / tradingMarketRouter / trading{Crypto,Us,Cn,Hk}MarketData / tradingEvents / tradingCustomIndicators / tradingKnowledgeCards / tradingCustomStrategies）的全部 `.get?.('key')` / `.get('key')` 调用位：**55 处，仅 2 处已修（okx）**。即前轮所谓"批量 sed 已覆盖 44 文件"实际未落盘——okx 被单独修过所以从 boot 失败清单消失，造成了假进展。
- 全量替换落盘 44 文件 53 行（`, false` + cast 扩为 `(key: string, strict?: boolean) => unknown`）；复扫 strict 残留 = 0。
- `pnpm build` 0 错误；`pnpm test` 86 files / 616 passed / 2 skipped。
- profile 全量刷新后 `dsh --profile trading-web --port 3081` boot：`failed to apply loader entry` 计数 **0**（此前为 31+），无 error 行；SSE 围栏 `GET /dshtrading/api/events` 无 token = **401**；带 token 页面 303→200 会话正常。

## Decision

1. **定式固化**：loader/apply 期对兄弟服务的旁查一律 `get(key, false)`（okx dataplane 注释为范本）；strict get 只允许出现在依赖已由 `inject([...])` 保证激活的回调内部（本期 client-ui-trading 的 inject 回调位也统一 non-strict，保持全仓一致、防止将来挪动代码位时踩回坑）。
2. **教训**：「批量替换已应用」必须以复扫结果为证，不能以记忆/计划为证——本轮就是被前次未落盘的 sed 记录误导了一轮 boot。
3. **同步治理**：`scripts/sync-profile-overrides.mjs`（npm 布局 + stale 行修复）与 AGENTS.md 的宿主本体条目（npm 全局 `@deepseek-ai/dsh@0.1.2-alpha.3`，旧 deepseek-harness checkout 弃用）随本变更一并提交。

## Consequences

- boot 全绿，#30–#33/#35 的 live 验收通道打通（事件总线/策略流水线/自选 SSOT/自定义指标/知识卡片/动态能力均在宿主内挂载）。
- 后续新增 dataplane/kit 一律复制 okx `resolveMarketDataRegistry` 的 non-strict 范式；CodeGraph 上 `get?.(\s*['"]trading` 可作为 lint 式抽查。
