/**
 * 卡片协议测试（P4 步骤 2）：纯函数，无 mock 无 sleep。
 * 重点验证"不退化"：未知枚举 ⇒ 不可操作；超限 ⇒ 非法（不截断）；兜底文本必有。
 */
import { describe, expect, it } from 'vitest'
import {
  ACTION_KINDS,
  ACTION_SCOPE,
  CARD_LIMITS,
  CARD_TYPES,
  FIELD_KINDS,
  fallbackFor,
  renderableActions,
  validateCard,
  type Card,
} from '../src/index.ts'

function card(over: Partial<Card> = {}): Card {
  return {
    cardId: 'card-1',
    cardType: 'desk-summary',
    revision: 1,
    fallbackText: 'desk 正常，无待处理升级',
    fields: [{ key: 'level', label: '档位', kind: 'status', value: 'normal' }],
    actions: [],
    ...over,
  }
}

describe('封闭枚举与未知值', () => {
  it('管理员：三类枚举都是封闭集合且数量与卡片一致（12 CardType / 12 FieldKind / 12 ActionKind）', () => {
    // Given 三份封闭词汇
    // When 数长度
    // Then 各 12（契约里写死的数量，改动即契约变更）
    expect(CARD_TYPES).toHaveLength(12)
    expect(FIELD_KINDS).toHaveLength(12)
    expect(ACTION_KINDS).toHaveLength(12)
    expect(new Set(CARD_TYPES).size).toBe(12)
  })

  it('管理员：未知 cardType 的卡片非法且不可操作', () => {
    // Given 一个未来版本的卡片类型
    const verdict = validateCard(card({ cardType: 'quantum-desk' as never }))
    // When 校验
    // Then 非法、不可操作、原因点名
    expect(verdict.valid).toBe(false)
    expect(verdict.operable).toBe(false)
    expect(verdict.problems.join(' ')).toContain('未知 cardType')
  })

  it('管理员：未知 fieldKind 或 actionKind ⇒ 卡片不可操作（结构可能合法，但禁用全部 Action）', () => {
    // Given 两种未来枚举
    const unknownField = validateCard(card({ fields: [{ key: 'x', label: 'X', kind: 'hologram' as never, value: 1 }] }))
    const unknownAction = validateCard(card({ actions: [{ kind: 'self-destruct' as never, label: '炸' }] }))
    // When 校验
    // Then 都不可操作
    expect(unknownField.operable).toBe(false)
    expect(unknownAction.operable).toBe(false)
  })

  it('管理员：enum 字段的值不在 values 内 ⇒ 不可操作（客户端无从判断怎么显示）', () => {
    // Given 一个值越界的 enum 字段
    const verdict = validateCard(card({ fields: [{ key: 'mode', label: '模式', kind: 'enum', value: 'turbo', values: ['normal', 'caution'] }] }))
    // When 校验
    // Then 不可操作且原因点名
    expect(verdict.operable).toBe(false)
    expect(verdict.problems.join(' ')).toContain('不在 values 内')
  })

  it('管理员：enum 字段缺 values 也判不可操作', () => {
    // Given 一个没有 values 的 enum 字段
    const verdict = validateCard(card({ fields: [{ key: 'mode', label: '模式', kind: 'enum', value: 'normal' }] }))
    // When 校验
    // Then 不可操作
    expect(verdict.operable).toBe(false)
    expect(verdict.problems.join(' ')).toContain('必须给出 values')
  })
})

