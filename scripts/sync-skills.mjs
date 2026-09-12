#!/usr/bin/env node

/**
 * sync-skills.mjs
 *
 * 自动化将 .agents/skills/<skill-name>/SKILL.md 同步至对应的
 * packages/kit-<market>/assets/skills/<skill-name>.md 或 base。
 *
 * 保证开发时以 .agents/skills/ 为单一事实来源（SSOT），
 * 同时满足各 kit 包在 npm 发布分发时的静态资产打包需求。
 *
 * 路由规则：
 *   - 'trading-*' / 'indicator-*' / 'knowledge-*' -> 全部 market kit（crypto/us/cn/hk/futures）
 *   - 'crypto-*'                                  -> kit-crypto
 *   - 'us-*'                                      -> kit-us
 *   - 'cn-*'                                      -> kit-cn
 *   - 'hk-*'                                      -> kit-hk
 *   - 'futures-*'                                 -> kit-futures
 *   - 其它通用基础技能                             -> base
 */

import { readdir, readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AGENTS_SKILLS_DIR = path.join(ROOT, '.agents', 'skills')

const MARKET_PACKAGES = {
  crypto: path.join(ROOT, 'packages', 'kit-crypto', 'assets', 'skills'),
  us: path.join(ROOT, 'packages', 'kit-us', 'assets', 'skills'),
  cn: path.join(ROOT, 'packages', 'kit-cn', 'assets', 'skills'),
  hk: path.join(ROOT, 'packages', 'kit-hk', 'assets', 'skills'),
  futures: path.join(ROOT, 'packages', 'kit-futures', 'assets', 'skills'),
  base: path.join(ROOT, 'packages', 'base', 'assets', 'skills'),
}

function resolveTargetDirs(skillName) {
  if (
    skillName.startsWith('trading-') ||
    skillName.startsWith('indicator-') ||
    skillName.startsWith('knowledge-')
  ) {
    return [MARKET_PACKAGES.crypto, MARKET_PACKAGES.us, MARKET_PACKAGES.cn, MARKET_PACKAGES.hk, MARKET_PACKAGES.futures]
  }
  if (skillName.startsWith('crypto-')) return [MARKET_PACKAGES.crypto]
  if (skillName.startsWith('us-')) return [MARKET_PACKAGES.us]
  if (skillName.startsWith('cn-')) return [MARKET_PACKAGES.cn]
  if (skillName.startsWith('hk-')) return [MARKET_PACKAGES.hk]
  if (skillName.startsWith('futures-')) return [MARKET_PACKAGES.futures]
  return [MARKET_PACKAGES.base]
}

async function main() {
  if (!existsSync(AGENTS_SKILLS_DIR)) {
    console.log(`[sync-skills] Directory ${AGENTS_SKILLS_DIR} does not exist, skipping.`)
    return
  }

  const entries = await readdir(AGENTS_SKILLS_DIR, { withFileTypes: true })
  const skillDirs = entries.filter((e) => e.isDirectory())

  let syncedCount = 0

  for (const dir of skillDirs) {
    const skillName = dir.name
    const srcFile = path.join(AGENTS_SKILLS_DIR, skillName, 'SKILL.md')
    if (!existsSync(srcFile)) continue

    let content = await readFile(srcFile, 'utf8')
    // 兼容 Windows git 下未开启 symlink 导致的相对路径纯文本指针
    if (content.trim().startsWith('../') && content.trim().split('\n').length <= 2) {
      const realPath = path.resolve(path.dirname(srcFile), content.trim())
      if (existsSync(realPath)) {
        content = await readFile(realPath, 'utf8')
      }
    }

    // Company research references/templates/scripts are relative to its own resourceBase.
    // Keep the flattened compatibility asset, and distribute the complete portable skill.
    if (skillName === 'company-analysis') {
      await cp(path.join(AGENTS_SKILLS_DIR, skillName), path.join(MARKET_PACKAGES.base, skillName), {
        recursive: true,
        dereference: true,
        filter: (source) => !path.basename(source).startsWith('.'),
      })
    }

    const targetDirs = resolveTargetDirs(skillName)

    for (const targetDir of targetDirs) {
      const targetFile = path.join(targetDir, `${skillName}.md`)
      await mkdir(targetDir, { recursive: true })
      await writeFile(targetFile, content, 'utf8')
      console.log(`[sync-skills] Synced: ${skillName} -> ${path.relative(ROOT, targetFile)}`)
      syncedCount++
    }
  }

  console.log(`[sync-skills] Successfully synced ${syncedCount} skill asset(s).`)
}

main().catch((err) => {
  console.error('[sync-skills] Error:', err)
  process.exit(1)
})
