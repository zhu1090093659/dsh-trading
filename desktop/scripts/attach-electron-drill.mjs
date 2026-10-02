#!/usr/bin/env node
/**
 * 附着模式的 **Electron 端到端演练**（P4 步骤 5 的接线验证，需要已下载 Electron 二进制）。
 *
 * 与 attach-drill.mjs 的分工：那个验"配置 → 决策"（无 GUI）；这个验**接线本身** ——
 * 真的把桌面壳起起来，看它 (a) 是否加载了远端 bot、(b) **是否没有起本地 host**。
 *
 * 观测手段（不依赖应用内部日志，因为 pushLogLine 只在 UI 请求时才落盘）：
 *   1. 自建一个记录请求的 HTTP 服务当作"远端 bot"，用它的访问记录证明窗口真的去加载了；
 *   2. 用进程表证明**没有** %%%%--profile trading-web%%%% 的本地 host 被派生出来；且只查
 *      **本次演练自己的进程**（ppid 链 + 进程组）—— 旧版在全机 ps 里 grep，机器上任何既存
 *      trading-web 实例（用户开着的 GUI、别的会话的 host）都会让这条断言假红。
 *
 * 回收：Electron 用 detached 起（POSIX 下 setsid ⇒ 自成进程组），结束时按**进程组** SIGKILL
 * 并等组清空 —— 只杀 desktop/node_modules/.bin/electron 这个包装脚本会把真 Electron 孤儿化
 * （2026-10-02 实测残留 1 个，见 AGENTS.md「跑完必查孤儿」）。残留未清即判 FAIL，不自证清白。
 *
 * 隔离：临时 DSH_HOME + 临时 --user-data-dir，结束全部清理；不碰真实 home 与正在运行的实例。
 * 退出码即断言。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const ELECTRON = join(REPO, 'desktop', 'node_modules', '.bin', 'electron')
const NL = String.fromCharCode(10)

/** 进程表解析：ps 的 -o 末尾加 = 关掉表头；只认"pid ppid pgid command"四列齐全的行。 */
function parsePs(text) {
  const rows = []
  for (const line of text.split(NL)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (match !== null) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] })
    }
  }
  return rows
}

function psTable() {
  const result = spawnSync('ps', ['-Ao', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
  return parsePs(result.stdout ?? '')
}

/**
 * 只收"本次演练自己"的进程：沿 ppid 链能追到 rootPid 的，或与 rootPid 同进程组的
 * （detached 起 ⇒ rootPid 即组长）。断言必须限定在自己的进程树里，不能拿全机进程表当证据。
 */
function ownProcesses(rows, rootPid) {
  const children = new Map()
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, [])
    children.get(row.ppid).push(row)
  }
  const own = new Map()
  const queue = [rootPid]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (own.has(child.pid)) continue
      own.set(child.pid, child)
      queue.push(child.pid)
    }
  }
  for (const row of rows) {
    if (row.pgid === rootPid) own.set(row.pid, row)
  }
  return [...own.values()]
}

/** 演练自己的进程里有没有被派生的本地 dsh host（附着模式下必须没有）。 */
function localHostProcesses(rows, rootPid) {
  return ownProcesses(rows, rootPid).filter((row) => row.command.includes('--profile trading-web'))
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 进程组回收：SIGKILL 整组（负 pid）再等组里成员消失，返回超时后仍活着的行。
 * 包装脚本与真 Electron 同组，一次 kill(-pid) 两边都收；单个 kill(pid) 会漏掉真 Electron。
 */
async function killGroup(pid, waitMs) {
  try { process.kill(-pid, 'SIGKILL') } catch { /* 组已不存在 */ }
  try { process.kill(pid, 'SIGKILL') } catch { /* 进程已退出 */ }
  const deadline = Date.now() + waitMs
  for (;;) {
    const left = psTable().filter((row) => row.pgid === pid && row.pid !== process.pid)
    if (left.length === 0 || Date.now() >= deadline) return left
    await delay(50)
  }
}

const home = mkdtempSync(join(tmpdir(), 'attach-electron-'))
const userdata = join(home, 'userdata')
const requests = []
let electron = null
let server = null
let failure = ''

// 前置：Electron 必须真的可用 —— 否则后面的"没有派生本地 host"会因为**什么都没跑**而假通过
// （第一版就踩了这个：二进制还在下载时演练报了 PASS，其实什么都没验）。
const probeEnv = { ...process.env }
delete probeEnv.ELECTRON_RUN_AS_NODE
const probe = spawn(ELECTRON, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: probeEnv, detached: true })
let probeOut = ''
probe.stdout.on('data', (chunk) => { probeOut += String(chunk) })
const probeCode = await new Promise((resolve) => probe.once('exit', resolve))
const probeLeftover = await killGroup(probe.pid, 3000)
if (probeCode !== 0 || !probeOut.trim().startsWith('v')) {
  process.stderr.write('[attach-electron] 跳过：Electron 不可用（' + probeOut.trim().slice(0, 120) + '）' + NL)
  process.exit(2)
}
process.stdout.write('[attach-electron] Electron ' + probeOut.trim() + NL)
if (probeLeftover.length > 0) {
  failure = '--version 探针的进程组未回收：' + probeLeftover[0].command.slice(0, 120)
}

