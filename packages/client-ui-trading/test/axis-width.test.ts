/**
 * 价格轴宽度下限纯计算层单测（axis-width.ts）：候选标签的口径与保守界。
 * 这是「图表宽度抖动」修复的判据层——标签一旦取窄，轴宽下限压不住 lwc 的
 * 「轴宽 ↔ 绘图区宽」正反馈，抖动会回来。
 */
import { describe, expect, it } from 'vitest'
import { AXIS_SCALE_MARGIN, axisMinimumWidth, percentAxisRef, percentLabel, percentLabelCandidates } from '../src/client/axis-width.ts'

describe('percentLabel（右轴 formatter 与宽度下限的唯一口径）', () => {
  it('正数不带正号、两位小数、带 %', () => {
    expect(percentLabel(110, 100)).toBe('10.00%')
    expect(percentLabel(90, 100)).toBe('-10.00%')
    expect(percentLabel(100, 100)).toBe('0.00%')
  })

  it('参考价 null/0/负数、价格非有限 → 空串（与旧 formatter 口径一致）', () => {
    expect(percentLabel(100, null)).toBe('')
    expect(percentLabel(100, 0)).toBe('')
    expect(percentLabel(100, -1)).toBe('')
    expect(percentLabel(Number.NaN, 100)).toBe('')
    expect(percentLabel(100, Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('percentAxisRef（右轴锚点：五日级别用昨收）', () => {
  it('用户停在五日级别：同一价位的右轴读数就是头部那个涨跌幅（41.61 / 昨收 41.54 = 0.17%）', () => {
    // Given 头部「41.61 +0.17%」，昨收 41.54
    const anchor = percentAxisRef(41.54)
    // When 右轴把同一价位 41.61 画成百分比标签
    // Then 与头部逐字一致
    expect(percentLabel(41.61, anchor)).toBe('0.17%')
  })

  it('用户报的 0.75% 出自「可视区首根收盘」锚点，修复前后必须可区分', () => {
    // Given 当天 09:30 首根收盘 41.30 当锚点（2026-10-27 修复前的口径）
    // Then 同一价位 41.61 读成 0.75%，与头部的 0.17% 差 0.58 个百分点
    expect(percentLabel(41.61, 41.30)).toBe('0.75%')
  })

  it('用户换到非五日级别时右轴退回可视区首根口径（锚点缺省/非正/非有限一律 null）', () => {
    // Given 父级没给锚点，或给的是 0/负数/非有限值（昨收缺省的行情）
    // When 右轴取锚点
    // Then 一律 null —— formatter 退回「可视区最左一根收盘」的既有口径
    expect(percentAxisRef(undefined)).toBeNull()
    expect(percentAxisRef(null)).toBeNull()
    expect(percentAxisRef(0)).toBeNull()
    expect(percentAxisRef(-1)).toBeNull()
    expect(percentAxisRef(Number.NaN)).toBeNull()
    expect(percentAxisRef(Number.POSITIVE_INFINITY)).toBeNull()
    expect(percentAxisRef(41.54)).toBe(41.54)
  })
})

describe('percentLabelCandidates', () => {
  it('参考价两个极端各取一条，且按轴留白外扩（scaleMargins 撑出的刻度不被漏算）', () => {
    // span=15 → pad=15×0.08/0.84=1.4286：rise=(45+1.4286−32)/32=45.09%；fall=(30−1.4286−44)/44=−35.06%
    expect(percentLabelCandidates({ minPrice: 30, maxPrice: 45, minClose: 32, maxClose: 44 }))
      .toEqual(['45.09%', '-35.06%'])
  })

  it('量级边界：数据最大涨幅 9.5% 时候选必须覆盖轴顶端的 10.40%（少一位就压不住抖动）', () => {
    // 实测反例（2026-09-15 评审 M5）：数据区间 100→109.5（标签 9.50%，5 字符），
    // 轴留白把顶端刻度撑到 109.5+0.905=110.40 → 真实标签 10.40%（6 字符）。
    // 不计留白时下限比自然轴宽窄一个字符，反馈链重新闭合。
    const labels = percentLabelCandidates({ minPrice: 100, maxPrice: 109.5, minClose: 100, maxClose: 109.5 })
    expect(labels[0]).toBe('10.40%')
    expect(labels[0].length).toBeGreaterThan('9.50%'.length)
  })

  it('正数不带正号（与右轴 formatter 同口径）', () => {
    expect(percentLabelCandidates({ minPrice: 90, maxPrice: 90, minClose: 90, maxClose: 90 })[0]).toBe('0.00%')
  })

  it('参考价为 0/负数等不可除情形回落到 0.00%（不产生 NaN/Infinity 标签）', () => {
    expect(percentLabelCandidates({ minPrice: 0, maxPrice: 0, minClose: 0, maxClose: 0 })).toEqual(['0.00%', '0.00%'])
    expect(percentLabelCandidates({ minPrice: -5, maxPrice: -3, minClose: -5, maxClose: -3 })).toEqual(['0.00%', '0.00%'])
  })

  it('用户遇到跳空高开的五日窗口时，右轴标签按昨收算而不被收盘包络算窄', () => {
    // Given 可视区收盘全在 100–101，昨收 90 落在区间下方（跳空高开后一路上行）
    const extremes = { minPrice: 100, maxPrice: 101, minClose: 100, maxClose: 101 }
    // When 固定锚点口径与可视区口径各算一次候选
    const fixed = percentLabelCandidates({ ...extremes, ref: 90 })
    const fallback = percentLabelCandidates(extremes)
    // Then 固定口径按 90 算（12.33% / 11.01%），比收盘包络口径宽一个字符
    expect(fixed).toEqual(['12.33%', '11.01%'])
    expect(fallback).toEqual(['1.10%', '-1.08%'])
    expect(fixed[0].length).toBeGreaterThan(fallback[0].length)
  })

  it('大幅区间给出更长的标签（量级跨 10/100 各差一个字符）', () => {
    // span=990 → pad=94.2857：rise=(1000+94.2857−10)/10=10842.86%；fall=(10−94.2857−1000)/1000=−108.43%
    const labels = percentLabelCandidates({ minPrice: 10, maxPrice: 1000, minClose: 10, maxClose: 1000 })
    expect(labels[0]).toBe('10842.86%')
    expect(labels[1]).toBe('-108.43%')
  })
})

describe('axisMinimumWidth', () => {
  it('node 环境（无 DOM）返回 0：调用方据此跳过 applyOptions，不误锁轴宽', () => {
    expect(axisMinimumWidth(['42.93%'])).toBe(0)
  })

  it('轴留白常量与 TvChart 的 scaleMargins 同源（0.08，两轴必须一致）', () => {
    expect(AXIS_SCALE_MARGIN).toBe(0.08)
  })
})
