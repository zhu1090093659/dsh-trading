/**
 * kdas-menu 单测：Key Day 槽位推导、添加/移除动作、锚定命中判定，以及官方菜单面
 * （target 动作推导、圆点图片、服务桥）。
 * 口径契约（UTC 取日、kd1..kd8、锚定 = 第一根交易日 >= kd）见模块头注；
 * 这里的手算期望值即 kdas computeSource 的同规则复算。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  addKdasDay, freeKdasSlot, formatKdasDay, installKdasContextMenu, isKdasDay, isKdasDayValue,
  kdasAnchorSourceDay, kdasDayDotSrc, kdasDayFromActionId, kdasMenuActions, kdasOutputKey,
  kdasRemoveDayActionId, kdasSlots, openKdasContextMenu, removeKdasDay, utcDayNum,
  type KdasContextMenus, type KdasMenuAction, type KdasMenuCopy, type KdasMenuValue,
} from '../src/client/kdas-menu.ts'
import { en, zh } from '../src/client/locales.ts'

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

describe('kdasMenuActions', () => {
  /** 真实词典 + 占位符替换：断言的是生产文案，不是替身文案。 */
  const copyFrom = (dict: Record<string, string>): KdasMenuCopy =>
    (key, vars) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => vars === undefined ? '' : (vars as Record<string, string>)[name] ?? '')
  const copy = copyFrom(zh)
  const value = (patch: Partial<KdasMenuValue> = {}): KdasMenuValue => ({
    market: 'cn',
    symbol: '002714.SZ',
    barDay: 20261008,
    anchorDay: null,
    mounted: true,
    days: [],
    ...patch,
  })

  it('用户没挂载 KDAS：右键只有挂载一项，不出现增删', () => {
    // Given: 未挂载（mounted=false）的命中快照
    // When: 推导菜单动作
    // Then: 只剩挂载一项，文案走词典的 kdas.menu.mount
    expect(kdasMenuActions(value({ mounted: false }), copy)).toEqual([
      { id: 'mount', label: '挂载 KDAS（关键日均价线）' },
    ])
  })

  it('用户右键已锚定的 K 线：给的是移除该锚，而不是再加一条同锚线', () => {
    // Given: 命中柱上锚定 20250821，名册里也有这一天
    // When: 推导菜单动作
    // Then: 首项是移除该锚（存储日进文案），没有设为关键日
    const actions = kdasMenuActions(value({ anchorDay: 20250821, days: [{ kd: 20250821, color: '#e5484d' }] }), copy)
    expect(actions[0]).toMatchObject({ id: 'remove-anchor', label: '移除关键日 2025-08-21' })
    expect(actions.some(action => action.id === 'add')).toBe(false)
  })

  it('用户右键自由柱：给设为关键日，日期取存储口径（UTC 日）', () => {
    // Given: 自由柱（anchorDay=null）与已有一条关键日
    // When: 推导菜单动作
    // Then: 首项是设为关键日 2026-10-08，且该项未禁用
    const actions = kdasMenuActions(value({ days: [{ kd: 20250821, color: '#e5484d' }] }), copy)
    expect(actions[0]).toMatchObject({ id: 'add', label: '设为关键日 2026-10-08' })
    expect(actions[0]?.disabled).toBeUndefined()
  })

  it('用户满 8 条再点自由柱：该项禁用，且行上写明原因', () => {
    // Given: 名册已满 8 条，命中柱不在其中
    // When: 推导菜单动作
    // Then: 设为关键日被禁用，文案换成 kdas.menu.full（官方动作没有 tooltip 位）
    const days = Array.from({ length: 8 }, (_, i) => ({ kd: 20200101 + i, color: '#3b82f6' }))
    const actions = kdasMenuActions(value({ days }), copy)
    expect(actions[0]).toMatchObject({ id: 'add', disabled: true, label: '关键日已满 8 条，先移除后再添加' })
  })

  it('用户点击的日已在名册里：满 8 条也不禁用（幂等拒绝由动作自己承担）', () => {
    // Given: 满 8 条且命中柱就是其中一条的存储日
    // When: 推导菜单动作
    // Then: 设为关键日仍可点（不是满槽）
    const days = Array.from({ length: 8 }, (_, i) => ({ kd: 20200101 + i, color: '#3b82f6' }))
    const actions = kdasMenuActions(value({ barDay: days[0]!.kd, days }), copy)
    expect(actions[0]).toMatchObject({ id: 'add' })
    expect(actions[0]?.disabled).toBeUndefined()
  })

  it('用户查看底部逐日行：按槽位序列出全部关键日，首行带分隔线', () => {
    // Given: 名册里两条关键日（槽位序）与自由柱快照
    // When: 推导菜单动作
    // Then: 两条移除行按序排列，id 带存储日、文案日期 + 移除、圆点走同一图标格、首行 separatorBefore
    const days = [{ kd: 20250821, color: '#e5484d' }, { kd: 20260625, color: '#3b82f6' }]
    const actions = kdasMenuActions(value({ days }), copy)
    const rows = actions.filter(action => action.id.startsWith('remove-day:'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 'remove-day:20250821',
      label: '2025-08-21 · 移除',
      separatorBefore: true,
      icon: { key: 'dshtrading.kdas.day', src: kdasDayDotSrc('#e5484d') },
    })
    expect(rows[1]).toMatchObject({ id: 'remove-day:20260625', label: '2026-06-25 · 移除' })
    expect(rows[1]?.separatorBefore).toBeUndefined()
  })

  it('用户切到英文：同一动作给英文文案（词典键 zh/en 两侧齐全）', () => {
    // Given: 英文词典与含一条关键日、命中锚点的快照
    // When: 推导菜单动作
    // Then: 移除锚点与逐日行的英文文案与 zh 同构
    const actions = kdasMenuActions(
      value({ anchorDay: 20250821, days: [{ kd: 20250821, color: '#e5484d' }] }),
      copyFrom(en),
    )
    expect(actions.map(action => action.label)).toEqual(['Remove key day 2025-08-21', '2025-08-21 · Remove'])
  })
})

