#!/usr/bin/env node
// UI 功能验收：启动（或附加）trading-web 实例，经 CDP 做交互级断言。
//
// 覆盖的回归类（每类都有真实事故背书）：
//   A. 认证栅栏：未认证 HTTP 请求必须 401/403（cohort 检查的同款语义）。
//   B. 会话创建链路：alpha.2 dsh-persona schema 变更曾让全部新建会话
//      失败（agent-preset/invalid），工作区无法选择、composer 停留在
//      禁用占位——断言 composer 进入可用态且无 SessionCreateError。
//   C. 壳接管与死区：宿主折叠信号从 [data-details-collapsed] 换成
//      [data-rightbar-collapsed]，镜像失配让工具详情列恒 360px 空转——
//      断言「宿主宣告折叠时工具详情轨道必须为 0 宽」。
//   D. 交易面挂载：[data-shell-overlay] 与自选行渲染。
//   E. 工作区菜单可打开且列出工作区（只验证不选择，不改用户状态）。
//   F. 全程无未捕获异常、无 error 级控制台输出。
//   G. 特殊指标视图宽度/高度契约：卡片 = 面板内容宽、图区 = 卡片内容宽、
//      图区吃掉中栏剩余高度、而文字/进度条块仍限宽（2026-09-18 事故：卡片
//      960px 上限让中栏更宽时右侧留白、固定像素高让卡片下方留白；宽度上限挪到
//      内容块后，还要钉住「文本没跟着无限拉长」。全部按实测矩形判定，不读 CSS）。
//
// 用法：
//   node scripts/ui-functional-check.mjs                 # 自起 trading-web 实例
//   node scripts/ui-functional-check.mjs --url <url>     # 附加到运行中实例
//   --profile trading-dev  --port 3095  --keep  --screenshot <path>
//
// 依赖：node 内置 fetch/WebSocket + 本机 Chrome（DSH_UI_CHROME 可覆盖）。
// 退出码：0 = 全绿；1 = 存在失败。失败详情逐条打印。
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const hasFlag = (name) => args.includes(name);

const profile = argOf('--profile', 'trading-web');
const port = argOf('--port', '3095');
const attachUrl = argOf('--url', null);
const keep = hasFlag('--keep');
const screenshotPath = argOf('--screenshot', '/tmp/dsh-ui-check/screenshot.png');
const chromeBin = process.env.DSH_UI_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dshBin = process.env.DSH_DSH_BIN ?? join(process.env.HOME, '.local/bin/dsh-trading');
const dshHome = process.env.DSH_HOME ? process.env.DSH_HOME : join(process.env.HOME, '.dsh-trading');

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  (ok ? passes : failures).push(name + (detail ? ` — ${detail}` : ''));
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
/** 环境缺前置（无凭据/桥不可用）时的显式跳过：不算通过，也不算失败。 */
function skip(name, detail = '') {
  console.log(`  SKIP  ${name}${detail ? ' — ' + detail : ''}`);
}

// --- 实例承载 -----------------------------------------------------------

let instance = null;
let baseUrl = attachUrl;
if (!baseUrl) {
  console.log(`[ui-check] boot ${profile} on 127.0.0.1:${port} (DSH_HOME=${dshHome})`);
  instance = spawn(dshBin, ['--profile', profile, '--port', port, '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(null), 45000);
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
      // 完整 tokenized URL 整行捕获；只解析端口会拿到无 token 地址，
      // Playwright/浏览器将停在鉴权页（0.1.5 宿主 URL 形态变更的教训）。
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    instance.stdout.on('data', onData);
    instance.stderr.on('data', onData);
    instance.on('exit', (code) => { clearTimeout(timer); console.error(`[ui-check] instance exited early: code=${code}`); resolve(null); });
  });
  if (!url) {
    console.error('[ui-check] FAIL  instance boot: 未在 45s 内取得 tokenized URL');
    process.exit(1);
  }
  baseUrl = url;
}
console.log(`[ui-check] instance: ${baseUrl.replace(/token=\S+/, 'token=***')}`);

// --- A. 认证栅栏 --------------------------------------------------------

try {
  const res = await fetch(baseUrl.split('?')[0].replace(/\/$/, '') + '/', { redirect: 'manual' });
  check('A. 认证栅栏：未认证请求被拒', res.status === 401 || res.status === 403, `status=${res.status}`);
} catch (e) {
  check('A. 认证栅栏：未认证请求被拒', false, String(e));
}

// --- CDP 承载 -----------------------------------------------------------

