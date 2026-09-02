/**
 * 一次性验证脚本（issue #39 盘口/逐笔）：用已构建的连接器 REST 客户端直连真实端点。
 * 运行前提：`pnpm build`。  node run-orderbook-probe.mjs
 */
const out = { timestamp: new Date().toISOString() }

/* ---------------- Binance / OKX / Bybit（spot depth + recent trades）---------------- */
{
  const { BinanceRestClient } = await import('../../packages/connector-binance/lib/index.js')
  const { OkxRestClient } = await import('../../packages/connector-okx/lib/index.js')
  const { BybitRestClient } = await import('../../packages/connector-bybit/lib/index.js')
  const binanceClient = new BinanceRestClient()
  const okxClient = new OkxRestClient()
  const bybitClient = new BybitRestClient()
  const cryptoSection = {}
  for (const [name, client, tasks] of [
    ['binance', binanceClient, {
      depth: () => binanceClient.getOrderbook('BTCUSDT'),
      trades: () => binanceClient.getRecentTrades('BTCUSDT', 5),
    }],
    ['okx', okxClient, {
      depth: () => okxClient.getOrderbook('BTC-USDT'),
      trades: () => okxClient.getRecentTrades('BTC-USDT', 5),
    }],
    ['bybit', bybitClient, {
      depth: () => bybitClient.getOrderbook('BTCUSDT'),
      trades: () => bybitClient.getRecentTrades('BTCUSDT', 5),
    }],
  ]) {
    cryptoSection[name] = {}
    for (const [label, task] of Object.entries(tasks)) {
      try {
        const result = await task()
        cryptoSection[name][label] = { ok: true, summary: result.timestamp !== undefined ? { symbol: result.symbol, bid1: result.bids[0], ask1: result.asks[0], levels: [result.bids.length, result.asks.length] } : { count: result.length, first: result[0], last: result[result.length - 1] } }
      } catch (err) {
        cryptoSection[name][label] = { ok: false, error: String(err?.message ?? err) }
      }
    }
  }
  out.crypto = cryptoSection
}

/* ---------------- Tencent cn（同一报价行五档；hk 结构性拒绝）---------------- */
{
  const { TencentRestClient } = await import('../../packages/connector-tencent/lib/index.js')
  const cn = new TencentRestClient('cn')
  const hk = new TencentRestClient('hk')
  const section = {}
  try {
    const orderbook = await cn.getOrderbook('600519.SH')
    section.cn = {
      ok: true,
      note: 'sh600519 五档（盘后可能为空档位）',
      bid1: orderbook.bids[0] ?? null,
      ask1: orderbook.asks[0] ?? null,
      levels: [orderbook.bids.length, orderbook.asks.length],
      symbol: orderbook.symbol,
    }
  } catch (err) {
    section.cn = { ok: false, error: String(err?.message ?? err) }
  }
  try {
    await hk.getOrderbook('00700.HK')
    section.hk = { ok: true }
  } catch (err) {
    section.hk = { ok: false, code: err?.code, error: String(err?.message ?? err) }
  }
  out.tencent = section
}

console.log(JSON.stringify(out, null, 2))
