# Agent Note: 自然语言生成自定义指标——Agent 原生指标创作链路

- **日期**：2026-08-31
- **状态**：已实现 (implemented)
- **关联 Issue**：[#19](https://github.com/zhu1090093659/dsh-trading/issues/19)
- **分支**：`feat/author-custom-indicators`

---

## 背景与目标

为了让用户在会话列中用自然语言（如 "帮我写一个 TD9 指标"、"帮我写一个 SuperTrend 指标"、"给 OBV 加一个 34 天均线"）自由创作自定义技术指标，本项目搭建了完整的 **Agent-Native 指标创作与安全执行链路**。

---

## 核心架构与设计决策

### 1. 纯函数安全校验器与五重沙箱断言 (`packages/indicators/src/validate.ts`)
- **零安全逃逸**：未通过校验器试算的源码绝不落库、绝不执行。
- **五重严密断言**：
  1. **结构合法性**：`id` 正则校验（小写字母数字下划线，2-32 字符，拒绝系统保留字覆盖）；`title` 1-32 字符；`pane`（`main` 主图叠加 / `sub` 独立副图）；`params`（0-8 个，`min < max` 且 `min <= default <= max`）。
  2. **源码体积上限**：单指标源码严格限制在 16KB（16384 字节）以内。
  3. **特征样例试算沙箱**：自动构造 5 组不同特征的测试 K 线（30 根平稳上涨、30 根连续下跌、30 根平盘震荡、15 根跳空大缺口、3 根极短序列），并在 100ms 超时限制下试算执行，捕获任何语法或运行时异常。
  4. **输出形状等长断言**：输出系列数量 1-8 个，每个 output 的 `values.length` 必须与传入的 `bars.length` **严格等长逐点对齐**。
  5. **数值有限性与 warm-up 断言**：`values` 中的每项元素必须是有限数字（`Number.isFinite`）或 `undefined`（warm-up 初始阶段），严禁包含 `NaN`、`Infinity`、`null` 或非法类型。

### 2. Agent 创作工具 `indicator_author` (`packages/indicators/src/tool.ts`)
- 工厂函数 `createAuthorIndicatorTool({ store })`，定义 `indicator_author` 工具。
- 支持接收 `id`, `title`, `pane`, `paramsJson`, `computeSource`, `description`。
- 校验失败时返回清晰结构化的原因（`[indicator_author] Validation failed: ...`），引导大模型自动反思并修复重试；校验成功后写入持久化存储。

### 3. 知识随包分发 (`packages/indicators/assets/skills/indicator-authoring/SKILL.md`)
- 遵循设计铁律 #2（知识随包分发）。
- 详细规范 `IndicatorDefinition` 契约、`bars` 输入、`IndicatorOutput[]` 输出、`warm-up undefined` 语义、红涨绿跌 Token 色彩约定。
- 提供三大富途同款生产级黄金范例：
  1. **TD9（狄马克九转序列，主图叠加）**
  2. **SuperTrend（超级趋势指标，主图叠加）**
  3. **OBV+MA34（能量潮叠加 34 天均线，副图双线）**

### 4. HTTP 桥与客户端自动同步 (`packages/client-ui-trading`)
- Node 端桥路由扩展 `/dshtrading/api/indicators/custom`（支持 GET 拉取与 DELETE 删除）。
- 客户端在启动与初始化时异步拉取自定义指标列表，经 `validateCustomIndicator` 校验生成定义后动态注册进 `indicators` 本地注册表。
- 图表底部的快捷指标词条带与选择器面板自动呈现自定义指标，点击即可一键挂载，`TvChart` 零感知绘制。

---

## 验证与验收

1. **编译构建**：全量 19 个 package `pnpm -r build` 100% 通过。
2. **单元测试**：全量 `pnpm -r test` 251+ 用例全绿（含针对坏例拦截、TD9、SuperTrend、OBV+MA34 黄金用例、HTTP 桥路由的专项单测）。
