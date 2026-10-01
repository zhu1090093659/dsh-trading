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
  const apiKey = input.env.OKX_API_KEY
  const secret = input.env.OKX_API_SECRET
  const password = input.env.OKX_API_PASSWORD
  if (apiKey === undefined || apiKey.trim() === '') missing.push('OKX_API_KEY')
  if (secret === undefined || secret.trim() === '') missing.push('OKX_API_SECRET')
  if (password === undefined || password.trim() === '') missing.push('OKX_API_PASSWORD')

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
