/**
 * @dshtrading/headlinearena —— Cordis 插件实现
 * Issue #66: Headline Arena 宏观研判外审与预测基准插件 host 端接入
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { HeadlineArenaClient } from './client.ts'
import { loadCredentials } from './store.ts'
import { createHeadlineArenaTools } from './tools.ts'
import type { HeadlineArenaConfig } from './types.ts'

export const name = 'dsh-trading-headlinearena'

export const TRADING_HEADLINEARENA_SERVICE_KEY = 'tradingHeadlineArena'

export interface Config extends HeadlineArenaConfig {
  enabled: boolean
  dryRun: boolean
  origin: string
  agentId: string
  defaultAssets: string[]
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean()
    .default(false)
    .description('是否启用 Headline Arena 宏观研判外审与预测基准插件（Issue #66，默认关闭显式启用）'),
  dryRun: Schema.boolean()
    .default(true)
    .description('模拟保护模式：true 时仅验证预测契约与本地逻辑，不向远端发送真实提交（默认开启保护）'),
  origin: Schema.string()
    .default('https://headlinearena.com')
    .description('Headline Arena API Base Origin 域名'),
  agentId: Schema.string()
    .default('')
    .description('指定绑定的 Agent ID（缺省留空自动读取 ~/.headlinearena/credentials.json 中的默认 agent）'),
  defaultAssets: Schema.array(Schema.string())
    .default(['GC', 'CL', 'ES', 'ZN', 'BTC'])
    .description('默认关注的宏观期货与数字货币标的代码'),
})

/** Headline Arena 服务单实例 */
export class HeadlineArenaService extends Service {
  public readonly client: HeadlineArenaClient
  public readonly config: Config

  constructor(
    ctx: Context,
    client: HeadlineArenaClient,
    config: Config,
    serviceName: string = TRADING_HEADLINEARENA_SERVICE_KEY
  ) {
    super(ctx, serviceName)
    this.client = client
    this.config = config
  }
}

/** 注册 Agent 工具到 host 平面 */
export function registerHeadlineArenaTools(ctx: Context, client: HeadlineArenaClient, config: Config): void {
  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (!tools || typeof tools.register !== 'function') return

    const toolsList = createHeadlineArenaTools({ client, config })
    for (const tool of toolsList) {
      if (tools.get(tool.name) === undefined) {
        tools.register(tool)
      }
    }
  })
}

/** 插件入口 apply */
export function apply(ctx: Context, config: Config): void {
  // 未显式启用时保持静默（安全防线）
  if (!config?.enabled) {
    return
  }

  const creds = loadCredentials({
    origin: config.origin,
    agentId: config.agentId || undefined,
  })

  const client = new HeadlineArenaClient({
    origin: config.origin,
    creds,
  })

  new HeadlineArenaService(ctx, client, config)
  registerHeadlineArenaTools(ctx, client, config)
}
