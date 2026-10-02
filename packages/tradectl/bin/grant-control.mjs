#!/usr/bin/env node
/**
 * 运维 control 授予入口（部署形态下"一键 kill"闭环的另一半）。
 *
 * 为什么需要它：配对**永不签发 control**（§7.4、edge 的 grantableByDefault），而 control 是
 * kill/pause/flatten 的唯一通行证；配对给的凭据打 /a0/kill 一律 403。在这条 CLI 之前，
 * `registry.grantControl` 在生产里**没有任何调用点** —— 也就是"紧急刹车"在部署形态下没有
 * 可用的签发动作（F2 报告点名的缺口）。
 *
 * 三条 fail-closed 纪律，每条都对应一种"看起来成功了"的坏形态：
 *   1. **注册表不可达即拒绝**：只走 edge 进程里的运维 UDS（`--socket`）。连不上就退出码非 0，
 *      不重试、不降级、不写任何本地状态 —— 一个"先记下来以后再授予"的队列会让操作者以为
 *      刹车已经准备好，而实际上没有。
 *   2. **不接受通配与批量**：`--device` 必须是一台设备的完整 id（`dev_` + 16 位十六进制）。
 *      `*`、逗号列表、重复给的 `--device` 一律拒绝：control 是停掉一切的开关，
 *      "授予所有人"与"授予一台"在命令里必须长得完全不一样。
 *   3. **只做一件事**：没有 `--all`、没有 `--revoke`、没有交互确认之外的分支；
 *      未知参数一律拒绝启动（未知即放宽）。
 *
 * 用法：node packages/tradectl/bin/grant-control.mjs --device=<dev_…> --socket=<path>
 * （socket 也可用 $EDGE_OPS_SOCKET 给；它是 edge 入口 `--ops-socket` 绑定的那条本地 UDS。）
 *
 * @module @dshtrading/tradectl/bin/grant-control
 */
import { pickImplementation } from './runtime.mjs'

const NL = String.fromCharCode(10)

const VALUE_FLAGS = new Set(['device', 'socket'])

const USAGE = [
  '用法：node packages/tradectl/bin/grant-control.mjs --device=<dev_…> --socket=<path>',
  '',
  '  --device=<id>   要授予 control 的设备 id（完整形态 dev_ + 16 位十六进制；不接受通配或批量）',
  '  --socket=<path> edge 的运维 UDS 路径（也可用 $EDGE_OPS_SOCKET；连不上即拒绝）',
  '  --help',
].join(NL)

/** 请求超时：授予是操作者盯着做的动作，"挂着"比"失败"更糟（失败能重来，挂着看不出没做）。 */
const REQUEST_TIMEOUT_MS = 5_000

function parseArgs(argv) {
  const values = new Map()
  const unknown = []
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help') {
      help = true
      continue
    }
    if (!token.startsWith('--')) {
      unknown.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    if (!VALUE_FLAGS.has(name)) {
      unknown.push(token)
      continue
    }
    let value = eq >= 0 ? token.slice(eq + 1) : undefined
    if (value === undefined) {
      value = argv[index + 1]
      index += 1
    }
    if (value === undefined) {
      unknown.push(token + '（缺值）')
      continue
    }
    // 重复给同一个 flag 一律拒绝：--device 出现两次时"用哪一个"没有正确答案
    if (values.has(name)) {
      unknown.push(token + '（重复：' + name + ' 只能给一次）')
      continue
    }
    values.set(name, value)
  }
  return { values, unknown, help }
}

function fail(message, code) {
  process.stderr.write('[grant-control] ' + message + NL)
  return code
}

function withTimeout(promise, label) {
  let timer = null
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(label + ' 超时（' + String(REQUEST_TIMEOUT_MS) + 'ms）')) }, REQUEST_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => { if (timer !== null) clearTimeout(timer) })
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE + NL)
    return 0
  }
  if (args.unknown.length > 0) {
    return fail('未知或非法参数：' + args.unknown.join('、') + ' —— 本命令只签发一台设备的 control' + NL + USAGE, 2)
  }
  const deviceId = args.values.get('device')
  const socketPath = args.values.get('socket') ?? process.env.EDGE_OPS_SOCKET
  if (deviceId === undefined || deviceId === '') return fail('缺少 --device=<id>' + NL + USAGE, 2)
  if (socketPath === undefined || socketPath === '') return fail('缺少 --socket=<path>（或 $EDGE_OPS_SOCKET）：不知道 edge 在哪就无从确认授予，本命令不猜' + NL + USAGE, 2)

  const impl = pickImplementation()
  const [edge, uds] = await Promise.all([impl.load('edge'), impl.load('uds')])

  // 通配/批量在**发请求之前**就被拒：这一类输入如果到了服务端，说明本地这道也是空的
  if (!edge.isDeviceId(deviceId)) {
    return fail('设备 id 形态不合法：' + JSON.stringify(deviceId)
      + '。要求完整 id（dev_ + 16 位十六进制）；通配（*）、逗号列表与半截 id 一律拒绝 —— '
      + 'control 是停掉一切的开关，授予所有人必须做不到。', 2)
  }

  let client
  try {
    client = await uds.connectUds(socketPath)
  } catch (error) {
    return fail('注册表不可达：连不上 ' + socketPath + '（' + (error instanceof Error ? error.message : String(error)) + '）。'
      + 'edge 没在跑、--ops-socket 没开、或路径不对 —— 本命令**不重试、不降级、不记待办**：'
      + '授予没发生就是没发生，别让操作者以为刹车已经准备好。', 3)
  }
  try {
    const response = await withTimeout(
      client.request({ protocolVersion: uds.PROTOCOL_VERSION, method: 'grant-control', params: { deviceId } }),
      'grant-control',
    )
    if (response.error !== undefined) {
      return fail('edge 拒绝授予：' + response.error.code + ' —— ' + response.error.message, 4)
    }
    const result = response.result
    const scopes = result !== null && typeof result === 'object' && Array.isArray(result.scopes) ? result.scopes : []
    process.stdout.write('[grant-control] ✓ 已授予 ' + deviceId + ' control；该设备现有平面 ' + JSON.stringify(scopes) + NL)
    process.stdout.write('[grant-control] 撤销入口：本命令只签发；撤销走 registry.revoke（部署面入口待接线）' + NL)
    return 0
  } catch (error) {
    return fail('授予失败：' + (error instanceof Error ? error.message : String(error)) + '（注册表不可达或 edge 无响应 ⇒ 拒绝，不当成成功）', 3)
  } finally {
    await client.close().catch(() => undefined)
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write('[grant-control] 失败：' + (error instanceof Error ? error.stack ?? error.message : String(error)) + NL)
    process.exitCode = 1
  })
