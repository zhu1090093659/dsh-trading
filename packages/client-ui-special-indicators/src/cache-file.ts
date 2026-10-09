/**
 * 特殊指标桥缓存的落盘镜像（node 半，随宿主进程存活于 $DSH_HOME）。
 *
 *
 * 为什么不能用浏览器侧缓存兜底：桌面壳每次启动都挑一个随机空闲端口
 * （desktop/src/main.cjs findFreePort），页面 origin 随之变化，而
 * sessionStorage / localStorage 按 origin 隔离——上个会话写入的面板缓存整片
 * 成为孤儿，用户每次重开都从零开始，被迫阻塞等上游全量重算。
 *
 * 因此缓存放在**不依赖 origin、也不随宿主进程退出而消失**的文件里：
 * 重启后首个请求即命中，先上屏再后台再验证。
 *
 * 纪律：文件只是缓存，任何读写失败都静默降级为「慢」，绝不让路由报错；
 * 换过 baseUrl 的旧缓存（可能指向另一套数据面）一律判废。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomeDir, writeJsonAtomic } from '@dshtrading/dsh-home'
import type { CachePersistence, PersistedCacheEntry } from './finance-client.ts'

const LOG_TAG = '[dsh-trading/special-indicators] failed to atomic flush bridge cache to'

/** 落盘信封版本：结构变更时递增，旧文件按缺失/失配丢弃。 */
const CACHE_SCHEMA_VERSION = 1

/** 缓存文件路径：$DSH_HOME/special-indicators/cache.json（缺省 ~/.dsh-trading）。
 *  刻意不进 TRADING_HOME_ENTRIES：那是旧 home 迁移的**用户数据**白名单，
 *  而本文件是可再生缓存，搬家没有意义（冷一次即可重建）。 */
export function defaultCacheFilePath(): string {
  return join(dshHomeDir(), 'special-indicators', 'cache.json')
}

interface CacheFile {
  v: number
  baseUrl: string
  entries: Record<string, PersistedCacheEntry>
}

/** 文件缓存端口 + 排空能力：save 是 fire-and-forget（不能阻塞请求路径），
 *  flush() 供退出钩子/测试等待最后一次落盘真正完成。 */
export interface FileCachePersistence extends CachePersistence {
  flush(): Promise<void>
}

/** 文件缓存端口：load 同步读（构造补水一次），save 异步原子写且失败静默。 */
export function createFileCachePersistence(options: { baseUrl: string; filePath?: string }): FileCachePersistence {
  const filePath = options.filePath ?? defaultCacheFilePath()
  // 串行化落盘：多次 save 依次落笔，flush() 等待链尾。
  let pending: Promise<void> = Promise.resolve()
  return {
    flush(): Promise<void> {
      return pending
    },
    load(): Record<string, PersistedCacheEntry> {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<CacheFile>
        if (parsed.v !== CACHE_SCHEMA_VERSION) return {}
        // 凭据/地址换过就判废：旧缓存可能来自另一套数据面。
        if (parsed.baseUrl !== options.baseUrl) return {}
        const entries = parsed.entries
        if (entries === null || typeof entries !== 'object') return {}
        return entries
      } catch {
        // 首次运行文件不存在、或文件损坏：冷启动即可，不是错误。
        return {}
      }
    },
    save(entries: Record<string, PersistedCacheEntry>): void {
      const file: CacheFile = { v: CACHE_SCHEMA_VERSION, baseUrl: options.baseUrl, entries }
      // 目录由 writeJsonAtomic 自己递归创建（它已 mkdir recursive），无需重复。
      // 落盘是缓存维护，不参与请求结果：失败已由 writeJsonAtomic 记日志，
      // 这里吞掉 rejection，避免 unhandled rejection 噪音。
      pending = pending.then(() => writeJsonAtomic(filePath, file, LOG_TAG)).catch(() => undefined)
    },
  }
}
