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

// ── crypto-trader preset 幂等自安装（S3 机制） ─────────────────────────────────

export const PRESET_ID = 'crypto-trader'

/** 默认安装 root：市场自有目录（S3 建议——绝不写进 ~/.dsh/.agent-presets 用户创作区）。 */
export const DEFAULT_PRESET_ROOT = join(homedir(), '.dsh-trading-presets')

/** 预置资产随本包分发（bundle 是市场组装点，preset 资产归 bundle 所有）。 */
const PRESET_ASSET_DIR = fileURLToPath(new URL('../assets/preset/', import.meta.url))
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const

export interface SelfInstallResult {
  /** 安装目录（preset 目录名即 roster id）。 */
  dir: string
  /** 本次实际写入的文件名；空数组 = 目录已是最新的幂等运行。 */
  wrote: string[]
}

/**
 * 幂等自安装 crypto-trader preset（S3 机制，参照 spikes/s3-preset/spike-preset-pkg 的
 * selfInstall）：mkdir -p + 逐文件内容 diff 后写，内容一致则零写入。
 *
 * 卸载本 bundle 不删除已安装目录（有意为之）：升级/重装后再次 apply 即恢复一致；本包
 * 被移除后 preset 行不可解析只会得到带原因的 broken 行，无进程崩溃（S3 REPORT broken 语义）。
 * preset 引用的插件包必须进本 bundle 的 dependencies（S3 坑 3），见 package.json。
 */
export async function installPreset(options: { presetRoot?: string } = {}): Promise<SelfInstallResult> {
  const dir = join(options.presetRoot ?? DEFAULT_PRESET_ROOT, PRESET_ID)
  await mkdir(dir, { recursive: true })
  const wrote: string[] = []
  for (const file of PRESET_FILES) {
    const content = await readFile(join(PRESET_ASSET_DIR, PRESET_ID, file), 'utf8')
    const target = join(dir, file)
    let current: string | null = null
    try {
      current = await readFile(target, 'utf8')
    } catch {
      // 不存在（首次安装）或不可读 → 视为需要写入。
    }
    if (current !== content) {
      await writeFile(target, content)
      wrote.push(file)
    }
  }
  return { dir, wrote }
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
    (result) => logger(ctx).info(
      '[dsh-trading-crypto-installer] self-install %s preset at %s wrote=[%s]',
      PRESET_ID,
      result.dir,
      result.wrote.join(',') || 'nothing — already current',
    ),
    (error: unknown) => logger(ctx).warn('[dsh-trading-crypto-installer] crypto-trader preset self-install failed: %s', error),
  )
}
