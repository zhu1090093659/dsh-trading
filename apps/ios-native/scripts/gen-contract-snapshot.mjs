#!/usr/bin/env node
/**
 * 契约快照生成器（见 README §4「契约防漂移机检」）—— **TS 契约是唯一权威**。
 *
 * 从 @dshtrading/contract 的**运行期真值**导出：常量表 + 封闭枚举 + 查表 + **行为向量**
 * （输入 → TS 的权威输出），写入 Generated/contract-snapshot.json（生成物，不入库）。
 * Swift 侧的 DshTradingContractTests 逐字段、逐向量断言与它一致；不一致即测试红。
 *
 * 夹具缺失必须让测试 FAIL —— 所以本脚本是唯一的产生者，快照缺失时测试会打印本命令。
 *
 * 用法：node scripts/gen-contract-snapshot.mjs
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const repoRoot = resolve(appRoot, '../..')
const contractSrc = resolve(repoRoot, 'packages/contract/src/core.ts')
const contractPkg = resolve(repoRoot, 'packages/contract/package.json')
const C = await import(contractSrc)

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

// ---------------------------------------------------------------- 行为向量夹具

const okCard = (over = {}) => ({
  cardId: 'card-1',
  cardType: 'risk-state',
  revision: 1,
  fallbackText: 'desk normal',
  fields: [],
  actions: [],
  ...over,
})

const field = (over = {}) => ({ key: 'k', label: '标签', kind: 'text', value: 'v', ...over })
const action = (over = {}) => ({ kind: 'ack', label: '确认', ...over })

// ---- negotiateVersion
const negotiateVersion = [
  { name: 'current-major-no-server-caps', input: { clientMajor: 1, clientCaps: [] } },
  { name: 'caps-intersection', input: { clientMajor: 1, clientCaps: ['action:ack'], serverCaps: ['action:ack', 'cards:display'] } },
  { name: 'client-older-within-window', input: { clientMajor: 0, clientCaps: [] } },
  { name: 'client-exactly-at-window-edge', input: { clientMajor: -1, clientCaps: [] } },
  { name: 'client-beyond-window', input: { clientMajor: -2, clientCaps: [] } },
  { name: 'client-newer-than-server', input: { clientMajor: 2, clientCaps: [] } },
  { name: 'missing-required-cap', input: { clientMajor: 1, clientCaps: ['a'], requiredCaps: ['a', 'b', 'c'] } },
  { name: 'server-major-3-with-client-1', input: { clientMajor: 1, serverMajor: 3, clientCaps: [] } },
  { name: 'duplicate-server-caps-preserved', input: { clientMajor: 1, clientCaps: ['x'], serverCaps: ['x', 'x', 'y'] } },
].map((entry) => {
  const verdict = C.negotiateVersion(entry.input)
  const expected = verdict.ok
    ? { kind: 'ok', caps: verdict.caps, downgraded: verdict.downgraded }
    : { kind: 'rejected', status: verdict.status, code: verdict.code, message: verdict.message }
  return { ...entry, expected }
})

// ---- validateCard
const validateCardCases = []
const addCard = (name, card, limits) =>
  validateCardCases.push({ name, card, limits: limits ?? { ...C.CARD_LIMITS } })

addCard('minimal-valid', okCard())
addCard('field-text-ok', okCard({ fields: [field({ key: 'age', label: '年龄', kind: 'timestamp', value: '120' })] }))
addCard('unknown-card-type', okCard({ cardType: 'future-card' }))
addCard('unknown-field-kind', okCard({ fields: [field({ kind: 'future-kind' })] }))
addCard('enum-ok', okCard({ fields: [field({ key: 'level', label: '档', kind: 'enum', value: 'normal', values: ['normal', 'caution'] })] }))
addCard('enum-missing-values', okCard({ fields: [field({ key: 'level', label: '档', kind: 'enum', value: 'normal' })] }))
addCard('enum-value-not-allowed', okCard({ fields: [field({ key: 'level', label: '档', kind: 'enum', value: 'halt', values: ['normal'] })] }))
addCard(
  'enum-too-many-values',
  okCard({ fields: [field({ key: 'level', label: '档', kind: 'enum', value: 'v0', values: Array.from({ length: 25 }, (_, i) => 'v' + String(i)) })] }),
)
addCard('control-without-confirm', okCard({ actions: [action({ kind: 'kill', label: 'Kill' })] }))
addCard('control-with-confirm', okCard({ actions: [action({ kind: 'kill', label: 'Kill', confirm: true })] }))
addCard('command-without-confirm', okCard({ actions: [action({ kind: 'approve', label: 'Approve' })] }))
addCard('too-many-fields', okCard({ fields: Array.from({ length: 25 }, (_, i) => field({ key: 'f' + String(i) })) }))
addCard('too-many-actions', okCard({ actions: Array.from({ length: 7 }, () => action()) }))
addCard('fallback-empty', okCard({ fallbackText: '   ' }))
addCard('fallback-too-long', okCard({ fallbackText: 'x'.repeat(513) }))
addCard('label-too-long', okCard({ fields: [field({ label: 'x'.repeat(65) })] }))
addCard('value-too-long', okCard({ fields: [field({ value: 'x'.repeat(257) })] }))
addCard('params-too-many', okCard({ actions: [action({ params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['p' + String(i), 'v'])) })] }))
addCard('unknown-action-kind', okCard({ actions: [action({ kind: 'future-action' })] }))
addCard('unknown-action-kind-not-in-caps', okCard({ actions: [action({ kind: 'future-action' })] }))
addCard('custom-limit-max-fields-2', okCard({ fields: [field({ key: 'a' }), field({ key: 'b' }), field({ key: 'c' })] }), { ...C.CARD_LIMITS, maxFields: 2 })
addCard('revision-negative', okCard({ revision: -1 }))
// 小数 revision：TS 只要求"有限非负数"，**不要求整数**（Lead 裁决 2026-10-02）。
// Swift 侧若用 Int 解码，服务端真发 3.5 时整页解码失败 ⇒ 与驾驶舱分歧；这条向量锁住"必须被接受"。
addCard('revision-fractional-accepted', okCard({ revision: 3.5 }))
addCard('revision-zero-accepted', okCard({ revision: 0 }))
addCard('freshness-does-not-affect-validity', okCard({ freshnessMs: 1200 }))

// 非字符串标量（Lead 裁决 #2）：CardField.value 在 TS 里是 unknown，在 Swift 侧被冻结成 String?。
// 把 number / bool / 大整数 / 对象各放一条进向量，让"收窄"这件事**可机检**而不是只写在说明里：
// TS 只在 typeof value === 'string' 时查 maxValueChars，我们对所有标量查文本长度；
// 非标量留 nil 交给判定。下面这些用例就是两侧在可达范围内等价的证据。
addCard('value-number-scalar', okCard({ fields: [field({ key: 'qty', label: '数量', kind: 'number', value: 42 })] }))
addCard('value-boolean-scalar', okCard({ fields: [field({ key: 'flag', label: '开关', kind: 'bool', value: true })] }))
addCard('value-huge-integer-scalar', okCard({ fields: [field({ key: 'big', label: '大数', kind: 'number', value: 123456789012345678901234567890 })] }))
// **String(field.value) 的转换语义**（独立审查 C6，Lead 复核为真）：Swift 旧实现把 JSON null 与
// "字段缺失"都解成 nil，于是 {value: null, values: ["null"]} 被判成"值 undefined 不在 values 内"而
// 不可操作 —— 一份 TS 判 valid+operable 的卡片在 iOS 端变成不可操作，且展示值也丢了。
// 下面每条都以 TS 的 String() 为权威，Swift 必须逐条复现（含数组 join、对象 [object Object]）。
addCard('enum-null-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: null, values: ['null'] })] }))
addCard('enum-null-value-not-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: null, values: ['undefined'] })] }))
addCard('enum-absent-value-in-values-undefined', okCard({ fields: [{ key: 'mode', label: '模式', kind: 'enum', values: ['undefined'] }] }))
addCard('enum-true-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: true, values: ['true'] })] }))
addCard('enum-false-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: false, values: ['false'] })] }))
addCard('enum-int-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: 42, values: ['42'] })] }))
addCard('enum-float-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: 3.5, values: ['3.5'] })] }))
addCard('enum-small-exponent-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: 1e-7, values: ['1e-7'] })] }))
addCard('enum-expanded-large-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: 1e20, values: ['100000000000000000000'] })] }))
addCard('enum-scientific-large-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: 1e21, values: ['1e+21'] })] }))
addCard('enum-empty-string-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: '', values: [''] })] }))
addCard('enum-array-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: [1, 2], values: ['1,2'] })] }))
addCard('enum-nested-array-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: [[1, 2], [3]], values: ['1,2,3'] })] }))
addCard('enum-array-with-null-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: [null, 1], values: [',1'] })] }))
addCard('enum-object-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: { a: 1 }, values: ['[object Object]'] })] }))
addCard('enum-array-of-objects-value-in-values', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: [{}, {}], values: ['[object Object],[object Object]'] })] }))
// 长度上限只对 **string** 生效（TS 的 typeof 判据）：数组值再长也不因此判非法。
const longArrayValue = Array.from({ length: 60 }, () => 'x'.repeat(10))
addCard('enum-long-array-value-not-length-limited', okCard({ fields: [field({ key: 'mode', label: '模式', kind: 'enum', value: longArrayValue, values: [longArrayValue.join(',')] })] }))
// revision 是**有限非负 Double**：1e100 / Number.MAX_VALUE / 1e19 都合法（Swift 不得因 Int 转换溢出而 trap 或收窄）。
addCard('revision-huge-finite-accepted', okCard({ revision: 1e100 }))
addCard('revision-greatest-finite-accepted', okCard({ revision: Number.MAX_VALUE }))
addCard('revision-beyond-int64-accepted', okCard({ revision: 1e19 }))
addCard('enum-number-value-in-values', okCard({ fields: [field({ key: 'qty', label: '数量', kind: 'enum', value: 1, values: ['1', '2'] })] }))
addCard('enum-boolean-value-in-values', okCard({ fields: [field({ key: 'flag', label: '开关', kind: 'enum', value: false, values: ['true', 'false'] })] }))
addCard('enum-object-value-is-not-in-values', okCard({ fields: [field({ key: 'obj', label: '对象', kind: 'enum', value: { a: 1 }, values: ['a'] })] }))
addCard('action-params-non-string-values', okCard({ actions: [action({ kind: 'approve', label: '批准', params: { amount: 12.5, dryRun: true } })] }))

// **UTF-16 边界**：TS 的 String.length 数码元，Swift 的 String.count 数字素簇。
// 一个 emoji 在 TS 算 2、Swift 算 1 —— 用错单位时"超限"会在 emoji 上漏判。这几条向量就是判据。
const emoji = '😀'
const combining = 'e\u0301' // e + combining acute accent (2 UTF-16 code units, 1 grapheme cluster)
const surrogate = '\uD835\uDC00' // Mathematical Bold Capital A U+1D400 (2 UTF-16 code units, 1 grapheme cluster)

addCard('fallback-emoji-at-limit', okCard({ fallbackText: emoji.repeat(256) }))          // TS length 512
addCard('fallback-emoji-over-limit', okCard({ fallbackText: emoji.repeat(257) }))         // TS length 514 > 512
addCard('cardid-emoji-over-limit', okCard({ cardId: emoji.repeat(33) }))                  // TS length 66 > 64
addCard('label-emoji-over-limit', okCard({ fields: [field({ label: emoji.repeat(33) })] })) // TS length 66 > 64
addCard('value-emoji-over-limit', okCard({ fields: [field({ value: emoji.repeat(129) })] })) // TS length 258 > 256

// 组合字符与代理对边界向量
addCard('cardid-combining-over-limit', okCard({ cardId: combining.repeat(33) }))
addCard('cardid-surrogate-over-limit', okCard({ cardId: surrogate.repeat(33) }))
addCard('fallback-combining-over-limit', okCard({ fallbackText: combining.repeat(257) }))
addCard('fallback-surrogate-over-limit', okCard({ fallbackText: surrogate.repeat(257) }))
addCard('label-combining-over-limit', okCard({ fields: [field({ label: combining.repeat(33) })] }))
addCard('label-surrogate-over-limit', okCard({ fields: [field({ label: surrogate.repeat(33) })] }))
addCard('value-combining-over-limit', okCard({ fields: [field({ value: combining.repeat(129) })] }))
addCard('value-surrogate-over-limit', okCard({ fields: [field({ value: surrogate.repeat(129) })] }))

// 空串与恰在上限边界
addCard('cardid-empty', okCard({ cardId: '' }))
addCard('fallback-empty-string', okCard({ fallbackText: '' }))
addCard('exact-limits-combining', okCard({
  cardId: combining.repeat(32),
  fallbackText: combining.repeat(256),
  fields: [field({ key: 'k', label: combining.repeat(32), value: combining.repeat(128) })],
}))
addCard('exact-limits-surrogates', okCard({
  cardId: surrogate.repeat(32),
  fallbackText: surrogate.repeat(256),
  fields: [field({ key: 'k', label: surrogate.repeat(32), value: surrogate.repeat(128) })],
}))

// 数值域边界：小数与大数 freshnessMs，小数 revision
addCard('freshness-fractional-accepted', okCard({ freshnessMs: 1200.5 }))
addCard('freshness-large-number-accepted', okCard({ freshnessMs: 1e12 }))
addCard('revision-fractional-small', okCard({ revision: 0.25 }))
addCard('ascii-at-every-string-limit', okCard({
  cardId: 'c'.repeat(64),
  fallbackText: 'f'.repeat(512),
  fields: [field({ key: 'k', label: 'l'.repeat(64), value: 'v'.repeat(256) })],
}))

// 卡片体积棘轮：**键序按字母排列**，这样 JS JSON.stringify 与 Swift 的 .sortedKeys 序列化字节一致，
// 两侧的 maxCardBytes 判定才能真正对齐（这是唯一一条字节级向量）。
const byteCard = { actions: [], cardId: 'c1', cardType: 'risk-state', fallbackText: 'ok', fields: [], revision: 1 }
const byteCardBytes = Buffer.byteLength(JSON.stringify(byteCard), 'utf8')
addCard('byte-limit-exactly-at-limit', byteCard, { ...C.CARD_LIMITS, maxCardBytes: byteCardBytes })
addCard('byte-limit-one-over', byteCard, { ...C.CARD_LIMITS, maxCardBytes: byteCardBytes - 1 })

const validateCard = validateCardCases.map((entry) => {
  const verdict = C.validateCard(entry.card, entry.limits)
  return {
    name: entry.name,
    card: entry.card,
    limits: entry.limits,
    expected: { valid: verdict.valid, operable: verdict.operable, problemCount: verdict.problems.length },
    problems: verdict.problems,
  }
})

// ---- renderableActions
const renderableActions = [
  { name: 'only-action-in-caps', card: okCard({ actions: [action({ kind: 'kill', label: 'Kill', confirm: true }), action({ kind: 'ack' })] }), clientCaps: ['action:kill'] },
  { name: 'wildcard-caps', card: okCard({ actions: [action({ kind: 'kill', label: 'Kill', confirm: true }), action({ kind: 'ack' })] }), clientCaps: ['action:*'] },
  { name: 'no-caps', card: okCard({ actions: [action({ kind: 'ack' })] }), clientCaps: [] },
  { name: 'unknown-card-type-disables-all', card: okCard({ cardType: 'future-card', actions: [action({ kind: 'ack' })] }), clientCaps: ['action:*'] },
  { name: 'unknown-action-kind-disables-all', card: okCard({ actions: [action({ kind: 'future-action' }), action({ kind: 'ack' })] }), clientCaps: ['action:*'] },
].map((entry) => ({
  ...entry,
  limits: { ...C.CARD_LIMITS },
  expected: C.renderableActions(entry.card, entry.clientCaps, entry.limits).map((item) => item.kind),
}))

// ---- fallbackFor
const fallbackFor = [
  { name: 'valid-card', card: okCard() },
  { name: 'unknown-card-type', card: okCard({ cardType: 'future-card' }) },
  { name: 'invalid-and-empty-fallback', card: okCard({ cardType: 'future-card', fallbackText: '  ' }) },
  { name: 'too-long-fallback', card: okCard({ fallbackText: 'x'.repeat(513) }) },
].map((entry) => ({ name: entry.name, card: entry.card, expected: C.fallbackFor(entry.card) }))

// ---- 陈旧度与离线视图
const budget = { freshMs: 1000, staleMs: 5000, ttlMs: 20000 }
const snapshotAt = (atMs) => ({ data: 'payload', atMs, sourceId: 'local' })
const stalenessInputs = [
  { name: 'no-snapshot', snapshot: null, nowMs: 10000, budget },
  { name: 'invalid-budget', snapshot: snapshotAt(0), nowMs: 10, budget: { freshMs: 5000, staleMs: 1000, ttlMs: 20000 } },
  { name: 'age-0-fresh', snapshot: snapshotAt(10000), nowMs: 10000, budget },
  { name: 'age-999-fresh', snapshot: snapshotAt(0), nowMs: 999, budget },
  { name: 'age-1000-aging', snapshot: snapshotAt(0), nowMs: 1000, budget },
  { name: 'age-4999-aging', snapshot: snapshotAt(0), nowMs: 4999, budget },
  { name: 'age-5000-stale', snapshot: snapshotAt(0), nowMs: 5000, budget },
  { name: 'age-19999-stale', snapshot: snapshotAt(0), nowMs: 19999, budget },
  { name: 'age-20000-expired', snapshot: snapshotAt(0), nowMs: 20000, budget },
  { name: 'future-timestamp-clamps-to-fresh', snapshot: snapshotAt(99999), nowMs: 1000, budget },
]
const stalenessOf = stalenessInputs.map((entry) => ({ ...entry, expected: C.stalenessOf(entry.snapshot ?? undefined, entry.nowMs, entry.budget) }))
const offlineView = stalenessInputs.map((entry) => {
  const view = C.offlineView(entry.snapshot ?? undefined, entry.nowMs, entry.budget)
  const expected =
    view.kind === 'data'
      ? { kind: 'data', data: view.data, staleness: view.staleness, badge: view.badge ?? null }
      : { kind: 'notice', staleness: view.staleness, message: view.message }
  return { ...entry, expected }
})

// ---- parseDeeplink
const parseDeeplink = [
  'dshtrading://escalations/esc-1',
  'dshtrading://decisions',
  'dshtrading://positions/p%2F1',
  'dshtrading://unknown/x',
  'https://example.com/escalations',
  'dshtrading://',
  'dshtrading:///control',
].map((url) => ({ url, expected: C.parseDeeplink(url) }))

// ---- grantableByDefault / parseCaps / formatCaps / requiresBiometric
const grantableByDefault = [[], ['read'], ['read', 'control'], ['command'], ['control'], ['bogus', 'control'], ['control', 'command']].map((requested) => ({
  requested,
  expected: C.grantableByDefault(requested),
}))
const parseCaps = [null, '', '   ', 'a', ' a , b ,a', 'z, a', 'x-dsht-caps, caps'].map((input) => ({ input, expected: C.parseCaps(input) }))
const formatCaps = [[], ['b', 'a', 'b'], ['action:ack']].map((input) => ({ input, expected: C.formatCaps(input) }))
const requiresBiometric = []
for (const kind of C.ACTION_KINDS) {
  for (const platform of ['web', 'mobile']) {
    requiresBiometric.push({ action: kind, platform, expected: C.requiresBiometric(kind, platform) })
  }
}

// ---- sourceGuard（声明式逐步重放；每步带 expected）
const datum = (id, sourceId, value) => ({ id, sourceId, value })
const sourceGuard = [
  {
    name: 'switch-then-reconcile-matching-counts',
    activeSourceId: 'local',
    ops: [
      { op: 'sourceId', expected: 'local' },
      { op: 'writable', expected: true },
      { op: 'switching', expected: false },
      { op: 'viewOf', data: [datum('a', 'local', '1'), datum('b', 'remote', '2'), datum('c', 'local', '3')], expectedIds: ['a', 'c'] },
      { op: 'switchTo', sourceId: 'remote' },
      { op: 'switching', expected: true },
      { op: 'writable', expected: false },
      // 切换期仍然只显示旧源（跨源永不混显）
      { op: 'viewOf', data: [datum('a', 'local', '1'), datum('b', 'remote', '2')], expectedIds: ['a'] },
      { op: 'reconcile', active: [datum('a', 'local', '1')], incoming: [datum('b', 'remote', '2')], expected: { ok: true, activeCount: 1, incomingCount: 1 } },
      { op: 'sourceId', expected: 'remote' },
      { op: 'writable', expected: true },
      { op: 'viewOf', data: [datum('a', 'local', '1'), datum('b', 'remote', '2')], expectedIds: ['b'] },
    ],
  },
  {
    name: 'reconcile-count-mismatch-stays-read-only',
    activeSourceId: 'local',
    ops: [
      { op: 'switchTo', sourceId: 'remote' },
      { op: 'reconcile', active: [datum('a', 'local', '1'), datum('c', 'local', '3')], incoming: [datum('b', 'remote', '2')], expected: { ok: false, activeCount: 2, incomingCount: 1, reason: '条数不一致（2 vs 1），保持只读' } },
      { op: 'sourceId', expected: 'local' },
      { op: 'writable', expected: false },
      { op: 'switching', expected: true },
    ],
  },
  {
    name: 'same-source-is-not-a-switch',
    activeSourceId: 'local',
    ops: [
      { op: 'switchTo', sourceId: 'local' },
      { op: 'switching', expected: false },
      { op: 'writable', expected: true },
    ],
  },
].map((scenario) => {
  const guard = C.createSourceGuard({ activeSourceId: scenario.activeSourceId })
  const ops = scenario.ops.map((step) => {
    if (step.op === 'sourceId') return { ...step, expected: guard.sourceId() }
    if (step.op === 'writable') return { ...step, expected: guard.writable() }
    if (step.op === 'switching') return { ...step, expected: guard.switching() }
    if (step.op === 'viewOf') return { ...step, expectedIds: guard.viewOf(step.data).map((item) => item.id) }
    if (step.op === 'switchTo') { guard.switchTo(step.sourceId); return { ...step } }
    if (step.op === 'reconcile') {
      const report = guard.reconcile(step.active, step.incoming)
      const expected = { ok: report.ok, activeCount: report.activeCount, incomingCount: report.incomingCount }
      if (report.reason !== undefined) expected.reason = report.reason
      return { ...step, expected }
    }
    throw new Error('unknown sourceGuard op: ' + String(step.op))
  })
  return { name: scenario.name, activeSourceId: scenario.activeSourceId, ops }
})

// ---- user receives push: Given payload, When TS validates, Then Swift must match
const pushBase = { kind: 'escalation', severity: 'warning', deskId: 'desk-1', deeplink: 'dshtrading://decisions/id', expiresInMs: 1000, actions: ['ack'], fallbackText: 'notice', revision: 0 }
const validatePushPayload = [
  ['valid', {}], ['unknown-kind', { kind: 'future' }], ['unknown-severity', { severity: 'future' }],
  ['external-link', { deeplink: 'https://example.com' }], ['empty-desk', { deskId: '' }],
  ['zero-ttl', { expiresInMs: 0 }], ['negative-revision', { revision: -1 }],
  ['critical-no-action', { severity: 'critical', actions: [] }], ['unknown-action', { actions: ['future'] }],
  ['too-many-actions', { actions: ['ack', 'approve', 'reject', 'kill'] }],
  ['empty-fallback', { fallbackText: '  ' }], ['emoji-desk-exact-limit', { deskId: '😀'.repeat(32) }],
  ['emoji-desk-over-limit', { deskId: '😀'.repeat(33) }],
  ['emoji-fallback-over-limit', { fallbackText: '😀'.repeat(91) }],
  ['emoji-link-over-limit', { deeplink: 'dshtrading://positions/' + '😀'.repeat(128) }],
  ['combining-desk-over-limit', { deskId: 'e\u0301'.repeat(33) }],
  ['combining-fallback-over-limit', { fallbackText: 'e\u0301'.repeat(91) }],
  ['combining-link-over-limit', { deeplink: 'dshtrading://positions/' + 'e\u0301'.repeat(128) }],
  ['surrogate-desk-over-limit', { deskId: '\uD835\uDC00'.repeat(33) }],
  ['surrogate-fallback-over-limit', { fallbackText: '\uD835\uDC00'.repeat(91) }],
  ['surrogate-link-over-limit', { deeplink: 'dshtrading://positions/' + '\uD835\uDC00'.repeat(128) }],
  ['fractional-expires-in-ms-accepted', { expiresInMs: 1500.5 }],
  ['fractional-revision-accepted', { revision: 2.75 }],
  ['zero-revision-accepted', { revision: 0 }],
  ['exact-limit-combining', { deskId: 'e\u0301'.repeat(32), fallbackText: 'e\u0301'.repeat(90) }],
  ['exact-limit-surrogates', { deskId: '\uD835\uDC00'.repeat(32), fallbackText: '\uD835\uDC00'.repeat(90) }],
  ['empty-fallback-string', { fallbackText: '' }],
].map(([name, over]) => {
  const payload = { ...pushBase, ...over }
  return { name, payload, expected: C.validatePushPayload(payload) }
})

// ---------------------------------------------------------------- 快照

const snapshot = {
  generator: 'apps/ios-native/scripts/gen-contract-snapshot.mjs',
  contractEntry: 'packages/contract/src/core.ts',
  contractVersion: JSON.parse(readFileSync(contractPkg, 'utf8')).version,
  contractSourceSha256: Object.fromEntries(
    ['version', 'scopes', 'cards', 'push', 'confirm', 'offline', 'source-guard', 'core'].map((name) => [
      name,
      sha256(resolve(repoRoot, 'packages/contract/src/' + name + '.ts')),
    ]),
  ),
  version: {
    apiMajor: C.API_MAJOR,
    apiMinor: C.API_MINOR,
    compatibleMajorSpan: C.COMPATIBLE_MAJOR_SPAN,
    capsHeader: C.CAPS_HEADER,
    clientTooOldStatus: C.CLIENT_TOO_OLD_STATUS,
  },
  scopes: {
    planes: [...C.SCOPE_PLANES],
    defaultPlanes: [...C.DEFAULT_SCOPE_PLANES],
    explicitPlanes: [...C.EXPLICIT_SCOPE_PLANES],
  },
  cardTypes: [...C.CARD_TYPES],
  fieldKinds: [...C.FIELD_KINDS],
  actionKinds: [...C.ACTION_KINDS],
  actionScope: { ...C.ACTION_SCOPE },
  actionConfirm: { ...C.ACTION_CONFIRM },
  cardLimits: { ...C.CARD_LIMITS },
  confirmLevels: [...C.CONFIRM_LEVELS],
  confirmAudit: C.auditConfirmPolicy(),
  staleness: [...C.STALENESS],
  deeplinkScreens: [...C.DEEPLINK_SCREENS],
  deeplinkScheme: C.DEEPLINK_SCHEME,
  pushKinds: [...C.PUSH_KINDS],
  pushSeverities: [...C.PUSH_SEVERITIES],
  pushActions: [...C.PUSH_ACTIONS],
  pushLimits: { ...C.PUSH_LIMITS },
  // 解码保真：不仅判合法，还要断言**值原样保留**（Int 解码会把 3.5 变成失败或截断）。
  // revision 另加极端有限值：1e100 / Number.MAX_VALUE / 1e19 都必须原样保留、断言不崩
  // （Swift 侧的 Int(Double) 在这些值上会 trap —— 独立审查 C6/IOS-9 的第二个家）。
  cardDecoding: [
    { name: 'revision-3.5-preserved', card: okCard({ revision: 3.5 }) },
    { name: 'revision-0-preserved', card: okCard({ revision: 0 }) },
    { name: 'revision-7-preserved', card: okCard({ revision: 7 }) },
    { name: 'revision-1e100-preserved', card: okCard({ revision: 1e100 }) },
    { name: 'revision-max-value-preserved', card: okCard({ revision: Number.MAX_VALUE }) },
    { name: 'revision-1e19-preserved', card: okCard({ revision: 1e19 }) },
    { name: 'freshness-1200.5-preserved', card: okCard({ freshnessMs: 1200.5 }) },
    { name: 'freshness-0-preserved', card: okCard({ freshnessMs: 0 }) },
  ].map((entry) => ({
    name: entry.name,
    card: entry.card,
    expected: {
      revision: entry.card.revision,
      freshnessMs: entry.card.freshnessMs ?? null,
      valid: C.validateCard(entry.card).valid,
    },
  })),
  // 字段值的 String() 保真：Swift 侧必须把 JSON null 读成 .null（不是 nil）、把字段缺失读成 nil，
  // 且投影出的文本等于 TS 的 String(value)（数组 join / 对象 [object Object] 都在这张表里）。
  cardValueText: [
    { name: 'null-value', hasValue: true, value: null },
    { name: 'absent-value', hasValue: false },
    { name: 'true-value', hasValue: true, value: true },
    { name: 'false-value', hasValue: true, value: false },
    { name: 'int-value', hasValue: true, value: 42 },
    { name: 'float-value', hasValue: true, value: 3.5 },
    { name: 'small-exponent-value', hasValue: true, value: 1e-7 },
    { name: 'expanded-large-value', hasValue: true, value: 1e20 },
    { name: 'scientific-large-value', hasValue: true, value: 1e21 },
    { name: 'empty-string-value', hasValue: true, value: '' },
    { name: 'array-value', hasValue: true, value: [1, 2] },
    { name: 'nested-array-value', hasValue: true, value: [[1, 2], [3]] },
    { name: 'array-with-null-element', hasValue: true, value: [null, 1] },
    { name: 'object-value', hasValue: true, value: { a: 1 } },
    { name: 'array-of-objects', hasValue: true, value: [{}, {}] },
  ].map((entry) => ({ ...entry, expected: String(entry.hasValue ? entry.value : undefined) })),
  // 字节棘轮：含 null / 数组 / 对象值的卡片，TS 的 JSON.stringify 字节数就是判据。
  byteShapes: [
    { name: 'null-value-card', card: okCard({ fields: [field({ key: 'k', label: 'L', kind: 'enum', value: null, values: ['null'] })] }) },
    { name: 'number-value-card', card: okCard({ fields: [field({ key: 'k', label: 'L', kind: 'number', value: 42 })] }) },
    { name: 'array-value-card', card: okCard({ fields: [field({ key: 'k', label: 'L', kind: 'enum', value: [1, 2], values: ['1,2'] })] }) },
    { name: 'object-value-card', card: okCard({ fields: [field({ key: 'k', label: 'L', kind: 'enum', value: { a: 1 }, values: ['[object Object]'] })] }) },
    { name: 'huge-revision-card', card: okCard({ revision: 1e100 }) },
    { name: 'max-revision-card', card: okCard({ revision: Number.MAX_VALUE }) },
  ].map((entry) => ({ ...entry, expectedBytes: Buffer.byteLength(JSON.stringify(entry.card), 'utf8') })),
  vectors: {
    negotiateVersion,
    validateCard,
    renderableActions,
    fallbackFor,
    stalenessOf,
    offlineView,
    parseDeeplink,
    grantableByDefault,
    parseCaps,
    formatCaps,
    requiresBiometric,
    sourceGuard,
    validatePushPayload,
  },
}

const outPath = resolve(appRoot, 'Generated/contract-snapshot.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
const vectorCount = Object.values(snapshot.vectors).reduce((total, list) => total + list.length, 0)
console.log('wrote ' + outPath)
console.log('contract ' + snapshot.contractVersion + ' | vectors ' + String(vectorCount) + ' | byte-card ' + String(byteCardBytes) + ' bytes')
