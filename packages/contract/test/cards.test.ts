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
