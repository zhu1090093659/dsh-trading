import { describe, expect, it } from 'vitest'
import { validateCustomIndicator, validateCustomIndicatorAsync, compileComputeSource } from '../src/validate.ts'
import { createMemoryCustomIndicatorStore } from '../src/custom.ts'
import { createAuthorIndicatorTool, validateCustomIndicatorNode } from '../src/tool.ts'

// issue #88：vm 试算超时默认 100ms 只作死循环熔断，不是性能阈值；CI（2 vCPU）
// 全包并行时墙钟抖动会让合法指标被误判超时。走 vm 试算的用例注入放宽值，
// 死循环保护用例仍用默认值（超时判定本身由「trialTimeoutMs 可注入」用例覆盖）。
const TEST_TRIAL_TIMEOUT_MS = 5_000

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

  it('trialTimeoutMs 可注入：慢试算默认判超时、放宽后通过（issue #88）', () => {
    const raw = {
      id: 'slow_calc',
      title: 'Slow',
      pane: 'main',
      // 150ms 墙钟忙等：超过默认 100ms 熔断线，但远低于注入的放宽值。
      computeSource: `(bars) => {
        const deadline = Date.now() + 150;
        while (Date.now() < deadline) {}
        return [{ key: 'line', kind: 'line', color: '#f00', values: bars.map(b => b.close) }];
      }`,
    }
    const strict = validateCustomIndicatorNode(raw)
    expect(strict.ok).toBe(false)
    if (!strict.ok) expect(strict.reason).toContain('超时')

    const relaxed = validateCustomIndicatorNode(raw, { trialTimeoutMs: TEST_TRIAL_TIMEOUT_MS })
    expect(relaxed.ok).toBe(true)
  })

  it('rejects infinite loop in computeSource (timeout protection)', () => {
    const res = validateCustomIndicatorNode({
      id: 'infinite_loop',
      title: 'Loop',
      pane: 'main',
      computeSource: '(bars) => { while(true) {} return []; }',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('超时')
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
    const tool = createAuthorIndicatorTool({ store, trialTimeoutMs: TEST_TRIAL_TIMEOUT_MS })

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

  it('successfully validates custom indicator with area kind and shading options', () => {
    const areaSource = `(bars, params) => {
      const closes = bars.map(b => b.close);
      return [
        {
          key: 'BAND',
          kind: 'area',
          color: '#2ba471',
          topColor: 'rgba(43, 164, 113, 0.2)',
          bottomColor: 'rgba(43, 164, 113, 0.0)',
          invertFilledArea: true,
          values: closes,
        },
      ];
    }`

    const res = validateCustomIndicator({
      id: 'custom_area',
      title: 'Custom Area',
      pane: 'main',
      computeSource: areaSource,
    })

    expect(res.ok).toBe(true)
  })
})

describe('参数控件的选项来源（optionsSource）', () => {
  const base = {
    id: 'param_source_probe',
    title: '参数来源探针',
    pane: 'main',
    computeSource: '(bars) => [{ key: "X", kind: "line", color: "#000000", values: bars.map(() => 1) }]',
  }

  it('用户声明 kdas-key-days 的参数经校验后仍带 optionsSource', () => {
    // Given 一个把 kd1 的输入来源声明成「关键日下拉」的指标
    const candidate = {
      ...base,
      params: [{ key: 'kd1', label: '关键日', default: 0, min: 0, max: 20991231, optionsSource: 'kdas-key-days' }],
    }

    // When 提交校验
    const res = validateCustomIndicator(candidate)

    // Then 校验通过，且来源字段被保留（丢弃它等于编辑期静默变回数字输入框）
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.record.params[0]?.optionsSource).toBe('kdas-key-days')
  })

  it('用户未声明来源时参数不带 optionsSource（存量指标零迁移）', () => {
    // Given 一个普通数字参数
    const candidate = { ...base, params: [{ key: 'n', label: '周期', default: 5, min: 2, max: 50 }] }

    // When 提交校验
    const res = validateCustomIndicator(candidate)

    // Then 该字段缺省不落地
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.record.params[0]?.optionsSource).toBeUndefined()
  })

  it('用户写了未知来源时校验拒收，不静默丢弃', () => {
    // Given 作者写了个不存在的来源
    const candidate = {
      ...base,
      params: [{ key: 'kd1', label: '关键日', default: 0, min: 0, max: 20991231, optionsSource: 'whatever' }],
    }

    // When 提交校验
    const res = validateCustomIndicator(candidate)

    // Then 直接拒收，并在原因里点名该字段
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toContain('optionsSource')
  })
})

