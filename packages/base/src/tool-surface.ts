/**
 * @dshtrading/base/tool-surface —— 按预设裁剪工具面（index-style 的第二级）。
 *
 * 背景：`market-tools` / `watchlist` / `knowledge` / `holdings` / `indicators`
 * 都在 base 的 host 平面注册，是 **global 工具**，四个预设无差别全看得到；
 * 只有连接器（下单面）与 `research-tools` 是预设平面的 scoped 注册。
 * 于是「一个角色需要什么」这件事在 global 工具上没有表达渠道。
 *
 * 本插件补这个渠道：每个预设声明自己要哪几族，插件在挂载时按**实际注册面**
 * 展开成工具名、调 `ctx.tools.restrict({ deny })` 收窄。
 *
 * 为什么用 deny 而不是 allow：
 *   `restrict` 作用于 agent scope 的**全部** global 工具，不只交易工具。
 *   用 allow 就等于把 read / read_image / write / bash / skill / job_output
 *   等非交易工具一并写进白名单，漏一个就悄悄消失。deny 只表达「我不要什么」，
 *   默认保留其余能力——最小权限且不会误伤。
 *
 * 为什么按族而不是按名单：
 *   族名取自 `tool-index.ts` 的 FAMILIES（同一事实源），新增工具自动归族；
 *   若某族在当前部署一个工具都不存在，展开结果为空、自动跳过，不报错
 *   （`restrict` 对未知工具名会失败，因此必须先按注册面过滤）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineConfig } from './tool-surface-config.ts'

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-tool-surface'

/** 只读注册面 + 收窄能力；不硬依赖其它服务。 */
export const inject = ['tools']

export interface ToolSurfaceConfig {
  /** 本预设不要的工具族（前缀，见 tool-index.ts 的 FAMILIES）。 */
  denyFamilies?: string[]
  /** 本预设额外不要的具体工具名（族内个别工具，优先级高于保留）。 */
  denyTools?: string[]
}

interface ToolSchemaLike {
  name: string
  description?: string
}

/** 族前缀 = 工具名首个下划线之前的部分。 */
export function familyOf(toolName: string): string {
  return toolName.split('_')[0] ?? toolName
}

/**
 * 把「族 + 具体工具」展开成真实存在的工具名。
 * 只返回注册面里确实存在的名字——`restrict` 对未知名直接失败。
 */
export function resolveDeny(
  schemas: readonly ToolSchemaLike[],
  config: ToolSurfaceConfig,
): string[] {
  const denyFamilies = new Set((config.denyFamilies ?? []).map(f => f.trim().toLowerCase()))
  const denyTools = new Set((config.denyTools ?? []).map(t => t.trim()))
  const out: string[] = []
  for (const schema of schemas) {
    if (denyTools.has(schema.name) || denyFamilies.has(familyOf(schema.name).toLowerCase())) out.push(schema.name)
  }
  return [...new Set(out)].sort()
}

export function apply(ctx: Context, rawConfig: unknown): void {
  const config = defineConfig(rawConfig)
  const tools = ctx.tools as unknown as {
    schemas(scope?: unknown): ToolSchemaLike[]
    restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
  }
  const deny = resolveDeny(tools.schemas(), config)
  // 空裁剪必须跳过：restrict 明确拒绝空 filter。
  if (deny.length > 0) tools.restrict({ deny })
}
