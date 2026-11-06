#!/usr/bin/env node
/**
 * ⑤ 附着模式的**切换演练**（P4 步骤 5 的证据之二：一次切换演练记录，含回滚点）。
 *
 * 演练范围**如实说明**：跑的是"配置 → 决策"这一层（真文件、真环境变量、临时 DSH_HOME），
 * **不启动 Electron**（本机没有可跑的 GUI 验证路径）。所以它证明的是"决策与配置读取正确、
 * 可切过去、可滚回来"，不证明"桌面壳窗口里真的换成了远端"。
 *
 * 硬约束遵循：全程使用**临时 DSH_HOME**（卡片：同一份 $DSH_HOME 同一时刻只允许一个 host 写者），
 * 演练结束删除临时目录，绝不触碰真实 home 与正在运行的实例。
 *
 * 退出码即断言（同 a0-e2e 的做法）。
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resolveHostMode, loadBotUrl } = require('../src/attach-mode.cjs')

const home = mkdtempSync(join(tmpdir(), 'attach-drill-'))
const steps = []
let failed = 0

function expectStep(name, actual, predicate, detail) {
  const ok = predicate(actual)
  steps.push({ name, ok, detail })
  if (!ok) failed += 1
  process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name + ' — ' + detail + String.fromCharCode(10))
}

function decide(env) {
  return resolveHostMode({ botUrl: loadBotUrl({ home, env }) })
}

try {
  process.stdout.write('[attach-drill] 临时 DSH_HOME: ' + home + String.fromCharCode(10))

  // ① 未配置：保持现状
  const initial = decide({})
  expectStep('① 未配置 ⇒ 起本地 host（现状）', initial, (m) => m.mode === 'local', initial.mode + ' / ' + initial.reason)

  // ② 写入内网 bot 配置：切到附着
  writeFileSync(join(home, 'attach.json'), JSON.stringify({ botUrl: 'http://192.168.1.20:8888/' }))
  const attached = decide({})
  expectStep('② 配内网 bot ⇒ 附着且不再起本地 host', attached, (m) => m.mode === 'attach' && m.url === 'http://192.168.1.20:8888', String(attached.url))

  // ③ 环境变量优先（脚本化/临时场景）
  const fromEnv = decide({ DSH_TRADING_BOT_URL: 'http://10.0.0.5:9999' })
  expectStep('③ 环境变量优先于配置文件', fromEnv, (m) => m.mode === 'attach' && m.url === 'http://10.0.0.5:9999', String(fromEnv.url))

  // ④ 公网地址：拒绝附着（fail-closed）
  writeFileSync(join(home, 'attach.json'), JSON.stringify({ botUrl: 'https://bot.example.com' }))
  const publicUrl = decide({})
  expectStep('④ 公网地址 ⇒ 回落本地（fail-closed）', publicUrl, (m) => m.mode === 'local', publicUrl.reason)

  // ⑤ 回滚点：删掉配置 ⇒ 回到现状
  unlinkSync(join(home, 'attach.json'))
  const rolledBack = decide({})
  expectStep('⑤ 回滚（删配置）⇒ 回到起本地 host', rolledBack, (m) => m.mode === 'local', rolledBack.reason)

  // ⑥ 坏配置不能让 App 起不来
  writeFileSync(join(home, 'attach.json'), '{ not json')
  const broken = decide({})
  expectStep('⑥ 坏配置 ⇒ 仍能起本地 host（不抛错）', broken, (m) => m.mode === 'local', broken.reason)
} finally {
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write('[attach-drill] ' + (6 - failed) + '/6 步通过' + String.fromCharCode(10))
process.exit(failed === 0 ? 0 : 1)
