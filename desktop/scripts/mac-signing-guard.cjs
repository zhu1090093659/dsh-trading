'use strict';

/**
 * macOS 签名 / 公证的收尾闸门，两个 hook 共用一个模块（resolveFunction 按导出名取，
 * 见 app-builder-lib/out/util/resolve.js）。
 *
 * afterSign —— electron-builder 只在真的签成功时才 emit（platformPackager.doSignAfterPack 的
 *   `if (didSign)`），此刻 macPackager.sign 内部已经跑完 notarizeIfProvided，也就是
 *   @electron/notarize 的 notarize + staple（@electron/notarize 2.5.0 lib/index.js 在
 *   notarizeAndWaitForNotaryTool 之后 retry(stapleApp)）。这里核对签名形态、hardened
 *   runtime、公证票据，不达标直接抛错。
 *
 * afterAllArtifactBuild —— 无论签没签都会跑（app-builder-lib/out/index.js build() 尾部）。
 *   未签名时打显式横幅：配了 mac.sign 之后 electron-builder 自己的「找不到身份」告警会被吞掉
 *   （MacTargetHelper.findSigningIdentity 里 noIdentity = !config.sign && identity == null），
 *   必须由本闸门兜底，否则就是「静默产出看着像签名其实是未签名的包」。
 *   APPLE_* 齐备且产物是 Developer ID 分发签名时，顺便把 .dmg 也送公证并 staple
 *   （electron-builder 只公证 .app）。
 */

const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
// 公证凭据判定只有一个家：签名侧（sign-mac.cjs）与 electron-builder 的
// MacTargetHelper.getNotarizeOptions 保持同一套三选一，这里直接复用。
const { notarizeCredentials } = require('./sign-mac.cjs');

const LOG_PREFIX = '  • mac-signing: ';
const UNSIGNED_BANNER = [
  '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
  '!!  本次 macOS 产物未做代码签名（只有上游 Electron 自带的 ad-hoc 签名）',
  '!!  它无法通过 Gatekeeper，只能本机自用，不能对外分发。',
  '!!  签名身份解析顺序：mac.identity -> CSC_NAME -> 钥匙串里的可用证书；',
  '!!  本机若已有 Apple Development 证书，正常构建会自动签上，出现本横幅说明',
  '!!  这次既没有指定身份，也没有自动发现到身份（例如 CSC_IDENTITY_AUTO_DISCOVERY=false）。',
  '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
];

function codesignField(text, name) {
  const match = new RegExp('^' + name + '=(.*)$', 'm').exec(text);
  return match === null ? null : match[1].trim();
}

/** `codesign -dv --verbose=4 <target>` 的文本（stdout+stderr）-> 结构化字段。 */
function parseCodesignDetails(text) {
  const authority = [];
  for (const line of String(text).split('\n')) {
    const match = /^Authority=(.*)$/.exec(line);
    if (match !== null) authority.push(match[1].trim());
  }
  // flags 不在行首（CodeDirectory v=... flags=0x10000(runtime) hashes=...），单独抓。
  const flags = /\bflags=(\S+)/.exec(text);
  return {
    identifier: codesignField(text, 'Identifier'),
    teamIdentifier: codesignField(text, 'TeamIdentifier'),
    signature: codesignField(text, 'Signature'),
    flags: flags === null ? null : flags[1],
    authorities: authority,
  };
}

/**
 * 归类产物签名形态。
 * - unsigned：没有任何真实签名（含上游 Electron 的 linker 签名，flags 里带 linker-signed）
 * - adhoc：codesign --sign - 出来的纯 ad-hoc 签名（identity:"-" 显式选择时才会出现）
 * - development：Apple Development / Mac Developer 开发签名
 * - developer-id：Developer ID Application 分发签名
 * - other：非 Apple 证书签名（electron-builder 的「自定义非 Apple 证书」回退）
 */
function classifySignature(details) {
  const signed = details.signature !== null || details.identifier !== null;
  if (!signed) return 'unsigned';
  const joined = details.authorities.join('\n');
  if (/^Developer ID Application:/m.test(joined)) return 'developer-id';
  if (/^(?:Apple Development|Mac Developer):/m.test(joined)) return 'development';
  if (details.signature === 'adhoc' && /linker-signed/.test(details.flags ?? '')) return 'unsigned';
  if (details.signature === 'adhoc') return 'adhoc';
  return 'other';
}

