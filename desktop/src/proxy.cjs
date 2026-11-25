'use strict';

/**
 * Electron desktop proxy bootstrap helpers (pure Node CommonJS, no electron import).
 *
 * Detects OS-level proxy settings and Electron session.resolveProxy results,
 * reads saved `dsh-trading-market-router` proxy preferences from `cordis.patch.yml`,
 * and builds the host child environment overlay so the DSH host and plugins use
 * the system proxy by default even when launched from Dock / Start Menu.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'];
const DETECT_TIMEOUT_MS = 1500;
const ROUTER_ENTRY_ID = 'dsh-trading-market-router';

const EXPLICIT_ENV_NAMES = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
];

function formatProxyAuthority(host, port, scheme = 'http') {
  const cleanHost = String(host || '').trim();
  if (cleanHost === '') return undefined;
  const bracketed = cleanHost.includes(':') && !cleanHost.startsWith('[') ? `[${cleanHost}]` : cleanHost;
  const cleanPort = port === undefined ? '' : String(port).trim();
  if (cleanPort !== '' && /^\d+$/.test(cleanPort) && Number(cleanPort) > 0) {
    return `${scheme}://${bracketed}:${cleanPort}`;
  }
  return `${scheme}://${bracketed}`;
}

function ensureScheme(raw, defaultScheme = 'http') {
  const trimmed = String(raw || '').trim();
  if (trimmed === '') return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  return `${defaultScheme}://${trimmed}`;
}

function isSocksProxyUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  try {
    const proto = new URL(raw.trim()).protocol;
    return proto === 'socks:' || proto === 'socks5:' || proto === 'socks5h:';
  } catch {
    return false;
  }
}

function validateProxyUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return { ok: false, kind: 'empty' };
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === '') return { ok: false, kind: 'invalid' };
    if (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'socks:' ||
      parsed.protocol === 'socks5:' ||
      parsed.protocol === 'socks5h:'
    ) {
      return { ok: true, value: trimmed };
    }
    return { ok: false, kind: 'unsupported' };
  } catch {
    return { ok: false, kind: 'invalid' };
  }
}

function redactProxyUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.username !== '' || parsed.password !== '') {
      const hostPort = parsed.port !== '' ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      return `${parsed.protocol}//***@${hostPort}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    }
    return trimmed;
  } catch {
    return trimmed.replace(/\/\/[^/@]+@/, '//***@');
  }
}

function mergeNoProxy(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    if (typeof list !== 'string' || list.trim() === '') continue;
    for (const raw of list.split(/[,\s;]+/)) {
      const entry = raw.trim();
      if (entry === '') continue;
      if (entry === '*') return '*';
      const key = entry.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(entry);
      }
    }
  }
  for (const loopback of LOOPBACK_NO_PROXY) {
    if (!seen.has(loopback)) {
      seen.add(loopback);
      merged.push(loopback);
    }
  }
  return merged.join(',');
}

/**
 * Parse Electron `session.resolveProxy(url)` return strings (e.g. `"PROXY 127.0.0.1:7890; DIRECT"`).
 * @param {string} result
 * @returns {string | undefined}
 */
function parseChromiumProxyResult(result) {
  if (typeof result !== 'string' || result.trim() === '') return undefined;
  for (const rawToken of result.split(';')) {
    const token = rawToken.trim();
    if (token === '' || /^DIRECT$/i.test(token)) continue;
    const match = /^(PROXY|HTTP|HTTPS|SOCKS5|SOCKS)\s+(.+)$/i.exec(token);
    if (match === null) continue;
    const kind = match[1].toUpperCase();
    const hostPort = match[2].trim();
    if (hostPort === '') continue;
    if (kind === 'PROXY' || kind === 'HTTP') return ensureScheme(hostPort, 'http');
    if (kind === 'HTTPS') return ensureScheme(hostPort, 'https');
    if (kind === 'SOCKS5' || kind === 'SOCKS') return ensureScheme(hostPort, 'socks5');
  }
  return undefined;
}

function unquoteYamlScalar(raw) {
  let value = raw.trim();
  if (value === '' || value === '~' || value === 'null') return '';
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  const commentIndex = value.indexOf(' #');
  if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
  return value;
}