describe('四类硬规则', () => {
  it('管理员：fallbackText 必填非空（富卡片必须能在老客户端退化成一句话）', () => {
    // Given 空白兜底文本
    const verdict = validateCard(card({ fallbackText: '   ' }))
    // When 校验
    // Then 非法
    expect(verdict.valid).toBe(false)
    expect(verdict.problems.join(' ')).toContain('fallbackText 必填')
  })

  it('管理员：控制类动作必须 confirm: true（kill/pause/flatten 不允许一键触发）', () => {
    // Given 一个没有二次确认的 kill
    const risky = validateCard(card({ actions: [{ kind: 'kill', label: '全部停止' }] }))
    const confirmed = validateCard(card({ actions: [{ kind: 'kill', label: '全部停止', confirm: true }] }))
    // When 校验
    // Then 前者不可操作、后者合法可操作
    expect(risky.operable).toBe(false)
    expect(risky.problems.join(' ')).toContain('必须 confirm: true')
    expect(confirmed).toMatchObject({ valid: true, operable: true })
    expect(ACTION_SCOPE.kill).toBe('control')
  })

  it('管理员：协议没有 html/template 逃生口——未知顶层键与未知字段类型都进不了契约', () => {
    // Given 有人试图塞 html
    const withHtml = { ...card(), html: '<b>hi</b>' } as Card
    // When 校验（html 不在契约里，所以它不会成为任何渲染路径的输入）
    const verdict = validateCard(withHtml)
    // Then 卡片仍按契约字段校验；html 不参与渲染（协议层没有承载它的字段类型）
    expect(FIELD_KINDS).not.toContain('html' as never)
    expect(verdict.valid).toBe(true)
    expect(Object.keys(verdict)).toEqual(['valid', 'operable', 'problems'])
  })

  it('管理员：revision 必须是非负有限数（客户端据此丢弃乱序到达的旧版本）', () => {
    // Given 两个非法 revision
    // When 校验
    // Then 都非法
    expect(validateCard(card({ revision: -1 })).valid).toBe(false)
    expect(validateCard(card({ revision: Number.NaN })).valid).toBe(false)
  })
})

describe('12 个硬上限是棘轮（超限即非法，不截断）', () => {
  it('管理员：fields / actions / enum values / label / value / fallback 超限都被拒', () => {
    // Given 六种超限
    const manyFields = card({ fields: Array.from({ length: CARD_LIMITS.maxFields + 1 }, (_v, index) => ({ key: 'k' + String(index), label: 'L', kind: 'text' as const, value: 'v' })) })
    const manyActions = card({ actions: Array.from({ length: CARD_LIMITS.maxActions + 1 }, () => ({ kind: 'ack' as const, label: 'A' })) })
    const manyEnum = card({ fields: [{ key: 'e', label: 'E', kind: 'enum', value: 'a', values: Array.from({ length: CARD_LIMITS.maxEnumValues + 1 }, (_v, index) => 'v' + String(index)) }] })
    const longLabel = card({ fields: [{ key: 'l', label: 'x'.repeat(CARD_LIMITS.maxLabelChars + 1), kind: 'text', value: 'v' }] })
    const longValue = card({ fields: [{ key: 'v', label: 'L', kind: 'text', value: 'y'.repeat(CARD_LIMITS.maxValueChars + 1) }] })
    const longFallback = card({ fallbackText: 'z'.repeat(CARD_LIMITS.maxFallbackChars + 1) })
    // When 校验
    // Then 全部非法（不是截断成合法）
    for (const [name, candidate] of Object.entries({ manyFields, manyActions, manyEnum, longLabel, longValue, longFallback })) {
      expect(validateCard(candidate).valid, name).toBe(false)
    }
  })

  it('管理员：卡片体积超限被拒（防止单卡把客户端撑爆）', () => {
    // Given 一张塞满长文本的卡片
    // 字段级上限（24 × 256 字符）加起来也到不了 16KB ⇒ 体积上限真正防的是**无界的 display 扩展**
    const big = card({ display: { chart: 'x'.repeat(CARD_LIMITS.maxCardBytes) } })
    // When 校验
    // Then 体积超限即非法
    const verdict = validateCard(big)
    expect(verdict.valid).toBe(false)
    expect(verdict.problems.join(' ')).toContain('字节上限')
  })

  it('管理员：上限本身被冻在契约里（12 项，改动即契约变更）', () => {
    // Given 上限表
    // When 数列数并抽查
    // Then 12 项且关键值确定
    expect(Object.keys(CARD_LIMITS)).toHaveLength(12)
    expect(CARD_LIMITS.maxActions).toBe(6)
    expect(CARD_LIMITS.maxCardsPerPage).toBe(50)
    expect(CARD_LIMITS.maxCardBytes).toBe(16_384)
  })
})

