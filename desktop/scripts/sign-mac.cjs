'use strict';

/**
 * mac.sign hook：把签名身份收敛成唯一一张证书（SHA-1 指纹）再交给 @electron/osx-sign。
 *
 * 为什么不能直接用 electron-builder 的内置路径（已核实）：
 * - MacTargetHelper.buildSignOptions 交给 osx-sign 的 identity 是 `identity.hash || identity.name`，
 *   但 macPackager.doSign 在没有自定义 sign 时又用 `identity.name` 覆盖一次——最终
 *   `codesign --sign "<证书通用名>"`。
 * - 本机钥匙串里有两张同名 "Apple Development: 1090093659@qq.com (5TWWJ2SW2N)"
 *   （AF607EA2CBEEF0924FA737BB037CA45545B3E5DA 与 A7767D3FEBF0D3E61FFC28DD18AC0CF278C850F2），
 *   通用名交出去必然报 ambiguous，整条签名链路走不通。
 *
 * 本 hook 做三件事：
 * 1. 重新枚举钥匙串身份，按 qualifier（mac.identity / CSC_NAME，证书全名或 SHA-1 指纹）
 *    或 electron-builder 已解析出的身份（正常就是一枚指纹）挑出唯一一张，把【指纹】
 *    交给 osx-sign（identityValidation:false 时它直接 `codesign --sign <identity>`）；
 *    通用名撞车时按候选顺序取第一张（与内置解析同序），并把选中、其余候选、覆盖命令
 *    一并打印——不让操作者去猜。一张都匹配不上则 fail closed。
 * 2. 时间戳策略：osx-sign 默认给每个被签文件加 `--timestamp`，本仓载荷里有成百上千个
 *    二进制（自带 Node 运行时 + dsh host 闭包 + node_modules 里的 .node/.png），
 *    实测一次性几百次 TSA 往返会被 Apple 限流并报 "The timestamp service is not available"
 *    中断构建（单次 TSA 往返本身正常，见 README/Agent Note）。因此：APPLE_* 公证凭据
 *    齐备（真要走公证，Apple 要求安全时间戳）时保持 osx-sign 默认；否则默认
 *    `--timestamp=none`，不依赖 TSA。DSH_MAC_TIMESTAMP=none|<TSA URL>|default 可显式覆盖。
 * 3. 公证前提校验：凭据齐备却选了非 Developer ID 身份时提前报错，免得撞 notarytool 的晦涩报错。
 */

const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');

const IDENTITY_LINE = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.*)"/;
const FINGERPRINT = /^[0-9A-Fa-f]{40}$/;
const AD_HOC = '-';
const DEVELOPER_ID_PREFIX = 'Developer ID Application:';
const TIMESTAMP_ENV = 'DSH_MAC_TIMESTAMP';

function isFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT.test(value.trim());
}

/** `security find-identity -v -p codesigning` 输出 -> [{hash, name}]（保持命令行顺序）。 */
function parseIdentities(stdout) {
  const identities = [];
  for (const raw of String(stdout).split('\n')) {
    const match = IDENTITY_LINE.exec(raw);
    if (match !== null) identities.push({ hash: match[1].toUpperCase(), name: match[2] });
  }
  return identities;
}

/** 与 MacTargetHelper.getNotarizeOptions 同一套判定：三选一齐备才算启用公证。 */
function notarizeCredentials(env) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = env;
  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    return { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID };
  }
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = env;
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return { appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER };
  }
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return env.APPLE_KEYCHAIN === undefined
      ? { keychainProfile: env.APPLE_KEYCHAIN_PROFILE }
      : { keychainProfile: env.APPLE_KEYCHAIN_PROFILE, keychain: env.APPLE_KEYCHAIN };
  }
  return null;
}

function matchByName(identities, name) {
  const exact = identities.filter((identity) => identity.name === name);
  return exact.length > 0 ? exact : identities.filter((identity) => identity.name.includes(name));
}

function accept(identities, identity, selectedBy) {
  const twins = identities.filter((candidate) => candidate.name === identity.name);
  return { ok: true, identity, selectedBy, ambiguous: twins.length > 1 ? twins : [] };
}