describe('kdasDayDotSrc', () => {
  it('用户看到关键日行圆点：线色进 SVG data URL，井号必须编码', () => {
    // Given: 图上线色 #e5484d
    // When: 生成圆点图片地址
    // Then: 是 svg data URL、解码后含该线色、原串里不出现裸井号（否则整段 URL 断在锚点上）
    const src = kdasDayDotSrc('#e5484d')
    expect(src.startsWith('data:image/svg+xml,')).toBe(true)
    expect(decodeURIComponent(src)).toContain('fill="#e5484d"')
    expect(src).not.toContain('#')
  })
})

describe('kdasRemoveDayActionId / kdasDayFromActionId', () => {
  it('用户点逐日移除：id 往返还原存储日', () => {
    // Given: 存储日 20260625
    // When: 生成动作 id 再还原
    // Then: id 为 remove-day:20260625，还原得同一日号
    const id = kdasRemoveDayActionId(20260625)
    expect(id).toBe('remove-day:20260625')
    expect(kdasDayFromActionId(id)).toBe(20260625)
  })

  it('用户点非本族动作：还原返回 null（不误伤挂载/新增/移除锚点）', () => {
    // Given: 挂载、新增、移除锚点三个动作 id，与一个非法日号
    // When: 逐个尝试还原
    // Then: 全部为 null
    expect(kdasDayFromActionId('mount')).toBeNull()
    expect(kdasDayFromActionId('add')).toBeNull()
    expect(kdasDayFromActionId('remove-anchor')).toBeNull()
    expect(kdasDayFromActionId('remove-day:123')).toBeNull()
  })
})

describe('installKdasContextMenu / openKdasContextMenu', () => {
  /** 官方 ContextMenus 的契约面替身：只记录调用，不伪造弹层行为。 */
  const recorder = () => {
    const opened: Array<{ target: unknown; point: { x: number; y: number } }> = []
    const registered: string[] = []
    const service: KdasContextMenus = {
      register(contribution) {
        registered.push(contribution.target + '/' + contribution.id)
        return () => { registered.pop() }
      },
      open(target, point) { opened.push({ target, point }) },
    }
    return { service, opened, registered }
  }
  let detach: (() => void) | undefined
  afterEach(() => {
    detach?.()
    detach = undefined
  })

  const target = {
    kind: 'dshtrading.kdas' as const,
    value: {
      market: 'cn', symbol: '002714.SZ', barDay: 20261008, anchorDay: null, mounted: true,
      days: [{ kd: 20250821, color: '#e5484d' }],
    },
  }

  it('用户右键时菜单服务缺席：不接管右键，交回浏览器默认菜单', () => {
    // Given: 没有装上任何菜单服务
    // When: 请求打开关键日菜单
    // Then: 返回 false（TvChart 据此不拦截默认菜单）
    expect(openKdasContextMenu(target, { x: 120, y: 240 })).toBe(false)
  })

  it('用户装上官方菜单服务后右键：target 与视口坐标原样交给它', () => {
    // Given: 一个记录调用的菜单服务
    // When: 装上后打开菜单
    // Then: 返回 true，服务收到同一个 target 与同一个坐标
    const { service, opened } = recorder()
    detach = installKdasContextMenu(service)
    expect(openKdasContextMenu(target, { x: 120, y: 240 })).toBe(true)
    expect(opened).toEqual([{ target, point: { x: 120, y: 240 } }])
  })

  it('用户卸载菜单服务之后右键：重新交回默认菜单', () => {
    // Given: 装上菜单服务后又卸载
    // When: 请求打开菜单
    // Then: 返回 false，且服务不再收到调用
    const { service, opened } = recorder()
    const uninstall = installKdasContextMenu(service)
    uninstall()
    expect(openKdasContextMenu(target, { x: 1, y: 2 })).toBe(false)
    expect(opened).toEqual([])
  })

  it('用户热重载菜单服务后再跑旧卸载：新服务仍然是当前服务', () => {
    // Given: 先装 A、再装 B（官方插件热重载）
    // When: 跑 A 的卸载
    // Then: 打开的仍是 B（旧卸载不摘新服务）
    const first = recorder()
    const second = recorder()
    const uninstallFirst = installKdasContextMenu(first.service)
    detach = installKdasContextMenu(second.service)
    uninstallFirst()
    expect(openKdasContextMenu(target, { x: 3, y: 4 })).toBe(true)
    expect(first.opened).toEqual([])
    expect(second.opened).toHaveLength(1)
  })
})