describe('渲染层的两个出口', () => {
  it('管理员：不可操作的卡片一个 Action 都不下发（禁用全部按钮）', () => {
    // Given 一张含未知枚举但带可识别动作的卡片
    const mixed = card({ actions: [{ kind: 'ack', label: '知道了' }], fields: [{ key: 'x', label: 'X', kind: 'hologram' as never, value: 1 }] })
    // When 取可渲染动作
    // Then 空数组
    expect(renderableActions(mixed, ['action:*'])).toEqual([])
  })

  it('管理员：可操作卡片按客户端 caps 过滤动作', () => {
    // Given 一张有两个动作的卡片
    const withActions = card({ actions: [{ kind: 'ack', label: '知道了' }, { kind: 'kill', label: '全部停止', confirm: true }] })
    // When 用只支持 ack 的 caps 过滤
    // Then 只下发 ack
    expect(renderableActions(withActions, ['action:ack']).map((action) => action.kind)).toEqual(['ack'])
    expect(renderableActions(withActions, ['action:*'])).toHaveLength(2)
  })

  it('管理员：兜底文本在不可渲染时明说"请升级客户端"（而不是装作正常）', () => {
    // Given 一张未知类型的卡片
    const unknown = card({ cardType: 'future-card' as never })
    // When 取兜底文本
    // Then 附带升级提示；正常卡片则原样返回
    expect(fallbackFor(unknown)).toContain('请升级客户端')
    expect(fallbackFor(card())).toBe('desk 正常，无待处理升级')
  })
})

