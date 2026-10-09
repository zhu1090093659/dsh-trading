/**
 * 桥的判据（scripts/futu-openapi-bridge.py）：把"桥把输入的什么当真"钉住。
 *
 * 为什么这些用例必须打**真进程**、而不是复刻一份桥的逻辑：被验的东西正是"Python 运行时
 * 怎么读这个 JSON"——`True == 1` 会让 `trdSide: true` 落进 `(1, 2)`，这不是任何类型标注
 * 或阅读能挡住的（PR #103 审查发现 ②）。所以这里起一个真桥进程（`FUTU_BRIDGE_PORT=0`，
 * 由内核选端口，只监听回环），把请求真发过去，再看信封里的 retType/retMsg。
 *
 * 被验的几条都在碰 OpenD **之前**就被拒（布尔、缺 accId、GET 落 trd 路径），
 * 因此用例不要求 OpenD 在跑；也**不碰常驻桥 11112 与它的 LaunchAgent**。
 *
 * 部署侧要起这个桥时，仍按 scripts/futu-openapi-bridge.py 文件头的手工命令（11112 常驻或
 * FUTU_BRIDGE_PORT 旁路端口）；本文件只做输入判据，不做部署。
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BRIDGE = fileURLToPath(new URL('futu-openapi-bridge.py', import.meta.url))

/** 桥启动到打印 listening 的上界（毫秒）——上界不是期望耗时：真卡死照样超时变红。 */
const START_TIMEOUT_MS = 30_000

/** 本机可用的 Python 解释器（CI 的 ubuntu/macos/windows 镜像三个上都装了 python/python3）。 */
function pythonCommand() {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return undefined
}

/**
 * 解释器是否带 futu SDK：桥在模块加载期 import futu，缺这个包时桥起不来。
 * CI 三个镜像都装了 Python 但都没有 futu（2026-10-09 实测：只判 Python 存在会让
 * 本文件在 CI 上红——ModuleNotFoundError: No module named 'futu'）。被验的几条判据
 * 都在碰 OpenD 之前就拒绝，因此只要求 SDK 可导入，不要求 OpenD 在跑。
 */
function hasFutuModule(command) {
  if (command === undefined) return false
  const probe = spawnSync(command, ['-c', 'import futu'], { encoding: 'utf8' })
  return probe.status === 0
}

const PYTHON = pythonCommand()
const HAS_FUTU = hasFutuModule(PYTHON)

/** 起一个真桥进程，等它报出实际绑定的端口。 */
function startBridge() {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [BRIDGE], { env: { ...process.env, FUTU_BRIDGE_PORT: '0' } })
    const log = []
    let settled = false
    const onChunk = (chunk) => {
      log.push(chunk.toString('utf8'))
      const matched = /listening on 127\.0\.0\.1:(\d+)/.exec(log.join(''))
      if (matched !== null && !settled) {
        settled = true
        resolve({ child, port: Number(matched[1]), log })
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      reject(new Error('桥提前退出（code=' + String(code) + '），输出：' + log.join('')))
    })
  })
}

describe.skipIf(!HAS_FUTU)('futu-openapi-bridge 输入判据（真进程，回环随机端口）', () => {
  let bridge

  beforeAll(async () => {
    bridge = await startBridge()
  }, START_TIMEOUT_MS)

  afterAll(() => {
    bridge?.child.kill()
  })

  async function postJson(path, body) {
    const base = 'http://127.0.0.1:' + String(bridge.port)
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return await response.json()
  }

  it('operator：桥拒 JSON 布尔 trdSide —— true 不许被读成"买入"', async () => {
    // Given 一个把 JSON true 放进 trdSide 的请求（Python 里 True == 1，(1,2) 判真）
    // When 发到真桥
    const reply = await postJson('/api/trd/place-order', {
      security: 'HK.00700', trdSide: true, orderType: 1, qty: 100, price: 406.8, trdEnv: 'SIMULATE', accId: 0,
    })
    // Then retType -1 且点名 trdSide（不是拿 true 当 1 把单买出去）
    expect(reply.retType).toBe(-1)
    expect(reply.retMsg).toContain('trdSide 必须是 1(买)/2(卖) 的整数')
  })

  it('operator：桥拒 JSON 布尔 orderType —— true 不许被读成"限价"', async () => {
    // Given 一个把 JSON true 放进 orderType 的请求
    // When 发到真桥
    const reply = await postJson('/api/trd/place-order', {
      security: 'HK.00700', trdSide: 1, orderType: true, qty: 100, price: 406.8, trdEnv: 'SIMULATE', accId: 0,
    })
    // Then retType -1 且点名 orderType
    expect(reply.retType).toBe(-1)
    expect(reply.retMsg).toContain('orderType 必须是 1(限价)/2(市价) 的整数')
  })

  it('operator：桥拒 JSON 布尔 accId（不把 true 当成一个账户）', async () => {
    // Given 一个 accId 是 JSON true 的挂单查询
    // When 发到真桥
    const reply = await postJson('/api/trd/get-orders', { market: 'HK', trdEnv: 'SIMULATE', accId: true })
    // Then 结构化拒绝（不猜账户）
    expect(reply.retType).toBe(-1)
    expect(reply.retMsg).toContain('accId 不能是布尔值')
  })

  it('operator：cancel-order 缺 accId 被结构化拒绝（请求里没有 market，不猜上下文）', async () => {
    // Given 一条只带 orderId + trdEnv 的撤单请求
    // When 发到真桥
    const reply = await postJson('/api/trd/cancel-order', { orderId: '1', trdEnv: 'SIMULATE' })
    // Then 结构化拒绝并说明理由（客户端此前会在这一格留空，只能等到上游错误串）
    expect(reply.retType).toBe(-1)
    expect(reply.retMsg).toContain('必须给 accId')
  })

  it('operator：GET 落到 trd 路径被拒（三条路由只有 POST + JSON 一种传输）', async () => {
    // Given 对 trd 路径发 GET
    // When 发到真桥
    const response = await fetch('http://127.0.0.1:' + String(bridge.port) + '/api/trd/place-order', {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    })
    const reply = await response.json()
    // Then 明确回 POST-only（不静默当成空 body 的 POST）
    expect(reply.retType).toBe(-1)
    expect(reply.retMsg).toContain('POST-only')
  })

  it('operator：桥日志只打方法与结果，请求体（账户/对账锚）不进日志', () => {
    // Given 前面几条真请求已经在真桥上跑过
    // When 读桥自己打的那几行
    // Then 只有 METHOD path -> retType=N；security / trdSide / price 一个都不出现
    const text = bridge.log.join('')
    expect(text).toMatch(/POST \/api\/trd\/place-order -> retType=-1/)
    expect(text).not.toContain('HK.00700')
    expect(text).not.toContain('trdSide')
    expect(text).not.toContain('406.8')
  })
})