try {
  server = createServer((req, res) => {
    requests.push(req.url ?? '/')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>远端 bot</title><h1>remote bot</h1>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const botUrl = 'http://127.0.0.1:' + String(server.address().port)
  writeFileSync(join(home, 'attach.json'), JSON.stringify({ botUrl }))
  writeFileSync(join(home, 'attach-device.json'), JSON.stringify({ botUrl, deviceId: 'dev_drill', secret: 'drill' }), { mode: 0o600 })

  // ELECTRON_RUN_AS_NODE 必须去掉：本会话环境里它是 1，Electron 会退化成普通 Node，
  // require(electron) 只拿到路径字符串、app 是 undefined，主进程直接崩
  // （实测报错：Cannot read properties of undefined (reading requestSingleInstanceLock)）。
  const env = { ...process.env, DSH_HOME: home }
  delete env.ELECTRON_RUN_AS_NODE
  // detached: true ⇒ setsid，Electron（含它派生的全部子进程）自成进程组，退出时整组回收。
  electron = spawn(ELECTRON, ['desktop', '--user-data-dir=' + userdata], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let stderr = ''
  electron.stderr.on('data', (chunk) => { stderr += String(chunk) })

  const deadline = Date.now() + 45_000
  while (requests.length === 0 && Date.now() < deadline && electron.exitCode === null) {
    await delay(500)
  }

  if (requests.length === 0) {
    failure = failure !== '' ? failure : electron.exitCode === null ? '窗口在 45 秒内没有去加载远端 bot' : 'Electron 提前退出：' + stderr.slice(-300)
  } else {
    process.stdout.write('  PASS  窗口加载了远端 bot — 收到请求 ' + JSON.stringify(requests.slice(0, 3)) + NL)
  }

  // 进程表断言：附着模式下不得派生本地 host —— 只看本次演练自己的进程树与进程组
  // （旧版全机 grep 的假红：本机任何既存 trading-web 实例都会被算到这次演练头上）。
  const rows = psTable()
  const own = ownProcesses(rows, electron.pid)
  const hostRows = localHostProcesses(rows, electron.pid)
  if (hostRows.length > 0) {
    failure = failure !== '' ? failure : '附着模式下仍派生了本地 host：' + hostRows[0].command.slice(0, 120)
  } else if (requests.length > 0) {
    process.stdout.write('  PASS  没有派生本地 host（只查本次演练的进程树：' + String(own.length) + ' 个进程，--profile trading-web 零命中）' + NL)
  }
  // 注意：只有"窗口确实加载了远端 bot"时，这条零命中才算证据 —— 否则它只是"什么都没跑"
} finally {
  if (electron !== null) {
    const leftover = await killGroup(electron.pid, 3000)
    if (leftover.length > 0) {
      failure = failure !== '' ? failure : '演练进程组未回收：' + leftover[0].command.slice(0, 120)
    }
  }
  server?.close()
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write(failure === '' ? '[attach-electron] 2/2 步通过' + NL : '[attach-electron] FAIL — ' + failure + NL)
process.exit(failure === '' ? 0 : 1)