describe('字段值的 String() 转换语义（Swift 必须等价，不得更窄）', () => {
  // 为什么单独锁这一组：Swift 旧实现把 JSON null 与"字段缺失"都解成 nil，
  // 于是 {value: null, values: ['null']} 被判成'值 undefined 不在 values 内'——
  // 一份 TS 判 valid 且 operable 的卡片，在 iOS 观测端变成不可操作，
  // 且展示值也丢了。这违反「Swift 是 TS 的等价实现，不得更窄」。
  const enumField = (value: unknown, values: readonly string[], withValue = true) =>
    withValue
      ? ({ key: 'mode', label: '模式', kind: 'enum' as const, value, values })
      : ({ key: 'mode', label: '模式', kind: 'enum' as const, values })

  const cases: readonly { name: string; field: { key: string; label: string; kind: 'enum'; value?: unknown; values: readonly string[] }; text: string }[] = [
    { name: 'null 是已知值 "null"（不是 undefined）', field: enumField(null, ['null']), text: 'null' },
    { name: '缺失才是 "undefined"', field: enumField(undefined, ['undefined'], false), text: 'undefined' },
    { name: 'true / false 各自成文本', field: enumField(true, ['true']), text: 'true' },
    { name: 'false 不与 true 混同', field: enumField(false, ['false']), text: 'false' },
    { name: '整数不带小数点', field: enumField(42, ['42']), text: '42' },
    { name: '浮点保留小数', field: enumField(3.5, ['3.5']), text: '3.5' },
    { name: '小指数用科学记数法', field: enumField(1e-7, ['1e-7']), text: '1e-7' },
    { name: '大数按 ECMAScript 阈值展开', field: enumField(1e20, ['100000000000000000000']), text: '100000000000000000000' },
    { name: '超过阈值才用科学记数法', field: enumField(1e21, ['1e+21']), text: '1e+21' },
    { name: '空字符串是合法值', field: enumField('', ['']), text: '' },
    { name: '数组按 join(",") 拼接', field: enumField([1, 2], ['1,2']), text: '1,2' },
    { name: '嵌套数组拍平成 join', field: enumField([[1, 2], [3]], ['1,2,3']), text: '1,2,3' },
    { name: '数组里的 null 元素变空串', field: enumField([null, 1], [',1']), text: ',1' },
    { name: '对象固定成 [object Object]', field: enumField({ a: 1 }, ['[object Object]']), text: '[object Object]' },
    { name: '对象数组逐个成 [object Object]', field: enumField([{}, {}], ['[object Object],[object Object]']), text: '[object Object],[object Object]' },
  ]

  for (const entry of cases) {
    it(`管理员：${entry.name} —— values 命中即合法可操作`, () => {
      // Given 一个 enum 字段，其 values 恰是 TS String(value) 的结果
      // When 校验卡片
      const verdict = validateCard(card({ fields: [entry.field] }))
      // Then JS 的 String() 就是那条文本，卡片合法且可操作（Swift 必须同样判）
      expect(String(entry.field.value)).toBe(entry.text)
      expect(verdict).toMatchObject({ valid: true, operable: true })
      expect(verdict.problems).toEqual([])
    })
  }

  it('管理员：null 不在 values 内时仍不可操作（null 是已知值，不是万能通行证）', () => {
    // Given values 里只有 "undefined"（旧 Swift 会误把 null 当成它）
    const field = enumField(null, ['undefined'])
    // When 校验
    const verdict = validateCard(card({ fields: [field] }))
    // Then TS 用的是 String(null) = "null"，因此不在集合里 ⇒ 不可操作
    expect(String(field.value)).toBe('null')
    expect(verdict.operable).toBe(false)
    expect(verdict.problems.join(' ')).toContain('不在 values 内')
  })

  it('管理员：未知 enum 值依旧不可操作（本组只改 null 的等价性，不放宽未知值）', () => {
    // Given 一个值越界的 enum 字段
    const verdict = validateCard(card({ fields: [enumField('halt', ['normal'])] }))
    // When / Then 仍然 fail-closed
    expect(verdict.valid).toBe(false)
    expect(verdict.operable).toBe(false)
    expect(verdict.problems.join(' ')).toContain('不在 values 内')
  })

  it('管理员：非字符串值不参与 maxValueChars（数组/对象再长也不因此判非法）', () => {
    // Given 一个很长的数组值，values 用 join 后的文本命中
    const long = Array.from({ length: 60 }, () => 'x'.repeat(10))
    const verdict = validateCard(card({ fields: [enumField(long, [long.join(',')])] }))
    // When / Then 长度上限只对 string 生效（TS 的 typeof 判据），命中即合法
    expect(long.join(',').length).toBeGreaterThan(CARD_LIMITS.maxValueChars)
    expect(verdict).toMatchObject({ valid: true, operable: true })
  })
})

describe('revision 是有限非负 Double（不得更窄）', () => {
  const revisionCase = (name: string, revision: number) =>
    it(`管理员：${name} —— 有限非负即合法，且不超过字节上限`, () => {
      // Given 一个合法卡片，只把 revision 换成极端但有限的值
      const candidate = card({ revision })
      // When 校验
      const verdict = validateCard(candidate)
      // Then 合法可操作（客户端不得因转换溢出而崩溃或收窄）
      expect(Number.isFinite(revision)).toBe(true)
      expect(verdict).toMatchObject({ valid: true, operable: true })
      expect(JSON.stringify(candidate)).toContain(String(revision))
    })

  revisionCase('1e100', 1e100)
  revisionCase('Double.greatestFiniteMagnitude', Number.MAX_VALUE)
  revisionCase('1e19（超出 Int64 的整数）', 1e19)
  revisionCase('小数 3.5', 3.5)

  it('管理员：非有限 revision 依旧非法（NaN / Infinity 不放宽）', () => {
    // Given 两个非有限 revision
    // When / Then 仍然非法
    expect(validateCard(card({ revision: Number.NaN })).valid).toBe(false)
    expect(validateCard(card({ revision: Number.POSITIVE_INFINITY })).valid).toBe(false)
  })
})

