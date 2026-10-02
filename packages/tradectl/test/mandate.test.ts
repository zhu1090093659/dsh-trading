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
  MANDATE_LIMIT_FIELDS,
  openRiskWithinMandate,
  resolveMandateLimits,
  revokeMandate,
  SCOPE_FIELDS,
  type MandateDoc,
  type MandateScope,
  type OpenRiskExposure,
  type OpenRiskProposal,
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

describe('额度上限：可执行判据（缺省即拒绝）', () => {
  const withinValidity = baseMandate.issuedAtMs + 1
  const exposure = (over: Partial<OpenRiskExposure> = {}): OpenRiskExposure => ({ positionNotional: 0, deskNotional: 0, openOrders: 0, leverage: 1, ...over })
  const openProposal = (notional: number, over: Partial<OpenRiskProposal> = {}): OpenRiskProposal => ({ kind: 'open', symbol: 'BTC/USDT', quantity: 1, notional, ...over })
  const judge = (mandate: MandateDoc, proposal: OpenRiskProposal, atMs = withinValidity, snapshot = exposure()) =>
    openRiskWithinMandate({ mandate, atMs, proposal, exposure: snapshot })
  /** 造一份"某个上限字段没被写进 scope"的 mandate（模拟漏签）。 */
  const withoutField = (field: keyof MandateScope): MandateDoc => {
    const scope: Record<string, unknown> = { ...baseScope }
    delete scope[field]
    return { ...baseMandate, scope: scope as unknown as MandateScope }
  }

  it('管理员：上限内放行、恰好等于上限放行、超一档拒绝并点名 notionalMax', () => {
    // Given 一份已声明上限的 mandate（单笔 notionalMax = 10_000）
    // When 分别判 9_000 / 10_000 / 10_000.01 三档
    const inside = judge(baseMandate, openProposal(9_000))
    const exactly = judge(baseMandate, openProposal(10_000))
    const over = judge(baseMandate, openProposal(10_000.01))
    // Then 前两档放行、超一档拒绝且原因指向具体限额
    expect(inside).toMatchObject({ allowed: true, limitHit: 'none' })
    expect(exactly).toMatchObject({ allowed: true, limitHit: 'none' })
    expect(over).toMatchObject({ allowed: false, limitHit: 'notionalMax' })
    expect(over.reason).toContain('quote-currency')
  })

  it('管理员：累计敞口上限（持仓/desk/挂单数）同样由同一判定挡下', () => {
    // Given 三种已经贴近上限的敞口
    const crowdedPosition = judge(baseMandate, openProposal(1_000), withinValidity, exposure({ positionNotional: 49_500 }))
    const crowdedDesk = judge(baseMandate, openProposal(1_000), withinValidity, exposure({ deskNotional: 199_500 }))
    const crowdedOrders = judge(baseMandate, openProposal(1_000), withinValidity, exposure({ openOrders: 20 }))
    // When/Then 各自命中自己的那条限额，不会串味
    expect(crowdedPosition).toMatchObject({ allowed: false, limitHit: 'positionNotionalMax' })
    expect(crowdedDesk).toMatchObject({ allowed: false, limitHit: 'deskNotionalMax' })
    expect(crowdedOrders).toMatchObject({ allowed: false, limitHit: 'maxOpenOrders' })
  })

  it('管理员：上限缺失即拒绝开新仓（缺省语义是拒绝，不是无限）', () => {
    // Given 一份没写 notionalMax 的 mandate：金额本身很小、时间也在有效期内
    const incomplete = withoutField('notionalMax')
    // When 判定与解析
    const verdict = judge(incomplete, openProposal(100))
    const resolution = resolveMandateLimits(incomplete)
    // Then 拒绝、点名缺了哪个字段，且解析结果明确标成未声明
    expect(verdict).toMatchObject({ allowed: false, limitHit: 'no-declared-limit' })
    expect(verdict.reason).toContain('notionalMax')
    expect(verdict.reason).toContain('拒绝开新仓')
    expect(resolution).toMatchObject({ declared: false, missing: ['notionalMax'] })
  })

  it('管理员：上限为 0 是显式声明（拒绝任何正数新增），与"没写"区分开', () => {
    // Given 一份把 notionalMax 明写成 0 的 mandate
    const zeroed: MandateDoc = { ...baseMandate, scope: { ...baseScope, notionalMax: 0 } }
    // When 判一单最小单位的开仓
    const verdict = judge(zeroed, openProposal(0.01))
    // Then 上限是"声明过"的（不是缺失），但正数新增一律被拒
    expect(resolveMandateLimits(zeroed)).toMatchObject({ declared: true })
    expect(verdict).toMatchObject({ allowed: false, limitHit: 'notionalMax' })
  })

  it('管理员：非法上限（Infinity/NaN/负数/非数字）按未声明处理 ⇒ 拒绝', () => {
    // Given 四种"看起来像上限"的写法，其中 Infinity 正是"无限"的写法
    const bad: readonly (readonly [string, unknown])[] = [['Infinity', Number.POSITIVE_INFINITY], ['NaN', Number.NaN], ['负数', -1], ['字符串', '10000']]
    // When 逐个判定
    // Then 一律拒绝并点名该字段（Infinity 不得被读成"无上限"）
    for (const [label, value] of bad) {
      const mandate: MandateDoc = { ...baseMandate, scope: { ...baseScope, notionalMax: value } as MandateScope }
      const verdict = judge(mandate, openProposal(100))
      expect(verdict.allowed, label).toBe(false)
      expect(verdict.limitHit, label).toBe('no-declared-limit')
      expect(resolveMandateLimits(mandate).declared, label).toBe(false)
    }
  })

  it('管理员：平仓/降风险不受上限影响（上限缺失且已过期也照放）', () => {
    // Given 一份既没声明上限、又已经到期的 mandate
    const expiredIncomplete = withoutField('deskNotionalMax')
    const afterExpiry = baseMandate.expiresAtMs + 1
    // When 分别判平仓与持有
    const reduce = judge(expiredIncomplete, openProposal(1_000_000, { kind: 'reduce' }), afterExpiry)
    const hold = judge(expiredIncomplete, openProposal(1_000_000, { kind: 'hold' }), afterExpiry)
    // Then 两者都放行——只约束新增风险，撤销/到期不得被读成把人锁在仓位里
    expect(reduce).toMatchObject({ allowed: true, limitHit: 'none' })
    expect(hold).toMatchObject({ allowed: true, limitHit: 'none' })
  })

  it('管理员：到期与撤销只挡开新仓（时间事实仍归 evaluateMandate 判）', () => {
    // Given 一份上限齐全的 mandate 与两个越界时刻
    const open = openProposal(100)
    // When 在到期时刻判定开仓，再对撤销后的语义取一次
    const atExpiry = judge(baseMandate, open, baseMandate.expiresAtMs)
    // Then 开仓被拒且原因是"mandate 不在有效期"，而不是额度
    expect(atExpiry).toMatchObject({ allowed: false, limitHit: 'mandate-not-active' })
    expect(revokeMandate(baseMandate).mayOpenNewRisk).toBe(false)
    expect(revokeMandate(baseMandate).mayReduce).toBe(true)
  })

  it('管理员：判定输入不可信（NaN/负数敞口）即拒绝，不给静默放行留路', () => {
    // Given 一个 NaN 名义额与一个负数持仓敞口
    const nanNotional = judge(baseMandate, openProposal(Number.NaN))
    const negativeExposure = judge(baseMandate, openProposal(100), withinValidity, exposure({ positionNotional: -1 }))
    // When/Then 都拒绝并标成输入问题（NaN 会让所有比较为假，正是要挡的形态）
    expect(nanNotional).toMatchObject({ allowed: false, limitHit: 'invalid-input' })
    expect(negativeExposure).toMatchObject({ allowed: false, limitHit: 'invalid-input' })
  })

  it('管理员：限额字段集与判定器读的字段集是同一张表（新增 upper 字段自动进入必须声明集合）', () => {
    // Given scope 表里的 upper 字段与判定器实际读的字段
    const uppers = Object.entries(SCOPE_FIELDS).filter(([, kind]) => kind.kind === 'upper').map(([name]) => name)
    const readByJudge = Object.keys(mandateLimits(baseMandate))
    // When 比较两个集合
    // Then 完全一致（少一个就是一条真空判定），且金额上限的单位口径是计价货币
    expect([...MANDATE_LIMIT_FIELDS].sort()).toEqual([...uppers].sort())
    expect([...MANDATE_LIMIT_FIELDS].sort()).toEqual([...readByJudge].sort())
    expect(SCOPE_FIELDS.notionalMax).toEqual({ kind: 'upper', unit: 'quote-currency' })
    expect(SCOPE_FIELDS.positionNotionalMax).toEqual({ kind: 'upper', unit: 'quote-currency' })
    expect(SCOPE_FIELDS.deskNotionalMax).toEqual({ kind: 'upper', unit: 'quote-currency' })
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
