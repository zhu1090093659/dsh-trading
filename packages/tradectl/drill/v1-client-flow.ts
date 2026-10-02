#!/usr/bin/env node
/**
 * P4 客户端链路演练：**配对（真实 HTTP）→ 下行流（真实 HTTP 分块）**。
 *
 * 为什么要有它：配对的**客户端一半**（%%createPairingClient%%）与 %%/v1%% 的**下行一半**
 * （%%createV1Stream%% / %%createV1StreamForDevice%%）此前只有单测 —— 单测里注册表是进程内直调、
 * 下行 socket 是记录帧的假件，于是"客户端真的能对着生产面完成配对""下行帧真的能穿过 socket 到达
 * 客户端"这两件事没有任何运行时证据（wiring:ledger 判它们为「无调用点」）。
 *
 * 本演练用**真实组件**把这条链路跑一遍，且不引入任何下单能力：
 *   - 真的 edge 网关（%%createEdgeGateway%%，绑定 127.0.0.1 的临时端口）；
 *   - 真的设备注册表（%%createDeviceRegistry%%）：配对码签发 → %%POST /pair/redeem%% 兑换；
 *   - 配对客户端走**真的 HTTP**（fetch）而不是进程内直调，密钥写进注入的安全存储端口；
 *   - 用配对拿到的 Authorization 打真 edge 的 %%/a0/status%%（证明这确实是一份能用的身份，而不只是字符串）；
 *   - 下行会话由**已鉴权设备**建（%%createV1StreamForDevice%%），帧经真实 socket 分块下发。
 *
 * 三条端到端断言（退出码即判定）：
 *   1. **游标补页 + resync**：cursor=0 落在保留窗口之前 ⇒ 先收 resync 帧（带 snapshotSeq），再从快照续读，
 *      不漏也不重；cursor=1（窗口内）⇒ 直接续读、没有 resync；
 *   2. **不带游标 = 只要新的**：连接建立前就有的事件**一条都不重推**；
 *   3. **主机面绑定设备**：会话带 deviceId、缺 read 平面时只发带 required 的拒绝帧（零事件帧）、
 *      设备被 revoke 后同一条令牌立刻 401 且 handler 一次都没被调用。
 *
 * 传输说明（如实标注）：本演练把下行的 %%DownstreamSocket%% 端口适配成**分块 HTTP（每行一帧 JSON）**——
 * 端口本身与传输无关（文档化的真实实现是包一层 WebSocket）；生产 wire 归 %%/v1%% 的宿主装配决定，
 * 本演练只证明会话语义与设备绑定在真实 socket 上成立，不宣称这就是线上 wire。
 *
 * 用法：node packages/tradectl/drill/v1-client-flow.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJournal, type Journal } from '../src/journal.ts'
import { openLedgers } from '../src/db.ts'
import { PAIR_PATH, createDeviceRegistry, createEdgeGateway, type BusinessHandler } from '../src/edge.ts'
import { createPairingClient, type PairingTransport, type SecureStorage } from '../src/pairing-client.ts'
import { createV1StreamForDevice, type DownstreamFrame } from '../src/stream-v1.ts'

const NL = String.fromCharCode(10)
const failures: string[] = []
const check = (ok: boolean, message: string): void => { if (!ok) failures.push(message) }

const home = mkdtempSync(join(tmpdir(), 'v1-client-flow-'))
let tick = 1_700_000_000_000
const now = (): number => (tick += 1)

const ledgers = openLedgers(home)
// 保留窗口故意压到 2 条 + 每裁必落快照：这样"游标过界"可以用真的裁剪造出来，而不是靠假件模拟。
const journal: Journal = createJournal(ledgers.audit, { now, retention: { keep: 2, snapshotEvery: 1 } })
journal.append('drill.begin', { note: 'first' }, now())
journal.append('drill.middle', { note: 'second' }, now())
journal.append('drill.end', { note: 'third' }, now())
const retained = journal.retain() // 裁掉 seq <= 1，落一份 seq=1 的快照 ⇒ cursor=0 会过界

const registry = createDeviceRegistry({ now })
let handlerCalls = 0
let lastSessionDeviceId: string | null = null

/** 下行会话的宿主侧装配：已鉴权设备 → createV1StreamForDevice → 分块 HTTP 适配器 → pump 到底。 */
const downstreamHost: BusinessHandler = (req, res, device) => {
  handlerCalls += 1
  const url = new URL(req.url ?? '/', 'http://edge')
  const rawCursor = url.searchParams.get('cursor')
  let ended = false
  const finish = (): void => { if (!ended) { ended = true; res.end() } }
  const session = createV1StreamForDevice(device, { journal }).attach(
    { send: (text: string) => { res.write(text + NL) }, close: finish },
    rawCursor === null ? undefined : Number(rawCursor),
  )
  lastSessionDeviceId = session.deviceId
  for (let round = 0; round < 20 && !session.closed; round += 1) {
    if (session.pump() === 0) break
  }
  finish()
}

