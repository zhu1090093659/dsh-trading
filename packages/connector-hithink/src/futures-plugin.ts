/**
 * @dshtrading/connector-hithink
 * 期货市场 preset 面插件入口：在 preset 的 isolate 组内直接 provide
 * tradingFuturesMarketData（对照 cn preset 挂 connector-tencent 主入口的形态）。
 *
 * 与 ./futures-dataplane 的分工（docs/connector-playbook.md §4/§4.1）：
 * - preset 行用本入口：隔离组内直接 provide 服务，会话可见；
 * - host 面 cordis.patch.yml 用 dataplane：注册 (futures, hithink) 进共享注册表（GUI 行情桥）。
 * 两面同挂时 preset 侧若也用 dataplane，会对同一 (market, provider) 注册第二个服务实例而
 * 响亮失败（router register 的重复注册检查），故 preset 必须走本入口。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HiThinkFuturesMarketDataService } from './futures.js'
import type { Config } from './index.js'

export { Config } from './index.js'

export const name = 'dsh-trading-futures-connector-hithink'

export const inject: string[] = []

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  // 凭证与 cn dataplane 同源：settings credentials 优先、env 兜底，请求期惰性解析。
  const apiKeyProvider = (): string | undefined => {
    const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as
      | { getCredential?(provider: string): Record<string, string> | undefined }
      | undefined
    return router?.getCredential?.('hithink')?.apiKey || process.env[config.apiKeyRef]
  }
  new HiThinkFuturesMarketDataService(ctx, { apiKeyProvider })
}
