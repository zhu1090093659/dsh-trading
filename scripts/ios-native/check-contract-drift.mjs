#!/usr/bin/env node
/**
 * 契约防漂移门禁（**可移植版**，不需要 Xcode）—— CI 的静态门禁跑这一条。
 *
 * TS 契约（packages/contract/src/core.ts）是唯一权威。本脚本：
 *   1. 运行期 import TS 契约，取到权威真值；
 *   2. 从 apps/ios-native/Sources/Contract/*.swift 解析出 Swift 侧的字面量表与类型规范
 *      （封闭枚举 rawValue、actionScope/actionConfirm 查表、cardLimits/pushLimits、
 *       版本常量、数值域 Double 规范、UTF-16 计量规范、未知动作 fail-closed 兜底）；
 *   3. 逐项比对，任何不一致即非零退出。
 *
 * 架构分工（CI 行为等价门禁承诺边界）：
 *   - 本脚本（Node 纯静态检查）：在 Linux/Ubuntu CI 上以毫秒级运行，拦截常量、查表、
 *     封闭枚举、上限棘轮、数值域声明与字符串计量规则的静态漂移；
 *   - scripts/test-contract.sh（Swift XCTest 动态重放）：在 macOS 本机运行，重放
 *     全部行为向量（validateCard / validatePushPayload / stalenessOf / sourceGuard 等）。
 *   既有先例保持：CI 不跑 iOS/macOS Xcode 构建（节约 10x 计算资源），机检承诺明确
 *   在常量/类型静态面守住边界，动态重放由本地开发门禁与发版前验收把关。
 *
 * 用法：node scripts/ios-native/check-contract-drift.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

// --swift-dir / --contract 供自测（scripts/ios-native/check-contract-drift.test.mjs）指向夹具；
// 默认值是仓内真路径，CI 与本地用法不变。
const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const contractSrc = resolve(argOf('--contract', resolve(repoRoot, 'packages/contract/src/core.ts')))
const swiftDir = resolve(argOf('--swift-dir', resolve(repoRoot, 'apps/ios-native/Sources/Contract')))

const C = await import(contractSrc)
const problems = []
const note = (message) => problems.push(message)
const swift = (name) => readFileSync(resolve(swiftDir, name), 'utf8')

/** 按花括号配对取出 public enum X 的正文；解析不到就抛（保守判红）。 */
function enumBody(source, enumName) {
  const start = source.indexOf('public enum ' + enumName)
  if (start < 0) throw new Error('找不到 enum ' + enumName)
  const open = source.indexOf('{', start)
  if (open < 0) throw new Error('enum ' + enumName + ' 没有正文')
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error('enum ' + enumName + ' 花括号不配对')
}

/** Swift enum 的 case 列表（声明顺序 = allCases 顺序；没写 rawValue 时 rawValue 就是 case 名）。 */
function enumCases(source, enumName) {
  const body = enumBody(source, enumName)
  const cases = []
  const re = /case\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*"([^"]*)")?/g
  let match
  while ((match = re.exec(body)) !== null) cases.push({ name: match[1], raw: match[2] ?? match[1] })
  if (cases.length === 0) throw new Error('enum ' + enumName + ' 没解析出任何 case')
  return cases
}

/** 解析 func 名(...) 里的 switch：case .a, .b: return .x 映射成 { caseName: 结果 }。 */
function switchMap(source, funcName) {
  const start = source.indexOf('func ' + funcName)
  if (start < 0) throw new Error('找不到 func ' + funcName)
  const open = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) throw new Error('func ' + funcName + ' 花括号不配对')
  const body = source.slice(open, end)
  const re = /case\s+([^:]+):\s*return\s*\.([A-Za-z_][A-Za-z0-9_]*)/g
  const map = new Map()
  let match
  while ((match = re.exec(body)) !== null) {
    for (const item of match[1].split(',')) {
      const name = item.trim().replace(/^\./, '')
      if (name !== '') map.set(name, match[2])
    }
  }
  if (map.size === 0) throw new Error('func ' + funcName + ' 没解析出任何 case')
  return map
}

