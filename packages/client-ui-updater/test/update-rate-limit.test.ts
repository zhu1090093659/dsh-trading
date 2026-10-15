/**
 * GitHub request-budget behavior for the update channel: an exhausted
 * unauthenticated budget (403 + `x-ratelimit-remaining: 0`, or 429 +
 * `retry-after`) is classified as rate limiting and backed off until the reset
 * instead of being retried on every launch. Real Response objects and a real
 * temp profile; no mocks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverEnvironmentFrom } from '../src/environment.js'
import { fetchLatestRelease, GithubRateLimitError } from '../src/github.js'
import { UpdaterService } from '../src/updater-service.js'

const REPO = 'zhu1090093659/dsh-trading'
const CLOCK_START = Date.parse('2026-10-15T12:00:00.000Z')
const RESET_IN_SECONDS = 600

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (dir === undefined) continue
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

/** A profile the updater recognizes as desktop-seeded, with no packages to apply. */
function makeSeededProfile(): string {
  const root = makeTempDir('dsh-updater-ratelimit-')
  writeFileSync(path.join(root, '.dsh-desktop-seed.json'), JSON.stringify({
    stamp: 'test-stamp',
    appVersion: '0.1.1',
    seededAt: '2026-09-04T00:00:00.000Z',
  }))
  const pkg = path.join(root, 'node_modules', '@dshtrading', 'client-ui-updater')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@dshtrading/client-ui-updater', version: '0.1.1' }))
  return root
}

/** GitHub's answer once this address has spent its unauthenticated budget. */
function overBudgetResponse(resetSeconds: number | undefined): Response {
  const headers = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60' })
  if (resetSeconds !== undefined) headers.set('x-ratelimit-reset', String(resetSeconds))
  return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers })
}

