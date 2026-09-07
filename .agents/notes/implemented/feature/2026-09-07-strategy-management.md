# Agent Note: 策略管理——覆盖 + 墓碑模型（含内置策略增删改）

Status: implemented

## Problem

策略插件此前只有单向创作管线：`strategy_author` 只能新增自定义策略（内置 6 范式 id 被校验器硬保留），桥 DELETE `/strategies/custom` 有端点但无任何 GUI 调用方（死代码），内置范式是代码常量完全不可管理。用户需求：**包括内置策略在内，每一个策略都可以修改、新增、删除**。范围经裁决同时覆盖 5 个内置选股器（PR2），GUI 提供完整编辑器（含 JS 源码）。

## Decision

**覆盖 + 墓碑模型**：内置策略/选股器保持代码常量作为出厂默认；用户修改 = 自定义 store 落一条同 id 覆盖记录；删除 = 落 id 墓碑（出厂代码不动）；恢复默认 = 清覆盖 + 墓碑。插件升级仍能更新未被用户动过的内置策略，符合 insert-only 铁律。

- **合成逻辑单点**（`strategies/src/management.ts`，浏览器安全）：`applyStrategyManagement(内置, 自定义定义, 墓碑)` = 内置 − 墓碑、覆盖原位替换、自定义追加；agent 侧 `resolveStrategyDefinition` 与 GUI 侧 `StrategyView` 共用，两侧名册一致。`isBuiltinStrategyId` / `BUILTIN_STRATEGY_IDS` 作 id 词汇源。
- **墓碑存储**：`~/.dsh/strategies/builtin-tombstones.json`（`{ deleted: string[] }`），策略与选股器共用（id 空间天然隔离）；内存版 + tmp+rename 文件版（同 custom-fs 模式）。
- **写边界显式确认**（防误覆盖，替代校验器保留名）：
  - 校验器（`validate.ts`）移除 RESERVED_IDS 硬拒绝——内置 id 现在是合法覆盖目标，全路径（GUI 拉取/agent 工具/桥）同源放行；
  - agent `strategy_author`：id 命中内置 = 覆盖语义（描述文案明示），顺带清该 id 墓碑；
  - GUI 桥 `PUT /strategies/custom`：内置 id 必须带 `overridesBuiltin: true`，否则 `TRADING_STRATEGY_OVERRIDE_CONFIRM` 业务拒绝；
  - 新工具 `strategy_delete`（自定义移除 / 内置墓碑 + 丢弃覆盖）、`strategy_reset`（恢复出厂；自定义 id 明确报错）；`strategy_backtest` 墓碑闸门——已删内置报错并引导 `strategy_reset`。
- **桥端点**：`PUT /strategies/custom`（保存，vm 沙箱全量校验通过才落盘，失败回 `TRADING_STRATEGY_INVALID` + 人话原因）、`POST /strategies/reset`、`GET /strategies/tombstones`；`DELETE /strategies/custom` 语义扩展（内置 → 墓碑，响应带 `scope`）；全部写成功 emit `'strategies'` SSE。
- **GUI 完整编辑器**（`client-ui-strategies/StrategyEditor.tsx`）：元数据 + 参数规格行编辑 + compute 源码 textarea；「校验」走浏览器 Worker 版 `validateCustomStrategy`，「保存」本地预校验后桥 PUT（host vm 复校验）。来源徽标（内置/已修改/自定义）+ 卡片操作（编辑/删除/恢复默认）+ 已删内置灰卡（可发现性）+「新建策略」；老壳（桥无管理方法）整组管理动作降级隐藏。
- **内置源码预填**（`builtinStrategySource`/`builtinStrategyRecord`）：5 个范式 compute 内联指标数学（ema/sma/rsi/bollinger，与 indicators `math.ts` 同式）实现自包含，`compute.toString()` 归一化为箭头形态即可导出完整可编译源码——内置范式天然成为可复制的自定义策略模板。**构建期安全网**：`management.test.ts` 对全部 6 范式做往返测试（导出源码过 Node 沙箱全量校验 + 编译后行为与原 compute 逐信号一致）。
- **存储收口前置**（独立 commit）：`strategies/plugin` provide `tradingStrategies` Service（issue #33 模式），桥解包 `.store`/`.tombstones` 复用单实例，消除双 file store 缓存互不感知的 stale 窗口。

## Alternatives considered

- **首启种子化**（内置写入存储后统一管理）：实现更简，但插件升级不再自动更新内置策略（用户拿的是快照），且需文件格式迁移。否决，覆盖 + 墓碑保住出厂默认层。
- **保留 RESERVED_IDS + 显式 override 标志字段**：校验器拒绝、覆盖记录带 `overridesBuiltin` 标记。多一个字段就多一条同步纪律（GUI 拉取/工具/桥三处都得理解标记）；改为「校验器全放行 + 写边界确认位」后，覆盖性由 id 是否内置单一事实推导，无标记可漂移。
- **GUI 仅元数据/参数编辑、逻辑走 agent**：编辑器不自足；用户明确选择完整编辑器。JS 源码 textarea + 双侧同源校验器（validate.ts 一份代码两侧跑）保证保存的东西就是校验过的东西。
- **内置编辑预填走 helper toString 拼接**（把 indicators 的 ema/sma toString 拼进 prelude）：minify 后名字映射脆弱；内联数学 + 往返单测确定性成立，且换来「参考范式 = 可复制模板」的额外收益。

## Consequences

- 内置策略可改可删可恢复；`strategy_backtest`/GUI 名册对墓碑与覆盖的呈现一致；paramsMap（localStorage 参数记忆）在删除/恢复时同步清除该 id，避免旧参数套在新定义上。
- 校验器参数解析保留合法 `step`（此前一律归一为 1），内置覆盖保存后参数步进不失真。
- 内联数学使范式文件不再 import indicators 运行时符号（类型依赖保留）；包行为由既有 paradigms/engine 测试守恒，另加 6 范式往返等价测试。
- 遗留：类型棘轮基线相对当前依赖状态过期——main 本身（干净 worktree 全量构建复现）在 client-ui-trading 上超基线 +5（QuoteStage 未用变量等），本 PR 已顺手修掉同文件的 store 窄化 1 处并使总错误数低于基线（503 < 504），其余属 main 既有债务待单独清偿。
- 测试：strategies 包 management（合成/墓碑存储/往返等价/step 保留）+ plugin-management（三工具/覆盖联动/墓碑闸门）共 +21 用例；client-ui-trading 桥路由 6 用例（确认闸门/墓碑语义/reset/tombstones）。pnpm build / pnpm test / i18n:check 全绿。