function isHardenedRuntime(details) {
  return typeof details.flags === 'string' && details.flags.includes('(runtime)');
}

/** 操作者是否声明了签名材料（用于区分「主动要求签名」与「本来就没打算签」）。 */
function signingRequest(buildOptions, env) {
  const reasons = [];
  const identity = buildOptions?.identity ?? null;
  if (typeof identity === 'string' && identity !== '' && identity !== '-') reasons.push('mac.identity=' + identity);
  if (identity === '-') reasons.push('mac.identity="-"（显式 ad-hoc）');
  for (const name of ['CSC_LINK', 'CSC_NAME', 'CSC_KEYCHAIN']) {
    if (env[name]) reasons.push(name);
  }
  return { requested: reasons.length > 0, reasons, autoDiscoveryDisabled: env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' };
}

/**
 * 判定矩阵。返回 [{level: 'info'|'warn'|'fail', message, banner?}]。
 * 缺 APPLE_* 一律不判失败（公证是可选路径）；只有「声明了材料却没签成」「Developer ID
 * 缺 hardened runtime」「凭据齐备却没有公证票据」才 fail。签名形态不是唯一要求：
 * 开发签名只给 warn。
 */
function decideOutcome(input) {
  const { state, hardened, request, notarizeRequested, stapled, details } = input;
  const notes = [];
  const add = (level, message, banner) => notes.push(banner === true ? { level, message, banner } : { level, message });
  if (state === 'unsigned') {
    const shape = 'codesign: Signature=' + String(details.signature) + ' flags=' + String(details.flags)
      + ' Identifier=' + String(details.identifier);
    if (request.requested) {
      add('fail', '产物未签名，但检测到签名材料声明（' + request.reasons.join('、') + '）。'
        + 'electron-builder 在配了 mac.sign 之后不再报「找不到签名身份」，由本闸门兜底中止。' + shape);
    } else {
      add('warn', '未签名产物：' + shape, true);
    }
    return notes;
  }
  add('info', '代码签名形态 ' + state + '；hardened runtime ' + (hardened ? '已启用' : '未启用'));
  if (state === 'adhoc') {
    add('warn', 'ad-hoc 签名（只在显式 mac.identity="-" 时出现）：没有 TeamIdentifier，无法通过 Gatekeeper。');
  }
  if (state === 'development') {
    add('warn', '开发签名（' + String(details.teamIdentifier) + '）：本机可启动，但不能对外分发，'
      + '要分发请换 Developer ID Application 身份（CSC_NAME=<SHA-1>）后再公证。');
  }
  if (state === 'other') {
    add('warn', '非 Apple 证书签名：electron-builder 的「自定义证书」回退，系统信任链不自洽。');
  }
  if (state === 'developer-id' && !hardened) {
    add('fail', 'Developer ID 签名却没有 hardened runtime（codesign flags 缺 (runtime)）。');
  }
  if (state !== 'developer-id' && !hardened) {
    add('warn', '签名未启用 hardened runtime（codesign flags 缺 (runtime)）：公证会拒，本机启动不受影响。');
  }
  if (notarizeRequested && stapled !== true) {
    add('fail', 'APPLE_* 公证凭据齐备，但产物没有公证票据（xcrun stapler validate 未通过）。');
  }
  if (!notarizeRequested) {
    add('info', '未提供 APPLE_* 公证凭据：跳过公证（开发签名的产物本来也无法公证）。');
  }
  return notes;
}

function readAppSignature(appPath) {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  const text = String(result.stdout ?? '') + String(result.stderr ?? '');
  const details = parseCodesignDetails(text);
  if (/is not signed at all/.test(text)) return { state: 'unsigned', details, text };
  if (result.status !== 0 && details.signature === null) return { state: 'unsigned', details, text };
  return { state: classifySignature(details), details, text };
}

/** xcrun stapler validate：票据已订上时退出码 0。 */
function isStapled(targetPath) {
  return spawnSync('xcrun', ['stapler', 'validate', targetPath], { encoding: 'utf8' }).status === 0;
}

function findMacApp(outDir, productFilename) {
  if (typeof outDir !== 'string' || !fs.existsSync(outDir)) return null;
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^mac(?:-|$)/.test(entry.name)) continue;
    const appPath = path.join(outDir, entry.name, productFilename + '.app');
    if (fs.existsSync(appPath)) return appPath;
  }
  return null;
}