const gateway = await createEdgeGateway({
  host: '127.0.0.1',
  port: 0,
  registry,
  killStatePath: join(home, 'kill.json'),
  now,
  registerBusinessRoutes: (register) => { register('/v1/stream', downstreamHost, 'read') },
})

/** 安全存储端口的演练实现（真实实现是 Keychain/Keystore；这里只实现三个文档化动作）。 */
function memoryStorage(): SecureStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    async save(key, value) { items.set(key, value) },
    async load(key) { return items.get(key) },
    async remove(key) { items.delete(key) },
  }
}

let redeemCalls = 0
/** 真实 HTTP 兑换端口：打的是真 edge 的 /pair/redeem，不是进程内直调注册表。 */
const transport: PairingTransport = {
  async redeem(input) {
    redeemCalls += 1
    const response = await fetch(gateway.url + PAIR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: input.code, name: input.name }),
    })
    const body = (await response.json()) as { deviceId?: unknown; secret?: unknown; code?: unknown }
    if (!response.ok || typeof body.deviceId !== 'string' || typeof body.secret !== 'string') {
      return { error: typeof body.code === 'string' ? body.code : 'PAIR_HTTP_' + String(response.status) }
    }
    return { deviceId: body.deviceId, secret: body.secret }
  },
}

const storage = memoryStorage()
const client = createPairingClient({ transport, storage })

/** 取一页下行帧（真实 HTTP；每行一帧 JSON）。 */
async function readFrames(query: string, authorization?: string): Promise<{ status: number; frames: DownstreamFrame[] }> {
  const response = await fetch(gateway.url + '/v1/stream' + query, {
    headers: authorization === undefined ? {} : { authorization },
  })
  const text = await response.text()
  const frames = text.split(NL).filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as DownstreamFrame)
  return { status: response.status, frames }
}

