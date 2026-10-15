/**
 * 白名单子路由表（桥 handler 与 agent 工具面共用）。
 *
 * 为什么单独成模块：路由白名单、查询参数夹取与缓存档是**同一份事实**——
 * 浏览器桥（src/index.ts）与 agent 工具面（src/indicator-tools.ts）都必须
 * 走同一批上游路径、同一套参数边界、同一档 TTL。各自抄一份就会漂移成
 * 「面板看到的 days 上限」与「模型能要到的 days 上限」不一致，或者工具绕开
 * 白名单直达上游（违反「同一取数实例、同一缓存」纪律）。
 *
 * 模块只描述**路径怎么拼**；取数、缓存、凭据全在 FinanceClient 一处。
 */

/** 路由参数面用到的配置子集（index.ts 的 Config 结构上兼容，不反向依赖）。 */
export interface RouteConfig {
  sentimentMethodology: number
}

/** 缓存档配置子集：快照类 60s / 历史类 300s（桥与工具面同档）。 */
export interface CacheTierConfig {
  snapshotCacheMs: number
  historyCacheMs: number
}

/** 缓存档：snapshot 用 snapshotCacheMs，history 用 historyCacheMs。 */
export type RouteTier = 'snapshot' | 'history'

export interface RouteDef {
  /** 子路径（MOUNT 之后），如 /basis/snapshot。 */
  sub: string
  /** 由已校验查询参数与被解析的配置拼上游路径；返回 null = 参数非法（400）。 */
  upstream: (url: URL, config: RouteConfig) => string | null
  /** 缓存档。 */
  tier: RouteTier
}

/** 板块代码白名单（数字/字母，防路径注入）。 */
export const SECTOR_CODE_RE = /^[0-9A-Za-z]{1,12}$/

export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 固定子路由白名单（非通用代理；对上游只读 GET）。 */
export const ROUTES: readonly RouteDef[] = [
  { sub: '/basis/snapshot', upstream: () => '/api/snapshot', tier: 'snapshot' },
  {
    sub: '/basis/history',
    upstream: (url) => '/api/v2/basis/history?days=' + clampInt(url.searchParams.get('days'), 200, 10, 500),
    tier: 'history',
  },
  // 恐慌指数固定 market=cn + 配置里的方法学版本（docs/api.md：调用方应固定方法，
  // 避免历史拼接混用；同一会话内不得一半 v2 一半 v3）。版本由配置给，不再写死在路由里。
  { sub: '/sentiment/snapshot', upstream: (_url, config) => '/api/sentiment/snapshot?market=cn&methodology=' + String(config.sentimentMethodology), tier: 'snapshot' },
  {
    sub: '/sentiment/history',
    upstream: (url, config) => '/api/sentiment/history?market=cn&methodology=' + String(config.sentimentMethodology) + '&days=' + clampInt(url.searchParams.get('days'), 750, 30, 800),
    tier: 'history',
  },
  { sub: '/hk-short/snapshot', upstream: () => '/api/hk-short/snapshot', tier: 'snapshot' },
  { sub: '/hk-short/chart', upstream: () => '/api/hk-short/chart', tier: 'history' },
  { sub: '/sectors/snapshot', upstream: () => '/api/sectors/snapshot', tier: 'snapshot' },
  {
    sub: '/sectors/ranking',
    upstream: (url) => '/api/sectors/ranking?window=' + clampInt(url.searchParams.get('window'), 20, 1, 120),
    tier: 'snapshot',
  },
  {
    sub: '/sectors/detail',
    upstream: (url) => {
      const code = url.searchParams.get('code') ?? ''
      if (!SECTOR_CODE_RE.test(code)) return null
      return '/api/v2/sectors/' + encodeURIComponent(code) + '?days=' + clampInt(url.searchParams.get('days'), 200, 10, 500)
    },
    tier: 'history',
  },
]

/** 该档 TTL（毫秒）。 */
export function tierTtlMs(tier: RouteTier, config: CacheTierConfig): number {
  return tier === 'snapshot' ? config.snapshotCacheMs : config.historyCacheMs
}

/**
 * 按白名单子路由拼上游路径（工具面走这条路，绝不自行拼 URL）。
 * @param sub - 白名单子路径，如 /sentiment/history
 * @param params - 子路由已声明的查询参数（多余键被忽略：upstream 只读它认得的键）
 * @param config - 路由参数面配置（方法学版本等）
 * @returns 上游路径；null = 参数未通过子路由校验（调用方应响亮报错，不发请求）
 */
export function buildUpstreamPath(sub: string, params: Readonly<Record<string, string | number>>, config: RouteConfig): string | null {
  const route = ROUTES.find((candidate) => candidate.sub === sub)
  if (route === undefined) return null
  const url = new URL('http://special-indicators.invalid' + sub)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  return route.upstream(url, config)
}

/** 该子路由所属缓存档（未知子路径 = undefined）。 */
export function tierOf(sub: string): RouteTier | undefined {
  return ROUTES.find((candidate) => candidate.sub === sub)?.tier
}
