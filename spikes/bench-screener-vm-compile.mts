/** P2 基准补测：现实体量源码（~200 行 helper）下重编译 vs 复用。 */
import * as vm from 'node:vm'
import { createNodeScreenerEvaluator } from '../packages/strategies/src/validate-node.ts'

// 构造现实体量的自定义选股器源码：多 helper + 主逻辑。
const helpers = Array.from({ length: 200 }, (_, i) =>
  `function h${i}(bars) { let s = 0; for (let j = 0; j < bars.length; j++) { s += bars[j].close * ${i % 7 + 1} % 13; } return s % 997; }`).join('\n')
const source = `(bars) => {\n${helpers}\n let s = 0; for (const b of bars) s += b.close + h3(bars) - h199(bars); return { metrics: { avg: s / bars.length }, reason: "bench" } }`
console.log('sourceBytes', source.length)
const bars = Array.from({ length: 500 }, (_, i) => ({ openTime: i, open: i, high: i, low: i, close: i, volume: i }))
const N = 200

function perInstrumentRecompile(): void {
  for (let i = 0; i < N; i++) {
    const sandbox = { bars, params: {}, result: null as unknown, Math, Array, Object, Number, String, Boolean, Date }
    const trimmed = source.trim()
    const code = `"use strict"; const fn = (${trimmed}); result = fn(bars, params);`
    const script = new vm.Script(code)
    const context = vm.createContext(sandbox)
    script.runInContext(context, { timeout: 1000 })
  }
}
async function compileOnce(): Promise<void> {
  const evaluate = createNodeScreenerEvaluator(source, 1000)
  for (let i = 0; i < N; i++) await evaluate(bars, {})
}
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
async function main(): Promise<void> {
  perInstrumentRecompile(); await compileOnce()
  const before: number[] = []; const after: number[] = []
  for (let round = 0; round < 5; round++) {
    let t = performance.now(); perInstrumentRecompile(); before.push(performance.now() - t)
    t = performance.now(); await compileOnce(); after.push(performance.now() - t)
  }
  console.log(JSON.stringify({ instruments: N, rounds: 5,
    beforeMs: before.map(x => +x.toFixed(1)), afterMs: after.map(x => +x.toFixed(1)),
    medianBeforeMs: +median(before).toFixed(1), medianAfterMs: +median(after).toFixed(1) }, null, 2))
}
await main()
