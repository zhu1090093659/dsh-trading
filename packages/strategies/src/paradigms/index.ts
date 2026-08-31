/**
 * 6 个经典策略参考范式汇聚。
 */
import { donchianBreakoutStrategy } from './donchian-breakout.ts'
import { rsiReversionStrategy } from './rsi-reversion.ts'
import { emaCrossoverStrategy } from './ema-crossover.ts'
import { bollingerReversionStrategy } from './bollinger-reversion.ts'
import { smaBaselineStrategy } from './sma-baseline.ts'
import { momentum12mStrategy } from './momentum-12m.ts'
import type { StrategyDefinition } from '../types.ts'

export {
  donchianBreakoutStrategy,
  rsiReversionStrategy,
  emaCrossoverStrategy,
  bollingerReversionStrategy,
  smaBaselineStrategy,
  momentum12mStrategy,
}

export const strategyParadigms: readonly StrategyDefinition[] = [
  donchianBreakoutStrategy,
  rsiReversionStrategy,
  emaCrossoverStrategy,
  bollingerReversionStrategy,
  smaBaselineStrategy,
  momentum12mStrategy,
]

export function getStrategyById(id: string): StrategyDefinition | undefined {
  return strategyParadigms.find((s) => s.id === id)
}
