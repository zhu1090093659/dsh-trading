/**
 * 预置指标提供插件（client 半）：在 client 上下文提供 tradingIndicators
 * 服务 = IndicatorRegistry 单例（注册六个预置指标）。机制先例 =
 * session-controller 的 `reflect.provide('sessions')`（dsh
 * packages/api/session-controller/src/client/sessions/service.ts:263）。
 *
 * 社区指标插件的接入方式：client 半 `ctx.inject(['tradingIndicators'],
 * scope => scope.tradingIndicators.register(definition))` —— 服务可用时
 * 回调才触发，加载顺序由 cordis 依赖解析保证；与本插件零耦合。
 *
 * 消费方 client-ui-trading 以可选依赖桥接（同样 ctx.inject），插件未
 * 安装时行情视图零指标正常工作。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createIndicatorRegistry, presetDefinitions } from '@dsh-trading/indicators'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-trading 技术指标注册表（社区指标经 ctx.inject 消费后 register）。 */
    tradingIndicators: import('@dsh-trading/indicators').IndicatorRegistry
  }
}

export function apply(ctx: Context): void {
  const registry = createIndicatorRegistry()
  for (const definition of presetDefinitions()) registry.register(definition)
  // provide 由插件 fiber 持有：插件卸载/重载时服务随之注销/重建。
  ctx.reflect.provide('tradingIndicators', registry)
}