/**
 * 挑出唯一一张证书。
 * @param identities parseIdentities 的结果
 * @param qualifier  {requested, resolved}：requested 是操作者给的（mac.identity / CSC_NAME，
 *                   可能是指纹或通用名），resolved 是 electron-builder 自己的解析结果。
 * @returns {{ok: true, identity, selectedBy, ambiguous} | {ok: false, reason, matches}}
 */
function selectIdentity(identities, qualifier) {
  if (identities.length === 0) return { ok: false, reason: 'no-identity', matches: [] };
  const requested = typeof qualifier.requested === 'string' ? qualifier.requested.trim() : '';
  const resolved = typeof qualifier.resolved === 'string' ? qualifier.resolved.trim() : '';
  const wanted = requested !== '' ? requested : resolved;
  if (wanted === '') {
    if (identities.length === 1) return accept(identities, identities[0], 'sole');
    return { ok: false, reason: 'no-qualifier', matches: identities };
  }
  if (isFingerprint(wanted)) {
    const hit = identities.filter((identity) => identity.hash === wanted.toUpperCase());
    if (hit.length === 0) return { ok: false, reason: 'fingerprint-not-found', matches: identities };
    return accept(identities, hit[0], 'fingerprint');
  }
  const matches = matchByName(identities, wanted);
  if (matches.length === 0) return { ok: false, reason: 'qualifier-not-found', matches: identities };
  return accept(identities, matches[0], 'name');
}

function describeCandidates(identities) {
  if (identities.length === 0) return '  （钥匙串里没有任何 codesigning 身份）';
  return identities.map((identity) => '  ' + identity.hash + '  ' + identity.name).join('\n');
}

function describeFailure(selection, requested) {
  const reason = {
    'no-identity': '钥匙串里找不到任何可用的 codesigning 证书。',
    'fingerprint-not-found': 'CSC_NAME / mac.identity 给的是 SHA-1 指纹，但钥匙串里没有这张证书。',
    'qualifier-not-found': '按 CSC_NAME / mac.identity 指定的身份名找不到证书。',
    'no-qualifier': '没有给出签名身份，而钥匙串里不止一张证书，无法唯一确定。',
  }[selection.reason] ?? '签名身份无法唯一确定。';
  return [
    'sign-mac: 签名身份无法唯一确定，构建已中止（fail closed）。',
    '原因：' + reason,
    'CSC_NAME / mac.identity 当前取值：' + (requested === '' ? '(未设置)' : requested),
    '候选身份：',
    describeCandidates(selection.matches),
    '用指纹重跑（指纹取自上面的候选列表）：',
    '  CSC_NAME=<SHA-1> npx electron-builder --mac',
  ].join('\n');
}

/** 通用名重名时的说明：讲清到底用了哪一张、其余是谁、怎么固定到另一张。 */
function describeAmbiguity(selection, requested) {
  const others = selection.ambiguous.filter((identity) => identity.hash !== selection.identity.hash);
  const head = selection.selectedBy === 'fingerprint'
    ? 'sign-mac: 选中的证书与另外 ' + String(others.length) + ' 张同名，但你给的是指纹，codesign 只会看到：'
    : selection.selectedBy === 'name'
      ? 'sign-mac: 有 ' + String(selection.ambiguous.length) + ' 张证书满足该通用名，已按候选顺序选用第一张：'
      : 'sign-mac: 有多张同名证书，已按候选顺序选用第一张：';
  return [
    head,
    '  选用 ' + selection.identity.hash + '  ' + selection.identity.name,
    ...others.map((identity) => '  同名 ' + identity.hash),
    '交给 codesign 的是上面的指纹（不是通用名），所以不会 ambiguous。',
    '要固定到另一张：CSC_NAME=<SHA-1> npx electron-builder --mac'
      + (requested === '' ? '' : '（当前 CSC_NAME / mac.identity = ' + requested + '）'),
  ].join('\n');
}

/**
 * 时间戳策略。返回 'none' | TSA URL | undefined（undefined = 保持 osx-sign 默认的 --timestamp）。
 */
function resolveTimestamp(env) {
  const override = typeof env[TIMESTAMP_ENV] === 'string' ? env[TIMESTAMP_ENV].trim() : '';
  if (override === 'default') return undefined;
  if (override !== '') return override;
  return notarizeCredentials(env) === null ? 'none' : undefined;
}

