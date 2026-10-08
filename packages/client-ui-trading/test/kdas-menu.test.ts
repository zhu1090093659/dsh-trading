/**
 * kdas-menu 纯函数单测：Key Day 槽位推导、添加/移除动作与锚定命中判定。
 * 口径契约（UTC 取日、kd1..kd8、锚定 = 第一根交易日 >= kd）见模块头注；
 * 这里的手算期望值即 kdas computeSource 的同规则复算。
 */
import { describe, expect, it } from 'vitest'
import {
  addKdasDay, clampRectInto, freeKdasSlot, formatKdasDay, isKdasDay, isKdasDayValue,
  kdasAnchorSourceDay, kdasOutputKey, kdasSlots, removeKdasDay, utcDayNum,
} from '../src/client/kdas-menu.ts'

/** UTC 日毫秒（避免本地时区影响测试断言）。 */
const utcMs = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d)

const EIGHT_KEYS = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['kd' + (i + 1), 0]))

describe('utcDayNum / formatKdasDay / kdasOutputKey', () => {
  it('用户读取 K 线时间：openTime 按 UTC 取日（HKT 零点算前一 UTC 日）', () => {
    // Given: 2026-10-08 的 UTC 零点与香港时间零点两个时刻
    // When: 按与 kdas compute 同源的规则推导日号
    // Then: UTC 零点算当日；HKT 零点落在前一 UTC 日（10-07）
    expect(utcDayNum(utcMs(2026, 10, 8))).toBe(20261008)
    // 2026-10-08T00:00+08:00 = 2026-10-07T16:00Z → UTC 日是 10-07
    expect(utcDayNum(Date.parse('2026-10-08T00:00:00+08:00'))).toBe(20261007)
  })

  it('用户看到 Key Day 文本：补零显示且输出键与 compute 的 key 规则一致', () => {
    // Given: 日号 20240924
    // When: 生成显示文本与输出键
    // Then: 显示为补零形 '2024-09-24'，输出键为 'KDAS_24-09-24'
    expect(formatKdasDay(20240924)).toBe('2024-09-24')
    expect(formatKdasDay(20240924)).not.toBe('2024-9-24')
    expect(kdasOutputKey(20240924)).toBe('KDAS_24-09-24')
  })

  it('用户输入非法 Key Day 值：0/越界/非整数一律判非法', () => {
    // Given: 0、1999 与 2100 年的越界日号、小数日号，以及合法日号 20240924
    // When: 逐项做合法性判定
    // Then: 非法项全为 false，合法日号为 true
    expect(isKdasDayValue(0)).toBe(false)
    expect(isKdasDayValue(19991231)).toBe(false)
    expect(isKdasDayValue(21000101)).toBe(false)
    expect(isKdasDayValue(20240924.5)).toBe(false)
    expect(isKdasDayValue(20240924)).toBe(true)
  })
})

describe('kdasSlots / freeKdasSlot', () => {
  it('用户查看已设 Key Day：跳过 0 槽与非法值，按槽位序返回', () => {
    // Given: 未设置（undefined），以及 kd1=20250821、kd2=0、kd6=20260625、kd8=123456 的参数表
    // When: 推导槽位列表
    // Then: 未设置为空数组；只回合法且非 0 的槽（1 与 6），按槽位序
    expect(kdasSlots(undefined)).toEqual([])
    const params = { ...EIGHT_KEYS, kd1: 20250821, kd2: 0, kd6: 20260625, kd8: 123456 }
    expect(kdasSlots(params)).toEqual([
      { slot: 1, kd: 20250821 },
      { slot: 6, kd: 20260625 },
    ])
  })

  it('用户重复设置同一天：只保留最小槽位', () => {
    // Given: kd2 与 kd5 指向同一天 20240924
    // When: 推导槽位列表并做命中判定
    // Then: 只回槽 2 一条，isKdasDay 命中该日
    const params = { ...EIGHT_KEYS, kd2: 20240924, kd5: 20240924 }
    expect(kdasSlots(params)).toEqual([{ slot: 2, kd: 20240924 }])
    expect(isKdasDay(params, 20240924)).toBe(true)
  })

  it('用户新增 Key Day：取最小未用槽，满槽返回 null', () => {
    // Given: 未设置、已占 kd1/kd2、以及八个槽全占的参数表
    // When: 查询下一个空闲槽
    // Then: 分别得到 1、3、null
    expect(freeKdasSlot(undefined)).toBe(1)
    const params = { ...EIGHT_KEYS, kd1: 20250821, kd2: 20240924 }
    expect(freeKdasSlot(params)).toBe(3)
    const full = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['kd' + (i + 1), 20200101 + i]))
    expect(freeKdasSlot(full)).toBeNull()
  })
})

