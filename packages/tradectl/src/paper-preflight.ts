/**
 * paper 档（第 2 档，OKX）预检：**没有凭证就什么都不做，且永不打主网**。
 *
 * 为什么把它做成纯函数并单独测：这一步是全流程唯一"贴近真钱"的地方，
 * 判据必须可执行、可复现，而不是散在演练脚本里的几个 if。
 * 两条硬规则：
 *   1. 凭证缺失 ⇒ 不通过（调用方直接退出，绝不发任何网络请求）；
 *   2. 环境里出现任何"允许实盘"的开关 ⇒ **拒绝运行** ——
 *      第 2 档是模拟盘，它没有资格因为一个环境变量就变成实盘。
 */
export interface PaperPreflightInput {
  readonly env: Readonly<Record<string, string | undefined>>
  /** 交易所名（仅用于提示文案与记录）。 */
  readonly venue: string
}

export type PaperPreflight =
  | {
      readonly ok: true
      readonly venue: string
      /** 凭证（调用方负责只在内存里传递，绝不落盘/落日志）。 */
      readonly credentials: { readonly apiKey: string; readonly secret: string; readonly password: string }
    }
  | { readonly ok: false; readonly reason: 'MISSING_CREDENTIALS' | 'LIVE_SWITCH_PRESENT'; readonly message: string; readonly missing: readonly string[] }

/** 任何"允许实盘"的环境开关都视为串味（第 2 档没有资格实盘）。 */
const LIVE_SWITCHES = ['DSHT_ALLOW_LIVE', 'DSHT_LIVE', 'DSHT_LIVE_TRADING', 'OKX_LIVE'] as const

/**
 * 预检 paper 档运行条件。
 * @param input - 环境与交易所名。
 */
export function paperPreflight(input: PaperPreflightInput): PaperPreflight {
  const venue = input.venue
  const missing: string[] = []
  const apiKey = input.env.OKX_DEMO_API_KEY
  const secret = input.env.OKX_DEMO_SECRET_KEY
  const password = input.env.OKX_DEMO_PASSPHRASE
  if (apiKey === undefined || apiKey.trim() === '') missing.push('OKX_DEMO_API_KEY')
  if (secret === undefined || secret.trim() === '') missing.push('OKX_DEMO_SECRET_KEY')
  if (password === undefined || password.trim() === '') missing.push('OKX_DEMO_PASSPHRASE')

  const live = LIVE_SWITCHES.filter((name) => {
    const value = input.env[name]
    return value !== undefined && value !== '' && value !== '0' && value !== 'false'
  })

  if (live.length > 0) {
    return {
      ok: false,
      reason: 'LIVE_SWITCH_PRESENT',
      message: '检测到实盘开关 ' + live.join('、') + '：第 2 档只跑 ' + venue + ' 模拟盘，拒绝运行',
      missing,
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'MISSING_CREDENTIALS',
      message: '缺少 ' + venue + ' 模拟盘凭证：' + missing.join('、') + '（凭证由人提供，agent 不申请、不保存）',
      missing,
    }
  }

  return { ok: true, venue, credentials: { apiKey: apiKey as string, secret: secret as string, password: password as string } }
}

/**
 * 模拟盘路由断言（据 2026-10-01 对 ccxt 4.5.84 的实测事实）：
 *
 * OKX 调 setSandboxMode(true) 后 **域名不变**（仍是 https://{hostname}），只在请求头加
 * x-simulated-trading: 1。⇒ **只看 URL 无法证明自己在模拟盘**；必须校验请求头。
 * 这条断言的用途：下单前把"我以为在模拟盘"变成"有证据在模拟盘"。
 */
export interface SandboxRoutingFacts {
  /** ccxt 的 options.sandboxMode。 */
  readonly sandboxMode: boolean
  /** 交易所实例上的请求头（ccxt 的 exchange.headers）。 */
  readonly headers: Readonly<Record<string, string>>
  /** 实际会打的 REST 基址。 */
  readonly apiUrl: string
}

export type SandboxRoutingVerdict = { readonly ok: true; readonly evidence: string } | { readonly ok: false; readonly reason: string }

/** OKX 模拟盘的唯一可核证据：该请求头为 1。 */
const OKX_SIMULATED_HEADER = 'x-simulated-trading'

/**
 * 断言当前实例确实指向模拟盘。
 * @param venue - 交易所名（目前只有 okx 有专门判据）。
 * @param facts - 从实例上读到的路由事实。
 */
export function assertSandboxRouting(venue: string, facts: SandboxRoutingFacts): SandboxRoutingVerdict {
  if (facts.apiUrl.trim() === '') return { ok: false, reason: 'apiUrl 为空：无法证明目标环境' }
  if (!facts.sandboxMode) return { ok: false, reason: 'sandboxMode 为 false：实例并未切到模拟盘' }
  if (venue === 'okx') {
    const value = facts.headers[OKX_SIMULATED_HEADER]
    if (value !== '1') {
      return {
        ok: false,
        reason: 'OKX 缺少 ' + OKX_SIMULATED_HEADER + ': 1 请求头（域名与主网相同，缺这个头就会打到主网）',
      }
    }
    return { ok: true, evidence: venue + ' 模拟盘：sandboxMode=true 且 ' + OKX_SIMULATED_HEADER + '=1' }
  }
  return { ok: true, evidence: venue + ' 模拟盘：sandboxMode=true（该 venue 无专门请求头判据）' }
}
