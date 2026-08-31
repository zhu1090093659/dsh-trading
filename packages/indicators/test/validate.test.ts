import { describe, expect, it } from 'vitest'
import { validateCustomIndicator, compileComputeSource } from '../src/validate.ts'
import { createMemoryCustomIndicatorStore } from '../src/custom.ts'
import { createAuthorIndicatorTool } from '../src/tool.ts'

describe('validateCustomIndicator', () => {
  it('rejects invalid structural inputs', () => {
    expect(validateCustomIndicator(null).ok).toBe(false)
    expect(validateCustomIndicator({}).ok).toBe(false)
    expect(validateCustomIndicator({ id: '1', title: 'test', pane: 'main', computeSource: '...' }).ok).toBe(false)
    expect(validateCustomIndicator({ id: 'ma', title: 'test', pane: 'main', computeSource: '...' }).ok).toBe(false)
    expect(validateCustomIndicator({ id: 'valid_id', title: '', pane: 'main', computeSource: '...' }).ok).toBe(false)
    expect(validateCustomIndicator({ id: 'valid_id', title: 't', pane: 'invalid', computeSource: '...' }).ok).toBe(false)
  })

  it('rejects invalid param specifications', () => {
    const base = {
      id: 'custom_test',
      title: 'Test',
      pane: 'main',
      computeSource: '(bars) => [{ key: "v", kind: "line", color: "#e64545", values: bars.map(b => b.close) }]',
    }
    // min >= max
    expect(validateCustomIndicator({
      ...base,
      params: [{ key: 'p', label: 'P', default: 10, min: 20, max: 10 }],
    }).ok).toBe(false)

    // default not in [min, max]
    expect(validateCustomIndicator({
      ...base,
      params: [{ key: 'p', label: 'P', default: 5, min: 10, max: 20 }],
    }).ok).toBe(false)
  })

  it('rejects syntax error in computeSource', () => {
    const res = validateCustomIndicator({
      id: 'syntax_err',
      title: 'Syntax Err',
      pane: 'main',
      computeSource: 'bars => { return [; }',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('语法错误')
  })

  it('rejects runtime errors during test calculation', () => {
    const res = validateCustomIndicator({
      id: 'runtime_err',
      title: 'Runtime Err',
      pane: 'main',
      computeSource: '(bars) => { throw new Error("boom"); }',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('试算执行报错')
  })

  it('rejects outputs with length mismatch', () => {
    const res = validateCustomIndicator({
      id: 'mismatch_len',
      title: 'Mismatch',
      pane: 'main',
      computeSource: '(bars) => [{ key: "line", kind: "line", color: "#f00", values: [1, 2, 3] }]',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('不一致')
  })

  it('rejects outputs containing NaN or Infinity', () => {
    const res = validateCustomIndicator({
      id: 'nan_test',
      title: 'NaN Test',
      pane: 'main',
      computeSource: '(bars) => [{ key: "line", kind: "line", color: "#f00", values: bars.map((b, i) => i === 0 ? NaN : b.close) }]',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('非法数值')
  })

  // ── 黄金范例测试 ──────────────────────────────────────────────────────────

  it('successfully validates TD9 (Demak 9-turn sequence)', () => {
    const td9Source = `(bars) => {
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
    }`

    const res = validateCustomIndicator({
      id: 'td9',
      title: 'TD9',
      pane: 'main',
      computeSource: td9Source,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.definition.id).toBe('td9')
      expect(res.definition.pane).toBe('main')
    }
  })

  it('successfully validates SuperTrend (ATR-based dynamic band)', () => {
    const supertrendSource = `(bars, params) => {
      const period = Math.max(1, Math.round(params.period ?? 10));
      const multiplier = Number(params.multiplier ?? 3);
      const len = bars.length;

      const upperBand = new Array(len).fill(undefined);
      const lowerBand = new Array(len).fill(undefined);
      const supertrend = new Array(len).fill(undefined);

      // True Range
      const tr = new Array(len);
      tr[0] = bars[0].high - bars[0].low;
      for (let i = 1; i < len; i++) {
        const hl = bars[i].high - bars[i].low;
        const hc = Math.abs(bars[i].high - bars[i - 1].close);
        const lc = Math.abs(bars[i].low - bars[i - 1].close);
        tr[i] = Math.max(hl, hc, lc);
      }

      // Simple ATR
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
    }`

    const res = validateCustomIndicator({
      id: 'supertrend',
      title: 'SuperTrend',
      pane: 'main',
      params: [
        { key: 'period', label: 'ATR Period', default: 10, min: 1, max: 50 },
        { key: 'multiplier', label: 'Multiplier', default: 3, min: 1, max: 10 },
      ],
      computeSource: supertrendSource,
    })

    expect(res.ok).toBe(true)
  })

  it('successfully validates OBV+MA34 (On-Balance Volume + 34 MA)', () => {
    const obvSource = `(bars, params) => {
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
    }`

    const res = validateCustomIndicator({
      id: 'obv_ma34',
      title: 'OBV+MA34',
      pane: 'sub',
      params: [
        { key: 'period', label: 'MA Period', default: 34, min: 2, max: 200 },
      ],
      computeSource: obvSource,
    })

    expect(res.ok).toBe(true)
  })
})

describe('createAuthorIndicatorTool', () => {
  it('validates and persists custom indicator through tool execute', async () => {
    const store = createMemoryCustomIndicatorStore()
    const tool = createAuthorIndicatorTool({ store })

    // 1. 尝试传入非法代码
    const failOut = await tool.execute({
      id: 'bad_ind',
      title: 'Bad',
      pane: 'main',
      computeSource: '(bars) => [{ key: "k", kind: "line", color: "#f00", values: [1, 2] }]',
    })
    expect(String(failOut)).toContain('[indicator_author] Validation failed')
    expect(await store.list()).toHaveLength(0)

    // 2. 传入合法代码
    const successOut = await tool.execute({
      id: 'my_custom_sma',
      title: 'Custom SMA',
      pane: 'main',
      paramsJson: JSON.stringify([{ key: 'n', label: 'N', default: 5, min: 2, max: 50 }]),
      computeSource: `(bars, params) => {
        const n = params.n || 5;
        const values = bars.map((b, i) => {
          if (i < n - 1) return undefined;
          let sum = 0;
          for (let j = 0; j < n; j++) sum += bars[i - j].close;
          return sum / n;
        });
        return [{ key: 'SMA', kind: 'line', color: '#3b82f6', values }];
      }`,
    })

    expect(String(successOut)).toContain('[indicator_author] Successfully authored')
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('my_custom_sma')
  })
})
