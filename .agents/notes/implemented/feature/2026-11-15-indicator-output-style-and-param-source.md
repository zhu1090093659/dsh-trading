# Agent Note: 指标参考线的渲染面、参数的输入来源与自定义指标的默认适用范围

Status: implemented

## Problem

自定义指标要画「参考线」时撞上三处缺口，2026-11-15 一个止损线指标把它们全踩了一遍：

1. **画不出参考线的样子**。`IndicatorOutput` 只有 `color` / `lineWidth` / `precision`，渲染层把 `lastValueVisible` 与 `priceLineVisible` 写死成 `false`、线型永远是实线。结果止损位、支撑位这类「非趋势线」只能画成和均线一样的实线曲线，数值只能挤在顶部读数行的文字里，无法以价签形式落在价格轴上。
2. **参数只有数字框**。`IndicatorParamSpec` 只有 key/label/default/min/max，用户填「关键日」得手打 `20261102` 八位数字，填「开关」得猜 0 和 1。
3. **参数位不够**。`MAX_PARAMS_COUNT` 是 8，KDAS 的 `kd1..kd8` 八个槽正好占满，任何「可选拓展」（同一指标里的止损开关、倍数、窗口）都无处安放。

## Decision

**输出侧三个可选字段**（`@dshtrading/indicators` 的 `IndicatorOutput`），缺省值都等于改动前的行为，存量指标零迁移：

- `lineStyle?: 'solid' | 'dashed' | 'dotted'` → 渲染层映射 lightweight-charts 的 `LineStyle`，只对 line / area 生效（histogram 无此概念）。
- `showLastValue?: boolean` → 打开 `lastValueVisible`，该序列最新值以实心价签落在所属价格轴（主图叠加是左轴）。
- `hideReadout?: boolean` → 主图读数行（`indicator-readout.ts` 的 `readoutItems`）跳过该输出。数值已经以价签落在轴上，同一条数不必在读数行再出现一次。判据是 output 的静态字段，与十字光标位置无关，读数行的布局契约（项数只随数据变化）不受影响。

**参数侧的输入来源**（`IndicatorParamSpec.optionsSource`，白名单两种，未知值 fail closed 而不是静默回落成数字框）：

- `'kdas-key-days'` → 渲染成下拉，选项来自**图表激活名册里 kdas 实例对当前标的的生效参数**（`effectiveInstanceParams` → `kdasSlots`）。读激活名册而不是别的指标：关键日存在 `chart.json` 的 kdas 实例参数里，是双方共享的事实，不违反 compute 的纯函数契约——compute 仍只吃传进来的 params，选项只影响编辑期。已存但后来从 KDAS 移除的日期仍占一项，免得一次编辑把旧值抹掉。
- `'on-off'` → 固定两态（关 / 开），用于可选拓展的开关。

**参数上限 8 → 12**：8 个关键日槽 + 4 个止损拓展参数的自然上限。面板按 schema 渲染、不假设上限，放宽只影响校验。13 个仍被拒（硬门，不静默截断）。

**自定义记录也能声明默认适用范围**：`CustomIndicatorRecord.defaultApplyScope`，经 `validateCustomIndicator`（同步与异步两个入口）校验形状、`resolveIndicatorSpec` 透传给 definition，最终由 `defaultActivationInstance` 落到新实例。该字段的语义与存储契约归 [指标适用范围](2026-10-09-indicator-apply-scope.md)，本篇只补「自定义指标此前没有这条通道」这一格。

**配套的界面修正**（同一次交付，证据在 harness）：指标选择器面板 250px → 320px 且标题列不再参与压缩（原来 `flex:1 + min-width:0` 会把四个动作按钮行的中文标题压到一个字宽、逐字竖排）；参数控件 `input` 与 `select` 合并到同一条 CSS 规则、统一 120px（原来只有 input 有盒子样式，开关下拉 35.5px 贴着数字框 72px 的右边，左边参差；120px 同时容得下 `2026-11-02` 加下拉箭头）。

## Alternatives considered

- **把所有指标线都改成虚线 + 挂轴签**：一行改动即可，但 MA/MACD 等存量指标的外观全变，且轴签会把价格轴塞满。否决，改为声明式可选。
- **再加一个 `style: { ... }` 嵌套对象**：字段一多就需要分组，但当前只有三项，嵌套让自定义指标的作者多写一层且更难向后兼容。否决。
- **参数上限提到 16 或干脆去掉**：12 已经覆盖「8 槽 + 4 拓展」的真实需求，无上限等于放弃对失控 schema 的兜底。否决。
- **开关用 checkbox 而不是下拉**：语义更贴切，但同一行里 checkbox 与数字框的盒子模型完全不同，对齐成本更高；用户明确要「开 / 关」两项的下拉。取下拉。
- **让 stoploss 指标直接读 KDAS 指标的输出**：指标之间没有取数通道（compute 只吃 bars + params），要做得先造一套指标间依赖。否决，改为内联同源算法并用真实数据逐点对齐（`43.598` / `44.973` 与图上 KDAS 图例逐个吻合）。

## Consequences

- 三个输出字段与 `optionsSource` 缺省即旧行为；`_store.schemaVersion` 不需要迁移，存量 `custom.json` 与 `chart.json` 原样可读。
- `indicator_author` 与桥 PUT 的校验白名单同步收紧：未知 `optionsSource`、坏形状 `defaultApplyScope` 一律拒收并点名字段，不静默降级。
- **耦合警告（本次实测踩到）**：`client-ui-trading` 的 `lib/client.js` 会把 `@dshtrading/indicators` 的校验器内联进 bundle。只更新 `indicators/lib` 而不重建客户端，会出现「宿主认 12 个参数、浏览器还认 8 个」的分裂，实测表现为指标区整片加载失败、宿主进程退出。**改 indicators 必须同时重建所有内联它的包。**
- 证据：`packages/client-ui-trading/harness/indicator-picker.harness.tsx`（标题单行：改前 `22x88px` / 改后 `60x18px`）与 `param-editor.harness.tsx`（控件等宽：改前 `72/72/72/72/90.5/35.5px` / 改后全 `120px`），均为真实 Chrome 渲染 + 矩形断言。测试：`validate.test.ts` 新增 optionsSource 白名单、defaultApplyScope 形状、参数上限 12 三组；`tv-chart-line-style.test.ts` 钉住「声明才生效、缺省不变」；`indicator-readout.test.ts` 加 `hideReadout` 用例。
