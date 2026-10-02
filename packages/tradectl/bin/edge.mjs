#!/usr/bin/env node
/**
 * edge 网关的进程入口（§2.1 三进程里的第三个：**唯一对网络暴露的进程**）。
 *
 * 它做四件事，其余不做：
 *   1. **绑定判定**：只接受回环或私网地址（§12.4「只在内网运行，不设公网入口」），
 *      %%0.0.0.0%% / %%::%% 与公网地址一律拒绝启动；
 *   2. **kill 状态可写性前置校验**（fail-closed）：%%/a0/kill%% 是"我方全挂时还成立"的那条
 *      带外通路（§13 #25），而它落盘是**同目录 temp+rename** ⇒ 目录不可写就等于 kill 在最需要
 *      的时候失败。所以启动时先探一次写，写不进去**拒绝启动**，不是等出事才发现；
 *   3. **起 %%createEdgeGateway%%**：A0 六端点先于业务面；业务面（%%/v1%%）归 bot/cockpit 后续注册，
 *      本入口不注册任何业务路由（也就不给"未实现的业务面"制造假象）；
 *   4. **优雅退出**：SIGINT/SIGTERM 关网关后退出，退出码 0。
 *
 * 设备注册表**落盘**（2026-10-02 补）：%%--device-registry=<path>%% 是必填项 —— 注册表文件是
 * 授权事实的家（配对结果、control 授予、逐设备撤销），不落盘就等于"edge 一重启，所有设备与
 * 授权一起消失"。启动时加载：文件不存在 = 空表（首次启动的正常状态），**损坏/认不出即拒绝启动**
 * （退出码 5，fail-closed，不许静默当空表）；文件只有 sha256(secret)，没有明文密钥。
 * 为什么必填而不是"不给就退回内存表"：那正是"看起来在跑、其实授权一重启就没了"的静默降级。
 *
 * 为什么这是"库的可执行入口"而不是设计 §2.2 禁止的"自建 application bin"：同 %%bin/core.mjs%% ——
 * edge 是独立 OS principal 的基础设施进程，不含任何产品功能，也不进 npm 分发（private 包、无 bin 字段）。
 *
 * @module @dshtrading/tradectl/bin/edge
 */
import { dirname } from 'node:path'

import { pickImplementation } from './runtime.mjs'

const NL = String.fromCharCode(10)

const VALUE_FLAGS = new Set(['bind', 'port', 'kill-state', 'device-registry', 'shell-dir', 'ops-socket'])
const BOOL_FLAGS = new Set(['issue-pairing-code', 'help'])

const USAGE = [
  '用法：node packages/tradectl/bin/edge.mjs --kill-state=<path> --device-registry=<path> [选项]',
  '',
  '  --kill-state=<path>      带外 kill 状态文件（必填：edge 写、核心每次风险判定读）',
  '  --device-registry=<path> 设备注册表文件（必填：配对/授予/撤销都落在这里，重启后仍在册）。',
  '                           文件不存在 = 空表；损坏或认不出 ⇒ 拒绝启动（退出码 5）。只存 sha256(secret)',
  '                           且权限 0600。不给就拒绝启动：内存表 = 重启即全部设备失效的静默降级',
  '  --bind=<host>            监听地址（缺省 $EDGE_BIND，再缺省 127.0.0.1；0.0.0.0/:: 与公网地址拒绝）',
  '  --port=<n>               端口（缺省 $EDGE_PORT，再缺省 8899）',
  '  --shell-dir=<path>       驾驶舱静态壳目录（§7.4：壳入口与壳资源免令牌，仅 GET/HEAD 精确路径；',
  '                           目录里出现非静态文件即拒绝启动。不给就一条静态路径都不开）',
  '  --ops-socket=<path>      运维通道（本地 UDS）：只服务 grant-control / revoke-control /',
  '                           revoke-device。不给就不开这条通路 —— 于是"授予/撤销 control"只能拒绝',
  '                           （fail-closed），不是在网络面开一个口子',
  '  --issue-pairing-code     启动时签发一个配对码并打印（10 分钟有效；缺省不签发）',
  '  --help',
].join(NL)

