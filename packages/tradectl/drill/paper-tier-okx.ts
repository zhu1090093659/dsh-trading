/**
 * P5 第 2 档（paper，OKX 模拟盘）演练入口。
 *
 * 本次落地的是**预检与守门**：没有凭证或环境里出现实盘开关时，
 * 立即以退出码 2 结束，**不发任何网络请求**。
 * 真正的下单流程由人提供凭证后执行（agent 不申请、不保存凭证）。
 *
 * 退出码：0 = 预检通过（尚未下单）；2 = 预检不通过（缺凭证 / 有实盘开关）。
 */
import { paperPreflight } from '../src/paper-preflight.ts'

const VENUE = 'okx'

function main(): number {
  const result = paperPreflight({ env: process.env, venue: VENUE })
  if (!result.ok) {
    console.error('[paper-okx] 预检未通过（' + result.reason + '）：' + result.message)
    console.error('[paper-okx] 提示：需要 OKX 模拟盘的三项凭证 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSWORD；')
    console.error('[paper-okx] 第 2 档只跑模拟盘，脚本不接受任何实盘开关。')
    return 2
  }
  console.log('[paper-okx] 预检通过：凭证齐全、无实盘开关；下一步可在模拟盘上下单（由人执行）。')
  return 0
}

process.exit(main())
