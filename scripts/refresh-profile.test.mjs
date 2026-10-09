/**
 * refresh-profile / profile-config-preflight 自测（进 test:scripts，真实脚本子进程）。
 *
 * 覆盖 2026-10-09 的两处收紧：
 *   1. 刷新入口从硬编码 trading-web 泛化为 scripts/refresh-profile.sh <profile...>，
 *      旧入口 refresh-trading-web-profile.sh 保留为转发 shim（位置参数仍是包名）。
 *   2. 预检新增 --allow-version-drift：刷新紧随其后的删除重装会消除版本漂移，故它
 *      对漂移只告警；其余三类漂移（死路径/身份漂移/闭包缺口）仍中止。
 *
 * 隔离纪律：所有用例只碰 mkdtemp 出的夹具 home（名字含 -trading 才过 home 守卫），
 * 并把 dsh 换成 PATH 上的假实现——测试绝不对 ~/.dsh-trading 做插件安装。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REFRESH = join(ROOT, 'scripts', 'refresh-profile.sh')
const SHIM = join(ROOT, 'scripts', 'refresh-trading-web-profile.sh')
const PREFLIGHT = join(ROOT, 'scripts', 'profile-config-preflight.sh')
const NL = String.fromCharCode(10)
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 枚举仓库真实的 @dshtrading 包名，让夹具的闭包检查有真实语义。 */
function repoPackageNames() {
  const out = spawnSync('node', ['-e', 'const fs=require("fs");const p=[];for(const d of fs.readdirSync("packages")){try{const m=JSON.parse(fs.readFileSync("packages/"+d+"/package.json","utf8"));if(m.name&&m.name.startsWith("@dshtrading/"))p.push(m.name)}catch{}};process.stdout.write(JSON.stringify(p))'], { cwd: ROOT, encoding: 'utf8' })
  return JSON.parse(out.stdout)
}

/** 名字含 -trading，才通过 preflight / refresh 共用的「是不是 trading home」守卫。 */
function tempTradingHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix + '-trading-'))
  dirs.push(home)
  return home
}

/** 仓库各包 peer 声明的 @deepseek-ai/* 名（含 dsh-tools 的 brand/values 传递依赖）。 */
function sdkPeerNames() {
  const names = new Set(['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-util-values'])
  for (const name of repoPackageNames()) {
    try {
      const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', name.replace('@dshtrading/', ''), 'package.json'), 'utf8'))
      for (const dep of Object.keys(manifest.peerDependencies ?? {})) {
        if (dep.startsWith('@deepseek-ai/')) names.add(dep)
      }
    } catch {
      // 无 manifest 的目录：跳过。
    }
  }
  return [...names]
}

/**
 * PATH 上的假 dsh：记录调用即退出，绝不对真实 home 装插件。
 *
 * 放在 <root>/bin/dsh 是刻意的：sync-profile-overrides.mjs 从 dsh 可执行文件的
 * realpath 推导 SDK 根（<root>/node_modules），并把 @deepseek-ai/* override 行写到
 * 那里。假 dsh 若不落在 bin/ 下，推导会回落到硬编码的 Homebrew 路径——本机存在、
 * CI 不存在，于是夹具里写下死路径、预检判红（2026-08-30 note 的 CI 约束）。
 * 一并造出该 SDK 根下的包目录，让夹具与宿主安装彻底解耦。
 */
function stubDsh() {
  const root = mkdtempSync(join(tmpdir(), 'stub-dsh-'))
  dirs.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'dsh')
  writeFileSync(file, '#!/bin/sh' + NL + 'exit 0' + NL)
  chmodSync(file, 0o755)
  for (const name of sdkPeerNames()) {
    const dir = join(root, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-test' }, null, 2))
  }
  return bin
}

/**
 * 夹具 home：每个 profile 都依赖全部 @dshtrading 包且 overrides 全覆盖（否则预检
 * 报闭包缺口），并在 node_modules 注入**两个不同版本**的非 private 拷贝触发检查 4。
 */
function fixtureHome(profiles = ['trading-web', 'trading-all']) {
  const home = tempTradingHome('refresh-profile')
  const names = repoPackageNames()
  for (const profile of profiles) {
    const P = join(home, 'profiles', profile)
    mkdirSync(P, { recursive: true })
    const deps = {}
    const rows = []
    for (const n of names) {
      const target = join(ROOT, 'packages', n.replace('@dshtrading/', ''))
      deps[n] = 'file:' + target
      rows.push("  '" + n + "': 'file:" + target + "'")
    }
    writeFileSync(join(P, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + profile, private: true, dependencies: deps }, null, 2))
    writeFileSync(join(P, 'pnpm-workspace.yaml'), ['overrides:', ...rows, ''].join(NL))
    for (const [n, v] of [['alpha', '0.4.1'], ['beta', '0.5.0']]) {
      const d = join(P, 'node_modules', '@dshtrading', n)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@dshtrading/' + n, version: v }, null, 2))
    }
  }
  return home
}