describe('字符串计量与数值域边界向量（向 TS 看齐，Swift 等价）', () => {
  it('管理员：UTF-16 码元边界（emoji、组合字符、代理对）按 .length 计数超限即非法', () => {
    // Given emoji、组合字符与代理对
    const emojiOver = card({ cardId: '😀'.repeat(33) })
    const combiningCardIdOver = card({ cardId: 'e\u0301'.repeat(33) })
    const combiningLabelOver = card({ fields: [{ key: 'k', label: 'e\u0301'.repeat(33), kind: 'text', value: 'v' }] })
    const combiningValueOver = card({ fields: [{ key: 'k', label: 'L', kind: 'text', value: 'e\u0301'.repeat(129) }] })
    const combiningFallbackOver = card({ fallbackText: 'e\u0301'.repeat(257) })
    const surrogateCardIdOver = card({ cardId: '\uD835\uDC00'.repeat(33) })
    const surrogateLabelOver = card({ fields: [{ key: 'k', label: '\uD835\uDC00'.repeat(33), kind: 'text', value: 'v' }] })
    const surrogateValueOver = card({ fields: [{ key: 'k', label: 'L', kind: 'text', value: '\uD835\uDC00'.repeat(129) }] })
    const surrogateFallbackOver = card({ fallbackText: '\uD835\uDC00'.repeat(257) })
    // When 校验超限卡片
    // Then 凡 UTF-16 码元超限者一律判非法
    expect(validateCard(emojiOver).valid).toBe(false)
    expect(validateCard(combiningCardIdOver).valid).toBe(false)
    expect(validateCard(combiningLabelOver).valid).toBe(false)
    expect(validateCard(combiningValueOver).valid).toBe(false)
    expect(validateCard(combiningFallbackOver).valid).toBe(false)
    expect(validateCard(surrogateCardIdOver).valid).toBe(false)
    expect(validateCard(surrogateLabelOver).valid).toBe(false)
    expect(validateCard(surrogateValueOver).valid).toBe(false)
    expect(validateCard(surrogateFallbackOver).valid).toBe(false)
  })

  it('管理员：空串与恰在上限边界（组合字符与代理对）合法', () => {
    // Given 边界卡片
    const emptyCardId = card({ cardId: '' })
    const whitespaceFallback = card({ fallbackText: '   ' })
    const exactCombining = card({
      cardId: 'e\u0301'.repeat(32),
      fallbackText: 'e\u0301'.repeat(256),
      fields: [{ key: 'k', label: 'e\u0301'.repeat(32), kind: 'text', value: 'e\u0301'.repeat(128) }],
    })
    const exactSurrogate = card({
      cardId: '\uD835\uDC00'.repeat(32),
      fallbackText: '\uD835\uDC00'.repeat(256),
      fields: [{ key: 'k', label: '\uD835\uDC00'.repeat(32), kind: 'text', value: '\uD835\uDC00'.repeat(128) }],
    })
    // When 校验
    // Then 空串非法、恰在上限合法
    expect(validateCard(emptyCardId).valid).toBe(false)
    expect(validateCard(whitespaceFallback).valid).toBe(false)
    expect(validateCard(exactCombining).valid).toBe(true)
    expect(validateCard(exactSurrogate).valid).toBe(true)
  })

  it('管理员：数值域边界（小数 revision 与小数 freshnessMs）被合法接受', () => {
    // Given 带有小数或极大有限数值的卡片
    const fractionalRev = card({ revision: 0.5 })
    const hugeRev = card({ revision: 1e19 })
    const fractionalFreshness = card({ freshnessMs: 1200.5 })
    // When 校验
    // Then 均判合法
    expect(validateCard(fractionalRev).valid).toBe(true)
    expect(validateCard(hugeRev).valid).toBe(true)
    expect(validateCard(fractionalFreshness).valid).toBe(true)
  })
})

