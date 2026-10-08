/**
 * kdas-menu 纯函数单测：Key Day 槽位推导、添加/移除动作与锚定命中判定。
 * 口径契约（UTC 取日、kd1..kd8、锚定 = 第一根交易日 >= kd）见模块头注；
 * 这里的手算期望值即 kdas computeSource 的同规则复算。
 */
import { describe, expect, it } from 'vitest'
import {
  addKdasDay, freeKdasSlot, formatKdasDay, isKdasDay, isKdasDayValue,
  kdasAnchorSourceDay, kdasOutputKey, kdasSlots, removeKdasDay, utcDayNum,
} from '../src/client/kdas-menu.ts'

/** UTC 日毫秒（避免本地时区影响测试断言）。 */
const utcMs = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d)

const EIGHT_KEYS = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['kd' + (i + 1), 0]))

describe('utcDayNum / formatKdasDay / kdasOutputKey', () => {
  it('openTime 取 UTC 日（HKT 零点 = 前一日，与 kdas compute dayNum 同源）', () => {
    expect(utcDayNum(utcMs(2026, 10, 8))).toBe(20261008)
    // 2026-10-08T00:00+08:00 = 2026-10-07T16:00Z → UTC 日是 10-07
    expect(utcDayNum(Date.parse('2026-10-08T00:00:00+08:00'))).toBe(20261007)
  })

  it('formatKdasDay 补零显示、kdasOutputKey 与 compute 的 key 规则一致', () => {
    expect(formatKdasDay(20240924)).toBe('2024-09-24')
    expect(formatKdasDay(20240924)).not.toBe('2024-9-24')
    expect(kdasOutputKey(20240924)).toBe('KDAS_24-09-24')
  })

  it('非法值判定：0/越界/非整数不是合法 Key Day', () => {
    expect(isKdasDayValue(0)).toBe(false)
    expect(isKdasDayValue(19991231)).toBe(false)
    expect(isKdasDayValue(21000101)).toBe(false)
    expect(isKdasDayValue(20240924.5)).toBe(false)
    expect(isKdasDayValue(20240924)).toBe(true)
  })
})

describe('kdasSlots / freeKdasSlot', () => {
  it('跳过 0 槽与非法值，槽位序返回', () => {
    expect(kdasSlots(undefined)).toEqual([])
    const params = { ...EIGHT_KEYS, kd1: 20250821, kd2: 0, kd6: 20260625, kd8: 123456 }
    expect(kdasSlots(params)).toEqual([
      { slot: 1, kd: 20250821 },
      { slot: 6, kd: 20260625 },
    ])
  })

  it('重复值保留最小槽位', () => {
    const params = { ...EIGHT_KEYS, kd2: 20240924, kd5: 20240924 }
    expect(kdasSlots(params)).toEqual([{ slot: 2, kd: 20240924 }])
    expect(isKdasDay(params, 20240924)).toBe(true)
  })

  it('空槽取最小未用槽；满槽返回 null', () => {
    expect(freeKdasSlot(undefined)).toBe(1)
    const params = { ...EIGHT_KEYS, kd1: 20250821, kd2: 20240924 }
    expect(freeKdasSlot(params)).toBe(3)
    const full = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['kd' + (i + 1), 20200101 + i]))
    expect(freeKdasSlot(full)).toBeNull()
  })
})

describe('addKdasDay / removeKdasDay', () => {
  it('空实例首添：写 kd1，其余键补 0（首次覆盖不得产出稀疏参数表）', () => {
    const result = addKdasDay({}, 20261008)
    expect(result).toEqual({ ok: true, params: { ...EIGHT_KEYS, kd1: 20261008 }, slot: 1 })
  })

  it('追加写第一个空槽，已有槽保持不变', () => {
    const params = { ...EIGHT_KEYS, kd1: 20250821, kd2: 20240924 }
    const result = addKdasDay(params, 20260625)
    expect(result).toEqual({
      ok: true,
      params: { ...params, kd3: 20260625 },
      slot: 3,
    })
  })

  it('重复与满槽拒绝', () => {
    const params = { ...EIGHT_KEYS, kd1: 20250821 }
    expect(addKdasDay(params, 20250821)).toEqual({ ok: false, reason: 'duplicate' })
    const full = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['kd' + (i + 1), 20200101 + i]))
    expect(addKdasDay(full, 20261008)).toEqual({ ok: false, reason: 'full' })
    expect(addKdasDay(params, 123)).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('移除清槽归 0；值不存在拒绝', () => {
    const params = { ...EIGHT_KEYS, kd1: 20250821, kd6: 20260625 }
    expect(removeKdasDay(params, 20260625)).toEqual({ ok: true, params: { ...params, kd6: 0 }, slot: 6 })
    expect(removeKdasDay(params, 20240924)).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('kdasAnchorSourceDay', () => {
  // 锚定语义要求升序：20251004（国庆，非交易日）锚定到第一根 >= 它的 20251009。
  const bars = [
    { openTime: utcMs(2024, 9, 23) },
    { openTime: utcMs(2024, 9, 24) },
    { openTime: utcMs(2025, 8, 21) },
    { openTime: utcMs(2025, 8, 22) },
    { openTime: utcMs(2025, 10, 9) },
    { openTime: utcMs(2026, 10, 9) },
  ]

  it('点击的 K 线是某 kd 的锚点 → 返回该存储 kd（含非交易日 kd 前移锚定）', () => {
    const params = { ...EIGHT_KEYS, kd1: 20250821, kd2: 20240924 }
    expect(kdasAnchorSourceDay(params, bars, 20240924)).toBe(20240924)
    // 20251004 是国庆非交易日：锚定 = 第一根交易日 >= kd = 20251009
    const holiday = { ...EIGHT_KEYS, kd1: 20251004 }
    expect(kdasAnchorSourceDay(holiday, bars, 20251009)).toBe(20251004)
  })

  it('无 kd 锚定到该日 → null（自由日，可新增）', () => {
    const params = { ...EIGHT_KEYS, kd1: 20240924 }
    expect(kdasAnchorSourceDay(params, bars, 20250821)).toBeNull()
    expect(kdasAnchorSourceDay(undefined, bars, 20240924)).toBeNull()
  })

  it('早于全部数据的 kd 无锚点，不命中任何 bar', () => {
    const params = { ...EIGHT_KEYS, kd1: 20200101 }
    expect(kdasAnchorSourceDay(params, bars, 20240924)).toBeNull()
  })
})
