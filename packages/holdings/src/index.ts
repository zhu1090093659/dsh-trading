/**
 * @dshtrading/holdings —— 统一资产台账数据平面核心库（issue #65）：
 * Holding 数据模型 + 校验/默认值推导纯函数 + 内存 Store。
 *
 * 纯库包，零 Node.js 运行时依赖，浏览器端可安全打包（client-ui-trading
 * client 半的类型来源）。Node 端专用件请经子路径引用：
 *   - `@dshtrading/holdings/fx`：FX 汇率服务（frankfurter.dev + 缓存降级链）
 *   - `@dshtrading/holdings/tool`：holdings_stage / holdings_list 工具工厂
 *     （并再导出 createFileHoldingsStore）
 *   - `@dshtrading/holdings/plugin`：cordis 插件（并再导出 file store 与 fx 工厂）
 */
export type {
  Holding,
  HoldingMarket,
  HoldingCurrency,
  HoldingKind,
  NewHolding,
  NewHoldingInput,
  HoldingsBook,
  HoldingsBookSnapshot,
  HoldingsStore,
  HoldingsStageResult,
  HoldingsConfirmResult,
  HoldingsDiscardResult,
  HoldingsAddResult,
  HoldingsUpdateResult,
  HoldingsRemoveResult,
} from './types.ts'

export {
  DEFAULT_ACCOUNT,
  HOLDING_CURRENCIES,
  HOLDING_KINDS,
  HOLDING_MARKETS,
  HoldingValidationError,
  applyHoldingEdits,
  defaultCurrencyForMarket,
  generateHoldingId,
  normalizeNewHolding,
  validateNewHoldingInput,
} from './normalize.ts'

export { createMemoryHoldingsStore } from './store-memory.ts'
