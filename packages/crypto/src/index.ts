/**
 * @dsh-trading/crypto — crypto 市场 bundle。包承载两块实质内容：
 *
 *   1. `cordis.patch.yml`（由 package.json 的 `dsh.bundle.patch` 声明）：insert-only
 *      聚合本 bundle 的 host 面常驻行（铁律 #1）。connector/kit 两行在 preset 的
 *      agent.cordis.yml（preset 级会话隔离，见 assets/preset/crypto-trader/）。
 *   2. `dsh-trading-crypto-installer` 插件（本模块）：crypto-trader preset 幂等
 *      自安装（S3 机制）。**自安装职责必须在 bundle（host 面常驻）而非 kit 插件**
 *      ——kit 行在 preset 平面，preset 不存在时 kit.apply() 永不运行，鸡生蛋
 *      （2026-08-29 主 agent 结构性修复）；bundle 行常驻，boot 即自安装，与会话无关。
 *
 * @module @dsh-trading/crypto
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/**
 * Cordis 插件名 = patch 行 id（TEMPLATES §8）：`dsh-trading-crypto-*` 市场命名空间，
 * 全仓唯一（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-crypto-installer'

export interface Config {
  /** preset 自安装 root 覆盖；默认 ~/.dsh-trading-presets（须与 base 层 agent-presets 行的 roots 一致）。 */
  presetRoot?: string
}

export const Config: Schema<Config> = Schema.object({
  presetRoot: Schema.string(),
})

// ── crypto 市场 preset 幂等自安装（S3 机制） ────────────────────────────────

/** 本 bundle 自安装的全部 preset（目录名即 roster id）。 */
export const PRESET_IDS = ['crypto-trader', 'crypto-trader-okx'] as const
/** 默认主 preset（默认 Bar 激活 binance 数据面；okx preset 为 OKX 切换会话，见其资产头注）。 */
export const PRESET_ID = PRESET_IDS[0]

/** 默认安装 root：市场自有目录（S3 建议——绝不写进 ~/.dsh/.agent-presets 用户创作区）。 */
export const DEFAULT_PRESET_ROOT = join(homedir(), '.dsh-trading-presets')

/** 预置资产随本包分发（bundle 是市场组装点，preset 资产归 bundle 所有）。 */
const PRESET_ASSET_DIR = fileURLToPath(new URL('../assets/preset/', import.meta.url))
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const

/** 管理戳注释行前缀：托管安装文件的头行，值 = shipped 内容（不含戳行）的 SHA-256 前 8 位。 */
const MANAGED_STAMP_PREFIX = '# dsh-trading-managed: '

function contentSha8(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8)
}

/** 提取已安装文件头行的管理戳；null = 无戳（文件视为用户所有）。 */
function readManagedStamp(current: string): string | null {
  if (!current.startsWith(MANAGED_STAMP_PREFIX)) return null
  const firstLine = current.includes('\n') ? current.slice(0, current.indexOf('\n')) : current
  const stamp = firstLine.slice(MANAGED_STAMP_PREFIX.length).trim()
  return /^[0-9a-f]{8}$/.test(stamp) ? stamp : null
}

/** 已安装文件去掉管理戳头行后的正文。 */
function bodyAfterStamp(current: string): string {
  return current.includes('\n') ? current.slice(current.indexOf('\n') + 1) : ''
}

export interface SelfInstallResult {
  /** 安装目录（preset 目录名即 roster id）。 */
  dir: string
  /** 本次实际写入的文件名；空数组 = 内容已是当前代际。 */
  wrote: string[]
  /** 被跳过的文件与原因（用户改过/无管理戳）。 */
  skipped: string[]
}

