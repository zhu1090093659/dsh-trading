/**
 * 桌面壳的设备凭据（P4 步骤 5 的接线前置）——**纯 CJS、无第三方依赖**，配合 attach-mode 使用。
 *
 * 为什么必须有自己的凭据：远端 bot 的 %%/v1%% 面要求 Bearer 设备令牌。桌面壳"把窗口指到 botUrl"
 * 并不够 —— 没有凭据只能打开一个未授权页面。
 *
 * 三条立场：
 *   1. **凭据与地址绑定**：密钥只在它配对时用的那个 bot 地址上使用。换了地址（哪怕只是端口不同）
 *      一律不外发 —— 否则一次配置改错就把设备密钥交给了另一个 host。
 *   2. **落盘 0600**：写 %%%%<DSH_HOME>/attach-device.json%% ，权限 0600（仅属主可读写）。移动端有
 *      Keychain，桌面端没有等价物，就退而求其次：限制权限 + 与地址绑定 + 随时可撤销（forget）。
 *   3. **401 即失效**：被 revoke 后继续拿旧密钥重试是最糟的状态（看起来在跑、每条请求都被拒），
 *      所以 %%forget()%% 是显式动作，调用方在收到 401 时用它回到未配对。
 *
 * @module desktop/device-credential
 */
const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const CREDENTIAL_FILE = 'attach-device.json'

/** 去掉地址尾斜杠，作为"凭据归属"的比较键。 */
function normalizeBaseUrl(url) {
  return String(url).trim().replace(/\/+$/, '')
}

/**
 * 建一个设备凭据句柄。
 * @param {{ home: string, fetchImpl?: typeof fetch }} options - home 目录（凭据落盘处）与可注入的 fetch。
 */
function createDeviceCredential(options) {
  const file = join(options.home, CREDENTIAL_FILE)
  const doFetch = options.fetchImpl ?? globalThis.fetch

  function load() {
    if (!existsSync(file)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return undefined
      if (typeof parsed.botUrl !== 'string' || typeof parsed.deviceId !== 'string' || typeof parsed.secret !== 'string') return undefined
      return parsed
    } catch {
      // 凭据文件坏了 ⇒ 当作未配对（宁可重新配对，也不要拿半个凭据去请求）
      return undefined
    }
  }

  return {
    load,
    /**
     * 用一次性配对码兑换设备凭据并落盘（0600）。
     * @returns {Promise<{ ok: true, deviceId: string } | { ok: false, code: string, message: string }>}
     */
    async pair(input) {
      const baseUrl = normalizeBaseUrl(input.baseUrl)
      let response
      try {
        response = await doFetch(baseUrl + '/pair/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: input.code, name: input.name ?? 'dsh-trading desktop' }),
        })
      } catch (error) {
        return { ok: false, code: 'PAIR_UNREACHABLE', message: '无法连接 bot：' + (error instanceof Error ? error.message : String(error)) }
      }
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        return {
          ok: false,
          code: typeof payload.code === 'string' ? payload.code : 'PAIR_FAILED',
          message: response.status === 429 ? '尝试过于频繁，请稍后再试' : '配对失败：' + String(payload.code ?? response.status),
        }
      }
      if (typeof payload.deviceId !== 'string' || typeof payload.secret !== 'string') {
        return { ok: false, code: 'PAIR_BAD_RESPONSE', message: 'bot 返回的配对响应缺少设备凭据' }
      }
      mkdirSync(options.home, { recursive: true })
      writeFileSync(file, JSON.stringify({ botUrl: baseUrl, deviceId: payload.deviceId, secret: payload.secret }), { mode: 0o600 })
      // writeFileSync 的 mode 受 umask 影响，显式再 chmod 一次以确保 0600
      chmodSync(file, 0o600)
      return { ok: true, deviceId: payload.deviceId }
    },
    /**
     * 取该地址可用的 Authorization 头；**地址不匹配或未配对时返回 undefined**。
     */
    authorization(baseUrl) {
      const stored = load()
      if (stored === undefined) return undefined
      if (stored.botUrl !== normalizeBaseUrl(baseUrl)) return undefined
      return 'Bearer ' + stored.deviceId + '.' + stored.secret
    },
    /** 忘记凭据（收到 401 或用户主动解绑时调用）。 */
    forget() {
      rmSync(file, { force: true })
    },
  }
}

module.exports = { createDeviceCredential, normalizeBaseUrl, CREDENTIAL_FILE }
