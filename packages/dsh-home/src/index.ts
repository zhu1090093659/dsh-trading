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

import { homedir } from 'node:os'
import { resolve } from 'node:path'

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
