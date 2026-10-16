import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sign = require('../scripts/sign-mac.cjs');
const guard = require('../scripts/mac-signing-guard.cjs');

const DUPLICATE_NAME = 'Apple Development: 1090093659@qq.com (5TWWJ2SW2N)';
const FIRST_FINGERPRINT = 'AF607EA2CBEEF0924FA737BB037CA45545B3E5DA';
const SECOND_FINGERPRINT = 'A7767D3FEBF0D3E61FFC28DD18AC0CF278C850F2';
const FIND_IDENTITY_OUTPUT = [
  '  1) ' + FIRST_FINGERPRINT + ' "' + DUPLICATE_NAME + '"',
  '  2) ' + SECOND_FINGERPRINT + ' "' + DUPLICATE_NAME + '"',
  '  3) FCB03EC8EF3A5EF3899B804E62EBBC97AEC3F1D4 "Apple Development: Haowei Hua (H4556B69TR)"',
  '     3 valid identities found',
].join('\n');

const DEVELOPMENT_SIGNED = [
  'Executable=/tmp/sandbox/DSH Trading.app/Contents/MacOS/DSH Trading',
  'Identifier=com.dsh-trading.desktop',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=1179 flags=0x10000(runtime) hashes=28+7 location=embedded',
  'TeamIdentifier=3H4FK5CBYJ',
  'Authority=' + DUPLICATE_NAME,
  'Authority=Apple Worldwide Developer Relations Certification Authority',
  'Authority=Apple Root CA',
].join('\n');

const DEVELOPER_ID_SIGNED = [
  'Identifier=com.dsh-trading.desktop',
  'CodeDirectory v=20500 size=1179 flags=0x10000(runtime) hashes=28+7 location=embedded',
  'TeamIdentifier=3H4FK5CBYJ',
  'Authority=Developer ID Application: Example Owner (3H4FK5CBYJ)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
].join('\n');

const UNTOUCHED = [
  'Executable=/Applications/DSH Trading.app/Contents/MacOS/DSH Trading',
  'Identifier=Electron',
  'CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded',
  'Signature=adhoc',
].join('\n');

function readBuilderYml() {
  return fs.readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8');
}

