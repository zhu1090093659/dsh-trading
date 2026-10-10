/**
 * docs-link-check 自测（进 test:scripts，纯 JS）：夹具驱动，验证三件事——
 *   ① 真的会拦**新增**断链（非零退出 + 点名到文件与目标）；
 *   ② 存量债入基线后**只拦新增**（基线内不报，基线外才报）；
 *   ③ 基线与报错**按仓库根相对路径**记账，与 checkout 落在哪个绝对路径无关
 *      （`DOCS_LINK_ROOT` 指到临时目录也照样对得上）——2026-10-09 修复前基线存的是
 *      `/Users/<人>/…` 绝对路径，在 CI 的 `/home/runner/…` 上 18 条存量全部对不上，
 *      门禁一上线就恒红。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NL = String.fromCharCode(10)
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * 造一个夹具仓库：files 的键是相对路径、值是内容；返回根绝对路径。
 * 恒补 `.agents/notes/.keep.md` —— 门禁的扫描根是 `AGENTS.md` / `docs` / `.agents` 三处
 * 固定位置（与真实仓库一致），夹具缺一个就测不到真实形状。
 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-link-'))
  dirs.push(dir)
  const all = { '.agents/notes/.keep.md': '# keep' + NL, 'docs/.keep.md': '# docs' + NL, 'scripts/.keep': '', ...files }
  for (const [relative, content] of Object.entries(all)) {
    const target = join(dir, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

/** 在夹具根下跑门禁；`DOCS_LINK_ROOT` 覆盖扫描根，`extraArgs` 传 --update 等。 */
function check(dir, extraArgs = []) {
  return spawnSync(process.execPath, ['scripts/docs-link-check.mjs', ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DOCS_LINK_ROOT: dir },
  })
}

describe('文档相对链接检查', () => {
  it('管理员：新增断链 ⇒ 报出仓库根相对的文件与目标并非零退出', () => {
    // Given 一份文档链接到不存在的文件（另有一份存在的做对照）
    const dir = fixture({
      'AGENTS.md': ['# a', '[在的](docs/ok.md)', '[断的](docs/gone.md)'].join(NL),
      'docs/ok.md': '# ok' + NL,
    })
    // When 跑门禁
    const result = check(dir)
    // Then 只报断的那条，且路径是仓库根相对写法
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('AGENTS.md → docs/gone.md')
    expect(result.stderr).not.toContain('docs/ok.md')
  })

  it('管理员：存量断链入基线后只拦新增，基线内不报', () => {
    // Given 一条存量断链已 --update 入基线
    const dir = fixture({ 'AGENTS.md': '[存量](docs/gone.md)' + NL })
    expect(check(dir, ['--update']).status).toBe(0)
    // When 原样再跑（无新增）
    const clean = check(dir)
    // Then 放行，且报出存量条数
    expect(clean.status).toBe(0)
    expect(clean.stdout).toContain('基线 1 条')
    // When 再加一条新的断链
    writeFileSync(join(dir, 'AGENTS.md'), ['[存量](docs/gone.md)', '[新增](docs/gone2.md)'].join(NL))
    const regressed = check(dir)
    // Then 只拦新增那条，存量那条不重复报
    expect(regressed.status).toBe(1)
    expect(regressed.stderr).toContain('docs/gone2.md')
    expect(regressed.stderr).toContain('1 条新增断链')
  })

  it('管理员：基线与报错是仓库根相对路径，换 scan root 仍对得上（CI 形态）', () => {
    // Given 同一份夹具内容分别落在两个不同的绝对路径下，各自 --update 出基线
    const one = fixture({ 'AGENTS.md': '[断](docs/gone.md)' + NL })
    const two = fixture({ 'AGENTS.md': '[断](docs/gone.md)' + NL })
    expect(check(one, ['--update']).status).toBe(0)
    const baseline = JSON.parse(readFileSync(join(one, 'scripts/docs-link-baseline.json'), 'utf8'))
    // Then 基线里没有任何绝对路径，只有仓库根相对写法
    expect(baseline.broken).toEqual(['AGENTS.md → docs/gone.md'])
    // When 把同一条基线搬到另一个绝对路径（模拟 CI 的 /home/runner/…）
    mkdirSync(join(two, 'scripts'), { recursive: true })
    writeFileSync(join(two, 'scripts/docs-link-baseline.json'), JSON.stringify(baseline))
    const result = check(two)
    // Then 存量仍然对得上，不会假报新增
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('基线 1 条')
  })

  it('管理员：按所在文件目录解析的相对链接不被仓库根解析放宽掉（不忽略断链）', () => {
    // Given 一条按文件目录解析才对得上的链接，和一条两种解析都失败的链接
    const dir = fixture({
      'docs/README.md': ['[同级](sibling.md)', '[真断](nowhere.md)'].join(NL),
      'docs/sibling.md': '# sib' + NL,
    })
    // When 跑门禁
    const result = check(dir)
    // Then 文件相对的合法链接放行，真断链照样拦
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('docs/README.md → nowhere.md')
    expect(result.stderr).not.toContain('sibling.md')
  })

  it('管理员：冻结的 archived 归档记录不参与活门禁，活树的断链照拦', () => {
    // Given 归档记录与活树记录各有一条同样的断链
    const dir = fixture({
      '.agents/notes/archived/old.md': '[断](nowhere.md)' + NL,
      '.agents/notes/implemented/live.md': '[断](nowhere.md)' + NL,
    })
    // When 跑门禁
    const result = check(dir)
    // Then 只报活树那条；归档记录不出现在结果里
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('.agents/notes/implemented/live.md')
    expect(result.stderr).not.toContain('archived/old.md')
  })
})
