/**
 * demo 盘集成测试（skip-if-no-creds 模式，调研 §7）：
 * 无凭证自动跳过不红；提供 OKX_DEMO_API_KEY / OKX_DEMO_SECRET_KEY / OKX_DEMO_PASSPHRASE
 * 环境变量后执行只读签名请求（GET balance/positions，带 x-simulated-trading: 1）。
 *
 * 出网测试：CI 不依赖出网；默认运行（无凭证）0 用例执行。
 */
import { describe, expect, it } from 'vitest'
import { OkxRestClient, type OkxCredentials } from '../src/rest.js'

const KEY = process.env.OKX_DEMO_API_KEY
const SECRET = process.env.OKX_DEMO_SECRET_KEY
const PASSPHRASE = process.env.OKX_DEMO_PASSPHRASE
const HAS_DEMO_CREDS = Boolean(KEY && SECRET && PASSPHRASE)

const CLIENT = new OkxRestClient() // 真实 base：https://openapi.okx.com（生产与 demo 同 host）

const AUTH = (): { credentials: OkxCredentials; simulated: boolean } => ({
  credentials: { key: KEY as string, secret: SECRET as string, passphrase: PASSPHRASE as string },
  simulated: true,
})

describe.skipIf(!HAS_DEMO_CREDS)('OKX demo 只读签名端点（需 OKX_DEMO_* 环境变量）', () => {
  it('GET /api/v5/account/balance（模拟盘）', async () => {
    const rows = await CLIENT.getBalance(AUTH())
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
  }, 15_000)

  it('GET /api/v5/account/positions（模拟盘）', async () => {
    const rows = await CLIENT.getPositions(AUTH())
    expect(Array.isArray(rows)).toBe(true)
  }, 15_000)
})
