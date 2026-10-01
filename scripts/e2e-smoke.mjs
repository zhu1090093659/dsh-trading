/**
 * 端到端最小验证集（路线纪律的可执行形式）：
 * **任何触及 tradectl / contract / cockpit 的改动之后，先跑这三条**。
 *
 * 为什么需要它：本会话已有 7 个"单元测试全绿、真实路径坏掉"的先例
 * （解码钩子缺失、乱序判定全局、基准不刷新、符号写法不一致、界面丢弃未知卡片、
 * 契约包引 node:crypto 导致浏览器构建失败、/v1/assets 漏传 accept-encoding）。
 * 单测喂的是我自己造的输入，而这些缺陷只在真实链路上现形 —— 所以"跑真实链路"
 * 必须和"跑单测"一样便宜，否则它就会在赶进度时被跳过。
 *
 * 用法：
 *   node scripts/e2e-smoke.mjs                 # 不需要网络的项（默认）
 *   node scripts/e2e-smoke.mjs --with-network  # 加上真实行情（约 20 秒）
 * 前置：先在根跑过 pnpm build（drill import 的是构建产物 lib/）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const withNetwork = process.argv.includes('--with-network')
// Electron 端到端演练需要已下载的 Electron 二进制，默认跳过；`--with-electron` 才跑。
const withElectron = process.argv.includes('--with-electron')

/** 每条检查：跑什么、断言输出里必须出现什么、需不需要网络。 */
const CHECKS = [
  {
    name: '带外通道（A0 六条路径在业务面全挂时仍可用）',
    script: 'packages/cockpit/drill/a0-e2e.mjs',
    // 脚本自己会 exit(1)：那是最强的断言，这里再核一遍输出
    expect: ['业务面全挂时 A0 六条路径全部 200'],
    network: false,
  },
  {
    name: '确定性 shadow 跑批（应逐字复现基线）',
    script: 'packages/tradectl/drill/shadow-run.ts',
    expect: ['决策 12 次', '可重建：12/12', 'journal 行数 12'],
    network: false,
  },
  {
    // P4 步骤 5 的切换演练：真文件 + 真环境变量 + 临时 DSH_HOME + 回滚点，退出码即断言。
    // 接进常设冒烟的理由：它此前只被"跑过一次"，而它检验的正是"配置改错会不会把桌面壳
    // 带到错误的地方或加载不该加载的东西"——这类回归没有人会主动去跑。
    name: '桌面壳附着切换演练（含回滚点）',
    script: 'desktop/scripts/attach-drill.mjs',
    expect: ['6/6 步通过', '⑤ 回滚（删配置）⇒ 回到起本地 host'],
  },
  {
    // P4 步骤 5 的**接线**验证：真的把桌面壳起起来，看它是否加载远端 bot、是否不起本地 host。
    // 观测手段是自建的记录型 HTTP 服务 + 进程表；不依赖应用内部日志（它只在 UI 请求时落盘）。
    name: '桌面壳附着接线（Electron 端到端）',
    script: 'desktop/scripts/attach-electron-drill.mjs',
    expect: ['2/2 步通过', '窗口加载了远端 bot', '没有派生本地 host'],
    electron: true,
  },
  {
    name: '真实行情（Binance 公共流，需网络）',
    script: 'packages/tradectl/drill/binance-smoke.ts',
    expect: ['"alignment":"aligned"', '"badFrames":0'],
    network: true,
  },
]

if (!existsSync(join(ROOT, 'packages/tradectl/lib/index.js'))) {
  process.stderr.write('[e2e-smoke] 找不到构建产物 packages/tradectl/lib/index.js' + String.fromCharCode(10))
  process.stderr.write('[e2e-smoke] 先在仓库根跑 pnpm build（drill import 的是 lib/，不是 src/）' + String.fromCharCode(10))
  process.exit(2)
}

const results = []
for (const check of CHECKS) {
  if (check.network && !withNetwork) {
    results.push({ ...check, skipped: true })
    process.stdout.write('[e2e-smoke] 跳过（需 --with-network）：' + check.name + String.fromCharCode(10))
    continue
  }
  if (check.electron && !withElectron) {
    results.push({ ...check, skipped: true })
    process.stdout.write('[e2e-smoke] 跳过（需 --with-electron）：' + check.name + String.fromCharCode(10))
    continue
  }
  const started = Date.now()
  const run = spawnSync(process.execPath, [check.script], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
  const output = (run.stdout ?? '') + (run.stderr ?? '')
  const missing = check.expect.filter((needle) => !output.includes(needle))
  const ok = run.status === 0 && missing.length === 0
  results.push({ ...check, ok, missing, ms: Date.now() - started })
  process.stdout.write('[e2e-smoke] ' + (ok ? '✓' : '✗') + ' ' + check.name + '（' + String(Date.now() - started) + 'ms）' + String.fromCharCode(10))
  if (!ok) {
    process.stdout.write('            退出码 ' + String(run.status) + '；缺少断言片段：' + JSON.stringify(missing) + String.fromCharCode(10))
    process.stdout.write('            最后几行输出：' + output.split(String.fromCharCode(10)).slice(-4).join(' | ') + String.fromCharCode(10))
  }
}

const failed = results.filter((result) => result.ok === false)
const skipped = results.filter((result) => result.skipped === true)
process.stdout.write(String.fromCharCode(10) + '[e2e-smoke] 通过 ' + String(results.length - failed.length - skipped.length) + ' / 失败 ' + String(failed.length) + ' / 跳过 ' + String(skipped.length) + String.fromCharCode(10))
process.exit(failed.length === 0 ? 0 : 1)
