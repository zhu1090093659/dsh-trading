// 观测面截图夹具服务器（零依赖 Node）。
//
// 它实现的**只是冻结件 §5 已经冻结的那几个面**，不新增端点、不改服务端语义：
//   POST /pair/redeem   body { code, name }        -> { deviceId, secret, scopes, deniedScopes }
//   GET  /a0/ping                                  -> { ok, atMs, device }
//   GET  /a0/status                                -> { ok, state:{killed,paused,reason,atMs}, device, scopes }
//   GET  /v1/cards                                 -> { cards, truncated, caps, downgraded }
//   POST /v1/commands                              -> { clientRequestId, replayed, result }
//   GET  /healthz                                  -> { ok }
// 除 /pair/redeem 与 /healthz 外一律要 Authorization: Bearer <deviceId>.<secret>，
// 缺/错给 401 + EDGE_UNAUTHORIZED（与 edge 同义：客户端应回配对门）。
//
// 用法：
//   node fixture-server.mjs --scenario running --port 8787
//   scenario: running | restricted | stopped | unreachable | unknown-enum
//
// unreachable 的实现是**在连接层断开**（req.socket.destroy()），
// 这样客户端拿到的是"连不上"，而不是一个可解析的 HTTP 错误 —— 这才是"App 看不到机器人"。

import http from 'node:http';
import { cardsFor } from './fixture-cards.mjs';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const index = argv.indexOf('--' + name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

const scenario = arg('scenario', 'running');
const port = Number(arg('port', '8787'));
const deviceId = 'dev-fixture';
const secret = 'sec-fixture';
const expectedAuthorization = 'Bearer ' + deviceId + '.' + secret;

const SCENARIOS = ['running', 'restricted', 'stopped', 'unreachable', 'unknown-enum'];
if (!SCENARIOS.includes(scenario)) {
  console.error('unknown scenario: ' + scenario + ' (expected one of ' + SCENARIOS.join(', ') + ')');
  process.exit(2);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

const server = http.createServer(async function (req, res) {
  if (scenario === 'unreachable') {
    req.socket.destroy();
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const authorization = req.headers['authorization'] || '';

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/pair/redeem' && req.method === 'POST') {
    const raw = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch (error) { parsed = {}; }
    if (!parsed.code) {
      sendJson(res, 400, { error: 'PAIR_CODE_REQUIRED' });
      return;
    }
    // 配对**永不签发 control**：响应里没有 control，deniedScopes 如实回报。
    sendJson(res, 200, {
      deviceId: deviceId,
      secret: secret,
      scopes: ['read'],
      deniedScopes: ['control']
    });
    return;
  }

  if (authorization !== expectedAuthorization) {
    sendJson(res, 401, { error: 'unauthorized', code: 'EDGE_UNAUTHORIZED' });
    return;
  }

  const nowMs = Date.now();

  if (url.pathname === '/a0/ping') {
    sendJson(res, 200, { ok: true, atMs: nowMs, device: deviceId });
    return;
  }

  if (url.pathname === '/a0/status') {
    const killed = scenario === 'stopped';
    const paused = false;
    sendJson(res, 200, {
      ok: true,
      state: {
        killed: killed,
        paused: paused,
        reason: killed ? '带外停机（夹具）' : '',
        atMs: nowMs
      },
      device: deviceId,
      scopes: ['read']
    });
    return;
  }

  if (url.pathname === '/v1/cards') {
    sendJson(res, 200, {
      cards: cardsFor(scenario),
      truncated: false,
      caps: url.headers ? [] : [],
      downgraded: []
    });
    return;
  }

  if (url.pathname === '/v1/commands' && req.method === 'POST') {
    const raw = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch (error) { parsed = {}; }
    sendJson(res, 200, {
      clientRequestId: parsed.clientRequestId || '',
      replayed: false,
      result: { accepted: true }
    });
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND' });
});

server.listen(port, '127.0.0.1', function () {
  console.log('fixture bot listening on http://127.0.0.1:' + String(port) + ' scenario=' + scenario);
  console.log('pair with code=any-code-1 (device ' + deviceId + '), token = ' + expectedAuthorization);
  if (scenario === 'unreachable') {
    console.log('NOTE: this scenario drops every connection at the socket level (App must show 看不到机器人)');
  }
});