function readMacBlock() {
  const lines = readBuilderYml().split('\n');
  const start = lines.indexOf('mac:');
  const block = [];
  for (let index = start + 1; index > 0 && index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && !/^\s/.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join('\n');
}

function readEntitlementKeys() {
  const plist = fs.readFileSync(path.join(desktopDir, 'resources', 'entitlements.mac.plist'), 'utf8');
  return [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
}

test('operator 从 security find-identity 输出里解析出指纹与证书通用名', () => {
  // Given 一份含两张同名证书的 find-identity 输出
  // When 解析它
  const identities = sign.parseIdentities(FIND_IDENTITY_OUTPUT);
  // Then 三张证书按命令行顺序读出，指纹统一大写，汇总行不被误读
  assert.equal(identities.length, 3);
  assert.deepEqual(identities[0], { hash: FIRST_FINGERPRINT, name: DUPLICATE_NAME });
  assert.equal(identities[2].name, 'Apple Development: Haowei Hua (H4556B69TR)');
});

test('operator 用 SHA-1 指纹在重名证书里挑出唯一一张', () => {
  // Given 两张同名 Apple Development 证书
  const identities = sign.parseIdentities(FIND_IDENTITY_OUTPUT);
  // When 用小写形式的第二张指纹指定身份
  const selection = sign.selectIdentity(identities, { requested: SECOND_FINGERPRINT.toLowerCase(), resolved: null });
  // Then 正好选中第二张，并如实告知它有一张同名兄弟
  assert.equal(selection.ok, true);
  assert.equal(selection.selectedBy, 'fingerprint');
  assert.equal(selection.identity.hash, SECOND_FINGERPRINT);
  assert.equal(selection.ambiguous.length, 2);
});

test('operator 只给重名通用名时按唯一指纹处理并把候选摊开', () => {
  // Given 两张同名证书与一个只写了通用名的身份声明
  const identities = sign.parseIdentities(FIND_IDENTITY_OUTPUT);
  // When 按通用名挑选
  const selection = sign.selectIdentity(identities, { requested: DUPLICATE_NAME, resolved: null });
  // Then 取候选顺序第一张（交给 codesign 的仍是指纹），并给出其余候选与覆盖命令
  assert.equal(selection.ok, true);
  assert.equal(selection.identity.hash, FIRST_FINGERPRINT);
  assert.equal(selection.ambiguous.length, 2);
  const notice = sign.describeAmbiguity(selection, DUPLICATE_NAME);
  assert.match(notice, new RegExp(SECOND_FINGERPRINT));
  assert.match(notice, /CSC_NAME=<SHA-1>/);
});

test('operator 指定的指纹不在钥匙串里时得到可执行的报错而不是随便挑一张', () => {
  // Given 钥匙串里没有这张证书
  const identities = sign.parseIdentities(FIND_IDENTITY_OUTPUT);
  // When 用一个不存在的指纹指定身份
  const selection = sign.selectIdentity(identities, { requested: '0'.repeat(40), resolved: null });
  // Then 判定失败，错误文本列出全部候选指纹和可直接复制的覆盖命令
  assert.equal(selection.ok, false);
  assert.equal(selection.reason, 'fingerprint-not-found');
  const failure = sign.describeFailure(selection, '0'.repeat(40));
  assert.match(failure, /fail closed/);
  assert.match(failure, new RegExp(FIRST_FINGERPRINT));
  assert.match(failure, /CSC_NAME=<SHA-1>/);
});

test('operator 从 codesign 输出读出签名形态与 hardened runtime', () => {
  // Given 一段 Apple Development 重签后的 codesign -dv 输出
  // When 解析并归类
  const details = guard.parseCodesignDetails(DEVELOPMENT_SIGNED);
  // Then 标识、团队、Authority 链与 runtime 标志都能读出来
  assert.equal(details.identifier, 'com.dsh-trading.desktop');
  assert.equal(details.teamIdentifier, '3H4FK5CBYJ');
  assert.equal(guard.classifySignature(details), 'development');
  assert.equal(guard.isHardenedRuntime(details), true);
});

test('operator 看到上游 Electron 的 linker 签名时判为未签名而不是已签的包', () => {
  // Given 未重新签名的产物形态（只有上游自带的 ad-hoc/linker 签名）
  // When 归类
  const details = guard.parseCodesignDetails(UNTOUCHED);
  // Then 判为未签名，且没有 hardened runtime
  assert.equal(guard.classifySignature(details), 'unsigned');
  assert.equal(guard.isHardenedRuntime(details), false);
});

test('operator 在没有签名材料时得到显式横幅而不是构建失败', () => {
  // Given 未签名产物，且没有任何签名材料声明
  const request = guard.signingRequest({}, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  // When 判定
  const notes = guard.decideOutcome({
    state: 'unsigned',
    hardened: false,
    request,
    notarizeRequested: false,
    stapled: null,
    details: guard.parseCodesignDetails(UNTOUCHED),
  });
  // Then 只有一条 warn 横幅，文案点明未签名不可分发
  assert.deepEqual(notes.map((note) => note.level), ['warn']);
  assert.equal(notes[0].banner, true);
  assert.match(notes[0].message, /未签名产物/);
  assert.equal(request.requested, false);
});

test('operator 声明了签名材料却拿到未签名产物时构建被判失败', () => {
  // Given CSC_NAME 已声明，但产物仍是未签名形态
  const request = guard.signingRequest({ identity: null }, { CSC_NAME: FIRST_FINGERPRINT });
  // When 判定
  const notes = guard.decideOutcome({
    state: 'unsigned',
    hardened: false,
    request,
    notarizeRequested: false,
    stapled: null,
    details: guard.parseCodesignDetails(UNTOUCHED),
  });
  // Then 明确 fail，并说明 electron-builder 的告警为何被吞掉
  assert.equal(request.requested, true);
  assert.deepEqual(notes.map((note) => note.level), ['fail']);
  assert.match(notes[0].message, /CSC_NAME/);
  assert.match(notes[0].message, /mac\.sign/);
});

test('operator 用 Apple Development 签名且没有 APPLE_ 凭据时构建仍然通过', () => {
  // Given 开发签名产物、hardened runtime 已启用、没有任何公证凭据
  const details = guard.parseCodesignDetails(DEVELOPMENT_SIGNED);
  // When 判定
  const notes = guard.decideOutcome({
    state: 'development',
    hardened: true,
    request: guard.signingRequest({}, {}),
    notarizeRequested: false,
    stapled: null,
    details,
  });
  // Then 没有 fail，只提示不可分发；公证凭据判定为空
  assert.equal(notes.some((note) => note.level === 'fail'), false);
  assert.match(notes.map((note) => note.message).join('\n'), /开发签名/);
  assert.equal(guard.notarizeCredentials({}), null);
  assert.equal(guard.notarizeCredentials({ APPLE_ID: 'a@b.c', APPLE_TEAM_ID: '3H4FK5CBYJ' }), null);
});

test('operator 给了 APPLE_ 凭据却拿不到公证票据时构建被判失败', () => {
  // Given API Key 形态的公证凭据齐备，但产物没有票据
  const credentials = guard.notarizeCredentials({
    APPLE_API_KEY: '/tmp/key.p8',
    APPLE_API_KEY_ID: 'KEYID12345',
    APPLE_API_ISSUER: 'ISSUER-UUID',
  });
  // When 判定
  const notes = guard.decideOutcome({
    state: 'developer-id',
    hardened: true,
    request: guard.signingRequest({ identity: 'Developer ID Application: X (3H4FK5CBYJ)' }, {}),
    notarizeRequested: true,
    stapled: false,
    details: guard.parseCodesignDetails(DEVELOPER_ID_SIGNED),
  });
  // Then 凭据被完整识别、判定失败并点名 stapler validate
  assert.deepEqual(credentials, {
    appleApiKey: '/tmp/key.p8',
    appleApiKeyId: 'KEYID12345',
    appleApiIssuer: 'ISSUER-UUID',
  });
  assert.ok(notes.some((note) => note.level === 'fail' && /stapler validate/.test(note.message)));
});

test('operator 的打包配置默认自动发现签名身份并挂上签名与公证钩子', () => {
  // Given 仓库里的 electron-builder.yml
  const yml = readBuilderYml();
  const macBlock = readMacBlock();
  // When 检查 mac 段与两个收尾钩子
  // Then identity 不再写死 null，hardenedRuntime/notarize 打开，钩子文件都真实存在
  assert.doesNotMatch(macBlock, /^\s+identity:/m);
  assert.match(macBlock, /^\s+hardenedRuntime:\s*true\s*$/m);
  assert.match(macBlock, /^\s+notarize:\s*true\s*$/m);
  assert.match(macBlock, /^\s+sign:\s*scripts\/sign-mac\.cjs\s*$/m);
  assert.match(yml, /^afterSign:\s*scripts\/mac-signing-guard\.cjs\s*$/m);
  assert.match(yml, /^afterAllArtifactBuild:\s*scripts\/mac-signing-guard\.cjs\s*$/m);
  for (const file of ['scripts/sign-mac.cjs', 'scripts/mac-signing-guard.cjs']) {
    assert.equal(fs.existsSync(path.join(desktopDir, file)), true, file + ' 应当存在');
  }
});

test('operator 的 entitlements 以 electron-builder 三项为基且 apple-events 与说明成对', () => {
  // Given 仓库里的 entitlements.mac.plist
  const keys = readEntitlementKeys();
  // When 检查键集合
  // Then 恰好是 electron-builder 自带三项；将来若加 apple-events，必须同时补 Info.plist 说明
  assert.equal(keys.length, 3);
  assert.deepEqual(keys.slice().sort(), [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ].sort());
  if (keys.includes('com.apple.security.automation.apple-events')) {
    assert.match(readBuilderYml(), /NSAppleEventsUsageDescription/);
  }
});

test('operator 在没有公证凭据时默认关掉时间戳以免被 TSA 限流打断', () => {
  // Given 有/没有公证凭据与显式覆盖三种输入
  const notarizeEnv = { APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: '3H4FK5CBYJ' };
  // When 结算时间戳策略
  // Then 默认 --timestamp=none；公证凭据齐备或被显式要求时回到 osx-sign 默认
  assert.equal(sign.resolveTimestamp({}), 'none');
  assert.equal(sign.resolveTimestamp({ DSH_MAC_TIMESTAMP: 'none' }), 'none');
  assert.equal(sign.resolveTimestamp({ DSH_MAC_TIMESTAMP: 'default' }), undefined);
  assert.equal(sign.resolveTimestamp({ DSH_MAC_TIMESTAMP: 'http://tsa.example/ts' }), 'http://tsa.example/ts');
  assert.equal(sign.resolveTimestamp(notarizeEnv), undefined);
});

test('operator 的时间戳策略补齐每个被签文件且不动原有签名选项', () => {
  // Given 一个像 electron-builder 那样逐个文件给选项的 optionsForFile
  const opts = {
    app: '/tmp/DSH Trading.app',
    optionsForFile: (filePath) => ({ entitlements: '/tmp/entitlements.mac.plist', hardenedRuntime: true, filePath }),
  };
  // When 施加 --timestamp=none
  const patched = sign.applyTimestampPolicy(opts, 'none');
  const perFile = patched.optionsForFile('/tmp/DSH Trading.app/Contents/MacOS/x');
  // Then 原选项原样保留，只多出 timestamp；不需要改写时原对象直接返回
  assert.equal(perFile.entitlements, '/tmp/entitlements.mac.plist');
  assert.equal(perFile.hardenedRuntime, true);
  assert.equal(perFile.timestamp, 'none');
  assert.equal(patched.app, opts.app);
  assert.equal(sign.applyTimestampPolicy(opts, undefined), opts);
});
