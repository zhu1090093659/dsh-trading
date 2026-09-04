---
name: indicator-authoring
description: 指标创作指南：自然语言生成符合注册表契约的自定义技术指标代码（TD9/SuperTrend/OBV+MA等），并通过 indicator_author 工具落库。
---

# 指标创作指南（Indicator Authoring Guide）

当用户在会话列中用自然语言提出编写或添加技术指标的需求时（例如："帮我写一个 TD9 指标"、"帮我写一个 SuperTrend 指标"、"给 OBV 加一个 34 天均线"），请遵循本指南生成符合 `@dshtrading/indicators` 契约规范的 JavaScript 纯函数代码，并调用 `indicator_author` 工具进行沙箱校验与落库。

---

## 1. 核心契约与计算模型

技术指标是纯数据与纯函数的契约对象：

```typescript
export interface IndicatorDefinition {
  id: string              // 唯一 ID，如 "td9"、"supertrend"、"custom_rsi"（小写字母数字下划线，2-32 字符）
  title: string           // 显示名称，如 "TD9"、"SuperTrend"（1-32 字符）
  pane: 'main' | 'sub'    // 归属："main" 主图叠加 或 "sub" 独立副图
  params: IndicatorParamSpec[] // 参数列表配置（0-8 个）
  compute(bars: readonly Kline[], params: Record<string, number>): IndicatorOutput[]
}
```

### 输入 `bars`（K 线数组）
每根 K 线包含：
- `openTime`: number（毫秒时间戳）
- `open`: number（开盘价）
- `high`: number（最高价）
- `low`: number（最低价）
- `close`: number（收盘价）
- `volume`: number（成交量）

### 输出 `IndicatorOutput[]`（序列数组）
每个输出序列包含：
- `key`: string（系列名称，如 `'TD_BUY'`、`'SUPERTREND'`、`'OBV_MA'`）
- `kind`: `'line'` | `'histogram'`
- `color`: string（如 `'#e64545'`（涨红）、`'#2ba471'`（跌绿）、`'#3b82f6'`（蓝）、`'#e6a23c'`（橙））
- `values`: `Array<number | undefined>`
- `histogramBySign`?: boolean（柱状图专用：为 true 时正值着红、负值着绿）

---

## 2. 编写黄金铁律（必须遵守）

1. **长度严格对齐**：`output.values.length` **必须严格等于** `bars.length`！
2. **warm-up 必须用 `undefined`**：历史数据不足以计算的前 N 根 K 线，对应位置的值必须填 `undefined`，图表引擎会自动将其作为未准备就绪点跳过渲染。
3. **数值必须有限（Finite）**：严禁在 `values` 中出现 `NaN`、`Infinity`、`null` 或字符串。除法操作必须做防除零保护（如 `denominator === 0 ? 0 : numerator / denominator`）。
4. **纯函数与零副作用**：`compute` 必须是无状态的纯函数，不得访问 `window`、`document` 或外部全局可变状态。
5. **红涨绿跌 Token 约定**：中国市场规范下，多头/上涨/买点使用红色系（如 `#e64545`），空头/下跌/卖点使用绿色系（如 `#2ba471`）。

---

## 3. 三大富途牛牛同款生产级范例

### 范例一：TD9（汤姆·狄马克九转序列，主图叠加）

连续 9 根收盘价低于 4 根前收盘价触发买入九转（看多转折），连续 9 根高于 4 根前触发卖出九转。

```javascript
(bars) => {
  const len = bars.length;
  const buySetup = new Array(len).fill(undefined);
  const sellSetup = new Array(len).fill(undefined);
  let buyCount = 0;
  let sellCount = 0;

  for (let i = 0; i < len; i++) {
    if (i < 4) continue;
    const currentClose = bars[i].close;
    const close4Ago = bars[i - 4].close;

    if (currentClose < close4Ago) {
      buyCount += 1;
      sellCount = 0;
      buySetup[i] = buyCount;
    } else if (currentClose > close4Ago) {
      sellCount += 1;
      buyCount = 0;
      sellSetup[i] = sellCount;
    } else {
      buyCount = 0;
      sellCount = 0;
    }
  }

  return [
    { key: 'TD_BUY', kind: 'line', color: '#2ba471', values: buySetup },
    { key: 'TD_SELL', kind: 'line', color: '#e64545', values: sellSetup },
  ];
}
```

---

### 范例二：SuperTrend（超级趋势指标，主图叠加）

基于 ATR 与倍数构建的动态趋势跟踪通道与止损线。

