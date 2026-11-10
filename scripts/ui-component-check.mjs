#!/usr/bin/env node
/**
 * 组件级 UI 取证：把某个视图/harness 入口构建成**单文件 HTML**，用真实 Chrome 打开，
 * 按 harness 自己声明的步骤驱动、断言、截图，作为「改前 / 改后」同场景对照证据。
 *
 * 为什么有它（2026-11-10 owner 裁决）：本仓界面验收的默认通道是本机 headless Chrome +
 * CDP。全宿主断言由 scripts/ui-functional-check.mjs 承担（起 trading-web 实例，需要
 * profile 已接线）；视图级改动往往只动一个组件，且本机（Linux）没有 macOS/Windows
 * 桌面壳可跑——组件级 harness 用真实浏览器渲染目标组件本身，不必先接 profile。
 *
 * 为什么走 file:// 单文件而不是 dev server（2026-11-10 本机实测）：本机 Chrome 拉不到
 * 任何本地 HTTP 服务（vite dev server、python http.server 一律停在 about:blank /
 * chrome-error，连会话自带的 Chrome 也一样），而 data:/file: 页面正常渲染——所以
 * runner 用 vite 打成 IIFE 单文件、把 JS/CSS 内联进 HTML，再以 file:// 打开。harness
 * 自己桩掉数据面，页面运行期不需要网络。
 *
 * 用法：
 *   node scripts/ui-component-check.mjs --harness packages/<pkg>/harness/<name>.harness.tsx
 *     [--out <dir>]       截图目录（缺省 /tmp/dsh-ui-component/<harness 名>）
 *     [--viewport 1280x900]
 *     [--timeout 30000]   ready 等待上限（ms）
 *     [--keep]            结束后保留临时目录（默认清理）
 *     [--chrome <bin>]    浏览器可执行文件（缺省 $DSH_UI_CHROME 或 google-chrome）
 *
 * harness 契约：页面在 window.__uiHarness 上声明自己，runner 只负责装载、驱动、截图、判定：
 *   ready  : boolean | Promise  —— 真值 / 落定后 runner 才开始跑步骤
 *   steps  : [{ name, run?, expect?, shot? }]
 *     name   步骤名（截图文件名前缀）
 *     run    页面内执行的 JS 表达式字符串（可 await）：点击、切换等驱动
 *     expect 页面内执行的 JS 表达式字符串，返回 { ok, detail } 或布尔；缺省只截图不断言
 *     shot   缺省 true；false 表示这一步不截图
 *
 * 依赖：node 内置 fetch/WebSocket + vite（经 vitest 的依赖解析）+ 本机 Chrome。
 * 退出码：0 = 全绿；1 = 有 FAIL / 页面异常 / 构建失败。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const hasFlag = (name) => args.includes(name)

const harnessArg = argOf('--harness', null)
if (harnessArg === null) {
  console.error('用法：node scripts/ui-component-check.mjs --harness <file.tsx> [--out <dir>] [--viewport 1280x900]')
  process.exit(2)
}
const harness = resolve(ROOT, harnessArg)
const harnessName = harness.split('/').pop().replace(/\.(tsx|jsx|ts|js)$/, '')
const outDir = resolve(argOf('--out', join('/tmp/dsh-ui-component', harnessName)))
const viewport = String(argOf('--viewport', '1280x900')).split('x').map(Number)
const viewW = viewport[0]
const viewH = viewport[1]
const readyTimeout = Number(argOf('--timeout', '30000'))
const keep = hasFlag('--keep')
const chromeBin = argOf('--chrome', process.env.DSH_UI_CHROME ?? 'google-chrome')

/** vite 不在本仓根依赖里，经 vitest（自带 vite 依赖）解析：与 vitest 跑测试时同一份工具链。 */
function loadVite() {
  const req = createRequire(join(ROOT, 'x.js'))
  const vitestDir = dirname(req.resolve('vitest/package.json'))
  const vitePath = createRequire(join(vitestDir, 'x.js')).resolve('vite')
  return import(pathToFileURL(vitePath).href)
}

const freePort = () => new Promise((res, rej) => {
  const srv = createServer()
  srv.on('error', rej)
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port
    srv.close(() => res(port))
  })
})

const results = []
const pageErrors = []
let chrome = null
let chromeDir = null
let buildDir = null