describe('新实例默认适用范围（defaultApplyScope）', () => {
  const base = {
    id: 'scope_probe',
    title: '作用域探针',
    pane: 'main',
    computeSource: '(bars) => [{ key: "X", kind: "line", color: "#000000", values: bars.map(() => 1) }]',
  }
  const onlyFiveDay = { cn: { enabled: true, intervals: ['5d'] } }

  it('管理员声明范围后 definition 与 record 带同一份 scope', () => {
    // Given 一个「只在五日显示」的自定义指标
    const candidate = { ...base, defaultApplyScope: onlyFiveDay }

    // When 提交校验
    const res = validateCustomIndicator(candidate)

    // Then 两条产物都带上范围（缺一条实例就落不到新范围）
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.definition.defaultApplyScope).toEqual(onlyFiveDay)
    expect(res.record.defaultApplyScope).toEqual(onlyFiveDay)
  })

  it('管理员未声明范围时字段缺席（存量自定义指标零迁移）', () => {
    // Given 一个没有范围声明的指标
    const candidate = { ...base }

    // When 提交校验
    const res = validateCustomIndicator(candidate)

    // Then 两个字段都不落地
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.definition.defaultApplyScope).toBeUndefined()
    expect(res.record.defaultApplyScope).toBeUndefined()
  })

  it('管理员填了不合法形状时一律拒收，不猜', () => {
    // Given 六种坏形状（非对象、数组、大写 slug、非布尔、非字符串数组、缺 intervals）
    const broken: unknown[] = [
      42,
      [],
      { CN: { enabled: true, intervals: ['5d'] } },
      { cn: { enabled: 'yes', intervals: ['5d'] } },
      { cn: { enabled: true, intervals: [1] } },
      { cn: { enabled: true } },
    ]

    // When 逐个提交校验
    const results = broken.map(defaultApplyScope => validateCustomIndicator({ ...base, defaultApplyScope }))

    // Then 全部拒收
    expect(results.every(result => !result.ok)).toBe(true)
  })

  it('用户经客户端异步入口校验时同样保留范围', () => {
    // Given 客户端实际调用的那个入口（indicator-load 的 register 吃它的 definition）
    const candidate = { ...base, defaultApplyScope: onlyFiveDay }

    // When await 异步校验，再断言
    return validateCustomIndicatorAsync(candidate).then(res => {
      // Then 定义侧仍带范围，自行长出来的实例才会有默认适用范围
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.definition.defaultApplyScope).toEqual(onlyFiveDay)
    })
  })
})

describe('参数个数上限（12）', () => {
  const source = '(bars) => [{ key: "X", kind: "line", color: "#000000", values: bars.map(() => 1) }]'
  const spec = (index: number) => ({ key: 'p' + index, label: 'P' + index, default: 1, min: 0, max: 10 })

  it('运营配置 12 个参数时通过（8 个关键日槽 + 4 个拓展参数）', () => {
    // Given 正好 12 个参数
    const params = Array.from({ length: 12 }, (_, index) => spec(index))

    // When 提交校验
    const res = validateCustomIndicator({ id: 'param_cap_probe', title: '参数上限探针', pane: 'main', params, computeSource: source })

    // Then 通过
    expect(res.ok).toBe(true)
  })

  it('运营配置 13 个参数时被拒（上限仍是硬门）', () => {
    // Given 13 个参数
    const params = Array.from({ length: 13 }, (_, index) => spec(index))

    // When 提交校验
    const res = validateCustomIndicator({ id: 'param_cap_probe', title: '参数上限探针', pane: 'main', params, computeSource: source })

    // Then 拒收且原因点明上限，不是静默截断
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toContain('上限')
  })
})

describe('参数控件来源 on-off（可选拓展的开关）', () => {
  const base = {
    id: 'switch_source_probe',
    title: '开关来源探针',
    pane: 'main',
    computeSource: '(bars) => [{ key: "X", kind: "line", color: "#000000", values: bars.map(() => 1) }]',
  }

  it('用户声明 on-off 的参数经校验后保留来源，编辑期渲染成开/关下拉', () => {
    // Given 一个可选拓展开关
    const candidate = {
      ...base,
      params: [{ key: 'stopOn', label: '止损线开关', default: 0, min: 0, max: 1, optionsSource: 'on-off' }],
    }

    // When 提交校验
    const res = validateCustomIndicator(candidate)

    // Then 来源落地
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.record.params[0]?.optionsSource).toBe('on-off')
  })

  it('用户写了未登记的来源时被拒（白名单仍是硬门）', () => {
    // Given 一个没登记过的来源
    const candidate = {
      ...base,
      params: [{ key: 'stopOn', label: '止损线开关', default: 0, min: 0, max: 1, optionsSource: 'checkbox' }],
    }

    // When 提交校验
    const res = validateCustomIndicator(candidate)

    // Then 拒收
    expect(res.ok).toBe(false)
  })
})
