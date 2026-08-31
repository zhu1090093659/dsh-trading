/**
 * color-mode: 全局涨跌配色管理单元测试。
 */
import { describe, expect, it } from 'vitest'
import { getColorPalette, PALETTES, type ColorMode } from '../src/client/color-mode.ts'
import { directionColor } from '../src/client/format.ts'

describe('getColorPalette', () => {
  it('returns red-up palette by default', () => {
    const palette = getColorPalette()
    expect(palette.mode).toBe('red-up')
    expect(palette.upColor).toBe('#e64545')
    expect(palette.downColor).toBe('#2ba471')
  })

  it('returns green-up palette when specified', () => {
    const palette = getColorPalette('green-up')
    expect(palette.mode).toBe('green-up')
    expect(palette.upColor).toBe('#2ba471')
    expect(palette.downColor).toBe('#e64545')
  })

  it('flatColor is the same for both modes', () => {
    expect(PALETTES['red-up'].flatColor).toBe(PALETTES['green-up'].flatColor)
  })

  it('upAlpha and downAlpha return valid rgba strings', () => {
    const palette = getColorPalette('red-up')
    expect(palette.upAlpha(0.55)).toContain('rgba(230, 69, 69, 0.55)')
    expect(palette.downAlpha(0.55)).toContain('rgba(43, 164, 113, 0.55)')
  })

  it('green-up upAlpha uses green rgba', () => {
    const palette = getColorPalette('green-up')
    expect(palette.upAlpha(0.55)).toContain('rgba(43, 164, 113, 0.55)')
    expect(palette.downAlpha(0.55)).toContain('rgba(230, 69, 69, 0.55)')
  })
})

describe('directionColor with ColorMode', () => {
  it('positive value returns upColor based on mode', () => {
    expect(directionColor(1.5, 'red-up')).toBe('#e64545')
    expect(directionColor(1.5, 'green-up')).toBe('#2ba471')
  })

  it('negative value returns downColor based on mode', () => {
    expect(directionColor(-0.5, 'red-up')).toBe('#2ba471')
    expect(directionColor(-0.5, 'green-up')).toBe('#e64545')
  })

  it('zero value returns flatColor regardless of mode', () => {
    expect(directionColor(0, 'red-up')).toBe('#8a8f99')
    expect(directionColor(0, 'green-up')).toBe('#8a8f99')
  })

  it('defaults to red-up when mode is omitted', () => {
    expect(directionColor(1)).toBe('#e64545')
    expect(directionColor(-1)).toBe('#2ba471')
  })
})