function cleanup() {
  if (chrome !== null && chrome.pid !== undefined) {
    // headless Chrome 不吃 SIGTERM（2026-10-21 实测）：起独立进程组、整组 SIGKILL，
    // 再清临时 profile——与 ui-functional-check / attach-electron-drill 同一口径。
    try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} }
    chrome = null
  }
  if (!keep) {
    const dirs = [chromeDir, buildDir]
    for (const dir of dirs) {
      if (dir !== null) { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
    }
  }
}
process.on('exit', cleanup)

/** vite 构建 harness（IIFE，依赖全打包）→ 把 JS/CSS 内联进单文件 HTML。 */
async function buildSingleFile(vite) {
  buildDir = mkdtempSync(join(tmpdir(), 'dsh-ui-component-'))
  const distDir = join(buildDir, 'dist')
  await vite.build({
    configFile: false,
    root: dirname(harness),
    logLevel: 'warn',
    esbuild: { jsx: 'automatic' },
    // 浏览器里没有 process：react / lightweight-charts 的 CJS 分支会读
    // process.env.NODE_ENV（2026-11-10 实测 file:// 首跑即 ReferenceError）。
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: distDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      cssCodeSplit: false,
      lib: { entry: harness, formats: ['iife'], name: 'UiHarness', fileName: () => 'harness.js' },
    },
  })
  const jsFile = join(distDir, 'harness.js')
  const js = readFileSync(jsFile, 'utf8')
  const cssFile = readdirSync(distDir).find((name) => name.endsWith('.css'))
  const css = cssFile === undefined ? '' : readFileSync(join(distDir, cssFile), 'utf8')
  const htmlFile = join(buildDir, 'harness.html')
  writeFileSync(htmlFile, '<!doctype html>\n'
    + '<html lang="zh-CN"><head><meta charset="utf-8"><title>' + harnessName + '</title>\n'
    + '<style>html,body{margin:0;height:100%;background:#fff;color:#1f2329}\n' + css + '</style>\n'
    + '</head><body><div id="root" style="height:100%"></div>\n'
    + '<script>window.process = { env: { NODE_ENV: "production" } };</script>\n'
    + '<script>' + js + '</script></body></html>\n')
  console.log('[ui-component] 单文件 HTML ' + htmlFile + '（js ' + Math.round(js.length / 1024) + 'KB，css ' + Math.round(css.length / 1024) + 'KB）')
  return htmlFile
}

