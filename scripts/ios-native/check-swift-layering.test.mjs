/**
 * check-swift-layering 自测（进 test:scripts）：夹具驱动，验证门禁**真的会抓越界**，
 * 尤其是 IOS-4 独立验收 §5.2/§5.3 实证过的两种绕过写法（带属性前缀、带种类词）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const LAYERS = ['Contract', 'Transport', 'Domain', 'Features', 'Alerts', 'Offline', 'App']
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个七层齐全的夹具目录；overrides 的键是层名、值是该层额外追加的源码行。 */
function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swift-layering-'))
  dirs.push(dir)
  for (const layer of LAYERS) {
    mkdirSync(join(dir, layer), { recursive: true })
    writeFileSync(join(dir, layer, 'Base.swift'), ['import Foundation', ...(overrides[layer] ?? [])].join('\n') + '\n')
  }
  return dir
}

function check(dir) {
  return spawnSync(process.execPath, ['scripts/ios-native/check-swift-layering.mjs', '--sources', dir], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

describe('Swift 分层门禁', () => {
  it('管理员：七层只 import 白名单内模块 ⇒ 绿', () => {
    // Given 一个每层都合规的夹具
    const dir = fixture()
    // When 检查
    const result = check(dir)
    // Then 通过
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('绿')
  })

  it('管理员：@_exported import SwiftUI 透传禁层模块 ⇒ 红且点名 SwiftUI', () => {
    // Given Domain 用 @_exported 把 SwiftUI 透传出去（IOS-4 验收 §5.2 的绕过写法）
    const dir = fixture({ Domain: ['@_exported import SwiftUI'] })
    // When 检查
    const result = check(dir)
    // Then 抓住越界，且诊断指向真正的模块名与透传语义
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('不许 import SwiftUI')
    expect(result.stderr).toContain('@_exported')
  })

  it('管理员：@testable import 上层模块 ⇒ 红', () => {
    // Given Domain 用 @testable 引上层 Features
    const dir = fixture({ Domain: ['@testable import DshTradingFeatures'] })
    // When 检查
    const result = check(dir)
    // Then 抓住上层依赖（Domain 的白名单本就不含 Features，所以走"不许 import"这一支；
    // "不许 import 上层模块"那支是给"白名单将来含上层模块"留的防线）
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('不许 import DshTradingFeatures')
  })

  it('管理员：import struct SwiftUI.Color ⇒ 红且报 SwiftUI 而不是 struct', () => {
    // Given Domain 用带种类词的写法引 SwiftUI 的子类型
    const dir = fixture({ Domain: ['import struct SwiftUI.Color'] })
    // When 检查
    const result = check(dir)
    // Then 越界模块名是 SwiftUI，不是关键字 struct（IOS-4 验收 §5.3）
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('不许 import SwiftUI')
    expect(result.stderr).not.toContain('不许 import struct')
  })

  it('管理员：注释里的 import 不算越界', () => {
    // Given Domain 只在注释里提到 SwiftUI
    const dir = fixture({ Domain: ['// import SwiftUI', '/// import UIKit'] })
    // When 检查
    const result = check(dir)
    // Then 不误报
    expect(result.status).toBe(0)
  })

  it('管理员：出现未登记的新分层目录 ⇒ 红', () => {
    // Given 多了一层没在白名单里登记
    const dir = fixture()
    mkdirSync(join(dir, 'Widgets'), { recursive: true })
    writeFileSync(join(dir, 'Widgets', 'Base.swift'), 'import Foundation\n')
    // When 检查
    const result = check(dir)
    // Then 要求显式登记
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Widgets')
  })
})
