#!/usr/bin/env node
/**
 * 附着模式的 **Electron 端到端演练**（P4 步骤 5 的接线验证，需要已下载 Electron 二进制）。
 *
 * 与 attach-drill.mjs 的分工：那个验"配置 → 决策"（无 GUI）；这个验**接线本身** ——
 * 真的把桌面壳起起来，看它 (a) 是否加载了远端 bot、(b) **是否没有起本地 host**。
 *
 * 观测手段（不依赖应用内部日志，因为 pushLogLine 只在 UI 请求时才落盘）：
 *   1. 自建一个记录请求的 HTTP 服务当作"远端 bot"，用它的访问记录证明窗口真的去加载了；
 *   2. 用进程表证明**没有** %%%%--profile trading-web%%%% 的本地 host 被派生出来。
 *
 * 隔离：临时 DSH_HOME + 临时 --user-data-dir，结束全部清理；不碰真实 home 与正在运行的实例。
 * 退出码即断言。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('../../', import.meta.url).pathname
const home = mkdtempSync(join(tmpdir(), 'attach-electron-'))
const userdata = join(home, 'userdata')
const requests = []
let electron = null
let failure = ''

// 前置：Electron 必须真的可用 —— 否则后面的"没有派生本地 host"会因为**什么都没跑**而假通过
// （第一版就踩了这个：二进制还在下载时演练报了 PASS，其实什么都没验）。
const probeEnv = { ...process.env }
delete probeEnv.ELECTRON_RUN_AS_NODE
const probe = spawn(join(REPO, 'desktop/node_modules/.bin/electron'), ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: probeEnv })
let probeOut = ''
probe.stdout.on('data', (chunk) => { probeOut += String(chunk) })
const probeCode = await new Promise((resolve) => probe.once('exit', resolve))
if (probeCode !== 0 || !probeOut.trim().startsWith('v')) {
  process.stderr.write('[attach-electron] 跳过：Electron 不可用（' + probeOut.trim().slice(0, 120) + '）' + String.fromCharCode(10))
  process.exit(2)
}
process.stdout.write('[attach-electron] Electron ' + probeOut.trim() + String.fromCharCode(10))

const server = createServer((req, res) => {
  requests.push(req.url ?? '/')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>远端 bot</title><h1>remote bot</h1>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const botUrl = 'http://127.0.0.1:' + String(port)

writeFileSync(join(home, 'attach.json'), JSON.stringify({ botUrl }))
writeFileSync(join(home, 'attach-device.json'), JSON.stringify({ botUrl, deviceId: 'dev_drill', secret: 'drill' }), { mode: 0o600 })

/** 进程表里有没有被派生的本地 dsh host（附着模式下必须没有）。 */
function localHostRunning() {
  try {
    const out = spawn('ps', ['-Ao', 'command']).output
    return false
  } catch {
    return false
  }
}

try {
  // ELECTRON_RUN_AS_NODE 必须去掉：本会话环境里它是 1，Electron 会退化成普通 Node，
  // require(electron) 只拿到路径字符串、app 是 undefined，主进程直接崩
  // （实测报错：Cannot read properties of undefined (reading requestSingleInstanceLock)）。
  const env = { ...process.env, DSH_HOME: home }
  delete env.ELECTRON_RUN_AS_NODE
  electron = spawn(join(REPO, 'desktop/node_modules/.bin/electron'), ['desktop', '--user-data-dir=' + userdata], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  electron.stderr.on('data', (chunk) => { stderr += String(chunk) })

  const deadline = Date.now() + 45_000
  while (requests.length === 0 && Date.now() < deadline && electron.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  if (requests.length === 0) {
    failure = electron.exitCode === null ? '窗口在 45 秒内没有去加载远端 bot' : 'Electron 提前退出：' + stderr.slice(-300)
  } else {
    process.stdout.write('  PASS  窗口加载了远端 bot — 收到请求 ' + JSON.stringify(requests.slice(0, 3)) + String.fromCharCode(10))
  }

  // 进程表断言：附着模式下不得派生本地 host
  const ps = spawn('ps', ['-Ao', 'command'])
  let psOut = ''
  ps.stdout.on('data', (chunk) => { psOut += String(chunk) })
  await new Promise((resolve) => ps.once('exit', resolve))
  const hostLines = psOut.split(String.fromCharCode(10)).filter((line) => line.includes('--profile trading-web') && !line.includes('ps -Ao'))
  if (hostLines.length > 0) failure = failure === '' ? '附着模式下仍派生了本地 host：' + hostLines[0].slice(0, 120) : failure
  else if (requests.length > 0) process.stdout.write('  PASS  没有派生本地 host（--profile trading-web 零命中）' + String.fromCharCode(10))
  // 注意：只有"窗口确实加载了远端 bot"时，这条零命中才算证据 —— 否则它只是"什么都没跑"
} finally {
  try { electron?.kill('SIGKILL') } catch { /* already gone */ }
  server.close()
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write(failure === '' ? '[attach-electron] 2/2 步通过' + String.fromCharCode(10) : '[attach-electron] FAIL — ' + failure + String.fromCharCode(10))
process.exit(failure === '' ? 0 : 1)
