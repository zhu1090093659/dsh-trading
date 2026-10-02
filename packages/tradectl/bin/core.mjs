#!/usr/bin/env node
/**
 * 执行核的进程入口（P5 步骤 1 的最后一段：**环路与事件泵都实现了，但没有进程启动它们**）。
 *
 * 它做四件事，其余一律不做：
 *   1. **启动断言**：四条禁止的降级（%%assertNoForbiddenDegradation%%）与两套词汇不相交
 *      （%%assertVocabulariesDisjoint%%）—— 违反即拒绝启动，不是"警告后继续"；
 *   2. **带外 kill/pause 闸门**：production 形态必填 %%--kill-state%%，被 kill 或 pause 时
 *      **拒绝启动**（edge 写、核心读，中间没有缓存）；
 *   3. **装配 desk 进程**：%%createDeskProcess%%（环路 + 事件泵 + dry-run 派发 + 积压告警入审计），
 *      真实库、真实 journal、真实时钟；
 *   4. **UDS 面（可选）**：%%--uds-socket%% 绑定核心的 UDS、并**周期调度 %%checkIdentity%%**
 *      （inode 被换掉 ⇒ 冻结 ⇒ 本进程停机且不重绑，§13 #17）。
 *
 * 三条立场：
 *   - **没有下单路径是装配出来的事实**：本入口不构造任何 venue 端口，%%--mode%% 只实现
 *     %%shadow%%（脚本化信号 + dry-run 派发）；%%--mode=paper|live%% 一律当场拒绝，不静默降级；
 *   - **入口不跑过期产物**：优先用构建产物 %%lib/%%；一旦 %%src/%% 比 %%lib/%% 新就改用源码
 *     （Node 类型剥离），宁可慢一点，也不拿旧构建产物冒充当前实现；
 *   - **绝不静默写进别人的家**：没给 %%--home%% 且没有 %%DSH_HOME%% 就拒绝启动；%%$DSH_HOME%%
 *     不是交易 home（**目录名不以 %%\-trading%% 结尾**）时拒绝启动 ——
 *     agent/桌面会话继承的宿主 %%DSH_HOME=~/.dsh%% 会让交易账本写进宿主 home 且**不报错**；
 *     账本目录对组/其他可读时同样按"凭据不在核心侧独占"拒绝启动（§13 #18-3 的可执行形式）。
 *
 * 为什么这是"库的可执行入口"而不是设计 §2.2 禁止的"自建 application bin"：
 *   - §2.2/§2.3 禁的是**产品面**另起 bin（bot 必须是 dsh profile + 官方 launcher，产品功能进
 *     profile bundle）——本文件不含任何产品功能，它是库里那条进程装配线的 %%main()%%；
 *   - 核与 edge 是**独立 OS principal 的基础设施进程**（§2.1 三进程 / §13 #2#16#18），它们
 *     不能跑在 dsh 宿主进程里：那会把"核心与宿主不同 principal"从结构变成一句注释；
 *   - 形态与既有 %%packages/authority/bin/sign-live-trading.mjs%% 一致：private 包、不进 %%files%%、
 *     不声明 package.json 的 %%bin%% 字段 ⇒ 它不是发布出去的应用，只是本仓的进程启动器。
 *
 * @module @dshtrading/tradectl/bin/core
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { pickImplementation } from './runtime.mjs'

const NL = String.fromCharCode(10)
const HERE = fileURLToPath(new URL('.', import.meta.url))

const VALUE_FLAGS = new Set([
  'home', 'mode', 'form', 'run-ms', 'interval-ms', 'desk-session-id', 'backlog-warn-threshold',
  'symbol', 'uds-socket', 'identity-check-ms', 'kill-state', 'heartbeat-path', 'probe-dir',
  'clock-drift-tolerance-ms',
])
const BOOL_FLAGS = new Set(['seed-demo-schedules', 'separate-uids', 'help'])

const USAGE = [
  '用法：node packages/tradectl/bin/core.mjs [选项]',
  '',
  '  --mode=shadow                 目前唯一实现的模式（脚本化信号 + dry-run 派发；无下单端口）',
  '  --home=<dir>                  账本目录（缺省取 $DSH_HOME，且它必须像交易 home；都没有即拒绝启动）',
  '  --form=development|production 启动形态声明（缺省 development；production 需同时给 --separate-uids）',
  '  --separate-uids               production 形态的显式声明（独立 uid 不可用时不得默认降级，§13 #18-4）',
  '  --kill-state=<path>           带外 kill/pause 状态文件（production 必填；killed/paused ⇒ 拒绝启动）',
  '  --uds-socket=<path>           绑定核心的 UDS 面（缺省不绑）；绑定后周期校验 inode',
  '  --identity-check-ms=<n>       inode 校验间隔（缺省 5000）',
  '  --heartbeat-path=<path>       心跳文件（缺省 <home>/tradectl-… 见运行输出）',
  '  --run-ms=<n>                  跑 n 毫秒后优雅退出（缺省 0 = 长跑，等 SIGINT/SIGTERM）',
  '  --interval-ms=<n>             环路与事件泵的检查间隔（缺省 1000）',
  '  --desk-session-id=<id>        触发扇出的 desk 会话 id（缺省 desk-core）',
  '  --backlog-warn-threshold=<n>  积压告警阈值（缺省泵的缺省值 200）',
  '  --symbol=<market>             标的（可重复；缺省 BTC/USDT）—— shadow 形态的脚本化源',
  '  --seed-demo-schedules         演示：种入两条调度（生产调度由编排写库，不由入口造）',
  '  --probe-dir=<path>            写探针目录（缺省账本目录：审计库所在的盘）',
  '  --clock-drift-tolerance-ms=<n> 时钟漂移容差（缺省 5000；给了才采样）',
  '  --help',
].join(NL)

function parseArgs(argv) {
  const values = new Map()
  const booleans = new Set()
  const symbols = []
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
    if (name === 'symbol') symbols.push(value)
    else values.set(name, value)
  }
  return { values, booleans, symbols, unknown }
}

/**
 * home 守卫：显式 %%--home%% 是人的决定，直接用；%%$DSH_HOME%% 必须**看起来像交易 home**
 * （**目录名以 %%\-trading%% 结尾**），否则拒绝启动。
 *
 * 为什么这条守卫必须在入口里：agent / 桌面壳会话会继承宿主实例的 %%DSH_HOME=~/.dsh%%，于是
 * 交易账本被写进宿主 home —— 而这一切**不报错**，脚本照常"成功"，只是作用在另一个实例的数据上
 * （2026-10-01 一天内在四处发现同形缺陷，策略已写成 %%pnpm home-guard:check%% 门禁）。
 * 本入口宁可拒绝启动，也不猜一个家。
 * @param explicitHome - %%--home%% 的值。
 */
