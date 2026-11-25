/**
 * 跨平台系统代理探测、URL 校验/脱敏、CIDR/通配符绕过匹配与策略裁决单测。
 */
import { describe, expect, it } from 'vitest'
import {
  bypassesProxy,
  captureLaunchProxyEnv,
  detectSystemProxy,
  isLoopbackHost,
  isSocksProxyUrl,
  mergeNoProxy,
  normalizeProxyMode,
  normalizeProxyUrlForUndici,
  parseGsettingsProxy,
  parseKdeKioslavercProxy,
  parseMacScutilProxy,
  parseWindowsRegProxy,
  proxyForUrl,
  redactProxyUrl,
  resolveEffectiveProxyPolicy,
  validateProxyUrl,
} from '../src/system-proxy.ts'

describe('proxy URL 校验、规范化与凭据脱敏', () => {
  it('用户：normalizeProxyMode 把非法或缺省值归一为 system，合法枚举原样保留', () => {
    // Given: 缺失、非法字符串与三种合法模式
    // When: 归一化模式值
    // Then: 只有 system/custom/direct 保留，其余回落 system
    expect(normalizeProxyMode(undefined)).toBe('system')
    expect(normalizeProxyMode('invalid')).toBe('system')
    expect(normalizeProxyMode('system')).toBe('system')
    expect(normalizeProxyMode('custom')).toBe('custom')
    expect(normalizeProxyMode('direct')).toBe('direct')
  })

  it('用户：validateProxyUrl 接受 http/https/socks5/socks5h，拒绝 socks4 与空串且不回显密码', () => {
    // Given: 各类合法与非法代理 URL
    // When: 调用 validateProxyUrl
    const okHttp = validateProxyUrl(' http://127.0.0.1:7890 ')
    const okSocks5h = validateProxyUrl('socks5h://user:s3cret@127.0.0.1:1080')
    const badEmpty = validateProxyUrl('   ')
    const badSocks4 = validateProxyUrl('socks4://alice:pass@127.0.0.1:1080')
    const badScheme = validateProxyUrl('ftp://proxy.local:21')
    const badMissingHost = validateProxyUrl('http://:7890')
    // Then: 合法 URL 去空白通过；非法输入失败且诊断消息绝不含明文密码
    expect(okHttp).toEqual({ ok: true, value: 'http://127.0.0.1:7890' })
    expect(okSocks5h).toEqual({ ok: true, value: 'socks5h://user:s3cret@127.0.0.1:1080' })
    expect(badEmpty.ok).toBe(false)
    expect(badSocks4.ok).toBe(false)
    if (!badSocks4.ok) {
      expect(badSocks4.kind).toBe('socks4')
      expect(badSocks4.message).not.toContain('s3cret')
      expect(badSocks4.message).not.toContain('pass')
    }
    expect(badScheme.ok).toBe(false)
    expect(badMissingHost.ok).toBe(false)
  })

  it('用户：normalizeProxyUrlForUndici 将 socks5h 转为 socks5 并保留认证与 IPv6 地址，redactProxyUrl 脱敏凭据', () => {
    // Given: 带凭据与 IPv6 的 socks5h/http 代理地址
    // When: 规范化并脱敏
    // Then: socks5h 变为 socks5；密码与用户名被替换为 ***
    expect(normalizeProxyUrlForUndici('socks5h://alice:pw@127.0.0.1:1080')).toBe('socks5://alice:pw@127.0.0.1:1080')
    expect(normalizeProxyUrlForUndici('http://[::1]:7890')).toBe('http://[::1]:7890')
    expect(isSocksProxyUrl('socks5h://127.0.0.1:1080')).toBe(true)
    expect(isSocksProxyUrl('http://127.0.0.1:7890')).toBe(false)
    expect(redactProxyUrl('http://alice:secret@proxy.example:8080')).toBe('http://***@proxy.example:8080')
    expect(redactProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(redactProxyUrl('  ')).toBeUndefined()
  })
})

describe('Loopback 与 NO_PROXY 绕过匹配', () => {
  it('用户：回环地址（127.0.0.0/8、localhost、::1、::ffff:127.0.0.1）始终绕过代理', () => {
    // Given: 指向本机的各类回环 URL
    // When: 检查 isLoopbackHost 与 bypassesProxy
    // Then: 全部判定为回环并绕过
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('api.localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.2')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('[::ffff:127.0.0.1]')).toBe(true)
    expect(isLoopbackHost('api.okx.com')).toBe(false)
    expect(bypassesProxy('', new URL('http://127.0.0.5:8888/api'))).toBe(true)
    expect(bypassesProxy('', new URL('http://[::ffff:127.0.0.1]:3080/'))).toBe(true)
  })

  it('用户：bypassesProxy 支持 CIDR、IPv4 通配符、<local>、域名后缀、端口与 *', () => {
    // Given: 含操作系统常见绕过规则的 NO_PROXY 串
    const noProxy = mergeNoProxy('10.0.0.0/8; 192.168.*, *.corp.example.com, api.test.com:8443, <local>')
    // When/Then: 对应目标绕过，公网与不匹配端口不绕过
    expect(noProxy).toContain('localhost')
    expect(bypassesProxy(noProxy, new URL('http://10.20.30.40/health'))).toBe(true)
    expect(bypassesProxy(noProxy, new URL('http://192.168.31.50:8080/'))).toBe(true)
    expect(bypassesProxy(noProxy, new URL('https://sub.corp.example.com/v1'))).toBe(true)
    expect(bypassesProxy(noProxy, new URL('https://api.test.com:8443/v1'))).toBe(true)
    expect(bypassesProxy(noProxy, new URL('https://api.test.com:443/v1'))).toBe(false)
    expect(bypassesProxy(noProxy, new URL('http://intranet:3000/'))).toBe(true)
    expect(bypassesProxy(noProxy, new URL('https://api.binance.com/api/v3/ping'))).toBe(false)
    expect(bypassesProxy('*', new URL('https://api.binance.com/'))).toBe(true)
    expect(mergeNoProxy('a.com, *')).toBe('*')
  })

  it('用户：proxyForUrl 对命中绕过的地址返回 undefined，其余按协议返回代理', () => {
    // Given: 双协议代理策略
    const policy = {
      mode: 'system' as const,
      source: 'env' as const,
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7891',
      noProxy: mergeNoProxy('192.168.0.0/16'),
      diagnostics: [],
    }
    // When/Then: HTTPS/HTTP 走各自槽位，回环与内网 CIDR 返回 undefined
    expect(proxyForUrl(policy, new URL('https://api.okx.com/'))).toBe('http://127.0.0.1:7891')
    expect(proxyForUrl(policy, new URL('http://example.com/'))).toBe('http://127.0.0.1:7890')
    expect(proxyForUrl(policy, new URL('http://192.168.1.10/'))).toBeUndefined()
    expect(proxyForUrl(policy, new URL('ws://api.okx.com/'))).toBeUndefined()
  })
})

