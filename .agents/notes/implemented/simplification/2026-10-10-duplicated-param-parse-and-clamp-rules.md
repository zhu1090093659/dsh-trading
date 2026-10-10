# Agent Note: 策略与指标的参数解析、clamp 规则收敛为单一实现

Status: implemented

## Problem

同一套「声明键校验 + 有限数校验 + min/max clamp」规则有三份拷贝：`packages/strategies/src/plugin.ts` 的 `screenerRecordEntry` 与 `parseScreenerSpecs` 解析块逐行同体；`strategy_backtest` 工具内联的参数解析与同文件的 `parseParamsOverride` 同口径（后者已参数化 tool/ownerId）；`packages/indicators` 的 `registry.clampParams` 与 `chart-activations.clampActivationParams` 规则逐行相同。

## Decision

- strategies：`screenerRecordEntry` 直接调用 `parseScreenerSpecs`；`strategy_backtest` 改调 `parseParamsOverride`，helper 额外返回 clamp 后的 `override`（原有 `effective` 语义不变，供 screener_run 继续使用），`run()` 入参语义保持「显式 override」。
- indicators：新增纯函数 `clampParamsBySpecs(specs, params)` 作为规则的单一实现；`registry.clampParams` 委托它，`clampActivationParams` 保留 `specs === undefined` 的透传分支后委托它（host 写入边界仍不依赖注册表实例）。
- 不改：两处 clamp 的取整/默认值/未知键语义、策略侧错误文案前缀与四类校验行为、任何调用点签名。

## Alternatives considered

- **抽到 `packages/base`**：参数语义属于各自领域，base 只收 ≥2 个市场共享的东西，落选（改为同包内抽纯函数）。
- **保留两份、加注释钉住同步**：仓库已有因复制而分裂的先例（校验器家族的超时文案），落选。
- **让 host 侧改用注册表实例**：`clampActivationParams` 的存在理由正是 host 平面没有注册表实例，落选。

## Consequences

- `packages/strategies/src/plugin.ts`：12 插入 / 48 删除；`pnpm --filter @dshtrading/strategies test` 15 个文件 145 例全绿（含 `unknown param` 与 `finite number` 两条既有约束用例）。
- `packages/indicators`：`pnpm --filter @dshtrading/indicators test` 8 个文件 79 例全绿，其中 `chart-activations.test.ts` 的五条 clamp 向量（999→100、1.6→2、缺失→default、ghost 丢弃、undefined 透传）逐条未改。
- 规则改动今后只改一处；`strategy_backtest` 的错误文案由 helper 生成（前缀不变，措辞与 screener_run 统一）。
