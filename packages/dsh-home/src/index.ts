/**
 * dsh home 根目录解析，与宿主 @deepseek-ai/dsh-home-paths 同语义：
 * 优先级 显式传入 > `$DSH_HOME`（空白视为未设，支持 `~` 展开）> `~/.dsh`，
 * 相对路径按 CWD 解析。
 *
 * dsh-trading 各包的 home 数据文件（watchlists.json、knowledge/cards.json、
 * trading-tasks/ledger 等）一律经此解析，使整套 trading 实例可以通过
 * `DSH_HOME=~/.dsh-trading` 迁到独立 home，与 dsh web 宿主 home 彻底分开
 * （2026-09-08 DSH_HOME 分离，note: implemented/process/2026-09-08-separate-dsh-home.md）。
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// home 数据文件原子写（tmp+rename，EPERM/EBUSY 重试）——全包唯一实现。
export { writeJsonAtomic } from './fs-atomic.ts'

const DEFAULT_HOME_DIR_NAME = '.dsh'

/** 展开 `~` 与 `~/` 前缀（对齐宿主 expandHomePath；Windows 反斜杠前缀同样接受）。 */
function expandHomePath(path: string): string {
  const home = homedir()
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(home, path.slice(2))
  return path
}

/**
 * 解析 dsh home 根目录。
 * @param env 环境变量映射，缺省读 `process.env`；空白 `$DSH_HOME` 视为未设。
 */
export function dshHomeDir(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  const configured =
    fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : resolve(homedir(), DEFAULT_HOME_DIR_NAME)
  return resolve(expandHomePath(configured))
}

/** 缺省 home（`~/.dsh`）——迁移判据用：解析结果等于它就没有旧 home 可迁。 */
export function defaultDshHome(): string {
  return resolve(homedir(), DEFAULT_HOME_DIR_NAME)
}

/**
 * dsh-trading 自有数据条目（迁移白名单）。
 *
 * 只搬这些——`sessions/`、`storages/`、`memory/`、`task-board/`、`integrations/`
 * 是宿主/共居资产（搬了会双实例重复收发消息或抢会话），settings/credentials 是
 * 宿主级配置（两个 home 刻意各自演化）。见
 * `.agents/notes/implemented/process/2026-09-08-separate-dsh-home.md`。
 */
export const TRADING_HOME_ENTRIES = [
  'watchlists.json',
  'selection.json',
  'watchlist-groups.json',
  'knowledge',
  'holdings',
  'indicators',
  'strategies',
  'trading-tasks',
  'trading-updater',
] as const

/** 迁移标记文件名（写在目标 home；存在即不再迁移，用户删档也不会被搬回）。 */
export const HOME_MIGRATION_MARKER = '.legacy-home-migrated.json'

export interface LegacyHomeMigrationOptions {
  /** 环境变量映射（缺省 `process.env`）；解析结果等于缺省 home 时直接跳过。 */
  env?: Record<string, string | undefined>
  /** 旧 home 根（缺省 `~/.dsh`）。 */
  legacyHome?: string
  /** 日志回调（缺省静默）。 */
  log?: (message: string) => void
}

export interface LegacyHomeMigrationResult {
  from: string
  to: string
  /** 本次复制过来的条目。 */
  copied: string[]
  /** 旧 home 有、目标 home 已有而跳过的条目（用户已自行迁移或本就同源）。 */
  skipped: string[]
}

/**
 * 旧 home → 当前 home 的一次性数据迁移（2026-09-08 审查 H4）。
 *
 * 背景：桌面壳内置缺省 home 翻到 `~/.dsh-trading` 后，老用户 `~/.dsh` 下的自选/
 * 持仓/知识库/定时任务数据不再被读取——表现是升级后「数据全空」。
 *
 * 语义（严格非破坏）：
 * - 解析结果等于缺省 home（`~/.dsh`）→ 不做任何事（CLI 缺省路径零影响）；
 * - 目标 home 已有标记文件 → 不再迁移（幂等；用户删除的文件不会被搬回）；
 * - 逐条目：目标已存在 → 跳过；旧 home 存在 → `cpSync` 复制（**复制不是移动**，
 *   旧 home 原样保留，回滚即删新 home 或继续用旧 home）；
 * - 只处理 {@link TRADING_HOME_ENTRIES} 白名单，绝不触碰宿主资产。
 *
 * @returns 迁移结果；未触发（同源/已迁移）返回 null。
 */
export function migrateLegacyTradingHome(options: LegacyHomeMigrationOptions = {}): LegacyHomeMigrationResult | null {
  const log = options.log ?? ((): void => {})
  const env = options.env ?? process.env
  const to = dshHomeDir(env)
  const from = resolve(expandHomePath(options.legacyHome ?? join(homedir(), DEFAULT_HOME_DIR_NAME)))
  if (from === to) return null
  const marker = join(to, HOME_MIGRATION_MARKER)
  if (existsSync(marker)) return null
  const copied: string[] = []
  const skipped: string[] = []
  for (const entry of TRADING_HOME_ENTRIES) {
    const source = join(from, entry)
    const target = join(to, entry)
    if (!existsSync(source)) continue
    if (existsSync(target)) {
      skipped.push(entry)
      continue
    }
    try {
      mkdirSync(to, { recursive: true })
      cpSync(source, target, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true })
      copied.push(entry)
    } catch (error) {
      log(`[dsh-home] legacy home migration failed for ${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    mkdirSync(to, { recursive: true })
    writeFileSync(marker, `${JSON.stringify({ from, to, copied, skipped, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  } catch (error) {
    log(`[dsh-home] could not write migration marker ${marker}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (copied.length > 0) {
    log(`[dsh-home] migrated legacy trading data from ${from} to ${to}: ${copied.join(', ')} (originals kept)`)
  }
  return { from, to, copied, skipped }
}
