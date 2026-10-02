#!/usr/bin/env node
/**
 * Swift 分层门禁：apps/ios-native 的层间依赖必须在白名单内，越界即红。
 *
 * 为什么还要这一条：分层 framework 已经让"下层 import 上层"在编译期失败，但**第三方依赖**
 * 与"Contract 里偷偷 import UIKit"这类平台耦合，编译器拦不住。这里把它们写成判据。
 *
 * 用法：node scripts/ios-native/check-swift-layering.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const sourcesRoot = resolve(repoRoot, 'apps/ios-native/Sources')

// 每层允许出现的 import。**没登记**的层（或新增目录）同样判红：新增层必须显式登记。
// Domain 合法 import Observation：@Observable 是随工具链的标准库宏（ObservationMacros），不是第三方包。
const LAYERS = {
  Contract: { allowed: ['Foundation'] },
  Transport: { allowed: ['Foundation', 'Security', 'DshTradingContract'] },
  Domain: { allowed: ['Foundation', 'Observation', 'DshTradingContract'] },
  Offline: { allowed: ['Foundation', 'Observation', 'DshTradingContract', 'DshTradingDomain'] },
  Alerts: {
    allowed: ['Foundation', 'UserNotifications', 'LocalAuthentication', 'UIKit', 'Observation', 'DshTradingContract', 'DshTradingDomain'],
  },
  Features: {
    allowed: [
      'Foundation', 'SwiftUI', 'UIKit', 'Observation', 'Combine', 'Charts',
      'DshTradingContract', 'DshTradingTransport', 'DshTradingDomain', 'DshTradingAlerts', 'DshTradingOffline',
    ],
  },
  App: {
    allowed: [
      'Foundation', 'SwiftUI', 'UIKit', 'Observation', 'Combine', 'Charts', 'UserNotifications', 'LocalAuthentication', 'Security',
      'DshTradingContract', 'DshTradingTransport', 'DshTradingDomain', 'DshTradingAlerts', 'DshTradingOffline', 'DshTradingFeatures',
    ],
  },
}

// 任何层都不得 import 的上层模块（只有 App 可以，Features 也不行——Features 是被 App 组合的那一层）
const UPPER_MODULES = ['DshTradingFeatures', 'DshTradingNative']

const swiftFiles = (dir) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...swiftFiles(full))
    else if (entry.endsWith('.swift')) out.push(full)
  }
  return out
}

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
    const relative = file.replace(repoRoot + '/', '')
    for (const match of source.matchAll(/^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)/gm)) {
      const moduleName = match[1]
      if (!allowed.has(moduleName)) {
        violations.push(relative + '：' + entry + ' 层不许 import ' + moduleName)
        continue
      }
      if (UPPER_MODULES.includes(moduleName) && entry !== 'App') {
        violations.push(relative + '：' + entry + ' 层不许 import 上层模块 ' + moduleName)
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
console.log('Swift 分层门禁：绿 —— ' + String(seenLayers.length) + ' 层全部合规（Domain 的 Observation 宏在白名单内）')
