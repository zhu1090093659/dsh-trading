/**
 * DSH_HOME 消费面守卫（2026-09-08 审查：分离改动改了 16 处默认数据路径，但只有纯
 * 解析器 `dshHomeDir()` 有测试——任何一处回落 `path.join(homedir(), '.dsh', …)`
 * 都会让该切片的数据静默读错 home，且全仓测试仍绿）。
 *
 * 本测试直接扫各包 src 的源码文本，禁止出现把 `~/.dsh` 写死进代码的模式
 * （注释里提到旧路径不拦——那是文档债，不是行为）。@dshtrading/dsh-home 自身是
 * 缺省值定义处，豁免。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const SELF_PACKAGE = 'dsh-home'

/** 把 `~/.dsh` 写死进路径的代码形态（homedir() 与 '.dsh' 同现于一个 join）。 */
const FORBIDDEN = /homedir\(\)\s*,\s*['"]\.dsh['"]/

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(full, out)
      continue
    }
    if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('DSH_HOME 消费面守卫', () => {
  it('各包 src 不得把 ~/.dsh 写死进代码（必须经 dshHomeDir() 解析）', () => {
    const offenders: string[] = []
    for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
      if (!pkg.isDirectory() || pkg.name === SELF_PACKAGE) continue
      const srcDir = join(PACKAGES_DIR, pkg.name, 'src')
      let files: string[] = []
      try {
        if (!statSync(srcDir).isDirectory()) continue
        files = collectSourceFiles(srcDir)
      } catch {
        continue
      }
      for (const file of files) {
        if (FORBIDDEN.test(readFileSync(file, 'utf8'))) {
          offenders.push(file.slice(REPO_ROOT.length + 1))
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('默认路径函数经 dshHomeDir() 派生（DSH_HOME 覆盖即时生效）', async () => {
    const { defaultWatchlistStorePath } = await import('../../watchlist/src/plugin.ts')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = join(REPO_ROOT, '.tmp-home-guard')
    try {
      expect(defaultWatchlistStorePath()).toBe(join(process.env.DSH_HOME, 'watchlists.json'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