/** 私网/回环判定：§12.4 只在内网运行 —— 公网地址不是"配置错误"，是**架构外**。 */
function isPrivateBind(host) {
  if (host === 'localhost' || host === '::1') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  const private172 = /^172\.(\d+)\./.exec(host)
  if (private172 !== null) {
    const second = Number(private172[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

function parseArgs(argv) {
  const values = new Map()
  const booleans = new Set()
  const unknown = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      unknown.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    if (BOOL_FLAGS.has(name)) {
      if (eq >= 0) {
        unknown.push(token)
        continue
      }
      booleans.add(name)
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
    values.set(name, value)
  }
  return { values, booleans, unknown }
}

function fail(message, code) {
  process.stderr.write('[edge] ' + message + NL)
  return code
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.booleans.has('help')) {
    process.stdout.write(USAGE + NL)
    return 0
  }
  if (args.unknown.length > 0) {
    return fail('未知参数：' + args.unknown.join('、') + ' —— 未知即放宽，本入口拒绝启动' + NL + USAGE, 2)
  }
  const killStatePath = args.values.get('kill-state')
  if (killStatePath === undefined || killStatePath === '') {
    return fail('缺少 --kill-state=<path>：A0 kill 落不了盘的 edge 不该启动（fail-closed）' + NL + USAGE, 2)
  }
  // 绑定与端口：命令行优先，其次 systemd 单元里那两行 Environment（单一事实，不两处各写一份）。
  const host = args.values.get('bind') ?? process.env.EDGE_BIND ?? '127.0.0.1'
  if (!isPrivateBind(host)) {
    return fail(
      '拒绝绑定 ' + host + '：edge 只监听回环或私网接口（设计 §12.4 仅内网，无公网入口）。'
      + '0.0.0.0/:: 与公网地址属架构外，不是"配置问题"。',
      2,
    )
  }
  const port = Number(args.values.get('port') ?? process.env.EDGE_PORT ?? '8899')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return fail('--port 需要一个 1-65535 的整数，收到 ' + String(args.values.get('port')), 2)

  const impl = pickImplementation()
  const [edge, detectors, uds] = await Promise.all([impl.load('edge'), impl.load('detectors'), impl.load('uds')])

  // 静态壳：**在起服务之前**解析一次（目录不合规必须表现为启动失败，而不是运行期某条路径 404）。
  // 解析结果同时用于打印"到底公开了几条路径"—— 这是运维最该看见的一行。
  const shellDir = args.values.get('shell-dir')
  let shell = null
  if (shellDir !== undefined && shellDir !== '') {
    try {
      shell = edge.createStaticShell(shellDir)
    } catch (error) {
      return fail('静态壳目录不合规：' + (error instanceof Error ? error.message : String(error)), 4)
    }
  }

  // kill 状态必须**真的写得进去**（同目录 temp+rename）：写不进去 ⇒ 拒绝启动。
  const killDir = dirname(killStatePath)
  const probe = detectors.probeWritable(killDir)
  if (!probe.writable) {
    return fail('kill 状态目录不可写（' + killDir + '）：' + probe.reason
      + '。A0 kill 是最需要时唯一还成立的通路，本入口不允许它在运行期才发现写不进去。', 3)
  }

  // 设备注册表：路径必填（见文件头"为什么必填"），目录同样先探一次写 —— 注册表的每次授权变更
  // 都是"先落盘再改内存"，目录不可写 ⇒ 第一台设备配对就会失败，而那正是最需要它成功的时候。
  const registryPath = args.values.get('device-registry')
  if (registryPath === undefined || registryPath === '') {
    return fail('缺少 --device-registry=<path>：注册表落不了盘的 edge 不该启动'
      + '（设备与授权会在重启后全部消失，那是静默降级）' + NL + USAGE, 2)
  }
  const registryDir = dirname(registryPath)
  const registryProbe = detectors.probeWritable(registryDir)
  if (!registryProbe.writable) {
    return fail('设备注册表目录不可写（' + registryDir + '）：' + registryProbe.reason
      + '。注册表每次授权变更都先落盘再改内存，写不进去就不要启动。', 5)
  }

  const now = () => Date.now()
  // 加载失败（文件损坏、版本认不出、条目形态不合规）⇒ 拒绝启动，不当成空表：空表意味着
  // "所有设备都不在册"，而那会让每一次鉴权都 401 —— 一个没人知道为什么的全面失联。
  let registry
  try {
    registry = edge.createDeviceRegistry({ now, storePath: registryPath })
  } catch (error) {
    return fail('设备注册表不可用（' + registryPath + '）：' + (error instanceof Error ? error.message : String(error))
      + '。拒绝启动：注册表读不懂时"设备还在不在册"不允许变成没人知道答案的问题。', 5)
  }

  /**
   * 运维通道（本地 UDS，不是网络面）：**唯一**的生产 grant-control 入口。
   * 为什么是 UDS 而不是再开一条 HTTP 端点：授予 control 是"把紧急刹车交给某台设备"，
   * 而这个动作需要有权限的人在一台能碰到 edge socket 的机器上完成；放到网络面上就等于
   * 给"第一台 control 设备"这件事加了一条远程攻击面（先有 control 才能授权 control 是死锁，
   * 所以那条端点必然要免令牌）。socket 的权限（0750/0660）就是这里的边界。
   * 只服务三个方法（grant-control / revoke-control / revoke-device）：unknown 一律结构化拒绝
   * （未知即放宽）。三个方法都**只碰在册设备**：不在册 ⇒ OPS_DEVICE_UNKNOWN，不"顺手建一台"。
   */
  const OPS_METHODS = ['grant-control', 'revoke-control', 'revoke-device']
  /** 撤销之后"到底还剩什么"必须可读：每次改完都从注册表里把当前平面取回来回给调用方。 */
  const scopesOf = (deviceId) => {
    const entry = registry.list().find((device) => device.id === deviceId)
    return entry === undefined ? [] : entry.scopes
  }
  const opsSocketPath = args.values.get('ops-socket')
  const ops = opsSocketPath === undefined || opsSocketPath === ''
    ? null
    : await uds.createUdsServer({
      socketPath: opsSocketPath,
      handle: (frame) => {
        const method = String(frame.method)
        if (!OPS_METHODS.includes(method)) {
          return { error: { code: 'OPS_METHOD_UNKNOWN', message: '本通道只服务 ' + OPS_METHODS.join(' / ') + '，收到 ' + method } }
        }
        const params = (frame.params ?? {})
        const deviceId = params.deviceId
        // 形态校验在**这里**再做一遍（CLI 也做）：通道是边界，边界不信任调用方。
        if (!edge.isDeviceId(deviceId)) {
          return { error: { code: 'OPS_DEVICE_ID_INVALID', message: '需要一个 dev_ + 16 位十六进制的设备 id；通配与批量一律拒绝（control 是停掉一切的开关）' } }
        }
        const device = registry.list().find((entry) => entry.id === deviceId)
        if (device === undefined) {
          return { error: { code: 'OPS_DEVICE_UNKNOWN', message: '注册表里没有这台设备：' + deviceId } }
        }
        if (method === 'grant-control') {
          // 授予是幂等的：已经持有 control 的设备再授一次不算错误（目标状态已经达成）。
          registry.grantControl(deviceId)
          return { result: { deviceId, scopes: scopesOf(deviceId) } }
        }
        if (method === 'revoke-control') {
          // "本来就没有 control" ⇒ 明确拒绝，不当成成功：撤销的退出码 0 必须意味着**真的收回了**，
          // 而这里什么都没变。消息里带上当前平面，操作者一眼看到还剩什么（不必再跑一条查询）。
          if (!device.scopes.includes('control')) {
            return { error: { code: 'OPS_CONTROL_ABSENT', message: '这台设备本来就没有 control（当前平面 ' + JSON.stringify(device.scopes) + '），没有可撤销的东西' } }
          }
          registry.revokeControl(deviceId)
          return { result: { deviceId, scopes: scopesOf(deviceId) } }
        }
        // revoke-device：整台设备作废。撤销后该设备**什么都不剩**（scopes 空数组），
        // 另报注册表里还剩几台 —— 那是"整台作废"之后运维最需要知道的那个数。
        registry.revoke(deviceId)
        return { result: { deviceId, scopes: [], devicesRemaining: registry.list().length } }
      },
    })

  const gateway = await edge.createEdgeGateway({
    host,
    port,
    registry,
    killStatePath,
    now,
    ...(shell === null ? {} : { shell: { dir: shell.dir } }),
    // 业务面（/v1）归 bot/cockpit：本进程不注册任何业务路由 —— 未实现的表面不造假象。
  })

  let stopping = false
  const startedAt = Date.now()
  const stop = async (reason) => {
    if (stopping) return
    stopping = true
    await gateway.close()
    if (ops !== null) await ops.close()
    const state = edge.readKillState(killStatePath)
    process.stdout.write('[edge] 退出原因=' + reason + ' 运行 ' + String(Date.now() - startedAt) + 'ms' + NL)
    process.stdout.write('[edge] kill 状态 ' + JSON.stringify(state) + NL)
    process.exitCode = 0
  }
  process.on('SIGINT', () => { void stop('SIGINT') })
  process.on('SIGTERM', () => { void stop('SIGTERM') })

  process.stdout.write('[edge] 已启动：' + gateway.url + ' 绑定=' + host + ':' + String(port)
    + ' 实现=' + impl.why + ' kill 状态=' + killStatePath + '（目录可写：' + probe.reason + '）' + NL)
  process.stdout.write('[edge] A0：' + edge.A0_PATHS.join(' ')
    + '；设备注册表=' + registryPath + '（在册 ' + String(registry.list().length) + ' 台，'
    + '只存 sha256 散列、权限 0600、目录可写：' + registryProbe.reason + '）' + NL)
  process.stdout.write('[edge] 静态壳：' + (shell === null
    ? '未托管（--shell-dir 未给：一条静态路径都不公开）'
    : shell.dir + ' ⇒ 免令牌精确路径 ' + String(shell.paths.length) + ' 条（仅 GET/HEAD）：' + shell.paths.join(' ')) + NL)
  process.stdout.write('[edge] 运维通道：' + (ops === null
    ? '未开（--ops-socket 未给 ⇒ 授予/撤销 control 只会失败，fail-closed）'
    : ops.socketPath + '（只服务 ' + OPS_METHODS.join(' / ') + '；本地 UDS，不在网络面上）') + NL)
  if (args.booleans.has('issue-pairing-code')) {
    const pairing = registry.issuePairingCode()
    process.stdout.write('[edge] 配对码 ' + pairing.code + '（' + String(Math.round(edge.PAIRING_TTL_MS / 60000)) + ' 分钟内有效；配对只签发 read scope）' + NL)
  }
  return 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write('[edge] 启动失败：' + (error instanceof Error ? error.stack ?? error.message : String(error)) + NL)
    process.exitCode = 1
  })