describe('update channel request budget', () => {
  it('用户看到的是"配额用尽"而不是未知的 403 失败', async () => {
    // Given GitHub refuses the release probe with an exhausted budget and a reset hint
    const resetSeconds = Math.floor(CLOCK_START / 1000) + RESET_IN_SECONDS
    const fetchImpl = (async () => overBudgetResponse(resetSeconds)) as unknown as typeof fetch

    // When the probe runs
    const error = await fetchLatestRelease({ repo: REPO, apiBase: 'https://api.example', fetchImpl })
      .then(() => undefined, (thrown: unknown) => thrown)

    // Then it is a rate-limit error carrying the reset instant, not a bare 403
    expect(error).toBeInstanceOf(GithubRateLimitError)
    expect((error as GithubRateLimitError).message).toContain('403 rate limit')
    expect((error as GithubRateLimitError).resetAt).toBe(resetSeconds * 1000)
  })

  it('用户仍能看到没有配额线索的 403 是普通失败', async () => {
    // Given GitHub answers 403 without saying anything about a budget
    const fetchImpl = (async () => new Response('{"message":"Forbidden"}', { status: 403 })) as unknown as typeof fetch

    // When the probe runs
    const error = await fetchLatestRelease({ repo: REPO, apiBase: 'https://api.example', fetchImpl })
      .then(() => undefined, (thrown: unknown) => thrown)

    // Then it stays a plain failure with the status in the message
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(GithubRateLimitError)
    expect((error as Error).message).toBe('GitHub API 403 for ' + REPO + ' releases/latest')
  })

  it('用户不会因为连开几次应用就被反复打到限流上', async () => {
    // Given a seeded profile, an exhausted budget with a reset 10 minutes out, and a fixed clock
    const profileRoot = makeSeededProfile()
    const statePath = path.join(makeTempDir('dsh-updater-state-'), 'state.json')
    const resetSeconds = Math.floor(CLOCK_START / 1000) + RESET_IN_SECONDS
    let clock = CLOCK_START
    const probes: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      probes.push(String(input))
      return overBudgetResponse(resetSeconds)
    }) as unknown as typeof fetch
    const service = new UpdaterService({
      env: discoverEnvironmentFrom(path.join(profileRoot, 'node_modules', '@dshtrading', 'client-ui-updater', 'lib', 'index.js')),
      repo: REPO,
      statePath,
      now: () => clock,
      github: { fetchImpl, apiBase: 'https://api.example' },
    })

    // When a check hits the wall and two more non-forced checks run inside the cooldown
    const first = await service.check(false)
    const second = await service.check(false)
    clock = resetSeconds * 1000 - 1
    const third = await service.check(false)

    // Then GitHub was asked once, the state says why, and the cooldown holds until the reset
    expect(first.check.status).toBe('error')
    expect(first.check.error).toContain('403 rate limit')
    expect(second.check.status).toBe('error')
    expect(third.check.status).toBe('error')
    expect(probes).toHaveLength(1)

    // When the clock passes the reset, the next non-forced check probes again
    clock = resetSeconds * 1000 + 1
    await service.check(false)
    expect(probes).toHaveLength(2)

    // And an explicit force still goes out during a cooldown (the user asked for it)
    await service.check(true)
    expect(probes).toHaveLength(3)
  })

  it('用户重启应用后仍在冷却期，不会被再打一次限流', async () => {
    // Given a seeded profile whose first launch already hit an exhausted budget
    const profileRoot = makeSeededProfile()
    const statePath = path.join(makeTempDir('dsh-updater-state-'), 'state.json')
    const resetSeconds = Math.floor(CLOCK_START / 1000) + RESET_IN_SECONDS
    let clock = CLOCK_START
    const probes: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      probes.push(String(input))
      return overBudgetResponse(resetSeconds)
    }) as unknown as typeof fetch
    const launch = (): UpdaterService => new UpdaterService({
      env: discoverEnvironmentFrom(path.join(profileRoot, 'node_modules', '@dshtrading', 'client-ui-updater', 'lib', 'index.js')),
      repo: REPO,
      statePath,
      now: () => clock,
      github: { fetchImpl, apiBase: 'https://api.example' },
    })
    const first = launch()
    await first.check(false)
    expect(probes).toHaveLength(1)

    // When the app restarts (a fresh service reading the same state file) inside the cooldown
    clock = CLOCK_START + 60_000
    const second = launch()
    await second.check(false)

    // Then the relaunch does not probe GitHub again, and the state still says why
    expect(probes).toHaveLength(1)
    expect(second.snapshot().check.status).toBe('error')

    // When the clock passes the reset, the next launch probes again
    clock = resetSeconds * 1000 + 1
    const third = launch()
    await third.check(false)
    expect(probes).toHaveLength(2)
  })

  it('用户在没有 reset 线索时得到一段兜底冷却而不是每次启动重试', async () => {
    // Given an exhausted budget that reports no reset time
    const profileRoot = makeSeededProfile()
    const statePath = path.join(makeTempDir('dsh-updater-state-'), 'state.json')
    let clock = CLOCK_START
    const probes: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      probes.push(String(input))
      return overBudgetResponse(undefined)
    }) as unknown as typeof fetch
    const service = new UpdaterService({
      env: discoverEnvironmentFrom(path.join(profileRoot, 'node_modules', '@dshtrading', 'client-ui-updater', 'lib', 'index.js')),
      repo: REPO,
      statePath,
      now: () => clock,
      github: { fetchImpl, apiBase: 'https://api.example' },
    })

    // When the check hits the wall and a second check runs a minute later
    await service.check(false)
    clock = CLOCK_START + 60_000
    await service.check(false)

    // Then the fallback cooldown suppresses the retry
    expect(probes).toHaveLength(1)

    // When the clock passes the fallback cooldown, the next check probes again
    clock = CLOCK_START + 15 * 60_000 + 1
    await service.check(false)
    expect(probes).toHaveLength(2)
  })
})