function resolveHome(explicitHome) {
  if (explicitHome !== undefined && explicitHome !== '') {
    return { home: resolve(expandTilde(explicitHome)), source: '--home（显式指定）' }
  }
  const fromEnv = process.env.DSH_HOME
  if (fromEnv === undefined || fromEnv.trim() === '') {
    return { reason: '没有账本目录：给 --home=<dir> 或设 DSH_HOME（拒绝猜一个位置写账本）' }
  }
  const candidate = resolve(expandTilde(fromEnv.trim()))
  // 判据只有一条：**目录名以 -trading 结尾**。不用 "有没有 profiles/trading-*" 当判据 ——
  // 实测宿主 home（~/.dsh）里也有 profiles/trading-web（桌面壳装的），拿它当证据会**恰好放过**
  // 最该拦的那一种（宿主 home）。
  if (!basename(candidate).endsWith('-trading')) {
    return {
      reason: 'DSH_HOME=' + candidate + ' 看起来是宿主实例的 home，不是交易 home（目录名不以 -trading 结尾）：'
        + '拒绝猜测写账本的位置。请显式给 --home=<交易 home>，或设 DSH_HOME=~/.dsh-trading。',
    }
  }
  return { home: candidate, source: 'DSH_HOME（交易 home）' }
}

/** 展开 %%~/%% 前缀（与 @dshtrading/dsh-home 的语义一致；本包不引它，所以只实现这一条）。 */
function expandTilde(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~' + String.fromCharCode(92))) return resolve(homedir(), path.slice(2))
  return path
}

function fail(message, code) {
  process.stderr.write('[core] ' + message + NL)
  return code
}