function listDmgArtifacts(buildResult, outDir) {
  const paths = Array.isArray(buildResult?.artifactPaths) ? buildResult.artifactPaths : [];
  const dmgs = paths.filter((file) => typeof file === 'string' && file.endsWith('.dmg'));
  if (dmgs.length > 0 || typeof outDir !== 'string' || !fs.existsSync(outDir)) return dmgs;
  return fs.readdirSync(outDir).filter((file) => file.endsWith('.dmg')).map((file) => path.join(outDir, file));
}

function printNotes(notes) {
  for (const note of notes) {
    if (note.banner === true) {
      for (const line of UNSIGNED_BANNER) console.log(line);
    }
    const prefix = note.level === 'fail' ? LOG_PREFIX + '[FAIL] ' : LOG_PREFIX + (note.level === 'warn' ? '[WARN] ' : '');
    console.log(prefix + note.message);
    if (note.banner === true) console.log(UNSIGNED_BANNER[0]);
  }
}

function throwOnFailures(notes, stage, target) {
  const failures = notes.filter((note) => note.level === 'fail');
  if (failures.length === 0) return;
  throw new Error([
    'mac 签名闸门（' + stage + '）未通过：',
    ...failures.map((note) => '- ' + note.message),
    '产物：' + target,
  ].join('\n'));
}

function loadBuilderDependency(name) {
  const anchor = require.resolve('electron-builder/package.json', { paths: [path.join(__dirname, '..')] });
  return createRequire(anchor)(name);
}

async function notarizeAndStapleDmgs(dmgs, credentials) {
  if (dmgs.length === 0) return [];
  const { notarize } = loadBuilderDependency('@electron/notarize');
  const done = [];
  for (const dmg of dmgs) {
    console.log(LOG_PREFIX + '送公证 ' + path.basename(dmg));
    // @electron/notarize 对 .dmg/.pkg 跳过 codesign 检查，并在 notarytool 通过后自行 staple。
    await notarize({ appPath: dmg, tool: 'notarytool', ...credentials });
    console.log(LOG_PREFIX + '公证并 staple 完成 ' + path.basename(dmg));
    done.push(dmg);
  }
  return done;
}

async function afterSign(context) {
  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, productFilename + '.app');
  if (!fs.existsSync(appPath)) return;
  const { state, details } = readAppSignature(appPath);
  const request = signingRequest(context.packager.platformSpecificBuildOptions, process.env);
  const credentials = notarizeCredentials(process.env);
  const stapled = credentials === null ? null : isStapled(appPath);
  const notes = decideOutcome({
    state,
    hardened: isHardenedRuntime(details),
    request,
    notarizeRequested: credentials !== null,
    stapled,
    details,
  });
  printNotes(notes);
  console.log(LOG_PREFIX + 'app 公证票据：' + (stapled === true ? '已 staple' : stapled === false ? '未 staple' : '本次未申请公证'));
  throwOnFailures(notes, 'afterSign', appPath);
}

async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== 'darwin') return;
  const packager = buildResult?.packager;
  const outDir = buildResult?.outDir
    ?? path.resolve(packager?.projectDir ?? process.cwd(), packager?.config?.directories?.output ?? 'dist');
  const appPath = findMacApp(outDir, packager?.appInfo?.productFilename ?? '');
  if (appPath === null) return;
  const { state, details } = readAppSignature(appPath);
  const request = signingRequest(packager?.platformSpecificBuildOptions, process.env);
  const credentials = notarizeCredentials(process.env);
  if (state === 'developer-id' && credentials !== null) {
    await notarizeAndStapleDmgs(listDmgArtifacts(buildResult, outDir), credentials);
  }
  const notes = decideOutcome({
    state,
    hardened: isHardenedRuntime(details),
    request,
    notarizeRequested: credentials !== null,
    stapled: credentials === null ? null : isStapled(appPath),
    details,
  });
  printNotes(notes);
  throwOnFailures(notes, 'afterAllArtifactBuild', appPath);
}

exports.afterSign = afterSign;
exports.afterAllArtifactBuild = afterAllArtifactBuild;
exports.default = afterAllArtifactBuild;
exports.classifySignature = classifySignature;
exports.decideOutcome = decideOutcome;
exports.findMacApp = findMacApp;
exports.isHardenedRuntime = isHardenedRuntime;
exports.notarizeCredentials = notarizeCredentials;
exports.parseCodesignDetails = parseCodesignDetails;
exports.signingRequest = signingRequest;