const cdpPort = 19200 + Math.floor(Math.random() * 8000);
const userDir = mkdtempSync(join(tmpdir(), 'dsh-ui-check-'));
const chrome = execFile(chromeBin, [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDir}`,
  '--window-size=1600,1000', baseUrl,
]);
const killChrome = () => { try { chrome.kill(); } catch {} };
process.on('exit', killChrome);

let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && t.url.startsWith('http')) ?? null;
  } catch {}
}
if (!page) {
  console.error('[ui-check] FAIL  chrome CDP: 未取得页面目标');
  instance?.kill();
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? 'unknown').slice(0, 300));
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};
await send('Runtime.enable');
await send('Page.enable');
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') };
  return r.result?.result?.value;
};
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
};

// --- 等待交易面挂载 ------------------------------------------------------

let mounted = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  mounted = await evalJs(`(() => ({
    overlay: !!document.querySelector('[data-shell-overlay]'),
    watchlist: document.querySelectorAll('[class*="codeRow"], [class*="code"]').length,
  }))()`);
  if (mounted?.overlay && mounted.watchlist > 0) break;
}
check('D. 交易面挂载', mounted?.overlay === true && (mounted?.watchlist ?? 0) > 0,
  mounted ? `overlay=${mounted.overlay} watchlistRows=${mounted.watchlist}` : 'eval failed');
await sleep(4000); // 行情流/注入稳定窗口

// --- B. 会话创建链路（composer 可用态） ----------------------------------

const composer = await evalJs(`(() => {
  const ph = document.querySelector('[class*="placeholder"]');
  const text = ph ? ph.textContent.trim() : '';
  return { text, blocked: text.includes('选择一个工作区') };
})()`);
check('B1. 会话创建链路：composer 进入可用态', composer && !composer.blocked,
  composer ? `placeholder="${composer.text.slice(0, 30)}"` : 'eval failed');
check('B2. 会话创建链路：无 SessionCreateError',
  !consoleErrors.concat(exceptions).some((t) => t.includes('SessionCreateError') || t.includes('agent-preset/invalid')),
  consoleErrors.concat(exceptions).find((t) => t.includes('SessionCreate')) ?? '');

// --- C. 壳接管与死区 ------------------------------------------------------

const zone = await evalJs(`(() => {
  const frame = document.querySelector('div:has(> [data-shell-overlay])');
  if (!frame) return null;
  const col = frame.querySelector('[data-rightbar-col]') ?? frame.querySelector('[class*="rightbarCol"]');
  const rect = col ? col.getBoundingClientRect() : null;
  return {
    collapsed: frame.getAttribute('data-rightbar-collapsed'),
    legacyCollapsed: frame.getAttribute('data-details-collapsed'),
    width: rect ? Math.round(rect.width) : null,
    gtc: getComputedStyle(frame).gridTemplateColumns,
  };
})()`);
if (zone === null || zone.width === null) {
  check('C. 壳死区（工具详情列）', false, '未找到工具详情列');
} else if (zone.collapsed === 'true' || zone.legacyCollapsed === 'true') {
  check('C. 壳死区（工具详情列）', zone.width <= 1,
    `宿主宣告折叠，轨道宽 ${zone.width}px（>1 即死区回归）`);
} else {
  check('C. 壳死区（工具详情列）', true, `dock 展开，轨道宽 ${zone.width}px（展开态不判死区）`);
}

// --- E. 工作区菜单交互 ----------------------------------------------------

const btn = await evalJs(`(() => {
  const b = document.querySelector('button[aria-label="选择工作区"]');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
})()`);
if (!btn) {
  check('E. 工作区菜单可打开', false, '未找到选择工作区按钮');
} else {
  await click(btn[0], btn[1]);
  await sleep(1000);
  const menu = await evalJs(`(() => {
    const m = [...document.querySelectorAll('[role="menu"]')].find((el) => el.textContent.includes('工作区') || el.querySelectorAll('button,[role="menuitem"]').length > 0);
    return m ? { items: m.querySelectorAll('button,[role="menuitem"]').length, text: (m.textContent || '').slice(0, 80) } : null;
  })()`);
  check('E. 工作区菜单可打开', !!menu && menu.items > 0, menu ? `items=${menu.items}` : '菜单未渲染');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
}

// --- G. 特殊指标视图铺满中栏（左右与上下都无空白） ------------------------

/** 布局探针：面板/卡片取内容盒（扣 padding），图区取实测矩形。 */
const LAYOUT_PROBE = `(() => {
  const stage = document.querySelector('[data-dshtrading-middle-stage]');
  if (!stage) return { state: 'no-stage' };
  if (/特殊指标未配置|加载失败/.test(stage.textContent || '')) {
    return { state: 'unavailable', text: (stage.textContent || '').trim().slice(0, 60) };
  }
  const card = stage.querySelector('section');
  if (!card) return { state: 'no-card' };
  const chart = [...stage.querySelectorAll('div')].find((el) => String(el.className).includes('chartCanvas'));
  if (!chart) return { state: 'no-chart' };
  // clientWidth/clientHeight 是 padding 盒（已排除边框与滚动条），扣掉 padding
  // 即内容盒——用 getBoundingClientRect 会把 1px 边框算成 2px 的假失配。
  const inner = (el) => {
    const cs = getComputedStyle(el);
    return {
      w: Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      h: Math.round(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
    };
  };
  const read = stage.querySelector('[class*="basisGrid"]') ?? stage.querySelector('[class*="statRow"]');
  const cr = chart.getBoundingClientRect();
  return {
    state: 'ready',
    panel: inner(card.parentElement),
    card: inner(card),
    chart: { w: Math.round(cr.width), h: Math.round(cr.height) },
    read: read === null ? null : inner(read),
    viewport: [innerWidth, innerHeight],
  };
})()`;

// 2400 宽视口是必需的触发条件：中栏窄于卡片宽度上限时回归不可见（首次漏检的原因）。
await send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1000, deviceScaleFactor: 1, mobile: false });
await evalJs("localStorage.setItem('dshtrading.stage.v1', JSON.stringify('special-indicators')); localStorage.setItem('dshtrading.special-indicators.tab.v1', JSON.stringify('basis')); true");
await send('Page.reload', { ignoreCache: true });

let layout = null;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  layout = await evalJs(LAYOUT_PROBE);
  if (layout?.state === 'ready' || layout?.state === 'unavailable') break;
}
if (layout?.state === 'ready') {
  check('G1. 特殊指标卡片铺满中栏宽度', layout.card.w >= layout.panel.w - 1,
    `卡片 ${layout.card.w}px / 面板内容 ${layout.panel.w}px（视口 ${layout.viewport[0]}px）`);
  check('G2. 特殊指标图区铺满卡片宽度', layout.chart.w >= layout.card.w - 1,
    `图区 ${layout.chart.w}px / 卡片内容 ${layout.card.w}px`);
  check('G3. 特殊指标图区吃掉中栏剩余高度', layout.chart.h >= 300,
    `图区高 ${layout.chart.h}px（视口高 ${layout.viewport[1]}px）`);
  // 文本块必须窄于图区（限宽生效），又不至于被压到不可用；图区此时是铺满的，
  // 因此「文本 < 图区 - 100」等价于「宽度上限只作用在内容块上」。
  check('G4. 特殊指标文字/进度条类内容限宽而图区仍铺满',
    layout.read !== null && layout.read.w >= 320 && layout.read.w <= layout.chart.w - 100,
    layout.read === null
      ? '未找到统计/进度条块'
      : `文本块 ${layout.read.w}px / 图区 ${layout.chart.w}px`);
} else if (layout?.state === 'unavailable') {
  // 只有「桥无凭据/不可用」才是环境缺前置；挂载失败、卡片或图区缺失都是真回归。
  skip('G. 特殊指标视图铺满中栏', `环境缺数据（${layout.text}），本机跳过`);
} else {
  check('G. 特殊指标视图铺满中栏', false, `探测结果 ${JSON.stringify(layout)}`);
}

// 还原现场：后续截图仍是行情视图的原始视口。
await evalJs("localStorage.setItem('dshtrading.stage.v1', JSON.stringify('quote')); true");
await send('Emulation.clearDeviceMetricsOverride');
await send('Page.reload', { ignoreCache: true });
await sleep(5000);

// --- F. 控制台健康 --------------------------------------------------------

check('F1. 无未捕获异常', exceptions.length === 0, exceptions[0] ?? '');
check('F2. 无 error 级控制台输出', consoleErrors.length === 0, consoleErrors[0] ?? '');

// --- 截图存证 -------------------------------------------------------------

try {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    mkdirSync(screenshotPath.substring(0, screenshotPath.lastIndexOf('/')), { recursive: true });
    writeFileSync(screenshotPath, Buffer.from(shot.result.data, 'base64'));
    console.log(`[ui-check] screenshot: ${screenshotPath}`);
  }
} catch {}

// --- 清理与结论 -----------------------------------------------------------

killChrome();
// Chrome 尚未退完时用户目录可能非空：recursive + maxRetries 才让 ENOTEMPTY 重试
// （否则断言全绿也会在收尾崩掉，退出码 1）。
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
if (instance && !keep) instance.kill();

console.log('');
if (failures.length > 0) {
  console.log(`[ui-check] FAIL：${failures.length} 项失败`);
  process.exit(1);
}
console.log(`[ui-check] PASS：${passes.length} 项断言全绿`);
process.exit(0);