/** 只支持整数字面量与 a * b * c 乘法（PUSH_LIMITS 的 24 小时用得到）。 */
function evalInt(expression) {
  const text = expression.trim()
  if (/^[0-9_]+$/.test(text)) return Number(text.replace(/_/g, ''))
  if (/^[0-9_]+(\s*\*\s*[0-9_]+)+$/.test(text)) {
    return text.split('*').reduce((total, part) => total * Number(part.trim().replace(/_/g, '')), 1)
  }
  throw new Error('不认识的常量表达式：' + text)
}

/** public let x = Type(a: 1, b: 2) 取成 { a: 1, b: 2 }。 */
function initializerValues(source, declaration, typeName) {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error('找不到 ' + declaration)
  const open = source.indexOf(typeName + '(', start)
  const close = source.indexOf(')', open)
  if (open < 0 || close < 0) throw new Error(declaration + ' 的初始化器不完整')
  const body = source.slice(open + typeName.length + 1, close)
  const values = {}
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,\n]+)/g
  let match
  while ((match = re.exec(body)) !== null) values[match[1]] = evalInt(match[2])
  return values
}

/** public let x: T = [.a, .b] 取成 ['a','b']。 */
function planeList(source, declaration) {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error('找不到 ' + declaration)
  // 注意：类型标注里也有方括号（[ScopePlane]），必须从 = 之后再找值数组
  const equals = source.indexOf('=', start)
  if (equals < 0) throw new Error(declaration + ' 没有赋值')
  const open = source.indexOf('[', equals)
  const close = source.indexOf(']', open)
  if (open < 0 || close < 0) throw new Error(declaration + ' 的数组不完整')
  return source.slice(open + 1, close).split(',')
    .map((item) => item.trim().replace(/^\./, ''))
    .filter((item) => item !== '')
}

const expectList = (label, swiftValues, tsValues) => {
  const a = JSON.stringify(swiftValues)
  const b = JSON.stringify(tsValues)
  if (a !== b) note(label + ' 漂移：Swift = ' + a + '，TS = ' + b)
}
const expectMap = (label, swiftMap, tsEntries) => {
  const pairs = [...swiftMap.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  const a = JSON.stringify(Object.fromEntries(pairs))
  const b = JSON.stringify(Object.fromEntries(Object.entries(tsEntries).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))))
  if (a !== b) note(label + ' 漂移：Swift = ' + a + '，TS = ' + b)
}

