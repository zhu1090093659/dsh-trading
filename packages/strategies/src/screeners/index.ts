/**
 * 内置选股器名册（与 strategyParadigms 同风格：确定性纯函数 + 稳定 id）。
 * 扫描调度（名册/并发/进度/取消）在 client-ui-strategies 视图层。
 */
import type { ScreenerDefinition } from './types.ts'
import { maBullAlignScreener } from './ma-bull-align.ts'
import { volumeBreakoutScreener } from './volume-breakout.ts'
import { rsiOversoldScreener } from './rsi-oversold.ts'
import { nearHighScreener } from './near-high.ts'
import { aboveMaScreener } from './above-ma.ts'

export type {
  ScreenerColumnSpec,
  ScreenerDefinition,
  ScreenerMatch,
} from './types.ts'

export { maBullAlignScreener } from './ma-bull-align.ts'
export { volumeBreakoutScreener } from './volume-breakout.ts'
export { rsiOversoldScreener } from './rsi-oversold.ts'
export { nearHighScreener } from './near-high.ts'
export { aboveMaScreener } from './above-ma.ts'

export const screenerParadigms: readonly ScreenerDefinition[] = [
  maBullAlignScreener,
  volumeBreakoutScreener,
  rsiOversoldScreener,
  nearHighScreener,
  aboveMaScreener,
]

export function getScreenerById(id: string): ScreenerDefinition | undefined {
  return screenerParadigms.find((s) => s.id === id)
}
