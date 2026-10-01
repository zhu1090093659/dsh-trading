/**
 * 驾驶舱截图验证用的临时静态服务（P4 步骤 3 证据）。
 *
 * 为什么需要它：驾驶舱的产物要由 **edge** 托管，而"托管得对不对 + 页面渲染成什么样"只能真跑。
 * 这个脚本用 tradectl 里已被测试覆盖的 handleV1 / handleV1Async / serveStatic 起一个
 * **仅回环**的临时服务，喂几张夹具卡片，供 headless Chrome 截图。
 *
 * 它不是产品代码，也不改任何线上形态：跑完即杀。用法：node packages/cockpit/drill/serve.mjs <port>
 */
import { createServer } from 'node:http'
import { handleV1, handleV1Async, serveStatic } from '../../tradectl/lib/api-v1.js'

const port = Number(process.argv[2] ?? '4571')
const dist = new URL('../dist/', import.meta.url).pathname

const cards = [
  { cardId: 'desk-1', cardType: 'desk-summary', revision: 7, fallbackText: 'desk 正常：2 个持仓、1 个挂单，风险档位 normal', fields: [{ key: 'level', label: '档位', kind: 'status', value: 'normal' }], actions: [{ kind: 'ack', label: '知道了' }] },
  { cardId: 'risk-1', cardType: 'risk-state', revision: 3, fallbackText: 'BTC/USDT 对齐正常，未触发降级', fields: [], actions: [] },
  { cardId: 'dec-2', cardType: 'decision', revision: 12, fallbackText: '决策：买入 0.05 BTC —— 论点：突破 83000 后回踩确认', fields: [], actions: [] },
  { cardId: 'dec-1', cardType: 'decision', revision: 11, fallbackText: '决策：持有 —— 论点：动量转弱，等待新信号', fields: [], actions: [] },
  { cardId: 'pos-1', cardType: 'position', revision: 5, fallbackText: 'BTC/USDT 多头 0.05，均价 83420.5，浮盈 +12.4 USDT', fields: [], actions: [] },
  { cardId: 'ord-1', cardType: 'order', revision: 4, fallbackText: '挂单：BTC/USDT 限价买 0.02 @ 82800（已确认）', fields: [], actions: [] },
  { cardId: 'esc-1', cardType: 'escalation', revision: 2, fallbackText: '升级：行情源连续 3 次分歧，需要人确认是否继续该标的', fields: [], actions: [{ kind: 'approve', label: '继续' }, { kind: 'reject', label: '停该标的' }] },
  { cardId: 'future-1', cardType: 'future-card', revision: 1, fallbackText: '这是一张本版客户端不认识的卡片（协议已有更新）', fields: [], actions: [{ kind: 'approve', label: '不该出现的按钮' }] },
]

const options = {
  serverMajor: 1,
  scopes: ['read', 'command', 'control'],
  serverCaps: ['action:ack', 'action:approve', 'action:reject', 'action:pause', 'action:kill', 'action:flatten'],
  cards: () => cards,
  staticDir: dist,
  execute: async (action) => ({ accepted: true, action }),
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value
  const isV1 = url.pathname.startsWith('/v1/')
  const path = url.pathname === '/' ? '/v1/assets/index.html' : url.pathname
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const handle = async () => {
      if (isV1) {
        const request = { method: req.method ?? 'GET', path, headers, body: Buffer.concat(chunks).toString('utf8') }
        return req.method === 'POST' ? handleV1Async(request, options) : handleV1(request, options)
      }
      return serveStatic(path.replace('/v1/assets/', ''), dist, headers['accept-encoding'])
    }
    void handle().then((result) => {
      res.writeHead(result.status, result.headers)
      res.end(result.body)
    })
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('cockpit drill serving on http://127.0.0.1:' + String(port) + String.fromCharCode(10))
})
