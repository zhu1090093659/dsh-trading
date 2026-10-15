#!/usr/bin/env node
/**
 * KDAS 数值工具（indicator_get_values）现场取证脚本 —— A 交付证据的一次性复现入口。
 *
 * 它跑**生产代码**：真实 profile store（只读 ~/.dsh-trading/indicators/*.json）、真实
 * cn/hk tencent provider（connector-tencent 的 TencentRestClient）、以及与桥 /klines
 * 同一条候选解析实现（bot-api 的 TradingBridge.klines 直调，非 HTTP 传输面）。
 *
 * 用法（在 worktree 根）：
 *   DSH_HOME=~/.dsh-trading node spikes/impl-kdas-values/run.mjs
 *
 * 只读：不写任何 store；导出的日 K JSON 落在系统临时目录，脚本结束即删。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const ROOT = new URL('../..', import.meta.url).pathname
process.env.DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh-trading`

const { createFileCustomIndicatorStore, createFileChartActivationStore, defaultStorePath, defaultChartStorePath } =
  await import(join(ROOT, 'packages/indicators/lib/plugin.js'))
const { createIndicatorValuesTool } = await import(join(ROOT, 'packages/indicators/lib/values-tool.js'))
const { runSourceInVmSandbox } = await import(join(ROOT, 'packages/indicators/lib/validate-node.js'))
const { TencentRestClient, tencentKlineCapabilities } = await import(join(ROOT, 'packages/connector-tencent/lib/rest.js'))
const { TradingBridge, createBridgeHost } = await import(join(ROOT, 'packages/bot-api/lib/bridge.js'))

const TARGETS = [
  { market: 'cn', symbol: '002714.SZ' },
  { market: 'cn', symbol: '159869.SZ' },
  { market: 'hk', symbol: '00700.HK' },
]

if (!defaultStorePath().includes('.dsh-trading')) {
  throw new Error(`refusing to run: DSH_HOME does not resolve to the trading instance (${defaultStorePath()})`)
}

/** 真实 provider 注册表（cn/hk 都由 tencent 供数，与 profile 的 markets.<m>.provider=tencent 一致）。 */
const services = {}
for (const market of ['cn', 'hk']) {
  const rest = new TencentRestClient(market, { timeoutMs: 15_000 })
  services[market] = {
    provider: 'tencent',
    service: {
      getKlines: (symbol, interval, limit) => rest.getKlines(symbol, interval, limit),
      klineCapabilities: () => tencentKlineCapabilities(market),
    },
  }
}
const registry = {
  active: market => services[market],
  list: market => (services[market] === undefined ? [] : [services[market]]),
}

const store = createFileCustomIndicatorStore(defaultStorePath())
const chartStore = createFileChartActivationStore(defaultChartStorePath())
const tool = createIndicatorValuesTool({ store, chartStore, getMarketRegistry: () => registry })

const kdasRecord = await store.get('kdas')
const activations = await chartStore.list()
const kdasInstance = activations.find(item => item.id === 'kdas')
const out = { dsh_home: process.env.DSH_HOME, storePath: defaultStorePath(), chartPath: defaultChartStorePath() }
out.kdas_params_global = kdasInstance?.params ?? null
out.kdas_symbol_params = kdasInstance?.symbolParams ?? null
out.compute_source_head = String(kdasRecord?.computeSource ?? '').slice(0, 160)

const tmp = mkdtempSync(join(tmpdir(), 'kdas-evidence-'))
const readings = []
try {
  for (const { market, symbol } of TARGETS) {
    const started = Date.now()
    const payload = JSON.parse(String(await tool.execute({ market, symbol })))
    payload.elapsed_ms = Date.now() - started
    readings.push(payload)

    // 图表面代理：桥 /klines 的同一实现（provider 标注 = GUI 实际拿到的供数源）。
    const wire = await bridgeKlines(market, symbol)
    payload.bridge_provider = wire.provider ?? null
    payload.bridge_bars = wire.klines.length
    payload.bridge_last_close = wire.klines.at(-1)?.close ?? null

    // 同一份日 K 落盘，供 python 侧 kdas.py --klines-file 复算（同一 openTime→UTC 日口径）。
    const file = join(tmp, `${market}-${symbol.replace(/[^A-Za-z0-9]/g, '_')}.json`)
    writeFileSync(file, JSON.stringify(wire.klines))
    payload.klines_file = file
    payload.kdas_py = runKdasPy(market, symbol, payload.keys.filter(key => typeof key === 'number').join(','), file)
    payload.sandbox_ms = measureSandbox(kdasRecord.computeSource, wire.klines, payload.params)
  }

  // fail-closed 分支：锚点被窗口截断 / 关键日晚于最新一根（两边都必须不给数）。
  // 取值都在指标合法区间 20000101..20991231 内——只是早于/晚于本次 800 根窗口。
  for (const keys of ['20220103', '20000103', '20991231']) {
    const payload = JSON.parse(String(await tool.execute({ market: 'cn', symbol: '002714.SZ', keys })))
    const file = readings[0].klines_file
    readings.push({ case: `fail-closed keys=${keys}`, tool: payload, kdas_py: runKdasPy('cn', '002714.SZ', keys, file) })
  }
  out.readings = readings
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

async function bridgeKlines(market, symbol) {
  const bridge = new TradingBridge(createBridgeHost({ registry, legacy: () => undefined }))
  return bridge.klines(market, symbol, '1d', '800')
}

function runKdasPy(market, symbol, keys, file) {
  try {
    const stdout = execFileSync('python3', [
      join(ROOT, '.agents/skills/weekly-trading-plan/scripts/kdas.py'),
      '--market', market, '--symbol', symbol, '--keys', keys, '--klines-file', file, '--json',
    ], { encoding: 'utf8' })
    return JSON.parse(stdout)
  } catch (error) {
    return { error: String(error.stderr ?? error.message).slice(0, 400) }
  }
}

/** 沙箱耗时实测：同一 computeSource + 同一窗口（报告里说明与默认 100ms 的关系）。 */
function measureSandbox(source, bars, params) {
  const started = Date.now()
  const outputs = runSourceInVmSandbox(source, bars, params, 2000, '指标读数')
  const elapsed = Date.now() - started
  return { elapsed_ms: elapsed, line_count: Array.isArray(outputs) ? outputs.length : null, bars: bars.length }
}

process.stdout.write(JSON.stringify(out, null, 1) + '\n')
