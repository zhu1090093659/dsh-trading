/**
 * mandate 行为与属性测试（P3 步骤 1）：纯函数，无 mock 无 sleep。
 * 属性测试用"逐字段 × 收紧/放宽"的穷举矩阵，而不是随机抽样——域很小，穷举更可信。
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateMandate,
  isMandateAtLeastAsStrict,
  isScopeSubset,
  mandateSigningPayload,
  revokeMandate,
  SCOPE_FIELDS,
  type MandateDoc,
  type MandateScope,
} from '../src/mandate.ts'
import { assertIntentHasNoQuotaFields, mandateLimits, INTENT_FIELDS } from '../src/intent.ts'

const baseScope: MandateScope = {
  markets: ['crypto'],
  symbols: ['BTC/USDT', 'ETH/USDT'],
  windows: ['asia', 'europe'],
  notionalMax: 10_000,
  positionNotionalMax: 50_000,
  deskNotionalMax: 200_000,
  maxOpenOrders: 20,
  leverageMax: 3,
  escalation: 'notify',
  revocation: 'allow-reduce-only',
}

const baseMandate: MandateDoc = {
  mandateVersion: 2,
  parentVersion: 1,
  issuedAtMs: 1_700_000_000_000,
  expiresAtMs: 1_700_000_000_000 + 30 * 24 * 3_600_000,
  scope: baseScope,
  signature: { keyId: 'operator-1', algorithm: 'ed25519', value: 'sig' },
}

describe('isSubset 属性：逐字段收紧/放宽矩阵', () => {
  it('管理员：每一个上限字段收紧都通过、放宽都拒绝（穷举 SCOPE_FIELDS 里的 upper）', () => {
    // Given 字段表里所有 upper 字段
    const uppers = Object.entries(SCOPE_FIELDS).filter(([, kind]) => kind.kind === 'upper').map(([name]) => name)
    // When 逐个收紧 1 个单位、再放宽 1 个单位
    // Then 收紧全通过、放宽全拒绝且原因里点名该字段
    for (const field of uppers) {
      const tighter = { ...baseScope, [field]: (baseScope as unknown as Record<string, number>)[field]! - 1 }
      const looser = { ...baseScope, [field]: (baseScope as unknown as Record<string, number>)[field]! + 1 }
      expect(isScopeSubset(tighter, baseScope).subset, field + ' 收紧应通过').toBe(true)
      const verdict = isScopeSubset(looser, baseScope)
      expect(verdict.subset, field + ' 放宽应拒绝').toBe(false)
      expect(verdict.widenings.join(' ')).toContain(field)
    }
    expect(uppers.length).toBeGreaterThan(0)
  })

  it('管理员：集合字段减少元素通过、新增元素拒绝', () => {
    // Given 三个集合字段
    const sets = Object.entries(SCOPE_FIELDS).filter(([, kind]) => kind.kind === 'set').map(([name]) => name)
    // When 各去掉一个元素、再加一个不存在的元素
    // Then 前者通过、后者拒绝
    for (const field of sets) {
      const current = (baseScope as unknown as Record<string, string[]>)[field]!
      const tighter = { ...baseScope, [field]: current.slice(0, 1) }
      const looser = { ...baseScope, [field]: [...current, 'NEW-THING'] }
      expect(isScopeSubset(tighter, baseScope).subset, field + ' 缩减应通过').toBe(true)
      expect(isScopeSubset(looser, baseScope).widenings.join(' ')).toContain('NEW-THING')
    }
  })

  it('管理员：阶梯字段（escalation）只能往上走，往下或未知取值都算放宽', () => {
    // Given 阶梯 none < notify < approve
    // When 从 notify 升到 approve、降到 none、改成未知值
    // Then 升级通过；降级与未知值都拒绝
    expect(isScopeSubset({ ...baseScope, escalation: 'approve' }, baseScope).subset).toBe(true)
    expect(isScopeSubset({ ...baseScope, escalation: 'none' }, baseScope).widenings.join(' ')).toContain('更松')
    expect(isScopeSubset({ ...baseScope, escalation: 'auto-approve' }, baseScope).widenings.join(' ')).toContain('未知取值')
  })

  it('管理员：唯一取值的 closed 字段（revocation）改成就地全平即放宽', () => {
    // Given revocation 只能是 allow-reduce-only
    // When 改成 flatten-all
    const verdict = isScopeSubset({ ...baseScope, revocation: 'flatten-all' }, baseScope)
    // Then 拒绝并说明不在允许集合
    expect(verdict.subset).toBe(false)
    expect(verdict.widenings.join(' ')).toContain('allow-reduce-only')
  })

  it('管理员：未知字段视为放宽（检查器不认识就不放行）', () => {
    // Given 新版多了一个 scope 字段
    const withUnknown = { ...baseScope, marginMode: 'cross' } as unknown as MandateScope
    // When 比较
    const verdict = isScopeSubset(withUnknown, baseScope)
    // Then 拒绝且原因写明"未知字段"
    expect(verdict.subset).toBe(false)
    expect(verdict.widenings.join(' ')).toContain('未知字段')
  })

  it('管理员：上一版没有的字段（新增字段）同样按放宽处理', () => {
    // Given 上一版缺一个已知字段
    const prevMissing = { ...baseScope } as Record<string, unknown>
    delete prevMissing.leverageMax
    // When 新版补上它
    const verdict = isScopeSubset(baseScope, prevMissing as unknown as MandateScope)
    // Then 拒绝且原因写明"新增"
    expect(verdict.subset).toBe(false)
    expect(verdict.widenings.join(' ')).toContain('新增')
  })

  it('管理员：单位换算边界——相等放行，多一个最小单位也拒绝（比较器不做容差/四舍五入）', () => {
    // Given 同一额度与"多了 0.01"的额度（典型的换算/舍入边界）
    // When 比较
    // Then 相等通过；+0.01 拒绝
    expect(isScopeSubset({ ...baseScope }, baseScope).subset).toBe(true)
    const epsilon = isScopeSubset({ ...baseScope, notionalMax: baseScope.notionalMax + 0.01 }, baseScope)
    expect(epsilon.subset).toBe(false)
    expect(epsilon.widenings.join(' ')).toContain('放宽')
  })

  it('管理员：非法上限（负数/NaN/Infinity）一律拒绝，不给"数值异常就默认放行"留路', () => {
    // Given 三种非法数值
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      // When 作为 notionalMax
      const verdict = isScopeSubset({ ...baseScope, notionalMax: bad }, baseScope)
      // Then 拒绝
      expect(verdict.subset, 'bad=' + String(bad)).toBe(false)
    }
  })
})

describe('mandate 版本链与有效期', () => {
  it('管理员：范围收紧 + 更早到期 + 版本递增 ⇒ 自动生效（无需重签）', () => {
    // Given 收紧的一版
    const tighter: MandateDoc = {
      ...baseMandate,
      mandateVersion: 3,
      parentVersion: 2,
      expiresAtMs: baseMandate.expiresAtMs - 3_600_000,
      scope: { ...baseScope, notionalMax: 5_000 },
    }
    // When 比较
    const verdict = isMandateAtLeastAsStrict(tighter, baseMandate)
    // Then 通过
    expect(verdict).toEqual({ subset: true, widenings: [] })
  })

  it('管理员：延长有效期、抬高额度、版本链断裂三种都属于放宽，逐条给出原因', () => {
    // Given 三种放宽
    const longer: MandateDoc = { ...baseMandate, mandateVersion: 3, parentVersion: 2, expiresAtMs: baseMandate.expiresAtMs + 1 }
    const richer: MandateDoc = { ...baseMandate, mandateVersion: 3, parentVersion: 2, scope: { ...baseScope, deskNotionalMax: baseScope.deskNotionalMax * 2 } }
    const broken: MandateDoc = { ...baseMandate, mandateVersion: 3, parentVersion: 0 }
    // When/Then 分别拒绝并点名
    expect(isMandateAtLeastAsStrict(longer, baseMandate).widenings.join(' ')).toContain('延长有效期')
    expect(isMandateAtLeastAsStrict(richer, baseMandate).widenings.join(' ')).toContain('deskNotionalMax')
    expect(isMandateAtLeastAsStrict(broken, baseMandate).widenings.join(' ')).toContain('版本链断裂')
  })

  it('管理员：到期边界——有效期内可开仓，到点那一刻起降为 reduce_only 但仍可减仓', () => {
    // Given 一份 mandate
    // When 在到期前一毫秒与到期时刻各判一次
    const before = evaluateMandate(baseMandate, baseMandate.expiresAtMs - 1)
    const at = evaluateMandate(baseMandate, baseMandate.expiresAtMs)
    // Then 前者 active 可开仓；后者 expired-reduce-only、不可开仓但可减仓
    expect(before).toMatchObject({ state: 'active', mayOpenNewRisk: true, mayReduce: true })
    expect(at).toMatchObject({ state: 'expired-reduce-only', mayOpenNewRisk: false, mayReduce: true })
  })
})

describe('撤销语义（已裁决：allow-reduce-only，不做"撤销即全平"）', () => {
  it('管理员：撤销后不可开新仓、仍可减仓，且原因写明不平仓', () => {
    // Given 一份 mandate
    // When 撤销
    const effect = revokeMandate(baseMandate)
    // Then reduce_only，且明确"不强制平仓"
    expect(effect).toMatchObject({ state: 'revoked-reduce-only', mayOpenNewRisk: false, mayReduce: true })
    expect(effect.reason).toContain('not force-closed')
  })
})

describe('意图不变量：额度不可表达', () => {
  it('管理员：合法意图通过；带额度字段的意图被拒（不可表达即不可自我扩权）', () => {
    // Given 一个合法意图与若干试图夹带额度的意图
    const legit = { symbol: 'BTC/USDT', side: 'buy', type: 'limit', quantity: 0.01, limitPrice: 60_000, clientOrderId: 'c1', reason: 'breakout' }
    // When 逐个断言
    // Then 合法通过；带 notionalMax / budget / maxNotional 的被拒
    expect(() => assertIntentHasNoQuotaFields(legit)).not.toThrow()
    for (const extra of [{ notionalMax: 1e9 }, { budget: 1e9 }, { maxNotional: 1e9 }]) {
      expect(() => assertIntentHasNoQuotaFields({ ...legit, ...extra }), JSON.stringify(extra)).toThrowError(/quota fields/)
    }
    // 未知但非额度类的字段同样被拒（白名单语义）
    expect(() => assertIntentHasNoQuotaFields({ ...legit, whatever: 1 })).toThrowError(/unknown fields/)
  })

  it('管理员：额度只能从 mandate 读，且读出来的是 mandate 的值（没有写回路径）', () => {
    // Given 一份 mandate
    // When 读额度
    const limits = mandateLimits(baseMandate)
    // Then 与 mandate 一致，且导出面里没有 setter/写函数
    expect(limits).toEqual({ notionalMax: 10_000, positionNotionalMax: 50_000, deskNotionalMax: 200_000, maxOpenOrders: 20, leverageMax: 3 })
    expect(INTENT_FIELDS).not.toContain('notionalMax')
  })
})

describe('mandate JSON 样例与签名载荷', () => {
  it('管理员：样例 JSON 可往返，且签名载荷与键序无关（canonicalize 契约）', () => {
    // Given 一份 mandate 的两种键序写法
    const json = JSON.stringify(baseMandate)
    // 注意：这里**不能**带 signature —— as 只是类型断言，运行期该键仍在，会让载荷不等
    const reordered = { scope: baseScope, expiresAtMs: baseMandate.expiresAtMs, issuedAtMs: baseMandate.issuedAtMs, parentVersion: baseMandate.parentVersion, mandateVersion: baseMandate.mandateVersion }
    // When 解析与求签名载荷
    const parsed = JSON.parse(json) as MandateDoc
    // Then 往返一致，且两种键序得到同一份 canonical 载荷
    expect(parsed).toEqual(baseMandate)
    const { signature, ...unsigned } = baseMandate
    expect(signature.algorithm).toBe('ed25519')
    expect(mandateSigningPayload(unsigned)).toBe(mandateSigningPayload(reordered as Omit<MandateDoc, 'signature'>))
  })
})