/**
 * 幂等自安装 preset（S3 机制 + 2026-08-29 代际管理戳升级）：mkdir -p + 逐文件按管理戳
 * 三代裁决——
 *
 *   1. 目标不存在 → 写入（头行 = `# dsh-trading-managed: <内容sha前8>` + shipped 内容）；
 *   2. 目标存在且带本包可识别的管理戳（托管文件）→ 正文与 shipped 内容不同则整文件更新
 *      （以新代际覆盖——戳即「本文件归安装器托管」的约定）；
 *   3. 目标存在但无管理戳（用户改过/前代安装器所装）→ 跳过并记录提示（删除该文件即可
 *      让安装器重新提供）。
 *
 * 迁移注意：代际升级前由旧安装器写入的已装文件没有管理戳，按第 3 条处理（跳过 + log
 * 提示）——宁可不更新，绝不覆盖用户改动。
 *
 * 卸载本 bundle 不删除已安装目录（有意为之）：升级/重装后再次 apply 即恢复一致；本包
 * 被移除后 preset 行不可解析只会得到带原因的 broken 行，无进程崩溃（S3 REPORT broken 语义）。
 * preset 引用的插件包必须进本 bundle 的 dependencies（S3 坑 3），见 package.json。
 */
/** 安装单个 preset 目录（resolved 为目录名）。 */
async function installOne(assetDir: string, presetRoot: string, presetId: string): Promise<SelfInstallResult> {
  const dir = join(presetRoot, presetId)
  await mkdir(dir, { recursive: true })
  const wrote: string[] = []
  const skipped: string[] = []
  for (const file of PRESET_FILES) {
    const content = await readFile(join(assetDir, presetId, file), 'utf8')
    const stamped = `${MANAGED_STAMP_PREFIX}${contentSha8(content)}\n${content}`
    const target = join(dir, file)
    let current: string | null = null
    try {
      current = await readFile(target, 'utf8')
    } catch {
      // 不存在（首次安装）或不可读 → 视为需要写入。
    }
    if (current === null) {
      await writeFile(target, stamped)
      wrote.push(file)
      continue
    }
    if (readManagedStamp(current) === null) {
      skipped.push(`${file} (no management stamp — user-modified file left untouched; delete it to let the installer re-provision it)`)
      continue
    }
    if (bodyAfterStamp(current) !== content) {
      await writeFile(target, stamped)
      wrote.push(file)
    }
  }
  return { dir, wrote, skipped }
}

/**
 * 幂等自安装全部 preset（S3 机制 + 2026-08-29 代际管理戳升级）：对每个 preset
 * 目录 mkdir -p + 逐文件按管理戳三代裁决（见 installOne 注释）。
 *
 * 迁移注意：代际升级前由旧安装器写入的已装文件没有管理戳，按「无戳跳过 + log 提示」
 * 处理——宁可不更新，绝不覆盖用户改动。
 *
 * 卸载本 bundle 不删除已安装目录（有意为之）：升级/重装后再次 apply 即恢复一致。
 */
export async function installPreset(options: { presetRoot?: string } = {}): Promise<SelfInstallResult[]> {
  const presetRoot = options.presetRoot ?? DEFAULT_PRESET_ROOT
  return Promise.all(PRESET_IDS.map((presetId) => installOne(PRESET_ASSET_DIR, presetRoot, presetId)))
}

// ── 插件入口 ──────────────────────────────────────────────────────────────────

/** 宿主 logger 的最小形状（ctx.logger(name) 不可用时回落 console，保证任何面可启动）。 */
interface LogLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

function logger(ctx: Context): LogLike {
  const service = (ctx as unknown as { logger?: (name: string) => LogLike }).logger
  return typeof service === 'function' ? service(name) : console
}

export function apply(ctx: Context, config: Config): void {
  // 自安装不阻塞插件启动、失败不炸 profile boot（fire-and-forget，日志留痕）。
  void installPreset({ presetRoot: config?.presetRoot }).then(
    (results) => {
      for (const result of results) {
        logger(ctx).info(
          '[dsh-trading-crypto-installer] self-install %s preset at %s wrote=[%s] skipped=[%s]',
          result.dir.split('/').pop() ?? result.dir,
          result.dir,
          result.wrote.join(',') || 'nothing — already current',
          result.skipped.join('; ') || 'none',
        )
      }
    },
    (error: unknown) => logger(ctx).warn('[dsh-trading-crypto-installer] crypto preset self-install failed: %s', error),
  )
}