const summary: Record<string, unknown> = { url: gateway.url, retained }
try {
  // —— ① 配对：真 HTTP 兑换 → 密钥进安全存储 → Authorization 真的能用 ——
  const { code } = registry.issuePairingCode()
  const outcome = await client.pair({ code, name: 'drill-phone' })
  summary.pair = outcome.ok ? { ok: true, deviceId: outcome.deviceId } : { ok: false, code: outcome.code }
  check(outcome.ok, '配对失败：' + (outcome.ok ? '' : outcome.code + ' / ' + outcome.message))
  if (outcome.ok) {
    const registered = registry.list().find((entry) => entry.id === outcome.deviceId)
    check(registered !== undefined, '配对待遇里的设备不在边缘注册表里：' + outcome.deviceId)
    check(registered !== undefined && registered.scopes.length === 1 && registered.scopes[0] === 'read',
      '配对签发的平面不是只有 read：' + JSON.stringify(registered?.scopes))
    const stored = storage.items.get('dshtrading.device')
    check(stored === outcome.deviceId + '.' + String(stored ?? '').slice(String(outcome.deviceId).length + 1) && String(stored).startsWith(outcome.deviceId + '.'),
      '安全存储里的密钥不是 <deviceId>.<secret> 形态：' + String(stored).slice(0, 12) + '…')
    check((await client.authorization()) === outcome.authorization, 'authorization() 与配对返回的授权头不一致')
    // 这份授权头必须是**能用的身份**：真打一次 edge 的 A0 面
    const status = await fetch(gateway.url + '/a0/status', { headers: { authorization: outcome.authorization } })
    const statusBody = (await status.json()) as { device?: unknown }
    check(status.status === 200, '配对拿到的授权头打 /a0/status 不是 200：' + String(status.status))
    check(statusBody.device === outcome.deviceId, 'A0 报的设备不是配对的那台：' + String(statusBody.device))
    const anonymous = await fetch(gateway.url + '/a0/status')
    check(anonymous.status === 401, '无令牌打 /a0/status 不是 401：' + String(anonymous.status))

    // —— ② 一次性配对码：同一个码再兑一次必须是「已被使用」，且客户端不重试 ——
    const before = redeemCalls
    const replay = await client.pair({ code, name: 'drill-phone' })
    check(replay.ok === false, '同一个配对码第二次兑换居然成功了')
    check(replay.ok === false && replay.code === 'PAIRING_CODE_UNKNOWN', '第二次兑换的错误码不是 PAIRING_CODE_UNKNOWN：' + (replay.ok ? '' : replay.code))
    check(redeemCalls === before + 1, '客户端对同一个码重试了：兑换调用 ' + String(redeemCalls - before) + ' 次')

    // —— ③ 下行流：游标过界 ⇒ resync 后从快照续读（真实 socket）——
    const expired = await readFrames('?cursor=0', outcome.authorization)
    summary.expired = expired.frames
    check(expired.status === 200, 'cursor=0 的下行请求不是 200：' + String(expired.status))
    check(expired.frames[0]?.type === 'resync', 'cursor=0 没有先给 resync 帧：' + JSON.stringify(expired.frames[0]))
    const resync = expired.frames[0]
    check(resync?.type === 'resync' && resync.snapshotSeq === retained.snapshotSeq,
      'resync 的 snapshotSeq 与裁剪快照不符：' + JSON.stringify(resync) + ' vs ' + String(retained.snapshotSeq))
    const expiredEvents = expired.frames.filter((frame) => frame.type === 'event')
    check(expiredEvents.length === 2 && expiredEvents.every((frame) => frame.type === 'event' && frame.seq > 1),
      'resync 之后没有从快照续读（应为 seq 2/3 两条）：' + JSON.stringify(expiredEvents))

    // 窗口内的游标：直接续读，没有 resync
    const inWindow = await readFrames('?cursor=1', outcome.authorization)
    check(inWindow.frames.every((frame) => frame.type === 'event'), 'cursor=1 不该出现 resync：' + JSON.stringify(inWindow.frames))
    check(inWindow.frames.length === 2, 'cursor=1 应续读两条：' + String(inWindow.frames.length))

    // 不带游标 = 只要新的：连接前就有的事件一条都不重推
    journal.append('drill.late', { note: 'after the first two reads' }, now())
    const freshOnly = await readFrames('', outcome.authorization)
    check(freshOnly.frames.length === 0, '不带游标却重推了历史事件：' + JSON.stringify(freshOnly.frames))
    check(lastSessionDeviceId === outcome.deviceId, '下行会话没有带上已鉴权设备的 deviceId：' + String(lastSessionDeviceId))

    // —— ④ 缺 read 平面：只发带 required 的拒绝帧，零事件帧 ——
    const refusedFrames: string[] = []
    let closedCalls = 0
    const refused = createV1StreamForDevice({ id: 'dev_drillnoread0000', scopes: ['command'] }, { journal }).attach({
      send: (text: string) => { refusedFrames.push(text) },
      close: () => { closedCalls += 1 },
    })
    check(refused.pump() === 0, '缺 read 平面却推了帧')
    check(refused.closed, '缺 read 平面却没有关闭会话')
    check(closedCalls === 1, '缺 read 平面时 close 调用次数不是 1：' + String(closedCalls))
    const refusal = refusedFrames.length === 1 ? (JSON.parse(refusedFrames[0] ?? '{}') as DownstreamFrame) : undefined
    check(refusal?.type === 'error' && refusal.code === 'SCOPE_REQUIRED' && refusal.required === 'read',
      '缺 read 平面的拒绝帧形态不对：' + JSON.stringify(refusedFrames))
    summary.refusal = refusal

    // —— ⑤ 撤销即时生效：同一条令牌立刻 401，且业务 handler 一次都没被调用 ——
    const callsBeforeRevoke = handlerCalls
    registry.revoke(outcome.deviceId)
    const revoked = await readFrames('?cursor=1', outcome.authorization)
    check(revoked.status === 401, '撤销后同一条令牌不是 401：' + String(revoked.status))
    check(handlerCalls === callsBeforeRevoke, '撤销后的请求居然进了业务 handler')

    // —— ⑥ forget：本地密钥清掉，回到未配对 ——
    await client.forget()
    check((await client.authorization()) === undefined, 'forget 之后 authorization() 还在')
    check(storage.items.size === 0, 'forget 之后安全存储里还有条目：' + String(storage.items.size))
  }
} catch (error) {
  failures.push('演练抛错：' + (error instanceof Error ? error.stack ?? error.message : String(error)))
} finally {
  await gateway.close()
  ledgers.close()
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write('[v1-client-flow] 摘要 ' + JSON.stringify(summary) + NL)
if (failures.length > 0) {
  process.stderr.write('[v1-client-flow] ✗ ' + String(failures.length) + ' 项断言失败：' + NL)
  for (const failure of failures) process.stderr.write('  - ' + failure + NL)
  process.exit(1)
}
process.stdout.write('[v1-client-flow] ✓ 客户端链路通过：真 HTTP 配对拿到可用身份、密钥只进安全存储、'
  + '下行按游标补页并对过界游标发 resync、不带游标只推新事件、缺 read 平面只发拒绝帧、撤销即时 401' + NL)
process.exit(0)
