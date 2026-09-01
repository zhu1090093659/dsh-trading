// P0（issue #29）真实网络验证：服务缝闸门三态矩阵 + OKX 公共行情驱动的 dry-run 富回执。
// 全程无凭证、不下单：真实网络只打 OKX 公共 REST（ticker）；实盘请求在服务缝被结构化拒绝。
// 运行：node spikes/impl-service-seam-gate/net-verify.mjs（需先 pnpm build 产出 lib/）
import { Context } from '@deepseek-ai/cordis'
import { OkxTradeService, buildDryRunReceipt } from '../../packages/connector-okx/lib/index.js'
import { OkxRestClient, TradingServiceError } from '../../packages/connector-okx/lib/rest.js'

const config = {
  enabled: true,
  env: 'demo',
  dryRun: true,
  liveTrading: false, // 缺省安全位：服务缝必须在没有任何显式解锁时 fail-closed
  apiKeyRef: 'OKX_API_KEY',
  secretRef: 'OKX_SECRET_KEY',
  passphraseRef: 'OKX_PASSPHRASE',
  demoApiKeyRef: 'OKX_DEMO_API_KEY',
  demoSecretRef: 'OKX_DEMO_SECRET_KEY',
  demoPassphraseRef: 'OKX_DEMO_PASSPHRASE',
}

const client = new OkxRestClient({ baseUrl: 'https://www.okx.com' })
// 凭证永真占位（无网络签名路径会被走到；真实网络只打公共 ticker）。
const trade = new OkxTradeService(new Context(), {
  client,
  config,
  getCredentials: async () => ({ key: 'spike-placeholder', secret: 'spike-placeholder', passphrase: 'spike-placeholder' }),
})

// [A] 服务缝 ①：绕过工具层直调 + dryRun=false + liveTrading=false → 结构化拒绝，不触网。
let seamReject
try {
  await trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01, dryRun: false })
  console.log('[A] FAIL — 实盘请求未被拒绝！')
  process.exit(1)
} catch (error) {
  seamReject = error
  console.log('[A] direct placeOrder(dryRun=false, liveTrading=false) ->', error.constructor.name, error.code, '|', error.message)
}

// [B] 服务缝 ②：缺省 dryRun 直调 → 本地模拟回执（不触网、不签名）。
const sim = await trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01 })
console.log('[B] direct placeOrder(dryRun 缺省) ->', JSON.stringify(sim))

// [C] 撤单服务缝：liveTrading=false 直调撤单 → 结构化拒绝（与下单同门槛）。
try {
  await trade.cancelOrder('12345', 'BTC-USDT')
  console.log('[C] FAIL — 撤单未被拒绝！')
  process.exit(1)
} catch (error) {
  console.log('[C] direct cancelOrder(liveTrading=false) ->', error.constructor.name, error.code, '|', error.message)
}

// [D] 真实网络 dry-run 富回执（工具层闸门 ② 路径）：OKX 公共 ticker 作市价参照。
const started = Date.now()
const receipt = await buildDryRunReceipt(
  { instId: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01 },
  { getTicker: (instId) => client.getTicker(instId) },
)
const ticker = await client.getTicker('BTC-USDT')
console.log('[D] OKX public getTicker BTC-USDT ->', JSON.stringify(ticker), `(${Date.now() - started}ms)`)
console.log('[D] buildDryRunReceipt（真实参照价） ->', receipt)

// [E] 语义自检：A 的拒绝码必须是 TRADING_LIVE_TRADING_DISABLED；B/D 回执必须显式 dryRun 标记。
const a = seamReject instanceof TradingServiceError && seamReject.code === 'TRADING_LIVE_TRADING_DISABLED'
const b = sim.dryRun === true
const d = JSON.parse(receipt).dryRun === true
console.log(`[ok] seamRejectStructured=${a} simReceiptLabeled=${b} dryRunReceiptLabeled=${d}`)
if (!(a && b && d)) process.exit(1)
