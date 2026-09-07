# Agent Note: 选股器管理——自定义创作管线 + 内置覆盖/墓碑

Status: implemented

## Problem

选股器（ScreenerDefinition，'scr.' 前缀 id 空间）此前完全没有自定义创作管线：无存储、无校验器、无工具、UI 名册纯静态，5 个内置选股器不可管理。策略管理（2026-09-07 feature note）落地时墓碑存储已预留 `scr.*` id 共用，本变更补齐全链路。

## Decision

复用策略管理的覆盖 + 墓碑模型，为选股器建平行管线：

- **数据模型**（`custom-screener.ts`）：`CustomScreenerRecord { id, title, horizon, summary, paramsJson, columnsJson, evaluateSource, createdAt }`——与策略记录同构；`columnsJson` 承载结果动态列声明（ScreenerColumnSpec[]，1-8 列，键唯一）；id 强制 `scr.` 前缀与策略 id 空间隔离（内置 id 同形可覆盖）；`horizon` 恒 'swing'（选股器无期限分组，仅保记录同构的词汇位）。文件版落 `~/.dsh/strategies/custom-screeners.json`，挂进 `tradingStrategies` Service（`.screenerStore`）。
- **校验器**（`validate.ts` 的 `validateCustomScreener`）：与策略校验同源共享 `compileStrategySource`/`parseParamSpecs`/样例 K 线试算骨架；差异在结果形状——evaluate 返回 null（未命中/数据不足，合法）或 ScreenerMatch（**metrics 键必须 ⊆ columns 声明**、值有限数字、reason 非空 ≤200）。Node 侧 `validateCustomScreenerNode` 复用同一 vm 熔断 runner。
- **内置源码自包含**：4 个引用 indicators `sma`/`rsi` 的选股器（ma-bull-align/volume-breakout/rsi-oversold/above-ma）内联数学（near-high 本就自包含），`builtinScreenerSource`（`evaluate.toString()` 归一化）导出完整可编译源码；`screener-management.test.ts` 对全部 5 个内置做往返测试（导出源码过 vm 全量校验 + 行为与原 evaluate 逐值一致）。
- **工具面**：`screener_author`（覆盖内置顺带清墓碑）、`screener_delete`（内置墓碑 + 丢弃覆盖）、`screener_reset`（恢复出厂）；与 strategy_* 共用墓碑表与 `'strategies'` SSE 通道（GUI 按 payload 分流）。
- **桥端点**：`GET/PUT/DELETE /strategies/screeners` + `POST /strategies/screeners/reset`；PUT 落盘前 vm 全量校验，内置 id 需显式 `overridesScreener: true`（`TRADING_SCREENER_OVERRIDE_CONFIRM` 业务拒绝），非法源码 `TRADING_SCREENER_INVALID`。
- **GUI**（ScreenerPane + ScreenerEditor）：名册 `applyScreenerManagement` 合成 + 来源徽标 + 编辑/删除/恢复默认操作 + 已删内置灰卡 + 新建按钮；编辑器含 columns 行编辑（key/label/format）与 evaluate 源码 textarea，浏览器 Worker 预校验 + host vm 复校验；SSE `'strategies'` 重拉；无管理面的老壳降级为静态名册（旧行为）。扫描调度/进度/取消逻辑不变。

## Alternatives considered

- **通用 Definition 管理抽象**（策略/选股器共用一套泛型管线）：两者契约差异实质存在（columns 声明 vs 信号序列校验、无回测语义），泛型化会把差异推进条件分支反而更难读；平行管线 + 共享底座（墓碑/Service/桥闸门模式）成本更低。若未来出现第三类纯函数实体再抽象不迟。
- **选股器纳入 `strategy_author` 单工具**（按 id 前缀分流）：一个工具描述承载两套语义会稀释模型遵循度，独立 `screener_*` 三件套与 strategy_* 对称更可预期。

## Consequences

- 选股器与策略管理能力对齐：GUI 与 agent 双入口 CRUD，内置可改可删可恢复。
- validate.ts 拆出共享的 `parseParamSpecs`（策略/选股器参数解析单点），step 保留语义两侧一致。
- `~/.dsh/strategies/` 现有四个文件：`custom.json`（策略+覆盖）、`custom-screeners.json`（选股器+覆盖）、`builtin-tombstones.json`（两类共用墓碑）——均在 `tradingStrategies` Service 单实例下。
- 测试：strategies 包 screener-management（5 选股器往返/校验器形状/名册合成/三工具）+13；client-ui-trading 桥路由 +4。全仓 build/test/i18n 门禁全绿。
