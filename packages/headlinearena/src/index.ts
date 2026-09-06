/**
 * @dshtrading/headlinearena —— Headline Arena 宏观研判外审与预测基准插件核心入口
 * Issue #66
 */

export * from './types.ts'
export * from './store.ts'
export * from './client.ts'
export * from './tools.ts'
export {
  name,
  TRADING_HEADLINEARENA_SERVICE_KEY,
  Config,
  HeadlineArenaService,
  registerHeadlineArenaTools,
  apply,
} from './plugin.ts'