describe('addKdasDay / removeKdasDay', () => {
  it('用户首次添加 Key Day：写 kd1 且其余键补 0（不产出稀疏参数表）', () => {
    // Given: 空参数表 {}
    // When: 添加 20261008
    // Then: 写 kd1、其余 kd 补 0，槽位 1
    const result = addKdasDay({}, 20261008)
    expect(result).toEqual({ ok: true, params: { ...EIGHT_KEYS, kd1: 20261008 }, slot: 1 })
  })

  it('用户追加 Key Day：写第一个空槽，已有槽保持不变', () => {
    // Given: 已占 kd1=20250821、kd2=20240924 的参数表
    // When: 追加 20260625
    // Then: 落到槽 3，kd1/kd2 原样保留
    const params = { ...EIGHT_KEYS, kd1: 20250821, kd2: 20240924 }
    const result = addKdasDay(params, 20260625)
    expect(result).toEqual({
      ok: true,
      params: { ...params, kd3: 20260625 },
      slot: 3,
    })
  })

  it('用户重复添加或满槽添加：拒绝且不写槽', () => {
    // Given: 已含 20250821 的参数表、八槽全占的参数表，以及非法值 123
    // When: 分别添加已存在的日、第 9 个 Key Day、非法值
    // Then: 分别以 duplicate / full / duplicate 拒绝，都不返回新参数表
    const params = { ...EIGHT_KEYS, kd1: 20250821 }
    expect(addKdasDay(params, 20250821)).toEqual({ ok: false, reason: 'duplicate' })
    const full = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['kd' + (i + 1), 20200101 + i]))
    expect(addKdasDay(full, 20261008)).toEqual({ ok: false, reason: 'full' })
    expect(addKdasDay(params, 123)).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('用户移除 Key Day：清槽归 0；值不存在时拒绝', () => {
    // Given: 已设 kd1=20250821、kd6=20260625 的参数表，另有一个未设置的日 20240924
    // When: 分别移除已设的 20260625 与未设的 20240924
    // Then: 前者把 kd6 清 0 并回槽 6；后者以 missing 拒绝
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

  it('用户点击的 K 线正是某 Key Day 的锚点：返回该存储日（含非交易日 kd 前移锚定）', () => {
    // Given: kd1=20250821/kd2=20240924 的参数表，以及 kd1=20251004（国庆非交易日）的参数表
    // When: 分别点击 20240924，与 20251009（第一根 >= 20251004 的交易日）
    // Then: 两次都返回各自存储的 kd
    const params = { ...EIGHT_KEYS, kd1: 20250821, kd2: 20240924 }
    expect(kdasAnchorSourceDay(params, bars, 20240924)).toBe(20240924)
    // 20251004 是国庆非交易日：锚定 = 第一根交易日 >= kd = 20251009
    const holiday = { ...EIGHT_KEYS, kd1: 20251004 }
    expect(kdasAnchorSourceDay(holiday, bars, 20251009)).toBe(20251004)
  })

  it('用户点击自由日（无 Key Day 锚定到该日）：返回 null', () => {
    // Given: 只设 kd1=20240924 的参数表与未设置（undefined）的参数表
    // When: 分别点击 20250821 与 20240924
    // Then: 两次都返回 null（该日可新增 Key Day）
    const params = { ...EIGHT_KEYS, kd1: 20240924 }
    expect(kdasAnchorSourceDay(params, bars, 20250821)).toBeNull()
    expect(kdasAnchorSourceDay(undefined, bars, 20240924)).toBeNull()
  })

  it('用户点击早于全部数据的 Key Day：无锚点，不命中任何 bar', () => {
    // Given: kd1=20200101，而 bars 最早为 2024-09-23
    // When: 在 20240924 这一根上做锚定判定
    // Then: null（不存在 openTime >= kd 的 bar）
    const params = { ...EIGHT_KEYS, kd1: 20200101 }
    expect(kdasAnchorSourceDay(params, bars, 20240924)).toBeNull()
  })
})

describe('clampRectInto', () => {
  const outer = { x: 100, y: 200, width: 800, height: 600 }

  it('用户拖出菜单到容器内：位置不动（含 padding 内边距裕量）', () => {
    // Given: 外层容器与完全落在内边距以内的 inner 矩形
    // When: 做越界钳位
    // Then: x/y 原样返回
    const inner = { x: 300, y: 400, width: 190, height: 220 }
    expect(clampRectInto(inner, outer)).toEqual({ x: 300, y: 400 })
  })

  it('用户拖到右缘或下缘越界：分别左移、上移收回容器', () => {
    // Given: 右缘越界与下缘越界两个矩形
    // When: 分别做钳位
    // Then: x 收到 right - 4 - width、y 收到 bottom - 4 - height（各留 4px padding）
    const atRightEdge = { x: 890, y: 300, width: 190, height: 220 }
    expect(clampRectInto(atRightEdge, outer)).toEqual({ x: 800 - 4 - 190 + 100, y: 300 })
    const atBottom = { x: 300, y: 700, width: 190, height: 220 }
    expect(clampRectInto(atBottom, outer)).toEqual({ x: 300, y: 200 + 600 - 4 - 220 })
  })

  it('用户拖到右下角同时越界：双向钳位', () => {
    // Given: 右下角同时越界的矩形
    // When: 做钳位
    // Then: x 与 y 同时收回容器内
    const corner = { x: 890, y: 700, width: 190, height: 220 }
    expect(clampRectInto(corner, outer)).toEqual({ x: 100 + 800 - 4 - 190, y: 200 + 600 - 4 - 220 })
  })

  it('用户遇到菜单比容器还大：钉在左/上 padding，保证左上可见', () => {
    // Given: 宽高都超过容器的矩形
    // When: 做钳位
    // Then: 钉在 (outer.x + 4, outer.y + 4)
    const huge = { x: 150, y: 250, width: 900, height: 700 }
    expect(clampRectInto(huge, outer)).toEqual({ x: 104, y: 204 })
  })

  it('用户自定义 padding：按该裕量钳位', () => {
    // Given: 右缘越界的矩形与 padding=8
    // When: 做钳位
    // Then: x = right - 8 - width
    const inner = { x: 890, y: 300, width: 190, height: 220 }
    expect(clampRectInto(inner, outer, 8).x).toBe(100 + 800 - 8 - 190)
  })
})