async function main() {
  const vite = await loadVite()
  const htmlFile = await buildSingleFile(vite)
  const url = pathToFileURL(htmlFile).href

  const cdpPort = await freePort()
  chromeDir = mkdtempSync(join(tmpdir(), 'dsh-ui-component-chrome-'))
  chrome = execFile(chromeBin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=2', '--allow-file-access-from-files',
    '--remote-debugging-port=' + cdpPort, '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + chromeDir, '--window-size=' + viewW + ',' + viewH, url,
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })

  // 只认 URL 命中的 page 目标：headless Chrome 启动瞬间就有一个 about:blank 目标，
  // 取「第一个 page」会挂到空白页上（2026-11-10 实测：诊断 href=about:blank、body 为空）。
  let page = null
  let lastTargets = []
  for (let i = 0; i < 60 && page === null; i++) {
    await sleep(300)
    try {
      const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
      lastTargets = list.filter((t) => t.type === 'page').map((t) => t.url).slice(0, 5)
      page = list.find((t) => t.type === 'page' && t.url.startsWith(url)) ?? null
    } catch {}
  }
  if (page === null) throw new Error('未取得 Chrome 页面目标（CDP ' + cdpPort + '，targets=' + JSON.stringify(lastTargets) + '）')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const opened = await Promise.race([
    new Promise((res) => { ws.onopen = () => res('open'); ws.onerror = () => res('error') }),
    sleep(10000).then(() => 'timeout'),
  ])
  if (opened !== 'open') throw new Error('CDP WebSocket 未在 10s 内建立（' + opened + '）')

  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? 'unknown').slice(0, 400))
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push('console.error: ' + (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
    }
  }
  // 每个 CDP 调用都有上限：WS 掉线时 pending 永不落定，裸 Promise 会把整轮取证挂死。
  const send = (method, params) => {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    return Promise.race([
      new Promise((res) => pending.set(id, res)),
      sleep(15000).then(() => ({ __timeout: true, method })),
    ])
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: viewW, height: viewH, deviceScaleFactor: 2, mobile: false })

  const evalRaw = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails !== undefined) {
      return { __error: String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text ?? 'eval failed').slice(0, 400) }
    }
    return r.result?.result?.value
  }
  // awaitPromise 的 evaluate 在页面 Promise 永不落定时会挂死整条 CDP 调用
  // （2026-11-10 实测：harness 未 ready 时 runner 一直等到外层超时）。所有页面求值
  // 一律套一层页面内 race，超时返回标记而不是无限等。
  const evalJs = (expression, budgetMs) => evalRaw(
    '(async () => { const t = {}; const v = await Promise.race([' + expression + ', new Promise((r) => setTimeout(() => r(t), ' + (budgetMs ?? 10000) + '))]); return v === t ? { __timeout: true } : v })()',
  )

  // ready：await 兼容 boolean 与 Promise 两种声明。
  const deadline = Date.now() + readyTimeout
  let ready = false
  while (!ready && Date.now() < deadline) {
    const v = await evalJs('(async () => { const h = window.__uiHarness; if (!h || h.ready === undefined) return false; await h.ready; return true })()', 3000)
    if (v === true) ready = true
    else await sleep(200)
  }
  if (!ready) {
    const diag = await evalJs('(() => ({ href: location.href, ready: document.readyState, harness: typeof window.__uiHarness, body: (document.body?.innerHTML ?? "").slice(0, 200) }))()')
    throw new Error('harness 未在 ' + readyTimeout + 'ms 内 ready（window.__uiHarness.ready 未落定）\n    诊断: ' + JSON.stringify(diag))
  }

  const steps = await evalJs('Array.isArray(window.__uiHarness.steps) ? window.__uiHarness.steps.map((s) => ({ name: s.name, run: s.run, expect: s.expect, shot: s.shot !== false })) : null')
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('harness 未声明步骤（window.__uiHarness.steps 为空）')

  mkdirSync(outDir, { recursive: true })
  let index = 0
  for (const step of steps) {
    index += 1
    const label = String(index).padStart(2, '0') + '-' + step.name
    if (typeof step.run === 'string' && step.run !== '') {
      const ran = await evalJs(step.run, 15000)
      if (ran !== null && typeof ran === 'object' && '__error' in ran) {
        results.push({ label, ok: false, detail: 'run 抛错：' + ran.__error })
        continue
      }
    }
    // 落地窗口：React 提交 + 图表 resize 各一帧，再给布局一个稳定窗口。
    await evalJs('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', 3000)
    await sleep(250)
    if (typeof step.expect === 'string' && step.expect !== '') {
      const got = await evalJs(step.expect, 10000)
      const ok = got === true || (got !== null && typeof got === 'object' && got.ok === true)
      const detail = got !== null && typeof got === 'object' ? String(got.detail ?? (got.__error ?? JSON.stringify(got))) : String(got)
      results.push({ label, ok, detail })
    } else {
      results.push({ label, ok: true, detail: '（无断言）' })
    }
    if (step.shot) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const file = join(outDir, label + '.png')
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      results[results.length - 1].shot = file
    }
  }
}

try {
  await main()
} catch (error) {
  console.error('[ui-component] FAIL  ' + (error instanceof Error ? error.message : String(error)))
  for (const e of pageErrors.slice(0, 10)) console.error('    page: ' + e.split('\n')[0])
  cleanup()
  process.exit(1)
}

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.label + (r.detail !== undefined && r.detail !== '' ? ' — ' + r.detail : ''))
}
for (const r of results) if (r.shot !== undefined) console.log('        shot: ' + r.shot)
if (pageErrors.length > 0) {
  console.log('  页面异常 ' + pageErrors.length + ' 条：')
  for (const e of pageErrors.slice(0, 10)) console.log('    ' + e.split('\n')[0])
}
cleanup()
console.log('[ui-component] ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败' + (pageErrors.length > 0 ? ' / 页面异常 ' + pageErrors.length : ''))
process.exit(failed > 0 || pageErrors.length > 0 ? 1 : 0)
