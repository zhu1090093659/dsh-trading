import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseChromiumProxyResult,
  readSavedProxyConfig,
  detectOsSystemProxySync,
  buildDesktopProxyEnv,
  redactProxyUrl,
} = require('../src/proxy.cjs');

test('operator: parseChromiumProxyResult parses PROXY/HTTPS/SOCKS5/DIRECT strings', () => {
  // Given: Chromium session.resolveProxy responses in various schemes
  // When: parsing each directive
  // Then: valid schemes normalize cleanly and DIRECT/SOCKS4 return undefined
  assert.equal(parseChromiumProxyResult('PROXY 127.0.0.1:7890; DIRECT'), 'http://127.0.0.1:7890');
  assert.equal(parseChromiumProxyResult('HTTPS proxy.corp:443'), 'https://proxy.corp:443');
  assert.equal(parseChromiumProxyResult('SOCKS5 127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.equal(parseChromiumProxyResult('SOCKS 127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.equal(parseChromiumProxyResult('DIRECT'), undefined);
  assert.equal(parseChromiumProxyResult('SOCKS4 127.0.0.1:1080; DIRECT'), undefined);
});

test('operator: readSavedProxyConfig reads router proxy config from cordis.patch.yml', () => {
  // Given: a temporary profile directory with cordis.patch.yml containing router proxy settings
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-proxy-'));
  try {
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), [
      '- id: ui-settings-general',
      '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
      '- id: dsh-trading-market-router',
      '  name: "@dshtrading/router"',
      '  config:',
      '    colorMode: green-up',
      '    proxy:',
      '      mode: custom',
      '      url: "socks5h://127.0.0.1:7890"',
      '      noProxy: "localhost,.internal"',
      '- id: other-plugin',
      '  config:',
      '    proxy:',
      '      mode: direct',
    ].join('\n'));
    // When: reading saved proxy config
    const parsed = readSavedProxyConfig(dir);
    // Then: extracts dsh-trading-market-router proxy block and stops before next entry
    assert.deepEqual(parsed, {
      mode: 'custom',
      url: 'socks5h://127.0.0.1:7890',
      noProxy: 'localhost,.internal',
    });
    assert.deepEqual(readSavedProxyConfig(path.join(dir, 'missing')), { mode: 'system' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('operator: buildDesktopProxyEnv injects system proxy by default and marks DSH_TRADING_INJECTED_SYSTEM_PROXY', () => {
  // Given: empty launch env, default mode=system, and detected OS proxy
  // When: building desktop child env overlay
  const plan = buildDesktopProxyEnv({}, {
    savedConfig: { mode: 'system' },
    osProxy: {
      source: 'macos-scutil',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: '192.168.0.0/16',
    },
  });
  // Then: injects HTTP/HTTPS/NO_PROXY with loopback, NODE_USE_ENV_PROXY=1, and system-injected marker
  assert.equal(plan.mode, 'system');
  assert.equal(plan.source, 'macos-scutil');
  assert.equal(plan.envOverlay.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(plan.envOverlay.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(plan.envOverlay.NODE_USE_ENV_PROXY, '1');
  assert.equal(plan.envOverlay.DSH_TRADING_INJECTED_SYSTEM_PROXY, '1');
  assert.ok(plan.envOverlay.NO_PROXY.includes('192.168.0.0/16'));
  assert.ok(plan.envOverlay.NO_PROXY.includes('127.0.0.1'));
});

test('operator: buildDesktopProxyEnv respects explicit env, direct mode, and SOCKS5 safety', () => {
  // Given: explicit shell env, direct mode, and custom SOCKS5 config
  const osProxy = { source: 'windows-registry', httpProxy: 'http://127.0.0.1:7890', httpsProxy: 'http://127.0.0.1:7890' };
  // When: building env overlays for each case
  const explicitPlan = buildDesktopProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:9999' }, { osProxy });
  const directPlan = buildDesktopProxyEnv({}, { savedConfig: { mode: 'direct' }, osProxy });
  const socksPlan = buildDesktopProxyEnv({}, {
    savedConfig: { mode: 'custom', url: 'socks5h://u:pw@127.0.0.1:1080' },
    osProxy,
  });
  // Then: explicit env is never overwritten; direct omits proxy vars; SOCKS5 never sets NODE_USE_ENV_PROXY
  assert.equal(explicitPlan.source, 'env');
  assert.equal(explicitPlan.envOverlay.HTTPS_PROXY, undefined);
  assert.equal(directPlan.source, 'direct');
  assert.equal(directPlan.envOverlay.HTTPS_PROXY, undefined);
  assert.equal(socksPlan.source, 'custom');
  assert.equal(socksPlan.envOverlay.ALL_PROXY, 'socks5h://u:pw@127.0.0.1:1080');
  assert.equal(socksPlan.envOverlay.HTTP_PROXY, undefined);
  assert.equal(socksPlan.envOverlay.NODE_USE_ENV_PROXY, undefined);
  assert.equal(redactProxyUrl('socks5h://u:pw@127.0.0.1:1080'), 'socks5h://***@127.0.0.1:1080');
});

test('operator: detectOsSystemProxySync falls back safely on KDE/gsettings and probe errors', () => {
  // Given: Linux gsettings throwing and KDE kioslaverc providing manual proxy
  // When: probing OS system proxy synchronously
  const kdeDetected = detectOsSystemProxySync({
    platform: 'linux',
    homeDir: '/fake-home',
    execFile: () => { throw new Error('no gsettings'); },
    readFile: (p) => (p.endsWith('kioslaverc') ? '[Proxy Settings]\nProxyType=1\nhttpProxy=http://127.0.0.1 7890\n' : undefined),
  });
  // Then: detects KDE proxy without throwing
  assert.equal(kdeDetected.source, 'linux-kde');
  assert.equal(kdeDetected.httpProxy, 'http://127.0.0.1:7890');
});
