#!/usr/bin/env node
/**
 * 运维撤销入口 —— 授权生命周期的另一半（授予在 %%bin/grant-control.mjs%%，撤销在这里）。
 *
 * 为什么需要它：设备注册表落盘之后，一台丢失/换手的设备的授权**会跨重启一直有效**；
 * 没有撤销入口，唯一的"收回"手段就是删文件重启 edge（会连带作废全部设备）。所以撤销必须
 * 是一条能指名道姓、能立刻生效、能把结果说清楚的命令。
 *
 * 为什么是**独立文件**而不是给 grant-control.mjs 加 %%--revoke%%：
 *   1. **撤销不是"反向的授予"**：grant-control 的纪律是"只做一件事"（文档里写死了没有
 *      %%--revoke%%），而"能授予的人"与"能撤销的人"在部署面本可以是两种角色 —— 两个二进制
 *      才能在 OS 权限层面分开（给谁哪个文件的执行权）。
 *   2. **一个 %%--revoke%% 布尔量表达不了两种破坏力**：收回 control（其余作用域保留，设备
 *      照样能读）与作废整台设备（令牌立即失效、必须重新配对）差一个量级。破坏性命令里
 *      "收哪个"不许由默认值或省略决定 —— 所以两个模式必须**显式二选一**。
 *
 * 三条与 grant-control 同款的 fail-closed 纪律：
 *   1. **注册表不可达即拒绝**（退出码 3）：只走 edge 进程里的本地运维 UDS（%%--socket%%），
 *      连不上就失败，不重试、不降级、不写任何本地"待撤销"清单 —— 一份待办清单会让操作者
 *      以为设备已经收回，而实际上没有。
 *   2. **不接受通配与批量**（退出码 2）：%%--device%% 必须是一台设备的完整 id
 *      （%%dev_%% + 16 位十六进制）。%%*%%、逗号列表、重复给 %%--device%% 一律拒绝。
 *   3. **退出码 0 只给"真的撤销了"**（退出码 4）：设备不在册（%%OPS_DEVICE_UNKNOWN%%）、
 *      或本来就没有 control（%%OPS_CONTROL_ABSENT%%）都不算成功 —— 前者没什么可撤，后者什么
 *      都没变；两者的消息里都会把"现在到底还剩什么"原样打出来。
 *
 * 用法：node packages/tradectl/bin/revoke-control.mjs (--revoke-control | --revoke-device) \
 *         --device=<dev_…> [--socket=<path>]
 * （socket 也可用 $EDGE_OPS_SOCKET 给；它是 edge 入口 `--ops-socket` 绑定的那条本地 UDS。）
 *
 * @module @dshtrading/tradectl/bin/revoke-control
 */
import { pickImplementation } from './runtime.mjs'

const NL = String.fromCharCode(10)

const VALUE_FLAGS = new Set(['device', 'socket'])
/** 两个撤销模式：必须且只能给一个（见文件头第 2 条理由）。 */
const MODE_FLAGS = ['revoke-control', 'revoke-device']

const USAGE = [
  '用法：node packages/tradectl/bin/revoke-control.mjs (--revoke-control | --revoke-device) --device=<dev_…> [--socket=<path>]',
  '',
  '  --revoke-control       只收回这台设备的 control；read / command 等其余作用域原样保留',
  '  --revoke-device        整台设备作废：令牌立即失效（设备从注册表移除，要回来只能重新配对）',
  '  --device=<id>          目标设备 id（完整形态 dev_ + 16 位十六进制；不接受通配或批量）',
  '  --socket=<path>        edge 的运维 UDS 路径（也可用 $EDGE_OPS_SOCKET；连不上即拒绝）',
  '  --help',
  '',
  '两个模式必须且只能给一个：撤销的破坏力差一个量级，"收哪个"不许由默认值决定。',
  '退出码：0 = 撤销真的发生了；2 = 用法 / 通配 / 半截 id（在发请求之前就拒，一次都不连）；',
  '        3 = 运维通道连不上或超时；4 = edge 明确拒绝（OPS_DEVICE_UNKNOWN / OPS_CONTROL_ABSENT）。',
].join(NL)

/** 请求超时：撤销是操作者盯着做的动作，"挂着"比"失败"更糟（失败能重来，挂着看不出没做）。 */
const REQUEST_TIMEOUT_MS = 5_000

