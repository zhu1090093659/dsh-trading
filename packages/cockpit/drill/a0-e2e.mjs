/**
 * A0 端到端验证（P4 步骤 3 的卡片证据项）：**行情与 agent 全挂时，带外 A0 通道仍可用**。
 *
 * 形态：真实 edge（createEdgeGateway）+ 驾驶舱 /v1 面作为 **business route** + 一个**故意的故障**：
 * business route 全部抛错（模拟行情与 agent 全挂）。然后带设备令牌请求 A0 六条路径，断言全部 200。
 *
 * 这条证据之所以必须真跑：A0 与业务面共用一个 edge，而"注册顺序 / 错误处理 / 鉴权路径"
 * 任何一处写错，都会让带外通道在真正的故障时刻跟着一起挂 —— 而那正是它唯一被需要的时候。
 * 跑法：node packages/cockpit/drill/a0-e2e.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A0_PATHS, createDeviceRegistry, createEdgeGateway } from '../../tradectl/lib/edge.js'

const dir = mkdtempSync(join(tmpdir(), 'a0-e2e-'))
const killStatePath = join(dir, 'kill.json')
const now = () => Date.now()

const registry = createDeviceRegistry({ now })
// 1) 配一台 read 设备（配对只发 read），再显式授予 control（配对永不签发 control）
const pairing = registry.issuePairingCode()
const redeemed = registry.redeem({ code: pairing.code, name: 'e2e-reader' })
if ('error' in redeemed) throw new Error('配对失败：' + redeemed.error)
registry.grantControl(redeemed.device.id)
const reader = registry.list().find((device) => device.id === redeemed.device.id)
const token = redeemed.device.id + '.' + redeemed.secret
const scopes = reader?.scopes ?? []
process.stdout.write('设备已配对：' + redeemed.device.id + ' scopes=' + JSON.stringify(scopes) + String.fromCharCode(10))

let businessCalls = 0
const gateway = await createEdgeGateway({
  host: '127.0.0.1',
  port: 4591,
  registry,
  killStatePath,
  now,
  // 业务面：**每个请求都抛错**，模拟行情与 agent 全挂
  registerBusinessRoutes: (register) => {
    register('/v1', () => {
      businessCalls += 1
      throw new Error('market data and agent are both down (simulated)')
    })
    register('/v1/cards', () => {
      businessCalls += 1
      throw new Error('market data and agent are both down (simulated)')
    })
  },
})
process.stdout.write('edge 已起：' + gateway.url + String.fromCharCode(10))

const results = []
for (const path of A0_PATHS) {
  const response = await fetch(gateway.url + path, { headers: { authorization: 'Bearer ' + token } })
  const body = await response.text()
  results.push({ path, status: response.status, body: body.slice(0, 90) })
}
const business = await fetch(gateway.url + '/v1/cards', { headers: { authorization: 'Bearer ' + token } }).then(
  (response) => response.status,
  (error) => 'fetch-failed: ' + String(error.message).slice(0, 40),
)

process.stdout.write(String.fromCharCode(10) + '=== 业务面（模拟全挂）===' + String.fromCharCode(10))
process.stdout.write('GET /v1/cards -> ' + String(business) + '（业务调用次数 ' + String(businessCalls) + '）' + String.fromCharCode(10))
process.stdout.write(String.fromCharCode(10) + '=== 带外 A0 六条路径 ===' + String.fromCharCode(10))
for (const result of results) process.stdout.write(result.path.padEnd(14) + ' -> ' + String(result.status) + '  ' + result.body + String.fromCharCode(10))
const allOk = results.every((result) => result.status === 200)
process.stdout.write(String.fromCharCode(10) + (allOk ? '结论：业务面全挂时 A0 六条路径全部 200 ✓' : '结论：有 A0 路径未返回 200 ✗') + String.fromCharCode(10))

await gateway.close()
rmSync(dir, { recursive: true, force: true })
process.exit(allOk ? 0 : 1)
