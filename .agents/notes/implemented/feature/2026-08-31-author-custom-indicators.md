# Agent Note: 自然语言生成自定义指标——Agent 原生指标创作链路

- **日期**：2026-08-31
- **状态**：已实现 (implemented)
- **关联 Issue**：[#19](https://github.com/zhu1090093659/dsh-trading/issues/19)
- **分支**：`feat/author-custom-indicators`

---

## 背景与目标

为了让用户在会话列中用自然语言（如 "帮我写一个 TD9 指标"、"帮我写一个 SuperTrend 指标"、"给 OBV 加一个 34 天均线"）自由创作自定义技术指标，本项目搭建了完整的 **Agent-Native 指标创作、校验与端到端图表加载链路**。

---

## 核心架构与设计决策

### 1. 校验器与超时熔断保护 (`packages/indicators/src/validate.ts` & `validate-node.ts`)
- **断言集**：
  1. **结构合法性**：`id` 正则校验（小写字母数字下划线，2-32 字符，拒绝系统保留字覆盖）；`title` 1-32 字符；`pane`（`main` 主图叠加 / `sub` 独立副图）；`params`（0-8 个，`min < max` 且 `min <= default <= max`）。
  2. **源码体积上限**：单指标源码严格限制在 16KB（16384 字节）以内。
  3. **特征样例试算**：自动构造 5 组不同特征的测试 K 线（30 根平稳上涨、30 根连续下跌、30 根平盘震荡、15 根跳空大缺口、3 根极短序列）。
  4. **超时熔断保护（F1 修复）**：Node.js 端采用 `node:vm` 运行时环境执行 100ms 超时熔断，精准拦截 `while(true){}` 等死循环与严重卡顿代码，返回结构化中文错误原因供 Agent 自我修正；浏览器端保持纯净 JS 执行。
  5. **输出形状等长断言**：输出系列数量 1-8 个，每个 output 的 `values.length` 必须与传入的 `bars.length` **严格等长逐点对齐**。
  6. **数值有限性与 warm-up 断言**：`values` 中的每项元素必须是有限数字（`Number.isFinite`）或 `undefined`（warm-up 初始阶段），严禁包含 `NaN`、`Infinity`、`null` 或非法类型。
- **信任边界说明**：
  - 代码执行模型：Node.js 侧生成者为当前会话 Agent（与当前用户等权限），浏览器端为用户自身页面会话。
  - 校验器的职责是提供严格的语法、数据形状、有限性断言与死循环超时熔断，确保指标逻辑正确且不卡死主线程，不作为跨租户逃逸隔离。

### 2. 端到端链路完整接线 (F2 修复)
- **工具注册**：
  - `packages/client-ui-trading/src/index.ts`（Node 宿主汇聚点）与各市场 kit（`kit-crypto`, `kit-us`, `kit-cn`, `kit-hk`）统一创建并注册 `indicator_author` 工具，具备同名互斥 `registerOnce` 机制。
- **持久化存储与原子写入 (F4 修复)**：
  - 统一持久化存储于 `~/.dsh/indicators/custom.json`（DSH 用户主目录）；
  - `custom-fs.ts` 实现 `tmp + rename` 原子写入，写盘失败时记录完整错误日志并向上抛出，绝不静默丢失数据。
- **知识 Skill 载体**：
  - 各 kit 随包分发 `indicator-authoring` skill（位于 `assets/skills/indicator-authoring.md`），Agent 在所有市场 preset 会话中均可原生识别与读取该指南（含 TD9、SuperTrend、OBV+MA34 完整范例）。

### 3. HTTP 桥与 Web 客户端自动同步 (`packages/client-ui-trading`)
- Node 端桥路由提供 `/dshtrading/api/indicators/custom`（支持 GET 拉取与 DELETE 删除）；
- 客户端在启动与初始化时异步拉取自定义指标列表，经 `validateCustomIndicator` 校验生成定义后动态注册进 `indicators` 注册表；
- 图表底部的快捷指标词条带与选择器面板自动呈现自定义指标，点击即可一键挂载，`TvChart` 零感知绘制。

---

## 验证与验收

1. **编译构建**：全量 19 个 package `pnpm -r build` 100% 通过。
2. **单元测试**：全量 `pnpm -r test` 252+ 用例全绿（涵盖坏例拦截、死循环超时熔断、TD9、SuperTrend、OBV+MA34 黄金用例、HTTP 桥端点等专项单测）。