function parseArgs(argv) {
  const values = new Map()
  const modes = new Set()
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
    if (MODE_FLAGS.includes(name)) {
      // 模式不带值（--revoke-control=yes 这种写法一律拒绝：未知即放宽）
      if (eq >= 0) {
        unknown.push(token)
        continue
      }
      modes.add(name)
      continue
    }
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
  return { values, modes, unknown, help }
}

function fail(message, code) {
  process.stderr.write('[revoke] ' + message + NL)
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
    return fail('未知或非法参数：' + args.unknown.join('、') + NL + USAGE, 2)
  }
  // 模式：必须且只能给一个。"两个都给"与"一个都不给"都没有正确答案 —— 不做默认值。
  if (args.modes.size !== 1) {
    return fail('必须且只能给一个撤销模式（收到 ' + String(args.modes.size) + ' 个：'
      + (args.modes.size === 0 ? '（无）' : [...args.modes].join('、')) + '）：'
      + '--revoke-control 只收回紧急刹车、其余作用域保留；--revoke-device 整台设备作废。'
      + '两者破坏力差一个量级，本命令不替你选。' + NL + USAGE, 2)
  }
  const method = args.modes.has('revoke-control') ? 'revoke-control' : 'revoke-device'
  const deviceId = args.values.get('device')
  const socketPath = args.values.get('socket') ?? process.env.EDGE_OPS_SOCKET
  if (deviceId === undefined || deviceId === '') return fail('缺少 --device=<id>' + NL + USAGE, 2)
  if (socketPath === undefined || socketPath === '') return fail('缺少 --socket=<path>（或 $EDGE_OPS_SOCKET）：不知道 edge 在哪就无从确认撤销，本命令不猜' + NL + USAGE, 2)

  const impl = pickImplementation()
  const [edge, uds] = await Promise.all([impl.load('edge'), impl.load('uds')])

  // 通配/批量在**发请求之前**就被拒：这一类输入如果到了服务端，说明本地这道也是空的
  if (!edge.isDeviceId(deviceId)) {
    return fail('设备 id 形态不合法：' + JSON.stringify(deviceId)
      + '。要求完整 id（dev_ + 16 位十六进制）；通配（*）、逗号列表与半截 id 一律拒绝 —— '
      + '撤销必须指名道姓，一台就是一台。', 2)
  }

  let client
  try {
    client = await uds.connectUds(socketPath)
  } catch (error) {
    return fail('注册表不可达：连不上 ' + socketPath + '（' + (error instanceof Error ? error.message : String(error)) + '）。'
      + 'edge 没在跑、--ops-socket 没开、或路径不对 —— 本命令**不重试、不降级、不记待办**：'
      + '撤销没发生就是没发生，别让操作者以为权限已经收回。', 3)
  }
  try {
    const response = await withTimeout(
      client.request({ protocolVersion: uds.PROTOCOL_VERSION, method, params: { deviceId } }),
      method,
    )
    if (response.error !== undefined) {
      return fail('edge 拒绝撤销：' + response.error.code + ' —— ' + response.error.message
        + '（退出码 4：撤销没有发生，别按"大概成功了"往下走）', 4)
    }
    const result = response.result
    const scopes = result !== null && typeof result === 'object' && Array.isArray(result.scopes) ? result.scopes : []
    if (method === 'revoke-control') {
      process.stdout.write('[revoke] ✓ 已收回 ' + deviceId + ' 的 control；该设备现有平面 ' + JSON.stringify(scopes)
        + '（其余作用域保留；同一凭据打 /a0/kill 现在是 403）' + NL)
      return 0
    }
    const remaining = result !== null && typeof result === 'object' && typeof result.devicesRemaining === 'number'
      ? result.devicesRemaining
      : undefined
    process.stdout.write('[revoke] ✓ 已作废整台设备 ' + deviceId + '：它的令牌立即失效'
      + '（设备已从注册表移除，现有平面 ' + JSON.stringify(scopes) + '；要回来只能重新配对）' + NL)
    if (remaining !== undefined) process.stdout.write('[revoke] 注册表还剩 ' + String(remaining) + ' 台设备' + NL)
    return 0
  } catch (error) {
    return fail('撤销失败：' + (error instanceof Error ? error.message : String(error)) + '（注册表不可达或 edge 无响应 ⇒ 拒绝，不当成成功）', 3)
  } finally {
    await client.close().catch(() => undefined)
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write('[revoke] 失败：' + (error instanceof Error ? error.stack ?? error.message : String(error)) + NL)
    process.exitCode = 1
  })
