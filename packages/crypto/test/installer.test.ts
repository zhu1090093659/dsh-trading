/**
 * 安装器代际管理戳单测（2026-08-29 升级，四市场同一逻辑——以 crypto 为代表测试）：
 * 不存在→写；带戳内容漂移→更新；无戳（用户改过）→跳过并提示。
 * 2026-08-29：installPreset 改为多 preset（crypto-trader + crypto-trader-okx），
 * 单项测试用 find 取目标 preset 的结果。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPreset } from '../src/index.js'

const STAMP_PREFIX = '# dsh-trading-managed: '

function sha8(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8)
}

const dirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-trading-installer-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 从多 preset 结果中取指定 preset 的那份（crypto-trader 为默认主 preset）。 */
async function installOne(root: string, presetId: string) {
  const results = await installPreset({ presetRoot: root })
  const hit = results.find((r) => r.dir.endsWith('/' + presetId))
  if (hit === undefined) throw new Error(`preset ${presetId} not installed: ${results.map((r) => r.dir).join(', ')}`)
  return hit
}

describe('installPreset（代际管理戳，单预设）', () => {
  it('第 1 代：preset 不存在 → 写入 stamp+内容；re-run 零写入（幂等）', async () => {
    const root = await tempRoot()
    const results = await installPreset({ presetRoot: root })
    expect(results).toHaveLength(1)
    for (const r of results) {
      expect(r.wrote.sort()).toEqual(['agent.cordis.yml', 'preset.yml'])
      expect(r.skipped).toEqual([])
      const raw = await readFile(join(r.dir, 'preset.yml'), 'utf8')
      const firstLineEnd = raw.indexOf('\n')
      expect(raw.slice(0, firstLineEnd)).toBe(`${STAMP_PREFIX}${sha8(raw.slice(firstLineEnd + 1))}`)
    }
    const again = await installPreset({ presetRoot: root })
    for (const r of again) {
      expect(r.wrote).toEqual([])
      expect(r.skipped).toEqual([])
    }
  })

  it('第 2 代：带戳但内容漂移 → 以新代际覆盖', async () => {
    const root = await tempRoot()
    const { dir } = await installOne(root, 'crypto-trader')
    const target = join(dir, 'agent.cordis.yml')
    const stamped = await readFile(target, 'utf8')
    const body = stamped.slice(stamped.indexOf('\n') + 1)
    // 用户在托管文件里改动正文（戳行保留）。
    await writeFile(target, `${stamped.slice(0, stamped.indexOf('\n') + 1)}${body}\n# my local hack\n`)
    const after = await installOne(root, 'crypto-trader')
    expect(after.wrote).toEqual(['agent.cordis.yml'])
    expect(after.skipped).toEqual([])
    const restored = await readFile(target, 'utf8')
    expect(restored).toBe(stamped) // 恢复为当前代际
  })

  it('第 3 代：无管理戳（用户改过）→ 跳过 + 提示，绝不覆盖', async () => {
    const root = await tempRoot()
    const { dir } = await installOne(root, 'crypto-trader')
    const target = join(dir, 'preset.yml')
    const stamped = await readFile(target, 'utf8')
    const body = stamped.slice(stamped.indexOf('\n') + 1)
    // 去掉戳行 = 用户接管。
    await writeFile(target, `${body}\n# user edited\n`)
    const after = await installOne(root, 'crypto-trader')
    expect(after.wrote).toEqual([])
    expect(after.skipped).toHaveLength(1)
    expect(after.skipped[0]).toContain('preset.yml')
    expect(after.skipped[0]).toContain('no management stamp')
    const untouched = await readFile(target, 'utf8')
    expect(untouched).toContain('# user edited')
  })

  it('戳行形态异常（非 8 位十六进制）→ 视为无戳跳过', async () => {
    const root = await tempRoot()
    const { dir } = await installOne(root, 'crypto-trader')
    const target = join(dir, 'preset.yml')
    const stamped = await readFile(target, 'utf8')
    const body = stamped.slice(stamped.indexOf('\n') + 1)
    await writeFile(target, `# dsh-trading-managed: zzzzzzzz\n${body}`)
    const after = await installOne(root, 'crypto-trader')
    expect(after.wrote).toEqual([])
    expect(after.skipped).toHaveLength(1)
  })
})