/**
 * Extract saved `proxy` config from `$PROFILE/cordis.patch.yml` for `dsh-trading-market-router`
 * without requiring an external YAML dependency inside Electron's asar.
 * @param {string} profileDir
 * @returns {{ mode: 'system' | 'custom' | 'direct', url?: string, noProxy?: string }}
 */
function readSavedProxyConfig(profileDir) {
  const fallback = { mode: 'system' };
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  let content;
  try {
    content = fs.readFileSync(patchPath, 'utf8');
  } catch {
    return fallback;
  }

  const lines = content.split(/\r?\n/);
  let entryIndent = -1;
  let configIndent = -1;
  let proxyIndent = -1;
  let foundEntry = false;
  let inConfig = false;
  let inProxy = false;
  const raw = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.search(/\S/);

    const idMatch = /^(?:-\s+)?id:\s*(.+)$/.exec(trimmed);
    if (idMatch !== null) {
      const idVal = unquoteYamlScalar(idMatch[1]);
      if (idVal === ROUTER_ENTRY_ID) {
        foundEntry = true;
        entryIndent = trimmed.startsWith('-') ? indent + 2 : indent;
        inConfig = false;
        inProxy = false;
        continue;
      }
      if (foundEntry && indent <= entryIndent) {
        break;
      }
    }

    if (!foundEntry) continue;
    if (trimmed.startsWith('- ') && indent < entryIndent) break;
    if (indent < entryIndent) break;

    if (trimmed === 'config:' && indent >= entryIndent) {
      inConfig = true;
      configIndent = indent;
      inProxy = false;
      continue;
    }

    if (inConfig && indent <= configIndent) {
      inConfig = false;
      inProxy = false;
    }
    if (!inConfig) continue;

    if (trimmed === 'proxy:' && indent > configIndent) {
      inProxy = true;
      proxyIndent = indent;
      continue;
    }

    if (inProxy) {
      if (indent <= proxyIndent) {
        inProxy = false;
        continue;
      }
      const kv = /^(mode|url|noProxy):\s*(.*)$/.exec(trimmed);
      if (kv !== null) {
        raw[kv[1]] = unquoteYamlScalar(kv[2]);
      }
    }
  }

  const mode = raw.mode === 'custom' || raw.mode === 'direct' || raw.mode === 'system' ? raw.mode : 'system';
  return {
    mode,
    ...(typeof raw.url === 'string' && raw.url !== '' ? { url: raw.url } : {}),
    ...(typeof raw.noProxy === 'string' && raw.noProxy !== '' ? { noProxy: raw.noProxy } : {}),
  };
}

