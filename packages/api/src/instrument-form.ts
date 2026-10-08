/**
 * 标的形态词汇的运行时裁决（2026-10-08 加密永续与 TradFi 永续落地）。
 *
 * 与 tasks-protocol/tasks-schedule 同理由放进契约包：**规范符号后缀就是形态词汇本身**，
 * 连接器（Binance/OKX/Bybit/CCXT）与检索面（router）必须按同一份判据裁决；各写一份
 * `endsWith('-SWAP')` 迟早分叉，`form` 与符号的一致性就成了没有唯一实现的口号。
 *
 * 硬不变量：`form` 与符号必须一致（`form=perp` ⟺ 符号带 `-SWAP`）；不一致由连接器报
 * `TRADING_UNSUPPORTED_SYMBOL`，不静默纠正。Binance 现货与永续在交易所侧同形
 * （都叫 `BTCUSDT`），那半边由名册 `form` 决定打 `/api/v3` 还是 `/fapi/v1`。
 */

import type { InstrumentForm } from './index.ts'

/** 永续规范形后缀（规范词汇的唯一载体，见 docs/guides/symbol-vocabulary.md）。 */
export const SWAP_SYMBOL_SUFFIX = '-SWAP'

/**
 * 由规范符号裁决形态：带 `-SWAP` 后缀为 `perp`，否则 `spot`。
 * 输入容忍小写与空白（trim + 大写化）后判定，**不剥后缀**——剥了就不是同一个符号了。
 */
export function instrumentFormOf(symbol: string): InstrumentForm {
  return symbol.trim().toUpperCase().endsWith(SWAP_SYMBOL_SUFFIX) ? 'perp' : 'spot'
}
