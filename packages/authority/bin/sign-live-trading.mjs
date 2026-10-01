#!/usr/bin/env node
/**
 * 实盘授权平面的运营 CLI（人操作，不是 agent 工具，也不是任何 HTTP 端点）。
 *
 * 三个动作，全部在**本机**、由**人手**执行：
 *   init    生成运营方 Ed25519 密钥对，私钥落盘（0600），并打印 trusted-keys.json 内容
 *   sign    用私钥签一份带到期的实盘授权，写进授权平面目录
 *   status  只读打印当前判定（证明「打开实盘」没有别的入口，也证明撤销立刻生效）
 *
 * 为什么是 CLI 而不是接口：设计文档 §5「对外 API 永远不存在『打开实盘』这个端点」。
 * 授权是主密钥 + 可信界面 + 展示 diff 的人工动作。
 *
 * 用法：
 *   node packages/authority/bin/sign-live-trading.mjs init --key <private.pem> [--key-id operator-1] [--trust <trusted-keys.json>]
 *   node packages/authority/bin/sign-live-trading.mjs sign --key <private.pem> [--key-id operator-1] [--days 30] [--operator 名字] [--note "..."] [--dir <授权平面目录>]
 *   node packages/authority/bin/sign-live-trading.mjs status [--dir <授权平面目录>]
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

function resolveDir(runtime) {
  return flag('dir', undefined) ?? runtime.authorityDir()
}

async function cmdInit() {
  const { generateOperatorKeyPair, buildTrustedKeysDocument } = await loadSignModule()
  const keyFile = flag('key')
  if (!keyFile) throw new Error('init 需要 --key <private.pem>（私钥落盘路径）')
  const keyId = flag('key-id', 'operator-1')
  if (existsSync(keyFile)) throw new Error('私钥文件已存在，拒绝覆盖：' + keyFile)
  const pair = generateOperatorKeyPair(keyId)
  mkdirSync(dirname(keyFile), { recursive: true })
  writeFileSync(keyFile, pair.privateKeyPem, { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  const keysDoc = buildTrustedKeysDocument([{ keyId, alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
  const trustFile = flag('trust')
  if (trustFile) {
    mkdirSync(dirname(trustFile), { recursive: true })
    writeFileSync(trustFile, keysDoc)
    console.log('[authority] 受信任公钥目录已写入：' + trustFile)
  } else {
    console.log('[authority] 把下面这份内容人工写进授权平面的 trusted-keys.json：')
    console.log(keysDoc)
  }
  console.log('[authority] 私钥已落盘（0600）：' + keyFile + ' —— 它属于人，不属于任何 agent 可读路径。')
}

async function cmdSign() {
  const { signLiveTradingGrant, expiryFromDays } = await loadSignModule()
  const runtime = await loadRuntime()
  const keyFile = flag('key')
  if (!keyFile) throw new Error('sign 需要 --key <private.pem>')
  if (!existsSync(keyFile)) throw new Error('私钥文件不存在：' + keyFile)
  const keyId = flag('key-id', 'operator-1')
  const days = Number(flag('days', '30'))
  const dir = resolveDir(runtime)
  const issuedAtMs = Date.now()
  const payload = {
    liveTrading: true,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: expiryFromDays(issuedAtMs, days),
    operator: flag('operator', process.env.USER ?? 'operator'),
    note: flag('note', ''),
  }
  const grant = signLiveTradingGrant(payload, readFileSync(keyFile, 'utf8'), keyId)
  mkdirSync(dir, { recursive: true })
  const grantFile = join(dir, runtime.GRANT_FILENAME)
  writeFileSync(grantFile, grant)
  runtime.resetAuthorityCache()
  console.log('[authority] 授权已写入：' + grantFile)
  console.log('  签署人 ' + payload.operator + ' / 密钥 ' + keyId + ' / 到期 ' + payload.expiresAt)
  const decision = runtime.liveTradingDecision(true, { dir })
  console.log('  复验：' + decision.reason + ' —— ' + decision.detail)
}

async function cmdStatus() {
  const runtime = await loadRuntime()
  const dir = resolveDir(runtime)
  console.log('[authority] 授权平面目录：' + dir)
  for (const file of [runtime.TRUSTED_KEYS_FILENAME, runtime.GRANT_FILENAME]) {
    console.log('  · ' + file + '：' + (existsSync(join(dir, file)) ? '存在' : '缺失'))
  }
  const decision = runtime.liveTradingDecision(true, { dir })
  console.log('[authority] 以镜像 liveTrading=true 判定：' + (decision.allowed ? '放行' : '拒绝')
    + '（' + decision.reason + '）—— ' + decision.detail)
  console.log('[authority] 撤销 = 删掉 ' + join(dir, runtime.GRANT_FILENAME) + '（下一次判定即生效，无需重启）。')
}

async function main() {
  if (action === 'init') return cmdInit()
  if (action === 'sign') return cmdSign()
  if (action === 'status') return cmdStatus()
  console.error('用法：sign-live-trading.mjs <init|sign|status> [--key <pem>] [--key-id id] [--days N] [--dir DIR]')
  process.exit(2)
}

main().catch((error) => {
  console.error('[authority] ' + (error?.message ?? error))
  process.exit(1)
})