function numberFlag(values, name, fallback) {
  const raw = values.get(name)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('--' + name + ' 需要一个非负数字，收到 ' + raw)
  return parsed
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

  const mode = args.values.get('mode') ?? 'shadow'
  if (mode !== 'shadow') {
    return fail(
      '只实现了 shadow 模式，收到 --mode=' + mode
      + '。paper/live 的派发路径在本仓尚不存在（实盘授权属 authority:sign 签署 + live-trading:check 门禁），'
      + '本入口不发明第二套授权判据：宁可不启动，也不静默降级。',
      2,
    )
  }
  const homeChoice = resolveHome(args.values.get('home'))
  if (homeChoice.home === undefined) return fail(homeChoice.reason, 2)
  const home = homeChoice.home
  const form = args.values.get('form') ?? 'development'
  if (form !== 'development' && form !== 'production') return fail('--form 只能是 development 或 production，收到 ' + form, 2)
  if (form === 'production' && !args.booleans.has('separate-uids')) {
    return fail('production 形态必须显式声明 --separate-uids（独立 uid 不可用时必须声明为开发形态，§13 #18-4）', 3)
  }
  const killStatePath = args.values.get('kill-state')
  if (form === 'production' && killStatePath === undefined) {
    return fail('production 形态必须给 --kill-state=<path>（带外 kill 闸门是 fail-closed 的前提，§13 #25）', 3)
  }

  const impl = pickImplementation()
  const [db, deskRecords, journalModule, triggers, deskProcessModule, degradation, riskGate, marketSource, uds] = await Promise.all([
    impl.load('db'),
    impl.load('desk-records'),
    impl.load('journal'),
    impl.load('triggers'),
    impl.load('desk-process'),
    impl.load('degradation'),
    impl.load('risk-gate'),
    impl.load('market-source'),
    impl.load('uds'),
  ])

  const ledgersDir = db.ledgerDir(home)
  mkdirSync(ledgersDir, { recursive: true, mode: 0o700 })
  const ledgersMode = statSync(ledgersDir).mode & 0o777
  // 账本目录不得对组/其他开放：这是"凭据/账本只住核心侧"（§13 #18-3）的可执行形式。
  const startupForm = {
    kind: form,
    authCheckAvailable: true,
    credentialsCoreOnly: (ledgersMode & 0o077) === 0,
    hostMayPlaceOrders: false,
    separateUids: args.booleans.has('separate-uids'),
  }
  try {
    degradation.assertNoForbiddenDegradation(startupForm)
  } catch (error) {
    process.stderr.write('[core] ' + (error instanceof Error ? error.message : String(error)) + NL)
    process.stderr.write('[core] 启动断言失败 ⇒ 拒绝启动（0o' + ledgersMode.toString(8) + ' 的账本目录不得对组/其他开放）' + NL)
    return 3
  }
  riskGate.assertVocabulariesDisjoint()

  if (killStatePath !== undefined) {
    const gate = degradation.gateNewRisk(killStatePath)
    if (!gate.allowed) return fail('带外 kill/pause 生效（' + gate.reason + '）⇒ 拒绝启动：' + killStatePath, 3)
  }

  const intervalMs = numberFlag(args.values, 'interval-ms', 1_000)
  const runMs = numberFlag(args.values, 'run-ms', 0)
  const identityCheckMs = numberFlag(args.values, 'identity-check-ms', 5_000)
  const clockDriftToleranceMs = numberFlag(args.values, 'clock-drift-tolerance-ms', 5_000)
  const deskSessionId = args.values.get('desk-session-id') ?? 'desk-core'
  const heartbeatPath = args.values.get('heartbeat-path') ?? join(ledgersDir, 'heartbeat.json')
  const probeDir = args.values.get('probe-dir') ?? ledgersDir
  const backlogRaw = args.values.get('backlog-warn-threshold')
  const backlogWarnThreshold = backlogRaw === undefined ? undefined : numberFlag(args.values, 'backlog-warn-threshold', 200)
  const udsSocketPath = args.values.get('uds-socket')
  const now = () => Date.now()

  const ledgers = db.openLedgers(ledgersDir)
  deskRecords.migrateDeskRecords(ledgers.orders)
  triggers.migrateTriggers(ledgers.orders)
  const journal = journalModule.createJournal(ledgers.audit, { now })

  // 行情源登记：shadow/单机形态用进程内 registry（market-source.ts 自陈它就是给这个形态的），
  // 生产形态里换成既有 tradingMarketDataRegistry（同名 register/list 契约）。
  const registry = marketSource.createMemorySourceRegistry()
  const watched = args.symbols.length > 0 ? args.symbols : ['BTC/USDT']
  const demoSource = { capabilities: () => ({ streaming: true, channel: 'shadow-scripted' }) }
  const attachment = marketSource.attachMarketSources(
    registry,
    Object.fromEntries(watched.map((symbol) => [symbol, demoSource])),
  )
  const symbols = () => registry.list().map((source) => source.market)

  if (args.booleans.has('seed-demo-schedules')) {
    const at = now()
    triggers.addSchedule(ledgers.orders, { id: 'demo-catch-up', intervalMs: null, atMs: at - 5_000, nextAtMs: at - 5_000, enabled: true, kind: 'risk-check' })
    triggers.addSchedule(ledgers.orders, { id: 'demo-tick', intervalMs: Math.max(intervalMs * 2, 200), atMs: null, nextAtMs: at + 50, enabled: true, kind: 'wake' })
  }

  let udsServer = null
  if (udsSocketPath !== undefined) {
    udsServer = await uds.createUdsServer({
      socketPath: udsSocketPath,
      // 业务面（P4）还没实现：**一律结构化拒绝**，不假装能服务。本面今天的存在意义是
      // 权限模型（0750/0660）与 inode 守卫真的在跑。
      handle: () => ({
        error: {
          code: 'CORE_SURFACE_NOT_IMPLEMENTED',
          message: '执行核的 UDS 业务面未实现（P4 范围）：本面只做绑定、权限与 inode 守卫。',
        },
      }),
    })
  }

  const desk = deskProcessModule.createDeskProcess({
    orders: ledgers.orders,
    audit: ledgers.audit,
    journal,
    // venue 没有原生条件单 ⇒ 保护性订单不在 venue 侧 ⇒ 按 §13 #25 封顶 reduce_only（halt 降级）。
    gate: { protectiveOrdersAtVenue: false },
    signals: () => ({
      symbols: symbols(),
      // shadow 形态：没有真实行情面（P4），对齐态由脚本给定 —— 启动与退出各标注一次这件事。
      alignmentOf: () => 'aligned',
      lastHeartbeatAtMs: now(),
      heartbeatTimeoutMs: 30_000,
      venueErrorStreak: 0,
      venueErrorThreshold: 3,
      diskWriteFailed: false, // 环路自己用 probeDir 探一次，比调用方上报更早
      now,
    }),
    scheduler: {
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        return () => clearTimeout(timer)
      },
    },
    now,
    intervalMs,
    heartbeatPath,
    probeDir,
    clockDriftToleranceMs,
    monotonicNow: () => Number(process.hrtime.bigint() / 1_000_000n),
    deskSessionId,
    ...(backlogWarnThreshold === undefined ? {} : { backlogWarnThreshold }),
    dispatchMode: 'dry-run',
  })

  let stopping = false
  let identityTimer = null
  let exitReason = 'run-ms'
  const startedAtMs = Date.now()

  const stop = async (reason, code) => {
    if (stopping) return
    stopping = true
    exitReason = reason
    if (identityTimer !== null) clearInterval(identityTimer)
    desk.stop()
    if (udsServer !== null) await udsServer.close()
    const stats = desk.stats()
    const events = journal.read(0, 10_000).events
    const byKind = {}
    for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1
    const failures = []
    // "一次都没跑"只在**活够了一个间隔**时才算失败：刚起来就被 SIGTERM 收走是正常的优雅退出。
    const uptimeMs = Date.now() - startedAtMs
    const livedLongEnough = uptimeMs >= intervalMs
    if (livedLongEnough && stats.loop.ticks === 0) failures.push('运行 ' + String(uptimeMs) + 'ms（≥ 间隔 ' + String(intervalMs) + 'ms）却一次都没跑环路')
    if (livedLongEnough && stats.pump.ticks === 0) failures.push('运行 ' + String(uptimeMs) + 'ms（≥ 间隔 ' + String(intervalMs) + 'ms）却一次都没跑事件泵')
    if (stats.dryRun.failures > 0) failures.push('dry-run 派发失败 ' + String(stats.dryRun.failures) + ' 次：' + String(stats.dryRun.lastError))
    if (stats.loop.recordFailures > 0) failures.push('审计记录写入失败 ' + String(stats.loop.recordFailures) + ' 次：' + String(stats.loop.lastRecordFailure))
    if (stats.dryRun.occurrences !== stats.pump.dispatched) {
      failures.push('dry-run 记账 ' + String(stats.dryRun.occurrences) + ' 与泵派发 ' + String(stats.pump.dispatched) + ' 不一致')
    }
    process.stdout.write('[core] 退出原因=' + reason + ' 模式=shadow 形态=' + form + ' 行情面=shadow-scripted（无真实行情）' + NL)
    process.stdout.write('[core] 统计 ' + JSON.stringify({
      loopTicks: stats.loop.ticks,
      loopTransitions: stats.loop.transitions,
      loopRecordFailures: stats.loop.recordFailures,
      pumpTicks: stats.pump.ticks,
      pumpDispatched: stats.pump.dispatched,
      pumpFailed: stats.pump.failed,
      dryRunCalls: stats.dryRun.calls,
      dryRunOccurrences: stats.dryRun.occurrences,
      backlogWarnings: stats.backlog.warnings,
      journalRows: events.length,
      journalKinds: byKind,
    }) + NL)
    process.stdout.write('[core] 接线 ' + JSON.stringify({
      实现: impl.why,
      账本目录: ledgersDir,
      标的: symbols(),
      行情源: attachment.registered,
      快照源: attachment.snapshotOnly,
      'UDS 面': udsSocketPath ?? '未绑定',
      心跳: heartbeatPath,
      写探针: probeDir,
    }) + NL)
    ledgers.close()
    if (failures.length > 0) {
      for (const failure of failures) process.stderr.write('[core] ✗ ' + failure + NL)
      process.exitCode = 1
      return
    }
    process.stdout.write('[core] ✓ shadow 环路与事件泵跑通：dry-run 派发只记录意图、无下单端口、优雅退出' + NL)
    process.exitCode = code
  }

  process.on('SIGINT', () => { void stop('SIGINT', 0) })
  process.on('SIGTERM', () => { void stop('SIGTERM', 0) })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write('[core] unhandled rejection：' + String(reason) + ' ⇒ 停机' + NL)
    void stop('unhandledRejection', 1)
  })

  desk.start()
  process.stdout.write('[core] 已启动：模式=shadow（dry-run 派发、无下单端口）形态=' + form
    + ' 实现=' + impl.why + ' 间隔=' + String(intervalMs) + 'ms 标的=' + JSON.stringify(symbols())
    + ' home 来源=' + homeChoice.source
    + ' 账本=' + ledgersDir + NL)
  if (udsServer !== null) {
    process.stdout.write('[core] UDS 已绑定：' + udsServer.socketPath + '（inode 每 ' + String(identityCheckMs) + 'ms 校验一次）' + NL)
    identityTimer = setInterval(() => {
      const verdict = udsServer.checkIdentity()
      if (!verdict.ok) {
        process.stderr.write('[core] UDS inode 守卫失败（' + String(verdict.reason) + '）⇒ freeze-risk 已生效；本进程停机且不重绑（§13 #17）' + NL)
        void stop('uds-identity-' + String(verdict.reason), 4)
      }
    }, identityCheckMs)
  }
  if (runMs > 0) {
    await delay(runMs)
    await stop('run-ms', 0)
  } else {
    process.stdout.write('[core] 长跑中：SIGINT / SIGTERM 优雅退出' + NL)
  }
  // 给在途的一轮派发与 journal 写留出落地时间，再让进程退出。
  await delay(50)
  return process.exitCode ?? 0
}

const startedAt = Date.now()
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write('[core] 启动失败：' + (error instanceof Error ? error.stack ?? error.message : String(error)) + NL)
    process.exitCode = 1
  })
  .finally(() => {
    process.stdout.write('[core] 进程退出（用时 ' + String(Date.now() - startedAt) + 'ms）' + NL)
  })