```javascript
(bars, params) => {
  const period = Math.max(1, Math.round(params.period ?? 10));
  const multiplier = Number(params.multiplier ?? 3);
  const len = bars.length;

  const upperBand = new Array(len).fill(undefined);
  const lowerBand = new Array(len).fill(undefined);
  const supertrend = new Array(len).fill(undefined);

  // 1. 计算 True Range
  const tr = new Array(len);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < len; i++) {
    const hl = bars[i].high - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low - bars[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }

  // 2. 计算 ATR 与 SuperTrend 轨迹
  let atrSum = 0;
  let trend = 1;

  for (let i = 0; i < len; i++) {
    atrSum += tr[i];
    if (i >= period) atrSum -= tr[i - period];

    if (i < period - 1) continue;

    const currentAtr = atrSum / period;
    const hl2 = (bars[i].high + bars[i].low) / 2;
    let basicUpper = hl2 + multiplier * currentAtr;
    let basicLower = hl2 - multiplier * currentAtr;

    if (i > 0 && lowerBand[i - 1] !== undefined) {
      if (basicLower < lowerBand[i - 1] && bars[i - 1].close > lowerBand[i - 1]) {
        basicLower = lowerBand[i - 1];
      }
    }
    if (i > 0 && upperBand[i - 1] !== undefined) {
      if (basicUpper > upperBand[i - 1] && bars[i - 1].close < upperBand[i - 1]) {
        basicUpper = upperBand[i - 1];
      }
    }

    lowerBand[i] = basicLower;
    upperBand[i] = basicUpper;

    if (i > 0 && supertrend[i - 1] !== undefined) {
      if (trend === 1 && bars[i].close < lowerBand[i]) {
        trend = -1;
      } else if (trend === -1 && bars[i].close > upperBand[i]) {
        trend = 1;
      }
    }

    supertrend[i] = trend === 1 ? lowerBand[i] : upperBand[i];
  }

  return [
    { key: 'SUPERTREND', kind: 'line', color: '#3b82f6', values: supertrend }
  ];
}
```

---

### 范例三：OBV + MA34（能量潮 + 34 天均线，副图指标）

量价配合指标，结合累积成交量与平滑均线研判多空力量。

```javascript
(bars, params) => {
  const maPeriod = Math.max(1, Math.round(params.period ?? 34));
  const len = bars.length;
  const obv = new Array(len);
  const obvMa = new Array(len).fill(undefined);

  obv[0] = 0;
  for (let i = 1; i < len; i++) {
    if (bars[i].close > bars[i - 1].close) {
      obv[i] = obv[i - 1] + bars[i].volume;
    } else if (bars[i].close < bars[i - 1].close) {
      obv[i] = obv[i - 1] - bars[i].volume;
    } else {
      obv[i] = obv[i - 1];
    }
  }

  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += obv[i];
    if (i >= maPeriod) sum -= obv[i - maPeriod];
    if (i >= maPeriod - 1) {
      obvMa[i] = sum / maPeriod;
    }
  }

  return [
    { key: 'OBV', kind: 'line', color: '#e6a23c', values: obv },
    { key: 'OBV_MA', kind: 'line', color: '#409eff', values: obvMa },
  ];
}
```

---

## 4. 工具调用范式

生成代码后，直接调用 `indicator_author` 工具：

```json
{
  "id": "td9",
  "title": "TD9",
  "pane": "main",
  "computeSource": "(bars) => { ... }",
  "description": "汤姆狄马克九转序列指标"
}
```

若工具返回 `Validation failed`，请根据返回的具体报错信息调整代码（如修复长度不对齐、NaN 防护等）后重新尝试，直至落库成功。

### 4.1 创作即上图（可选一步到位）

`indicator_author` 支持可选参数 `activate`（布尔，默认 false）：置 true 时指标通过校验落库后会立即按 schema 默认参数挂上用户当前图表（GUI 经 SSE 即时点亮），无需再调 `indicator_activate`。适合「帮我写个 XXX 并加到图上」这类一句话需求；仅落库不上图的需求保持缺省。

### 4.2 图表挂载管理（indicator_list / indicator_activate / indicator_deactivate）

- `indicator_list`：枚举全部可用指标——预置与自定义（id/title/pane/参数 schema/描述）及当前激活名册（含生效参数）。创作前查重、挂载前选 id 与参数时先调它。
- `indicator_activate`：把指标挂上用户图表。`id` 必须是预置或已创作落库的自定义指标；可选 `paramsJson`（JSON 对象，如 `{"period":14}`）覆写参数默认值，越界自动收敛到 min/max，缺失键取默认值。重复挂载同 id 即更新参数（每 id 至多一个实例）。
- `indicator_deactivate`：从图上摘除一个实例（定义仍在指标库）；彻底删除自定义指标定义用 `indicator_delete`。

典型链路：`indicator_list` 查重 → `indicator_author`（或带 `activate: true` 一步上图）→ 需要调参时 `indicator_activate` + `paramsJson` → `indicator_deactivate` 摘除。
