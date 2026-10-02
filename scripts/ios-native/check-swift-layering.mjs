#!/usr/bin/env node
/**
 * Swift 分层门禁：apps/ios-native 的层间依赖必须在白名单内，越界即红。
 *
 * 为什么还要这一条：分层 framework 已经让"下层 import 上层"在编译期失败，但**第三方依赖**、
 * "Contract 里偷偷 import UIKit"这类平台耦合，以及**把禁层模块透传出去**的写法，编译器拦不住。
 *
 * 用法：node scripts/ios-native/check-swift-layering.mjs [--sources <目录>]
 *   --sources 供自测（scripts/ios-native/check-swift-layering.test.mjs）指向夹具目录。
 *
 * import 的识别（2026-10-02 修 IOS-4 验收 §5.2/§5.3 的两个真实缺口）：
 *   * **属性前缀必须识别**：@_exported import SwiftUI 的行首不是 import，旧正则整行漏掉；
 *     而 @_exported 恰恰是"把禁层模块透传出去"的写法（@testable / @preconcurrency 同理）。
 *   * **种类词必须跳过**：import struct SwiftUI.Color 的模块名是 SwiftUI，不是 struct；
 *     旧正则把关键字当模块名，诊断文案会指错对象。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const sourcesRoot = resolve(argOf('--sources', resolve(repoRoot, 'apps/ios-native/Sources')))

// 每层允许出现的 import。**没登记**的层（或新增目录）同样判红：新增层必须显式登记。
//
// Observation 在 Domain/Offline/Alerts/Features/App 上白名单化是**经 Lead 批准**的：
// @Observable 是随工具链的标准库宏（ObservationMacros），不是第三方包。
// Combine / Charts **未获批准**，故不在表内（IOS-4 验收 §5.4）。
const OBSERVATION_APPROVED = 'Observation'
const LAYERS = {
  Contract: { allowed: ['Foundation'] },
  Transport: { allowed: ['Foundation', 'Security', 'DshTradingContract'] },
  Domain: { allowed: ['Foundation', OBSERVATION_APPROVED, 'DshTradingContract'] },
  Offline: { allowed: ['Foundation', OBSERVATION_APPROVED, 'DshTradingContract', 'DshTradingDomain'] },
  Alerts: {
    allowed: ['Foundation', 'UserNotifications', 'LocalAuthentication', 'UIKit', OBSERVATION_APPROVED, 'DshTradingContract', 'DshTradingDomain'],
  },
  Features: {
    allowed: [
      'Foundation', 'SwiftUI', 'UIKit', OBSERVATION_APPROVED,
      'DshTradingContract', 'DshTradingTransport', 'DshTradingDomain', 'DshTradingAlerts', 'DshTradingOffline',
    ],
  },
  App: {
    allowed: [
      'Foundation', 'SwiftUI', 'UIKit', OBSERVATION_APPROVED, 'UserNotifications', 'LocalAuthentication', 'Security',
      'DshTradingContract', 'DshTradingTransport', 'DshTradingDomain', 'DshTradingAlerts', 'DshTradingOffline', 'DshTradingFeatures',
    ],
  },
}

// 任何层都不得 import 的上层模块（只有 App 可以，Features 也不行——Features 是被 App 组合的那一层）
const UPPER_MODULES = ['DshTradingFeatures', 'DshTradingNative']

// 属性前缀（@_exported / @testable / @preconcurrency …，允许带参数）→ import → 可选种类词 → **根模块名**。
// 只取根模块：import struct SwiftUI.Color 的模块是 SwiftUI，不是 struct，也不是 SwiftUI.Color。
const IMPORT_RE = /^[ \t]*(?<attributes>(?:@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?[ \t]*)*)import[ \t]+(?:(?:struct|class|enum|protocol|typealias|func|var|let)[ \t]+)?(?<module>[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*/gm

const swiftFiles = (dir) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...swiftFiles(full))
    else if (entry.endsWith('.swift')) out.push(full)
  }
  return out
}

const displayPath = (file) => (file.startsWith(repoRoot + '/') ? file.slice(repoRoot.length + 1) : file)

const violations = []
const seenLayers = []
for (const entry of readdirSync(sourcesRoot)) {
  const full = join(sourcesRoot, entry)
  if (!statSync(full).isDirectory()) continue
  seenLayers.push(entry)
  const layer = LAYERS[entry]
  if (layer === undefined) {
    violations.push(entry + '/：新增分层未在 scripts/ios-native/check-swift-layering.mjs 白名单里登记')
    continue
  }
  const allowed = new Set(layer.allowed)
  for (const file of swiftFiles(full)) {
    const source = readFileSync(file, 'utf8')
    const relative = displayPath(file)
    for (const match of source.matchAll(IMPORT_RE)) {
      const moduleName = match.groups.module
      const attributes = (match.groups.attributes ?? '').trim()
      const exported = attributes.includes('@_exported')
      const suffix = exported ? '（@_exported 会把该模块再透传出去，所以更要拦）' : ''
      if (!allowed.has(moduleName)) {
        violations.push(relative + '：' + entry + ' 层不许 import ' + moduleName + suffix)
        continue
      }
      if (UPPER_MODULES.includes(moduleName) && entry !== 'App') {
        violations.push(relative + '：' + entry + ' 层不许 import 上层模块 ' + moduleName + suffix)
      }
    }
  }
}

for (const name of Object.keys(LAYERS)) {
  if (!seenLayers.includes(name)) violations.push('Sources/' + name + '/ 不存在（分层被删/改名也要显式改白名单）')
}

if (violations.length > 0) {
  console.error('Swift 分层门禁：红（' + String(violations.length) + ' 处越界）')
  for (const violation of violations) console.error('  - ' + violation)
  process.exit(1)
}
console.log('Swift 分层门禁：绿 —— ' + String(seenLayers.length) + ' 层全部合规（Observation 经 Lead 批准）')