function runScript(script, args, { home, bin } = {}) {
  const env = { ...process.env }
  if (home) env.DSH_HOME = home
  if (bin) env.PATH = bin + ':' + env.PATH
  return spawnSync('bash', [script, ...args], { cwd: ROOT, encoding: 'utf8', env, timeout: 20000 })
}

describe('profile-config-preflight --allow-version-drift', () => {
  it('管理员：默认模式下混世代副本判红且退出码非零', () => {
    // Given: a trading home whose @dshtrading copies mix two versions
    const home = fixtureHome(['trading-web'])
    // When: the preflight runs in its default gate mode
    const result = runScript(PREFLIGHT, ['trading-web'], { home })
    // Then: version drift is a hard failure
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('版本漂移')
  })

  it('管理员：--allow-version-drift 把版本漂移降级为告警并放行', () => {
    // Given: the same drifting home
    const home = fixtureHome(['trading-web'])
    // When: the preflight runs in refresh mode
    const result = runScript(PREFLIGHT, ['--allow-version-drift', 'trading-web'], { home })
    // Then: it warns but exits clean, so the refresh can proceed to reinstall
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--allow-version-drift')
  })

  it('管理员：闭包缺口不受 --allow-version-drift 影响，仍然中止', () => {
    // Given: a trading home whose profile covers only one repo package (deps 与 overrides 都窄)
    const home = tempTradingHome('refresh-gap')
    const P = join(home, 'profiles', 'trading-web')
    mkdirSync(P, { recursive: true })
    const base = 'file:' + join(ROOT, 'packages', 'base')
    writeFileSync(join(P, 'package.json'), JSON.stringify({ name: 'dsh-profile-trading-web', private: true, dependencies: { '@dshtrading/base': base } }, null, 2))
    writeFileSync(join(P, 'pnpm-workspace.yaml'), ['overrides:', "  '@dshtrading/base': '" + base + "'", ''].join(NL))
    // When: the preflight runs in refresh mode
    const result = runScript(PREFLIGHT, ['--allow-version-drift', 'trading-web'], { home })
    // Then: the closure gap still fails the gate
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('闭包缺口')
  })
})

describe('refresh-profile 入口', () => {
  it('运营：未知选项打印用法并以非零码退出', () => {
    // Given: an unknown flag
    const home = tempTradingHome('refresh-opt')
    // When: the refresh script is invoked
    const result = runScript(REFRESH, ['--bogus'], { home })
    // Then: it refuses rather than guessing
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('未知选项')
  })

  it('运营：--help 说明 profile 与 package 两种用法', () => {
    // Given: the help flag
    const home = tempTradingHome('refresh-help')
    // When: the refresh script is invoked
    const result = runScript(REFRESH, ['--help'], { home })
    // Then: both entry shapes are documented
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--package')
    expect(result.stdout).toContain('trading-web-profile.sh')
  })

  it('运营：DSH_HOME 指向宿主 home 时拒绝执行且不动任何文件', () => {
    // Given: an inherited host home
    const hostHome = join(process.env.HOME, '.dsh')
    // When: the refresh script is invoked against it
    const result = runScript(REFRESH, ['trading-web'], { home: hostHome })
    // Then: it refuses instead of refreshing the wrong home
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('不是 trading home')
  })

  it('运营：不存在的 profile 在动手前即被拒绝', () => {
    // Given: a trading home without the requested profile
    const home = fixtureHome(['trading-web'])
    // When: the refresh targets a profile that does not exist
    const result = runScript(REFRESH, ['--profile', 'no-such-profile'], { home })
    // Then: it exits before any install
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('profile 不存在')
  })

  it('运营：泛化入口刷新指定 profile 并重挂宿主核心包 symlink', () => {
    // Given: a trading home with a real fixture profile and a stubbed dsh
    const home = fixtureHome(['trading-all'])
    const bin = stubDsh()
    // When: the generalized entry refreshes that profile
    const result = runScript(REFRESH, ['--profile', 'trading-all'], { home, bin })
    // Then: it targets that profile and always re-mounts the core cohort
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('-- trading-all --')
    expect(result.stdout).toContain('恢复宿主核心包单一实例 symlink')
  })

  it('运营：旧入口把位置参数当包名转发，仍刷新 trading-web', () => {
    // Given: the legacy entry invoked with a package name against an isolated home
    const home = fixtureHome(['trading-web'])
    const bin = stubDsh()
    // When: the shim runs
    const result = runScript(SHIM, ['connector-futu'], { home, bin })
    // Then: it forwards to the generalized script, targeting trading-web
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('-- trading-web --')
    expect(existsSync(join(home, 'profiles', 'trading-web', 'package.json'))).toBe(true)
  })
})

describe('refresh-profile 夹具前置', () => {
  it('运营：仓库存在 @dshtrading 闭包，夹具非空', () => {
    // Given: the repo workspace
    // When: package names are enumerated
    const names = repoPackageNames()
    // Then: the closure fixtures cover real packages
    expect(names.length).toBeGreaterThan(0)
    expect(names.every(n => n.startsWith('@dshtrading/'))).toBe(true)
  })
})
