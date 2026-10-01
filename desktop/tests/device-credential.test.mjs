/**
 * 桌面壳设备凭据测试（P4 步骤 5 接线前置）：
 * **起真实 edge**（127.0.0.1 + 临时端口）走真 HTTP + 真文件权限断言；不打桩注册表、不打桩 HTTP。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDeviceRegistry, createEdgeGateway } from '../../packages/tradectl/lib/edge.js'

const require = createRequire(import.meta.url)
const { createDeviceCredential, CREDENTIAL_FILE } = require('../src/device-credential.cjs')

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'desktop-cred-'))
  let tick = 1_700_000_000_000
  const registry = createDeviceRegistry({ now: () => (tick += 1) })
  const gateway = await createEdgeGateway({
    host: '127.0.0.1',
    port: 0,
    registry,
    killStatePath: join(home, 'kill-state.json'),
    now: () => (tick += 1),
  })
  const credential = createDeviceCredential({ home })
  return {
    home,
    registry,
    gateway,
    credential,
    cleanup: async () => {
      await gateway.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('管理员：配对后凭据可用，且能真的读到 A0（端到端）', async () => {
  // Given 一个真实 edge 与一个配对码
  const f = await fixture()
  try {
    const { code } = f.registry.issuePairingCode()
    // When 桌面壳配对
    const paired = await f.credential.pair({ baseUrl: f.gateway.url, code })
    // Then 成功、拿到授权头
    assert.equal(paired.ok, true)
    const authorization = f.credential.authorization(f.gateway.url)
    assert.match(String(authorization), /^Bearer dev_/)
    // 且该凭据真的能读到 A0
    const ping = await fetch(f.gateway.url + '/a0/ping', { headers: { authorization: String(authorization) } })
    assert.equal(ping.status, 200)
  } finally {
    await f.cleanup()
  }
})

test('管理员：凭据文件权限是 0600（桌面端没有 Keychain，就限制权限）', async () => {
  // Given 已配对的桌面壳
  const f = await fixture()
  try {
    const { code } = f.registry.issuePairingCode()
    await f.credential.pair({ baseUrl: f.gateway.url, code })
    // When 看落盘文件的权限
    const mode = statSync(join(f.home, CREDENTIAL_FILE)).mode & 0o777
    // Then 仅属主可读写
    assert.equal(mode, 0o600)
  } finally {
    await f.cleanup()
  }
})

test('管理员：凭据与地址绑定——换了地址一律不外发', async () => {
  // Given 在 A 地址配对成功
  const f = await fixture()
  try {
    const { code } = f.registry.issuePairingCode()
    await f.credential.pair({ baseUrl: f.gateway.url, code })
    // When 向另一个地址（仅端口不同）索取授权头
    const other = 'http://127.0.0.1:1'
    // Then 拒绝（一次配置改错不该把设备密钥交给另一个 host）
    assert.equal(f.credential.authorization(other), undefined)
    // 而原地址仍然可用
    assert.match(String(f.credential.authorization(f.gateway.url)), /^Bearer dev_/)
  } finally {
    await f.cleanup()
  }
})

test('管理员：forget 之后回到未配对，且请求不再被接受', async () => {
  // Given 已配对
  const f = await fixture()
  try {
    const { code } = f.registry.issuePairingCode()
    await f.credential.pair({ baseUrl: f.gateway.url, code })
    // When 忘记凭据（收到 401 或用户解绑时）
    f.credential.forget()
    // Then 本地没有授权头，A0 也不再接受
    assert.equal(f.credential.authorization(f.gateway.url), undefined)
    const ping = await fetch(f.gateway.url + '/a0/ping')
    assert.equal(ping.status, 401)
  } finally {
    await f.cleanup()
  }
})

test('管理员：坏码与连不上的 bot 都给出可操作的失败，而不是抛错', async () => {
  // Given 一个真实 edge
  const f = await fixture()
  try {
    // When 用错码
    const bad = await f.credential.pair({ baseUrl: f.gateway.url, code: 'nope' })
    // Then 明确失败码
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'PAIRING_CODE_UNKNOWN')
    // When 指向一个没人听的端口
    const unreachable = await f.credential.pair({ baseUrl: 'http://127.0.0.1:1', code: 'x' })
    // Then 也是可操作的失败（桌面壳不该因此崩）
    assert.equal(unreachable.ok, false)
    assert.equal(unreachable.code, 'PAIR_UNREACHABLE')
  } finally {
    await f.cleanup()
  }
})
