/**
 * 桌面壳附着模式决策（P4 步骤 5）——**纯函数，无副作用、无 IO、不探测端口**。
 *
 * 卡片要求：配了 bot 的机器默认**不再起本地 host**（把现有 handoff 扩到远端 bot URL）；没配 bot 时保持现状。
 *
 * 为什么是"显式配置驱动"而不是"探测"：main.cjs 头部记录过一次**已发布**的 bug ——
 * 探测 3080 端口时撞上了一个普通 web GUI，桌面壳于是把用户自己的 DSH Web 打开了。
 * 探测无法分辨"已在跑的实例服务的是哪个 profile"，所以本模块**只认配置**：
 *   有配置 ⇒ attach；没有 ⇒ 照旧起本地 host；配置不合法/不是内网 ⇒ **回落本地并说明原因**（fail-closed）。
 *
 * @module desktop/attach-mode
 */

/** 回环与私有网段（IPv4 私有三段 + 链路本地 + IPv6 回环/ULA/link-local）与常见内网域名后缀。 */
function isPrivateOrLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6：ULA fc00::/7 与 link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  return false;
}

/**
 * 决定桌面壳该起本地 host 还是附着到远端 bot。
 * @param {{ botUrl?: string | undefined }} options - %%botUrl%% 来自显式配置（例如 settings 里的 botUrl 字段或环境变量）。
 * @returns {{ mode: 'local' | 'attach', url?: string, reason: string }}
 */
function resolveHostMode(options) {
  const raw = typeof options.botUrl === 'string' ? options.botUrl.trim() : '';
  if (raw === '') return { mode: 'local', reason: '未配置 bot：保持现状（起本地 host）' };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { mode: 'local', reason: 'bot 配置不是合法 URL：回落本地 host（fail-closed）' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { mode: 'local', reason: 'bot 配置协议不受支持（只接受 http/https）：回落本地 host' };
  }
  if (!isPrivateOrLoopbackHost(parsed.hostname)) {
    // 卡片前提是"仅内网可达"：公网地址不下手，宁可本地起一个也不要把执行核的会话交到公网上
    return { mode: 'local', reason: 'bot 地址不是内网/回环：回落本地 host（本系统只承诺内网可达）' };
  }
  const url = parsed.toString().replace(/\/$/, '');
  return { mode: 'attach', url, reason: '已配置内网 bot：附着，不再起本地 host' };
}

module.exports = { resolveHostMode, isPrivateOrLoopbackHost };
