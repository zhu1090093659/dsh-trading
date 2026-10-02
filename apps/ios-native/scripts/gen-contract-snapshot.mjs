#!/usr/bin/env node
// 契约快照生成器：**TS 契约是唯一权威**，本脚本把它的枚举/表/常量与一组行为夹具
// 导出成 JSON，供 Swift 侧 XCTest 断言（见 scripts/test-contract.sh）。
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const contractSrc = resolve(appRoot, '../../packages/contract/src/core.ts')

const contract = await import(contractSrc)

const snapshot = {
  generator: 'apps/ios-native/scripts/gen-contract-snapshot.mjs',
  contractEntry: 'packages/contract/src/core.ts',
  version: {
    apiMajor: contract.API_MAJOR,
    apiMinor: contract.API_MINOR,
    compatibleMajorSpan: contract.COMPATIBLE_MAJOR_SPAN,
    capsHeader: contract.CAPS_HEADER,
    clientTooOldStatus: contract.CLIENT_TOO_OLD_STATUS,
  },
  scopes: {
    planes: [...contract.SCOPE_PLANES],
    defaultPlanes: [...contract.DEFAULT_SCOPE_PLANES],
    explicitPlanes: [...contract.EXPLICIT_SCOPE_PLANES],
  },
  cards: {
    types: [...contract.CARD_TYPES],
    fieldKinds: [...contract.FIELD_KINDS],
    actionKinds: [...contract.ACTION_KINDS],
    actionScope: { ...contract.ACTION_SCOPE },
  },
  confirm: {
    levels: [...contract.CONFIRM_LEVELS],
    actionConfirm: { ...contract.ACTION_CONFIRM },
  },
  push: {
    severities: [...contract.PUSH_SEVERITIES],
    kinds: [...contract.PUSH_KINDS],
    actions: [...contract.PUSH_ACTIONS],
    deeplinkScheme: contract.DEEPLINK_SCHEME,
  },
  offline: {
    staleness: [...contract.STALENESS],
    deeplinkScreens: [...contract.DEEPLINK_SCREENS],
  },
}

const outPath = resolve(appRoot, 'Generated/contract-snapshot.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
console.log('wrote ' + outPath)