describe('跨平台系统代理读取', () => {
  it('用户：macOS scutil --proxy 解析 HTTP/HTTPS、ExceptionsList 与 ExcludeSimpleHostnames', () => {
    // Given: macOS scutil --proxy 典型输出（HTTPSProxy 在 macOS 下也是 HTTP CONNECT 代理）
    const scutilOut = [
      '<dictionary> {',
      '  ExceptionsList : <array> {',
      '    0 : *.local',
      '    1 : 169.254/16',
      '  }',
      '  ExcludeSimpleHostnames : 1',
      '  HTTPEnable : 1',
      '  HTTPPort : 7890',
      '  HTTPProxy : 127.0.0.1',
      '  HTTPSEnable : 1',
      '  HTTPSPort : 7890',
      '  HTTPSProxy : 127.0.0.1',
      '  SOCKSEnable : 1',
      '  SOCKSPort : 7891',
      '  SOCKSProxy : 127.0.0.1',
      '}',
    ].join('\n')
    // When: 解析输出
    const parsed = parseMacScutilProxy(scutilOut)
    // Then: 优先使用 HTTP CONNECT 代理并保留绕过列表与 <local>
    expect(parsed).toEqual({
      source: 'macos-scutil',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: '*.local,169.254/16,<local>',
    })
  })

  it('用户：macOS scutil 仅开启 SOCKS 时解析为 socks5://，Windows 注册表解析单地址与分协议格式', () => {
    // Given: macOS 仅 SOCKS 输出与 Windows 两种 reg query 输出
    const macSocks = [
      '<dictionary> {',
      '  SOCKSEnable : 1',
      '  SOCKSPort : 1080',
      '  SOCKSProxy : ::1',
      '}',
    ].join('\n')
    const winSingle = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:7890',
      '    ProxyOverride    REG_SZ    localhost;127.*;192.168.*;<local>',
    ].join('\n')
    const winMulti = [
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080',
    ].join('\n')
    const winDisabled = '    ProxyEnable    REG_DWORD    0x0\n    AutoConfigURL    REG_SZ    http://pac.local/p.pac'
    // When/Then: 分别准确识别协议与开关态
    expect(parseMacScutilProxy(macSocks)).toEqual({
      source: 'macos-scutil',
      httpProxy: 'socks5://[::1]:1080',
      httpsProxy: 'socks5://[::1]:1080',
    })
    expect(parseWindowsRegProxy(winSingle)).toEqual({
      source: 'windows-registry',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: 'localhost,127.*,192.168.*,<local>',
    })
    expect(parseWindowsRegProxy(winMulti)).toEqual({
      source: 'windows-registry',
      httpProxy: 'http://127.0.0.1:8080',
      httpsProxy: 'http://127.0.0.1:8443',
    })
    expect(parseWindowsRegProxy(winDisabled)).toEqual({
      source: 'none',
      pacUrl: 'http://pac.local/p.pac',
    })
  })

  it('用户：Linux GNOME gsettings 与 KDE kioslaverc 解析手工代理和 PAC', () => {
    // Given: GNOME 手工代理与 KDE kioslaverc 文本
    const gnome = parseGsettingsProxy({
      mode: "'manual'",
      httpHost: "'127.0.0.1'",
      httpPort: '7890',
      httpAuth: 'true',
      httpUser: "'u1'",
      httpPass: "'p@1'",
      httpsHost: "'127.0.0.1'",
      httpsPort: '7890',
      ignoreHosts: "['localhost', '127.0.0.0/8']",
    })
    const kde = parseKdeKioslavercProxy([
      '[Proxy Settings]',
      'ProxyType=1',
      'httpProxy=http://127.0.0.1 7890',
      'httpsProxy=http://127.0.0.1 7890',
      'NoProxyFor=localhost,192.168.0.0/16',
    ].join('\n'))
    const gnomePac = parseGsettingsProxy({ mode: "'auto'", autoconfigUrl: "'http://127.0.0.1/proxy.pac'" })
    // When/Then: 分别返回 linux-gsettings、linux-kde 与 PAC 提示
    expect(gnome).toEqual({
      source: 'linux-gsettings',
      httpProxy: 'http://u1:p%401@127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: 'localhost,127.0.0.0/8',
    })
    expect(kde).toEqual({
      source: 'linux-kde',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: 'localhost,192.168.0.0/16',
    })
    expect(gnomePac).toEqual({ source: 'none', pacUrl: 'http://127.0.0.1/proxy.pac' })
  })

  it('用户：detectSystemProxy 注入探测失败时回落 desktopHint，不抛异常', () => {
    // Given: 命令行探测器抛错，但 Electron 桌面壳提供了 PAC 解析 hint
    const detected = detectSystemProxy({
      platform: 'linux',
      execFile: () => { throw new Error('gsettings not installed') },
      readFile: () => undefined,
      desktopHint: { source: 'desktop-system', httpsProxy: 'http://127.0.0.1:7890' },
    })
    // When/Then: 平滑回落到 desktopHint
    expect(detected).toEqual({
      source: 'desktop-system',
      httpsProxy: 'http://127.0.0.1:7890',
    })
  })
})

