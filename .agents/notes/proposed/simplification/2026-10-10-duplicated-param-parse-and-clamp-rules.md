# Agent Note: 策略与指标的参数解析、clamp 规则各留了两份实现

Status: proposed

## Problem

同一套「声明键校验 + 有限数校验 + min/max clamp」规则在三个地方各写了一份（全部本仓实测行号）：

1. `packages/strategies/src/plugin.ts:271-285` 的 `screenerRecordEntry` 与 `:961-977` 的 `parseScreenerSpecs`：paramsJson/columnsJson 的「解析失败降级为空数组」块逐行同体，调用点分别在 `:329` 与 `:995`。
2. `packages/strategies/src/plugin.ts:477-511`（`strategy_backtest` 工具内联）与 `:1033-1069` 的 `parseParamsOverride`：同一口径（未知键报错并列出合法键、非有限数报错、clamp 到 `[min,max]`、再按 default 补齐）。后者已经参数化 `tool` 与 `ownerId`，前者是它的第二份拷贝，只是错误前缀写死 `strategy_backtest:`。
3. `packages/indicators/src/registry.ts:73-81` 的 `clampParams` 与 `packages/indicators/src/chart-activations.ts:318-337` 的 `clampActivationParams`：同规则（有限数 → min/max 收敛并 `Math.round`；缺失/非法 → `spec.default`；schema 外键丢弃）逐行相同；后者多一个 `specs === undefined` 时「原样透传有限数键」的分支。该文件 `:312-317` 的注释说明独立实现的原因是「host 平面没有注册表实例」——但那只是不需要**实例**，两处同在 `packages/indicators` 包内，抽一个纯函数既不新增依赖也不改变写入边界。

这三对都不是「刻意的双实现」：没有平台中立、协议或第三方扩展面的理由，且第 3 对已经在注释里用「与 registry.clampParams 同规则」自我声明需要同步。

## Proposal

- `screenerRecordEntry` 直接调用 `parseScreenerSpecs`（两者返回 `{ params, columns }`，行为一致）。
- `strategy_backtest` 的工具实现改调 `parseParamsOverride`，把 `tool` 传 `strategy_backtest`；helper 需要额外返回 clamp 后的 override（见 Risks 的口径确认）。
- 在 `packages/indicators` 内抽一个纯函数（例如 `clampParamsBySpecs(specs, params)`）承载第 3 对的公共规则：registry 用 `definition.params` 调用它，`clampActivationParams` 保留 `specs === undefined` 的透传分支后调用它。
- 不动的东西：三处的错误文案、返回值形状与全部 clamp 语义（取整、默认值、未知键丢弃/报错），以及 `clampActivationParams` 在 host 写入边界的独立性（它仍不依赖注册表实例）。

## Context & Efficiency Impact

- 消失的维护面：三对重复（约 15-35 行每处），以及「clamp 规则改一处、另一处忘记改」的漂移风险——同仓已有同类先例（超时文案在三份 runner 里分裂，见 [校验器家族收敛](../../implemented/simplification/2026-09-09-validator-family-consolidation.md)）。
- 不改能力：没有删除任何参数、校验或降级路径；净减少的是同规则的第二份实现。

## Alternatives considered

- **抽到 `packages/base`**：参数语义属于 strategies/indicators 各自领域，base 只收「≥2 个市场共享」的东西（六条铁律之一）。落选，改为在同包内抽纯函数。
- **保留两份、加注释钉住同步**：注释防不住漂移，仓库里已有因复制而分裂的实证。落选。
- **让 host 侧改用注册表实例**：`clampActivationParams` 的存在理由正是 host 平面没有注册表实例；为去重引入实例依赖是方向倒退。落选。
- **按 validator-family 先例把整条编译/沙箱链也一起收敛**：那是已交付的另一条记录，本记录只处理参数解析与 clamp，不重开它。

## Verification & Gates

- 单包测试：`pnpm --filter @dshtrading/strategies test`、`pnpm --filter @dshtrading/indicators test`、`pnpm --filter @dshtrading/client-ui-trading test`（三个 clamp 调用点）。
- 行为向量必须逐条不变：`packages/indicators/test/chart-activations.test.ts:67-76`（999→100、1.6→2、缺失→default、ghost 丢弃、undefined 透传）与 strategies 现有参数用例。
- `pnpm test:audit`（新写用例的命名与结构）与 `pnpm gates:all`（14 条）绑 HEAD sha 现场复跑。

## Risks

- `strategy_backtest` 的内联块把 clamp 后的 override 传给 `run()`；`parseParamsOverride` 现在返回的是补齐默认值后的 `effective`。两者对「未声明键」的处理不同，复用前必须确认 `run()` 是否需要区分「未指定」与「等于默认值」；拿不准就让 helper 同时返回 override，不要改 `run()` 的入参语义。
- `clampActivationParams` 的 `specs === undefined` 分支是 host 边界独有行为，抽取时漏掉会让未就位实例无法落盘。