function parseMacScutilProxy(output) {
  const scalars = new Map();
  const exceptions = [];
  let inExceptions = false;

  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (inExceptions) {
      if (line === '}') {
        inExceptions = false;
        continue;
      }
      const item = /^\d+\s*:\s*(.+)$/.exec(line);
      if (item !== null) exceptions.push(item[1].trim());
      continue;
    }
    if (/^ExceptionsList\s*:\s*<array>\s*\{$/i.test(line)) {
      inExceptions = true;
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(line);
    if (kv !== null) scalars.set(kv[1], kv[2].trim());
  }

  const httpUrl = scalars.get('HTTPEnable') === '1'
    ? formatProxyAuthority(scalars.get('HTTPProxy'), scalars.get('HTTPPort'), 'http')
    : undefined;
  const httpsHost = scalars.get('HTTPSProxy') || '';
  const httpsUrl = scalars.get('HTTPSEnable') === '1'
    ? (httpsHost.includes('://') ? httpsHost : formatProxyAuthority(httpsHost, scalars.get('HTTPSPort'), 'http'))
    : undefined;
  const socksUrl = scalars.get('SOCKSEnable') === '1'
    ? formatProxyAuthority(scalars.get('SOCKSProxy'), scalars.get('SOCKSPort'), 'socks5')
    : undefined;

  if (scalars.get('ExcludeSimpleHostnames') === '1') exceptions.push('<local>');
  const httpProxy = httpUrl ?? (httpsUrl === undefined ? socksUrl : undefined);
  const httpsProxy = httpsUrl ?? httpUrl ?? socksUrl;

  return {
    source: httpProxy !== undefined || httpsProxy !== undefined ? 'macos-scutil' : 'none',
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(exceptions.length === 0 ? {} : { noProxy: exceptions.join(',') }),
  };
}

function parseWindowsRegProxy(output) {
  const values = new Map();
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s+REG_[A-Z0-9_]+\s+(.+)$/.exec(rawLine);
    if (match !== null) values.set(match[1], match[2].trim());
  }
  const enableRaw = (values.get('ProxyEnable') || '').toLowerCase();
  if (enableRaw !== '0x1' && enableRaw !== '1') return { source: 'none' };

  const serverRaw = (values.get('ProxyServer') || '').trim();
  let httpProxy;
  let httpsProxy;
  let socksProxy;
  if (serverRaw !== '') {
    if (serverRaw.includes('=')) {
      for (const segment of serverRaw.split(';')) {
        const eq = segment.indexOf('=');
        if (eq === -1) continue;
        const key = segment.slice(0, eq).trim().toLowerCase();
        const target = segment.slice(eq + 1).trim();
        if (target === '') continue;
        if (key === 'http') httpProxy = ensureScheme(target, 'http');
        else if (key === 'https') httpsProxy = ensureScheme(target, 'http');
        else if (key === 'socks' || key === 'socks5') socksProxy = ensureScheme(target, 'socks5');
      }
    } else {
      const normalized = ensureScheme(serverRaw, 'http');
      httpProxy = normalized;
      httpsProxy = normalized;
    }
  }

  const effectiveHttp = httpProxy ?? (httpsProxy === undefined ? socksProxy : undefined);
  const effectiveHttps = httpsProxy ?? httpProxy ?? socksProxy;
  const overrideRaw = (values.get('ProxyOverride') || '').trim();
  const noProxy = overrideRaw === ''
    ? undefined
    : overrideRaw.split(';').map((s) => s.trim()).filter((s) => s !== '').join(',');

  return {
    source: effectiveHttp !== undefined || effectiveHttps !== undefined ? 'windows-registry' : 'none',
    ...(effectiveHttp === undefined ? {} : { httpProxy: effectiveHttp }),
    ...(effectiveHttps === undefined ? {} : { httpsProxy: effectiveHttps }),
    ...(noProxy === undefined ? {} : { noProxy }),
  };
}

function unquoteGsetting(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseGsettingsProxy(values) {
  if (unquoteGsetting(values.mode) !== 'manual') return { source: 'none' };
  const httpHost = unquoteGsetting(values.httpHost);
  const httpPort = Number(String(values.httpPort || '0').trim());
  let httpUrl;
  if (httpHost !== '') {
    const auth = values.httpAuth && String(values.httpAuth).trim() === 'true' && unquoteGsetting(values.httpUser) !== ''
      ? `${encodeURIComponent(unquoteGsetting(values.httpUser))}:${encodeURIComponent(unquoteGsetting(values.httpPass))}@`
      : '';
    const hostPart = httpHost.includes(':') && !httpHost.startsWith('[') ? `[${httpHost}]` : httpHost;
    const portPart = Number.isInteger(httpPort) && httpPort > 0 ? `:${httpPort}` : '';
    httpUrl = `http://${auth}${hostPart}${portPart}`;
  }
  const httpsHost = unquoteGsetting(values.httpsHost);
  const httpsPort = Number(String(values.httpsPort || '0').trim());
  const httpsUrl = httpsHost !== ''
    ? formatProxyAuthority(httpsHost, Number.isInteger(httpsPort) && httpsPort > 0 ? String(httpsPort) : undefined, 'http')
    : undefined;
  const socksHost = unquoteGsetting(values.socksHost);
  const socksPort = Number(String(values.socksPort || '0').trim());
  const socksUrl = socksHost !== ''
    ? formatProxyAuthority(socksHost, Number.isInteger(socksPort) && socksPort > 0 ? String(socksPort) : undefined, 'socks5')
    : undefined;

  const httpProxy = httpUrl ?? (httpsUrl === undefined ? socksUrl : undefined);
  const httpsProxy = httpsUrl ?? httpUrl ?? socksUrl;
  const ignoreItems = [...String(values.ignoreHosts || '').matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map((m) => (m[1] || m[2] || '').trim())
    .filter((v) => v !== '');

  return {
    source: httpProxy !== undefined || httpsProxy !== undefined ? 'linux-gsettings' : 'none',
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(ignoreItems.length === 0 ? {} : { noProxy: ignoreItems.join(',') }),
  };
}

function parseKdeKioslavercProxy(content) {
  let inProxy = false;
  const entries = new Map();
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      inProxy = /^\[Proxy Settings\]$/i.test(line);
      continue;
    }
    if (!inProxy) continue;
    const eq = line.indexOf('=');
    if (eq !== -1) entries.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  if (entries.get('ProxyType') !== '1') return { source: 'none' };
  const normalizeKde = (val, scheme) => {
    if (!val) return undefined;
    const spacePort = /^(.+?)\s+(\d{1,5})$/.exec(val.trim());
    return ensureScheme(spacePort ? `${spacePort[1]}:${spacePort[2]}` : val.trim(), scheme);
  };
  const httpUrl = normalizeKde(entries.get('httpProxy'), 'http');
  const httpsUrl = normalizeKde(entries.get('httpsProxy'), 'http');
  const socksUrl = normalizeKde(entries.get('socksProxy'), 'socks5');
  const httpProxy = httpUrl ?? (httpsUrl === undefined ? socksUrl : undefined);
  const httpsProxy = httpsUrl ?? httpUrl ?? socksUrl;
  const noProxyRaw = entries.get('NoProxyFor');
  return {
    source: httpProxy !== undefined || httpsProxy !== undefined ? 'linux-kde' : 'none',
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxyRaw ? { noProxy: noProxyRaw } : {}),
  };
}