/** 用一层 optionsForFile 包装施加时间戳策略；osx-sign 的 optionsForFile 是同步函数，这里也必须同步。 */
function applyTimestampPolicy(opts, timestamp) {
  if (timestamp === undefined) return opts;
  const inner = opts.optionsForFile;
  return {
    ...opts,
    optionsForFile: (filePath) => ({ ...(typeof inner === 'function' ? inner(filePath) : {}), timestamp }),
  };
}

function readKeychainIdentities(keychain) {
  const args = ['find-identity', '-v', '-p', 'codesigning'];
  if (typeof keychain === 'string' && keychain !== '') args.push(keychain);
  return parseIdentities(execFileSync('/usr/bin/security', args, { encoding: 'utf8' }));
}

/** 用 electron-builder 自己的依赖树解析 @electron/osx-sign，避免出现第二个漂移的副本。 */
function loadOsxSign() {
  const anchor = require.resolve('electron-builder/package.json', { paths: [path.join(__dirname, '..')] });
  return createRequire(anchor)('@electron/osx-sign');
}

/** 公证凭据齐备时只有 Developer ID 分发的产物能送公证，提前拦下免得撞 notarytool 的晦涩报错。 */
function assertNotarizableWhenCredentialsPresent(env, identity) {
  if (env.DSH_MAC_SKIP_NOTARIZE || notarizeCredentials(env) === null) return;
  if (identity.name.startsWith(DEVELOPER_ID_PREFIX)) return;
  throw new Error([
    'sign-mac: APPLE_* 公证凭据齐备，但选中的签名身份不是 Developer ID Application：',
    '  ' + identity.hash + '  ' + identity.name,
    'Apple 只公证 Developer ID 分发的产物，开发签名送公证必被拒。二选一：',
    '  • 本次只做签名：去掉 APPLE_* 环境变量，或设 DSH_MAC_SKIP_NOTARIZE=1；',
    '  • 要出可分发的包：CSC_NAME=<Developer ID Application 证书的 SHA-1> npx electron-builder --mac',
  ].join('\n'));
}

async function withRetry(operation, attempts, intervalMs) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
  }
  throw lastError;
}

async function signMac(opts, packager) {
  const requested = packager?.platformSpecificBuildOptions?.identity ?? process.env.CSC_NAME ?? null;
  const timestamp = resolveTimestamp(process.env);
  const { signAsync } = loadOsxSign();
  console.log('  • sign-mac: 时间戳策略 ' + (timestamp === undefined ? '--timestamp（osx-sign 默认）' : '--timestamp=' + timestamp));
  // `identity: "-"` 是显式选择 ad-hoc 签名，保持 electron-builder 原语义透传。
  if (requested === AD_HOC) {
    console.log('  • sign-mac: identity "-" 为显式 ad-hoc 签名，按原样交给 codesign');
    return withRetry(() => signAsync(applyTimestampPolicy(opts, timestamp)), 3, 5000);
  }
  const selection = selectIdentity(readKeychainIdentities(opts.keychain), {
    requested,
    resolved: opts.identity,
  });
  if (!selection.ok) throw new Error(describeFailure(selection, typeof requested === 'string' ? requested : ''));
  if (selection.ambiguous.length > 0) console.log(describeAmbiguity(selection, typeof requested === 'string' ? requested : ''));
  assertNotarizableWhenCredentialsPresent(process.env, selection.identity);
  console.log('  • sign-mac: 用唯一指纹签名 ' + selection.identity.hash + '  ' + selection.identity.name);
  const withIdentity = { ...applyTimestampPolicy(opts, timestamp), identity: selection.identity.hash, identityValidation: false };
  return withRetry(() => signAsync(withIdentity), 3, 5000);
}

exports.default = signMac;
exports.isFingerprint = isFingerprint;
exports.parseIdentities = parseIdentities;
exports.selectIdentity = selectIdentity;
exports.describeAmbiguity = describeAmbiguity;
exports.describeFailure = describeFailure;
exports.notarizeCredentials = notarizeCredentials;
exports.resolveTimestamp = resolveTimestamp;
exports.applyTimestampPolicy = applyTimestampPolicy;
