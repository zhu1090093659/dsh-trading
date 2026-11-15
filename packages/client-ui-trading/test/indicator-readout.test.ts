/**
 * 主图指标读数行渲染项单测（indicator-readout.ts）：冻结「项数与宽度不随
 * readoutIndex 变化」这条布局契约——读数行是流内元素，行数变化会让下方图表
 * 容器跳变（2026-09-15 牧原股份 6 条 KDAS 闪烁晃动 bug 的根因）。
 */
import { describe, expect, it } from 'vitest'
import { readoutItems } from '../src/client/indicator-readout.ts'
import type { IndicatorOutput } from '@dshtrading/indicators'

function output(key: string, values: ReadonlyArray<number | undefined>, precision?: number): IndicatorOutput {
  return { key, kind: 'line', color: '#FFD700', values, ...(precision === undefined ? {} : { precision }) }
}

const GROUP = {
  key: 'kdas',
  title: 'KDAS',
  outputs: [
    output('KDAS_24-09-24', [undefined, undefined, 42.312, 42.973], 3),
    output('KDAS_26-09-05', [undefined, undefined, undefined, 42.978], 3),
  ],
}

describe('readoutItems', () => {
  it('每个 output 恒定产出 1 项：无值项用 — 占位，不整项消失', () => {
    const beforeAnchor = readoutItems([GROUP], 1)
    expect(beforeAnchor).toHaveLength(2)
    expect(beforeAnchor.map(item => item.text)).toEqual(['—', '—'])

    const afterAnchor = readoutItems([GROUP], 3)
    expect(afterAnchor).toHaveLength(2)
    expect(afterAnchor.map(item => item.text)).toEqual(['42.973', '42.978'])
  })

  it('值列宽度取该 output 全序列最大格式化长度，与 readoutIndex 无关', () => {
    // [undefined, undefined, 42.312, 42.973] → 最长 '42.312'/'42.973' = 6ch
    const widths = [0, 1, 2, 3].map(index => readoutItems([GROUP], index).map(item => item.width))
    expect(widths).toEqual([[6, 6], [6, 6], [6, 6], [6, 6]])
  })

  it('全序列无值时值列宽度回落到占位宽度（1ch），仍恒定产出', () => {
    const empty = { key: 'x', title: 'X', outputs: [output('X1', [undefined, undefined], 3)] }
    expect(readoutItems([empty], 0)).toEqual([
      { key: 'x.X1', title: 'X', label: 'X1', text: '—', color: '#FFD700', width: 1 },
    ])
  })

  it('precision 缺省两位、显式三位生效', () => {
    const group = { key: 'g', title: 'G', outputs: [output('A', [1.23456]), output('B', [1.23456], 3)] }
    const items = readoutItems([group], 0)
    expect(items.map(item => item.text)).toEqual(['1.23', '1.235'])
    expect(items.map(item => item.width)).toEqual([4, 5])
  })

  it('非有限值（NaN/Infinity）按无值处理', () => {
    const group = { key: 'g', title: 'G', outputs: [output('A', [Number.NaN, Number.POSITIVE_INFINITY, 2])] }
    expect(readoutItems([group], 0)[0]?.text).toBe('—')
    expect(readoutItems([group], 1)[0]?.text).toBe('—')
    expect(readoutItems([group], 2)[0]?.text).toBe('2.00')
  })

  it('readoutIndex 为 null（序列未就绪）时整行为空', () => {
    expect(readoutItems([GROUP], null)).toEqual([])
  })

  it('多组按组序拼接，项 key / 组名 / 分量名 / 颜色透传', () => {
    const other = { key: 'ma', title: 'MA', outputs: [output('MA5', [10, 11, 12])] }
    const items = readoutItems([GROUP, other], 2)
    expect(items.map(item => item.key)).toEqual(['kdas.KDAS_24-09-24', 'kdas.KDAS_26-09-05', 'ma.MA5'])
    expect(items[0]).toMatchObject({ title: 'KDAS', label: 'KDAS_24-09-24', color: '#FFD700' })
    expect(items[2]).toMatchObject({ title: 'MA', label: 'MA5', text: '12.00' })
  })

  it('用户声明 hideReadout 后该输出不进读数行，未声明的照旧', () => {
    // Given 同组一条普通分量，和一条「数只走价格轴价签」的参考线
    const group = {
      key: 'stoploss',
      title: '综合止损线',
      outputs: [
        { key: 'MA', kind: 'line', color: '#e6a23c', values: [10, 11, 12] } as IndicatorOutput,
        {
          key: 'SL_NOW',
          kind: 'line',
          color: '#2ba471',
          values: [8, 8, 8],
          showLastValue: true,
          hideReadout: true,
        } as IndicatorOutput,
      ],
    }

    // When 取读数项
    const items = readoutItems([group], 2)

    // Then 读数行只剩未声明隐藏的那条，项数与会话/悬停无关
    expect(items.map(item => item.key)).toEqual(['stoploss.MA'])
    expect(items.map(item => item.text)).toEqual(['12.00'])
  })
})
