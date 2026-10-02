/**
 * 运营 CLI 的端到端用例：把验收发现 #1 的复现命令序列钉进测试。
 *
 * 跑的是**真实进程**（node bin/sign-live-trading.mjs）与**真实文件**，没有 mock、没有等待。
 * 它需要 packages/authority/lib 已构建（CLI 从 lib/ 加载）——仓里所有连接器用例本来
 * 就经 @dshtrading/authority/testing 读 lib，构建是测试的前置条件。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTHORITY_DEV_ENV, AUTHORITY_DIR_ENV, GRANT_FILENAME, TRUSTED_KEYS_FILENAME, liveTradingDecision, processEuid, resetAuthorityCache } from '../src/index.ts'

const CLI = fileURLToPath(new URL('../bin/sign-live-trading.mjs', import.meta.url))
const REAL_UID = processEuid() ?? 0
/** 声明成另一个 uid：等价于「平面归人、agent 在别的 uid」，本机唯一能表达的合法形态。 */
const AGENT_UID = REAL_UID + 4_242
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-authority-cli-'))
  tempDirs.push(dir)
  return dir
}

/** 干净的运营环境：只带平面目录，绝不带 dev opt-in（除非测试显式加）。 */
function operatorEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env[AUTHORITY_DIR_ENV] = dir
  delete env[AUTHORITY_DEV_ENV]
  return { ...env, ...extra }
}

function runCli(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

afterEach(() => {
  resetAuthorityCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('复现序列：agent 用自己 uid 自铸信任锚', () => {
  it('管理员：复现命令序列（init / sign / status）不再有任何一步输出放行', () => {
    // Given 一个 agent 可写的临时平面目录，环境里没有 dev opt-in
    const dir = join(tempDir(), 'plane')
    const keyFile = join(tempDir(), 'operator.pem')
    const env = operatorEnv(dir)
    // When 依次跑验收发现 #1 的三条命令
    const init = runCli(['init', '--key', keyFile, '--trust', join(dir, TRUSTED_KEYS_FILENAME)], env)
    const sign = runCli(['sign', '--key', keyFile, '--dir', dir, '--days', '30'], env)
    const status = runCli(['status', '--dir', dir], env)
    // Then init/sign 在写入侧被拒（声明不了 agent uid），status 也不会放行
    expect(init.status).not.toBe(0)
    expect(init.stderr).toContain('agent-uid-required')
    expect(sign.status).not.toBe(0)
    expect(sign.stderr).toContain('agent-uid-required')
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('拒绝')
    expect(status.stdout).not.toContain('放行')
    expect(existsSync(join(dir, TRUSTED_KEYS_FILENAME))).toBe(false)
  })

  it('管理员：强行 --force-dev 自铸后，status 在没有 opt-in 时仍拒绝', () => {
    // Given 同一序列，但攻击者显式声明开发形态
    const dir = join(tempDir(), 'plane')
    const keyFile = join(tempDir(), 'operator.pem')
    const env = operatorEnv(dir)
    const init = runCli(['init', '--key', keyFile, '--trust', join(dir, TRUSTED_KEYS_FILENAME), '--force-dev'], env)
    const sign = runCli(['sign', '--key', keyFile, '--dir', dir, '--force-dev'], env)
    // When 读取端（没有 opt-in）看这份平面
    const status = runCli(['status', '--dir', dir], env)
    // Then 写入确实发生了（dev 形态允许），但判定拒绝：平面归运行 uid，未与 agent 隔离
    expect(init.status).toBe(0)
    expect(init.stderr).toContain('[DEV]')
    expect(sign.status).toBe(0)
    expect(sign.stderr).toContain('[DEV]')
    expect(status.stdout).toContain('plane-not-isolated')
    expect(status.stdout).not.toContain('放行')
    // When 同一个读取端显式 opt-in dev
    const devStatus = runCli(['status', '--dir', dir], operatorEnv(dir, { [AUTHORITY_DEV_ENV]: '1' }))
    // Then 才放行，并在 stderr 留下 dev 痕迹
    expect(devStatus.stdout).toContain('放行')
    expect(devStatus.stdout).toContain('granted')
    expect(devStatus.stderr).toContain('[DEV]')
  })

  it('管理员：CLI 的合法路径（声明 agent uid）签出的授权在读取端放行', () => {
    // Given 一个声明了另一个 agent uid 的运营环境（人 ≠ agent）
    const dir = join(tempDir(), 'plane')
    const keyFile = join(tempDir(), 'operator.pem')
    const env = operatorEnv(dir)
    // When 走 CLI 的 init + sign
    const init = runCli(['init', '--key', keyFile, '--trust', join(dir, TRUSTED_KEYS_FILENAME), '--agent-uid', String(AGENT_UID)], env)
    const sign = runCli(['sign', '--key', keyFile, '--dir', dir, '--days', '30', '--operator', 'zcl', '--agent-uid', String(AGENT_UID)], env)
    // Then 两步都成功，且授权不带 dev 标记
    expect(init.status).toBe(0)
    expect(sign.status).toBe(0)
    expect(sign.stdout).toContain('granted')
    expect(sign.stdout).not.toContain('[DEV]')
    // When 读取端以 agent uid 判定
    const decision = liveTradingDecision(true, { dir, env: {}, euid: AGENT_UID })
    // Then 放行——这是「合法人工签署 → granted」的那条路径
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('granted')
    expect(decision.payload?.operator).toBe('zcl')
    expect(decision.isolation?.code).toBe('isolated')
    expect(existsSync(join(dir, GRANT_FILENAME))).toBe(true)
  })
})
