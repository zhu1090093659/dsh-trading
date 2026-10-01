/**
 * 附着模式决策测试（P4 步骤 5）：纯函数，无 IO、无探测、无 mock。
 * 用 node:test（与 desktop/tests 其余用例一致），跑法：pnpm test:desktop
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { resolveHostMode, isPrivateOrLoopbackHost } = require('../src/attach-mode.cjs')

test('管理员：没配 bot 时保持现状（起本地 host）', () => {
  // Given 没有 bot 配置
  // When 决策
  const mode = resolveHostMode({})
  // Then 本地模式，且原因说得清
  assert.equal(mode.mode, 'local')
  assert.match(mode.reason, /未配置 bot/)
})

test('管理员：配了内网 bot 就附着，不再起本地 host', () => {
  // Given 一个内网地址（含尾斜杠）
  // When 决策
  const mode = resolveHostMode({ botUrl: 'http://192.168.1.20:8888/' })
  // Then 附着，且 URL 规整（去掉尾斜杠）
  assert.equal(mode.mode, 'attach')
  assert.equal(mode.url, 'http://192.168.1.20:8888')
})

test('管理员：公网地址一律回落本地（本系统只承诺内网可达）', () => {
  // Given 一个公网地址
  // When 决策
  const mode = resolveHostMode({ botUrl: 'https://bot.example.com' })
  // Then 回落本地并给出原因（fail-closed，绝不把会话交到公网）
  assert.equal(mode.mode, 'local')
  assert.match(mode.reason, /不是内网|回落/)
})

test('管理员：非法配置与不支持协议都回落本地，而不是抛错挡住启动', () => {
  // Given 两种坏配置
  // When 决策
  const broken = resolveHostMode({ botUrl: 'not a url' })
  const wrongScheme = resolveHostMode({ botUrl: 'ftp://192.168.1.20' })
  // Then 都回落本地且说明原因（桌面壳必须还能启动）
  assert.equal(broken.mode, 'local')
  assert.match(broken.reason, /合法 URL/)
  assert.equal(wrongScheme.mode, 'local')
  assert.match(wrongScheme.reason, /协议/)
})

test('管理员：回环/私有网段判定覆盖本机、私有段与内网域名后缀', () => {
  // Given 一组应被认作内网的与一组公网的
  const inside = ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.4', '172.31.255.254', '169.254.1.1', 'mac.local', 'bot.internal', '[::1]', 'fd00::1']
  const outside = ['8.8.8.8', '172.32.0.1', '172.15.0.1', 'example.com', '1.1.1.1']
  // When/Then 分别判定
  for (const host of inside) assert.equal(isPrivateOrLoopbackHost(host), true, host + ' 应被认作内网')
  for (const host of outside) assert.equal(isPrivateOrLoopbackHost(host), false, host + ' 不应被认作内网')
})
