#!/usr/bin/env node
/**
 * 实盘授权平面的运营 CLI（人操作，不是 agent 工具，也不是任何 HTTP 端点）。
 *
 * 三个动作，全部在**本机**、由**人手**执行：
 *   init    生成运营方 Ed25519 密钥对，私钥落盘（0600），并把 trusted-keys.json 写进平面
 *   sign    用私钥签一份带到期的实盘授权，写进授权平面目录
 *   status  只读打印当前判定（证明「打开实盘」没有别的入口，也证明撤销立刻生效）
 *
 * 为什么是 CLI 而不是接口：设计文档 §5「对外 API 永远不存在『打开实盘』这个端点」。
 * 授权是主密钥 + 可信界面 + 展示 diff 的人工动作。
 *
 * **没有默认平面目录**（验收发现 #1）：init/sign 必须给出 --dir（或
 * $DSH_TRADING_AUTHORITY_DIR）。缺省落在 $DSH_HOME/authority 会让 agent 用自己 uid
 * 自铸信任锚并自我授权。
 *
 * 写平面的人还必须声明 agent 跑在哪个 uid 下（--agent-uid / $DSH_TRADING_AUTHORITY_AGENT_UID）：
 * 声明不了、或声明成当前 uid（自铸形态）一律拒绝。只有在**显式开发形态**（--force-dev，
 * 名字里带 dev）下才放行，且签出的授权带 payload.dev=true —— 读取端没有同一个 opt-in 时
 * 会拒绝它（dev-grant-not-accepted）。
 *
 * 用法：
 *   node packages/authority/bin/sign-live-trading.mjs init --key <private.pem> [--key-id operator-1] [--dir <平面目录> | --trust <trusted-keys.json>] [--agent-uid <uid>] [--force-dev]
 *   node packages/authority/bin/sign-live-trading.mjs sign --key <private.pem> --dir <平面目录> [--key-id operator-1] [--days 30] [--operator 名字] [--note "..."] [--agent-uid <uid>] [--force-dev]
 *   node packages/authority/bin/sign-live-trading.mjs status [--dir <平面目录>]
 */
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const action = argv[0]
const flag = (name, fallback) => {
  const at = argv.indexOf('--' + name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const has = (name) => argv.includes('--' + name)

function loadSignModule() {
  const entry = new URL('../lib/sign.js', import.meta.url)
  try {
    return import(entry.href)
  } catch (error) {
    console.error('[authority] 找不到构建产物 ' + entry.pathname + '：先跑 pnpm build（tsdown 产出 lib/）。')
    throw error
  }
}

async function loadRuntime() {
  return import(new URL('../lib/index.js', import.meta.url).href)
}

function usageError(message) {
  console.error('[authority] ' + message)
  console.error('用法：sign-live-trading.mjs <init|sign|status> [--key <pem>] [--dir <平面目录>] [--trust <trusted-keys.json>] [--key-id id] [--days N] [--agent-uid <uid>] [--force-dev]')
  process.exit(2)
}

/** 平面目录：--dir > $DSH_TRADING_AUTHORITY_DIR > 未配置（**没有默认位置**）。 */
function resolveDir(runtime, required = true) {
  const explicit = flag('dir', undefined)
  if (explicit !== undefined) return explicit
  const fromEnv = process.env[runtime.AUTHORITY_DIR_ENV]
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv
  if (!required) return undefined
  usageError('必须显式给出平面目录：--dir <目录> 或 ' + runtime.AUTHORITY_DIR_ENV
    + '=<目录>。本工具没有默认位置——缺省落在 $DSH_HOME/authority 等于让 agent 用自己 uid 自铸信任锚。')
}

/** 声明的 agent uid：--agent-uid > $DSH_TRADING_AUTHORITY_AGENT_UID > 未声明。 */
function declaredAgentUid(runtime) {
  const raw = flag('agent-uid', undefined) ?? process.env[runtime.AUTHORITY_AGENT_UID_ENV]
  if (raw === undefined || String(raw).trim().length === 0) return undefined
  const parsed = Number(String(raw).trim())
  if (!Number.isInteger(parsed) || parsed < 0) usageError('agent uid 必须是非负整数，实际 ' + JSON.stringify(raw))
  return parsed
}

function operatorContext(runtime) {
  return {
    agentUid: declaredAgentUid(runtime),
    forceDev: has('force-dev'),
    env: process.env,
  }
}

async function cmdInit() {
  const { initTrustAnchor } = await loadSignModule()
  const runtime = await loadRuntime()
  const keyFile = flag('key')
  if (!keyFile) usageError('init 需要 --key <private.pem>（私钥落盘路径）')
  const trustFlag = flag('trust', undefined)
  const dir = trustFlag !== undefined ? dirname(trustFlag) : resolveDir(runtime)
  const explicitDir = flag('dir', undefined) ?? process.env[runtime.AUTHORITY_DIR_ENV]
  if (trustFlag !== undefined && explicitDir !== undefined && explicitDir !== dir) {
    usageError('--trust 必须落在平面目录里：--trust 的父目录是 ' + dir + '，而 --dir/' + runtime.AUTHORITY_DIR_ENV + ' 是 ' + explicitDir)
  }
  const result = initTrustAnchor({
    dir,
    keyFile,
    keyId: flag('key-id', 'operator-1'),
    writeTrust: trustFlag !== undefined,
    ...operatorContext(runtime),
  })
  console.log('[authority] 私钥已落盘（0600）：' + result.keyFile + ' —— 它属于人，不属于任何 agent 可读路径。')
  if (result.trustWritten) {
    console.log('[authority] 受信任公钥目录已写入：' + result.trustFile)
  } else {
    console.log('[authority] 把下面这份内容人工写进授权平面的 ' + runtime.TRUSTED_KEYS_FILENAME + '（' + join(dir, runtime.TRUSTED_KEYS_FILENAME) + '）：')
    console.log(JSON.stringify({ version: 1, keys: [{ keyId: result.keyId, alg: 'ed25519', publicKeyPem: result.publicKeyPem }] }, null, 2))
  }
  console.log('[authority] 平面目录：' + dir + '（' + result.detail + '）')
  if (result.devMode) console.error('[authority][DEV] 这是开发形态：授权文档会带 payload.dev=true，读取端没有 ' + runtime.AUTHORITY_DEV_ENV + '=1 时会拒绝它。')
}

async function cmdSign() {
  const { signGrantIntoPlane } = await loadSignModule()
  const runtime = await loadRuntime()
  const keyFile = flag('key')
  if (!keyFile) usageError('sign 需要 --key <private.pem>')
  const dir = resolveDir(runtime)
  const result = signGrantIntoPlane({
    dir,
    keyFile,
    keyId: flag('key-id', 'operator-1'),
    days: Number(flag('days', '30')),
    operator: flag('operator', process.env.USER ?? 'operator'),
    note: flag('note', ''),
    ...operatorContext(runtime),
  })
  console.log('[authority] 授权已写入：' + result.grantFile)
  console.log('  签署人 ' + (result.payload.operator ?? '未署名') + ' / 密钥 ' + result.keyId + ' / 到期 ' + result.payload.expiresAt)
  if (result.devMode) console.error('[authority][DEV] 这是开发形态授权（payload.dev=true）：只对显式设置 ' + runtime.AUTHORITY_DEV_ENV + '=1 的读取端生效，不是生产授权。')
  // 复验从**声明的 agent uid** 视角做：那才是这条授权真正会被判定的地方。
  const agentUid = declaredAgentUid(runtime)
  const decision = runtime.liveTradingDecision(true, agentUid === undefined ? { dir } : { dir, euid: agentUid })
  console.log('  复验（' + (agentUid === undefined ? '本进程 uid' : '声明的 agent uid ' + agentUid) + ' 视角）：' + decision.reason + ' —— ' + decision.detail)
}

async function cmdStatus() {
  const runtime = await loadRuntime()
  const dir = resolveDir(runtime, false)
  if (dir === undefined) {
    const decision = runtime.liveTradingDecision(true, { env: process.env })
    console.log('[authority] 授权平面目录：未配置（--dir 或 ' + runtime.AUTHORITY_DIR_ENV + '）—— 没有默认位置')
    console.log('[authority] 以镜像 liveTrading=true 判定：拒绝（' + decision.reason + '）—— ' + decision.detail)
    return
  }
  console.log('[authority] 授权平面目录：' + dir)
  for (const file of [runtime.TRUSTED_KEYS_FILENAME, runtime.GRANT_FILENAME]) {
    let present = false
    try {
      present = statSync(join(dir, file)).isFile()
    } catch {
      present = false
    }
    console.log('  · ' + file + '：' + (present ? '存在' : '缺失'))
  }
  const agentUid = declaredAgentUid(runtime)
  const decision = runtime.liveTradingDecision(true, agentUid === undefined ? { dir } : { dir, euid: agentUid })
  if (agentUid !== undefined) console.log('[authority] 判定视角：声明的 agent uid ' + agentUid)
  console.log('[authority] 平面隔离：' + (decision.isolation === undefined ? '未检查' : decision.isolation.code)
    + ' —— ' + (decision.isolation === undefined ? '目录未配置' : decision.isolation.detail))
  console.log('[authority] 以镜像 liveTrading=true 判定：' + (decision.allowed ? '放行' : '拒绝')
    + '（' + decision.reason + '）—— ' + decision.detail)
  if (decision.devMode) console.error('[authority][DEV] 判定在开发形态下做出（' + runtime.AUTHORITY_DEV_ENV + '=1）：这不是生产授权。')
  console.log('[authority] 撤销 = 删掉 ' + join(dir, runtime.GRANT_FILENAME) + '（下一次判定即生效，无需重启）。')
}

async function main() {
  if (action === 'init') return cmdInit()
  if (action === 'sign') return cmdSign()
  if (action === 'status') return cmdStatus()
  usageError('未知动作 ' + JSON.stringify(action ?? ''))
}

main().catch((error) => {
  const code = error?.code
  console.error('[authority] ' + (typeof code === 'string' && code.length > 0 ? code + '：' : '') + (error?.message ?? error))
  process.exit(1)
})