function defaultExec(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: DETECT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function defaultReadFile(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Synchronously detect OS-level proxy settings (macOS scutil / Windows registry / Linux GNOME & KDE).
 */
function detectOsSystemProxySync(options = {}) {
  const platform = options.platform || process.platform;
  const exec = options.execFile || defaultExec;
  const read = options.readFile || defaultReadFile;
  const home = options.homeDir || os.homedir();

  if (platform === 'darwin') {
    try {
      return parseMacScutilProxy(exec('scutil', ['--proxy']));
    } catch {
      return { source: 'none' };
    }
  }
  if (platform === 'win32') {
    try {
      return parseWindowsRegProxy(
        exec('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']),
      );
    } catch {
      return { source: 'none' };
    }
  }
  if (platform === 'linux') {
    const safeGet = (schema, key) => {
      try { return exec('gsettings', ['get', schema, key]); } catch { return undefined; }
    };
    const mode = safeGet('org.gnome.system.proxy', 'mode');
    if (mode !== undefined) {
      const gnome = parseGsettingsProxy({
        mode,
        httpHost: safeGet('org.gnome.system.proxy.http', 'host'),
        httpPort: safeGet('org.gnome.system.proxy.http', 'port'),
        httpAuth: safeGet('org.gnome.system.proxy.http', 'use-authentication'),
        httpUser: safeGet('org.gnome.system.proxy.http', 'authentication-user'),
        httpPass: safeGet('org.gnome.system.proxy.http', 'authentication-password'),
        httpsHost: safeGet('org.gnome.system.proxy.https', 'host'),
        httpsPort: safeGet('org.gnome.system.proxy.https', 'port'),
        socksHost: safeGet('org.gnome.system.proxy.socks', 'host'),
        socksPort: safeGet('org.gnome.system.proxy.socks', 'port'),
        ignoreHosts: safeGet('org.gnome.system.proxy', 'ignore-hosts'),
      });
      if (gnome.source !== 'none') return gnome;
    }
    for (const rel of ['.config/kioslaverc', '.kde/share/config/kioslaverc']) {
      try {
        const content = read(path.join(home, rel));
        if (content !== undefined) {
          const kde = parseKdeKioslavercProxy(content);
          if (kde.source !== 'none') return kde;
        }
      } catch {
        // Ignore unreadable KDE file.
      }
    }
  }
  return { source: 'none' };
}

function hasExplicitEnvProxy(env) {
  return EXPLICIT_ENV_NAMES.some((name) => typeof env[name] === 'string' && env[name].trim() !== '');
}

function injectEnvForProxy(overlay, httpProxy, httpsProxy, noProxy, markSystemInjected) {
  const effectiveNoProxy = mergeNoProxy(noProxy);
  if (isSocksProxyUrl(httpProxy) || isSocksProxyUrl(httpsProxy)) {
    const socksUrl = httpsProxy || httpProxy;
    overlay.all_proxy = socksUrl;
    overlay.ALL_PROXY = socksUrl;
    overlay.no_proxy = effectiveNoProxy;
    overlay.NO_PROXY = effectiveNoProxy;
  } else {
    if (httpProxy !== undefined) {
      overlay.http_proxy = httpProxy;
      overlay.HTTP_PROXY = httpProxy;
    }
    if (httpsProxy !== undefined) {
      overlay.https_proxy = httpsProxy;
      overlay.HTTPS_PROXY = httpsProxy;
    }
    overlay.no_proxy = effectiveNoProxy;
    overlay.NO_PROXY = effectiveNoProxy;
    overlay.NODE_USE_ENV_PROXY = '1';
  }
  if (markSystemInjected) {
    overlay.DSH_TRADING_INJECTED_SYSTEM_PROXY = '1';
  }
}

/**
 * Build host child process proxy environment overlay based on launch env, saved settings,
 * Electron session proxy resolution, and OS system proxy detection.
 */
function buildDesktopProxyEnv(baseEnv, options = {}) {
  const savedConfig = options.savedConfig || { mode: 'system' };
  const mode = savedConfig.mode === 'custom' || savedConfig.mode === 'direct' ? savedConfig.mode : 'system';
  const osProxy = options.osProxy || { source: 'none' };
  const sessionHttp = options.sessionHttp;
  const sessionHttps = options.sessionHttps;

  const envOverlay = {};
  const desktopHintHttp = osProxy.httpProxy || sessionHttp;
  const desktopHintHttps = osProxy.httpsProxy || sessionHttps || desktopHintHttp;
  const desktopHintNoProxy = osProxy.noProxy;
  if (desktopHintHttp) envOverlay.DSH_TRADING_DESKTOP_SYSTEM_PROXY_HTTP = desktopHintHttp;
  if (desktopHintHttps) envOverlay.DSH_TRADING_DESKTOP_SYSTEM_PROXY_HTTPS = desktopHintHttps;
  if (desktopHintNoProxy) envOverlay.DSH_TRADING_DESKTOP_SYSTEM_PROXY_NO_PROXY = desktopHintNoProxy;

  if (mode === 'direct') {
    return { envOverlay, mode, source: 'direct' };
  }

  if (mode === 'custom') {
    const check = validateProxyUrl(savedConfig.url);
    if (check.ok) {
      injectEnvForProxy(envOverlay, check.value, check.value, savedConfig.noProxy, false);
      return {
        envOverlay,
        mode,
        source: 'custom',
        httpProxy: check.value,
        httpsProxy: check.value,
      };
    }
    return { envOverlay, mode, source: 'none' };
  }

  if (hasExplicitEnvProxy(baseEnv || {})) {
    return {
      envOverlay,
      mode: 'system',
      source: 'env',
      httpProxy: baseEnv.http_proxy || baseEnv.HTTP_PROXY || baseEnv.all_proxy || baseEnv.ALL_PROXY,
      httpsProxy: baseEnv.https_proxy || baseEnv.HTTPS_PROXY || baseEnv.all_proxy || baseEnv.ALL_PROXY,
    };
  }

  const effectiveHttp = osProxy.httpProxy || sessionHttp;
  const effectiveHttps = osProxy.httpsProxy || sessionHttps || effectiveHttp;
  if (effectiveHttp || effectiveHttps) {
    const source = osProxy.source && osProxy.source !== 'none' ? osProxy.source : 'electron-session';
    injectEnvForProxy(
      envOverlay,
      effectiveHttp,
      effectiveHttps,
      mergeNoProxy(osProxy.noProxy, savedConfig.noProxy),
      true,
    );
    return {
      envOverlay,
      mode: 'system',
      source,
      httpProxy: effectiveHttp,
      httpsProxy: effectiveHttps,
    };
  }

  return { envOverlay, mode: 'system', source: 'none' };
}

module.exports = {
  LOOPBACK_NO_PROXY,
  parseChromiumProxyResult,
  readSavedProxyConfig,
  parseMacScutilProxy,
  parseWindowsRegProxy,
  parseGsettingsProxy,
  parseKdeKioslavercProxy,
  detectOsSystemProxySync,
  buildDesktopProxyEnv,
  redactProxyUrl,
};
