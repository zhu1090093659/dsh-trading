/**
 * 一次性验证脚本（issue #38 衍生品数据面）：用已构建的连接器 REST 客户端直连
 * 三家交易所公共端点，打印解析结果。运行前提：`pnpm build`（lib 存在）。
 *
 *   node run-derivatives-probe.mjs
 *
 * 输出仅落 spike 证据（铁律 #5：工具实现不缓存不分发，公共统计数据按需拉取）。
 */

const out = {}

/* ---------------- OKX（open-interest + rubik 多空比/主动买卖量）---------------- */
{
  const { OkxRestClient } = await import('../../packages/connector-okx/lib/index.js')
  const client = new OkxRestClient()
  const section = {}
  for (const [label, task] of Object.entries({
    'open-interest': () => client.getOpenInterest('BTC-USDT-SWAP'),
    'funding-rate': () => client.getFundingRate('BTC-USDT-SWAP'),
    'long-short-account-ratio': () => client.getLongShortAccountRatio('BTC'),
    'taker-volume': () => client.getContractTakerVolume('BTC'),
  })) {
    try {
      section[label] = { ok: true, parsed: await task() }
    } catch (err) {
      section[label] = { ok: false, error: String(err?.message ?? err) }
    }
  }
  out.okx = section
}

/* ---------------- Binance（fapi 公共面）---------------- */
{
  const { BinanceRestClient } = await import('../../packages/connector-binance/lib/index.js')
  const client = new BinanceRestClient()
  const section = {}
  for (const [label, task] of Object.entries({
    'open-interest': () => client.getFuturesOpenInterest('BTCUSDT'),
    'funding-rate': () => client.getFuturesFundingRate('BTCUSDT'),
    'global-ls-ratio': () => client.getFuturesLongShortRatio('global', 'BTCUSDT'),
    'top-ls-ratio': () => client.getFuturesLongShortRatio('top', 'BTCUSDT'),
    'taker-ratio': () => client.getFuturesTakerRatio('BTCUSDT'),
  })) {
    try {
      section[label] = { ok: true, parsed: await task() }
    } catch (err) {
      section[label] = { ok: false, error: String(err?.message ?? err) }
    }
  }
  out.binance = section
}

/* ---------------- Bybit（v5 linear 公共面）---------------- */
{
  const { BybitRestClient } = await import('../../packages/connector-bybit/lib/index.js')
  const client = new BybitRestClient()
  const section = {}
  for (const [label, task] of Object.entries({
    'linear-tickers': () => client.getLinearTickerSnapshot('BTCUSDT'),
    'account-ratio': () => client.getLinearAccountRatio('BTCUSDT'),
  })) {
    try {
      section[label] = { ok: true, parsed: await task() }
    } catch (err) {
      section[label] = { ok: false, error: String(err?.message ?? err) }
    }
  }
  out.bybit = section
}

console.log(JSON.stringify(out, null, 2))