describe('有效代理策略裁决（系统代理默认、环境变量优先、自定义与直连覆盖）', () => {
  it('用户：默认 system 模式下未设 shell env 时使用系统代理，桌面注入变量不粘死刷新', () => {
    // Given: Electron 注入系统代理 env，随后 OS 系统代理切换了端口
    const launch = captureLaunchProxyEnv({
      DSH_TRADING_INJECTED_SYSTEM_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      DSH_TRADING_DESKTOP_SYSTEM_PROXY_HTTPS: 'http://127.0.0.1:7890',
    })
    // When: OS 系统代理更新到 7899
    const policy = resolveEffectiveProxyPolicy(
      {},
      launch,
      { source: 'macos-scutil', httpProxy: 'http://127.0.0.1:7899', httpsProxy: 'http://127.0.0.1:7899' },
    )
    // Then: 桌面注入标记被识别，立刻跟进新系统代理 7899
    expect(policy.mode).toBe('system')
    expect(policy.source).toBe('macos-scutil')
    expect(policy.httpsProxy).toBe('http://127.0.0.1:7899')
    expect(policy.noProxy).toContain('127.0.0.1')
  })

  it('用户：CLI 显式导出的环境变量优先于 OS 系统代理；direct 与 custom 覆盖环境变量与系统代理', () => {
    // Given: 显式环境变量 + OS 系统代理并存
    const launch = captureLaunchProxyEnv({
      https_proxy: 'http://127.0.0.1:8888',
      no_proxy: '.corp.internal',
    })
    const osSys = { source: 'macos-scutil' as const, httpProxy: 'http://127.0.0.1:7890', httpsProxy: 'http://127.0.0.1:7890' }
    // When: 分别解析 system / custom / direct 模式
    const sysPolicy = resolveEffectiveProxyPolicy({ mode: 'system', noProxy: '.my-exchange.com' }, launch, osSys)
    const customPolicy = resolveEffectiveProxyPolicy({ mode: 'custom', url: 'socks5h://127.0.0.1:1080' }, launch, osSys)
    const directPolicy = resolveEffectiveProxyPolicy({ mode: 'direct' }, launch, osSys)
    // Then: system 走显式 env 并合并 noProxy；custom 走 socks5h；direct 彻底关闭代理
    expect(sysPolicy.source).toBe('env')
    expect(sysPolicy.httpsProxy).toBe('http://127.0.0.1:8888')
    expect(sysPolicy.noProxy).toContain('.corp.internal')
    expect(sysPolicy.noProxy).toContain('.my-exchange.com')
    expect(customPolicy).toMatchObject({
      mode: 'custom',
      source: 'custom',
      httpProxy: 'socks5h://127.0.0.1:1080',
      httpsProxy: 'socks5h://127.0.0.1:1080',
    })
    expect(directPolicy).toMatchObject({ mode: 'direct', source: 'direct' })
    expect(directPolicy.httpProxy).toBeUndefined()
    expect(directPolicy.httpsProxy).toBeUndefined()
  })
})