try {
  const versionSource = swift('ContractVersion.swift')
  const apiBody = enumBody(versionSource, 'ApiContract')
  const statics = {}
  for (const match of apiBody.matchAll(/static let ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|[0-9_]+)/g)) {
    statics[match[1]] = match[2].startsWith('"') ? match[2].slice(1, -1) : evalInt(match[2])
  }
  for (const [swiftKey, tsValue] of Object.entries({
    major: C.API_MAJOR,
    minor: C.API_MINOR,
    compatibleMajorSpan: C.COMPATIBLE_MAJOR_SPAN,
    capsHeader: C.CAPS_HEADER,
    clientTooOldStatus: C.CLIENT_TOO_OLD_STATUS,
  })) {
    if (statics[swiftKey] !== tsValue) {
      note('ApiContract.' + swiftKey + ' 漂移：Swift = ' + String(statics[swiftKey]) + '，TS = ' + String(tsValue))
    }
  }

  const scopesSource = swift('ContractScopes.swift')
  expectList('ScopePlane.allCases', enumCases(scopesSource, 'ScopePlane').map((item) => item.raw), [...C.SCOPE_PLANES])
  expectList('defaultScopePlanes', planeList(scopesSource, 'public let defaultScopePlanes'), [...C.DEFAULT_SCOPE_PLANES])
  expectList('explicitScopePlanes', planeList(scopesSource, 'public let explicitScopePlanes'), [...C.EXPLICIT_SCOPE_PLANES])

  const cardsSource = swift('ContractCards.swift')
  expectList('CardType.allCases', enumCases(cardsSource, 'CardType').map((item) => item.raw), [...C.CARD_TYPES])
  expectList('FieldKind.allCases', enumCases(cardsSource, 'FieldKind').map((item) => item.raw), [...C.FIELD_KINDS])
  const actionCases = enumCases(cardsSource, 'ActionKind')
  expectList('ActionKind.allCases', actionCases.map((item) => item.raw), [...C.ACTION_KINDS])
  const actionRawByName = new Map(actionCases.map((item) => [item.name, item.raw]))
  const swiftScope = new Map()
  for (const [name, plane] of switchMap(cardsSource, 'scopeOf')) {
    const raw = actionRawByName.get(name)
    if (raw === undefined) throw new Error('scopeOf 里的 case .' + name + ' 不在 ActionKind 里')
    swiftScope.set(raw, plane)
  }
  expectMap('actionScope', swiftScope, C.ACTION_SCOPE)

  const swiftLimits = initializerValues(cardsSource, 'public let cardLimits', 'CardLimits')
  for (const [key, value] of Object.entries(C.CARD_LIMITS)) {
    if (swiftLimits[key] !== value) note('cardLimits.' + key + ' 漂移：Swift = ' + String(swiftLimits[key]) + '，TS = ' + String(value))
  }
  if (Object.keys(swiftLimits).length !== Object.keys(C.CARD_LIMITS).length) {
    note('cardLimits 字段数与 TS 不一致：Swift = ' + Object.keys(swiftLimits).length + '，TS = ' + Object.keys(C.CARD_LIMITS).length)
  }

  const confirmSource = swift('ContractConfirm.swift')
  expectList('ConfirmLevel.allCases', enumCases(confirmSource, 'ConfirmLevel').map((item) => item.raw), [...C.CONFIRM_LEVELS])
  const swiftConfirm = new Map()
  for (const [name, level] of switchMap(confirmSource, 'confirmLevelOf')) {
    const raw = actionRawByName.get(name)
    if (raw === undefined) throw new Error('confirmLevelOf 里的 case .' + name + ' 不在 ActionKind 里')
    swiftConfirm.set(raw, level)
  }
  expectMap('actionConfirm', swiftConfirm, C.ACTION_CONFIRM)
  const audit = C.auditConfirmPolicy()
  if (!audit.ok) note('TS 确认策略表自身不完整：' + audit.problems.join('; '))

  const pushSource = swift('ContractPush.swift')
  expectList('PushSeverity.allCases', enumCases(pushSource, 'PushSeverity').map((item) => item.raw), [...C.PUSH_SEVERITIES])
  expectList('PushKind.allCases', enumCases(pushSource, 'PushKind').map((item) => item.raw), [...C.PUSH_KINDS])
  expectList('PushAction.allCases', enumCases(pushSource, 'PushAction').map((item) => item.raw), [...C.PUSH_ACTIONS])
  const schemeMatch = pushSource.match(/public let deeplinkScheme\s*=\s*"([^"]*)"/)
  if (schemeMatch === null) throw new Error('找不到 deeplinkScheme')
  if (schemeMatch[1] !== C.DEEPLINK_SCHEME) note('deeplinkScheme 漂移：Swift = ' + schemeMatch[1] + '，TS = ' + C.DEEPLINK_SCHEME)
  const swiftPushLimits = initializerValues(pushSource, 'public let pushLimits', 'PushLimits')
  for (const [key, value] of Object.entries(C.PUSH_LIMITS)) {
    if (swiftPushLimits[key] !== value) note('pushLimits.' + key + ' 漂移：Swift = ' + String(swiftPushLimits[key]) + '，TS = ' + String(value))
  }

  const offlineSource = swift('ContractOffline.swift')
  expectList('Staleness.allCases', enumCases(offlineSource, 'Staleness').map((item) => item.raw), [...C.STALENESS])
  expectList('DeeplinkScreen.allCases', enumCases(offlineSource, 'DeeplinkScreen').map((item) => item.raw), [...C.DEEPLINK_SCREENS])

  // 数值域等价性：TS number 允许有限小数，Swift 对应字段必须使用 Double（不得用 Int 截断或收窄）
  if (!/public let revision:\s*Double\b/.test(cardsSource)) {
    note('Card.revision 类型漂移：必须为 Double（对齐 TS number 允许有限小数，不得收窄为 Int）')
  }
  if (!/public let freshnessMs:\s*Double\?(?!\w)/.test(cardsSource)) {
    note('Card.freshnessMs 类型漂移：必须为 Double?（对齐 TS number 允许有限小数，不得收窄为 Int）')
  }
  if (!/public let revision:\s*Double\b/.test(pushSource)) {
    note('PushPayload.revision 类型漂移：必须为 Double（对齐 TS number 允许有限小数，不得收窄为 Int）')
  }
  if (!/public let expiresInMs:\s*Double\b/.test(pushSource)) {
    note('PushPayload.expiresInMs 类型漂移：必须为 Double（对齐 TS number 允许有限小数，不得收窄为 Int）')
  }
  if (!/public let maxExpiresInMs:\s*Double\b/.test(pushSource)) {
    note('PushLimits.maxExpiresInMs 类型漂移：必须为 Double（与 PushPayload.expiresInMs 保持同型）')
  }

  // 字符串计量等价性：TS 的 String.length 数 UTF-16 码元，Swift 必须使用 utf16.count
  const cardLengthChecks = [
    ['cardId', 'card.cardId.utf16.count > limits.maxIdChars'],
    ['fallbackText', 'card.fallbackText.utf16.count > limits.maxFallbackChars'],
    ['label', 'field.label.utf16.count > limits.maxLabelChars'],
    ['value', 'text.utf16.count > limits.maxValueChars'],
  ]
  for (const [field, pattern] of cardLengthChecks) {
    if (!cardsSource.includes(pattern)) {
      note('validateCard 字符串计量漂移：' + field + ' 必须使用 .utf16.count（对齐 TS .length）')
    }
  }
  if (/\b(?:cardId|fallbackText|label|value)\.count\s*>\s*limits\./.test(cardsSource)) {
    note('validateCard 存在使用 bare .count 计量字符串长度的缺陷（必须改用 .utf16.count）')
  }

  const pushLengthChecks = [
    ['deskId', 'payload.deskId.utf16.count > pushLimits.maxDeskIdChars'],
    ['deeplink', 'payload.deeplink.utf16.count > pushLimits.maxDeeplinkChars'],
    ['fallbackText', 'payload.fallbackText.utf16.count > pushLimits.maxFallbackChars'],
  ]
  for (const [field, pattern] of pushLengthChecks) {
    if (!pushSource.includes(pattern)) {
      note('validatePushPayload 字符串计量漂移：' + field + ' 必须使用 .utf16.count（对齐 TS .length）')
    }
  }
  if (/\b(?:deskId|deeplink|fallbackText)\.count\s*>\s*pushLimits\./.test(pushSource)) {
    note('validatePushPayload 存在使用 bare .count 计量字符串长度的缺陷（必须改用 .utf16.count）')
  }

  // 未知动作 fail-closed 门禁：未知动作在确认档位必须兜底到 .biometric、作用域必须兜底到 .control
  if (!confirmSource.includes('guard let known = ActionKind(rawValue: action) else { return .biometric }')) {
    note('confirmLevel(for: String) 未知动作未 fail-closed 到 .biometric')
  }
  if (!confirmSource.includes('guard let known = ActionKind(rawValue: action) else { return .control }')) {
    note('scopeForAction(_ action: String) 未知动作未 fail-closed 到 .control')
  }

  // 保真度门禁：CardField.rawValue 必须保留 CardValue?
  if (!cardsSource.includes('public let rawValue: CardValue?')) {
    note('CardField.rawValue 缺失：必须保留 CardValue?（防止 null 与缺失塌缩成同一个 nil）')
  }
} catch (error) {
  note('解析 Swift 契约失败（保守判红，不静默通过）：' + String(error && error.message ? error.message : error))
}

if (problems.length > 0) {
  console.error('契约防漂移门禁：红 —— Swift 侧与 TS 权威不一致（' + String(problems.length) + ' 项）')
  for (const problem of problems) console.error('  - ' + problem)
  console.error('\n权威在 packages/contract/src：要改契约先改 TS，再让 Swift 跟上。')
  process.exit(1)
}
console.log('契约防漂移门禁：绿 —— Swift 侧封闭枚举 / 查表 / 上限 / 常量与 TS 权威一致')
