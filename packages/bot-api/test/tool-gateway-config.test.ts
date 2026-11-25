/**
 * 外部工具调用网关配置与策略单元测试（BDD，零 mock）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPOSED_TOOL_FAMILIES,
  isHostAllowedByConfig,
  isOriginAllowedByConfig,
  isToolAllowedByPolicy,
  resolveToolGatewayConfig,
} from '../src/tool-gateway-config.ts'

describe('tool-gateway config and policy resolution', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-gw-cfg-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('operator: resolves layered config from defaults, rowConfig, config file, env, and overrides', () => {
    // Given defaults, Cordis rowConfig, tool-gateway.config.json, tokenFile, env vars, and programmatic overrides
    const tokenFilePath = join(dir, 'gateway.token')
    writeFileSync(tokenFilePath, '  file-secret-token-value  \n', 'utf8')
    writeFileSync(join(dir, 'tool-gateway.config.json'), JSON.stringify({
      host: '0.0.0.0',
      port: 9001,
      tokenFile: tokenFilePath,
      publicUrl: 'https://gw.example.com/',
      allowedHosts: ['gw.example.com', '*.internal.local'],
      allowedOrigins: ['https://ui.example.com'],
      extraFamilies: ['custom'],
      deniedFamilies: ['tasks'],
      deniedTools: ['cn_get_valuation'],
      mcpDefaultMode: 'flat',
      familyMeta: {
        custom: { label: '自定义研究工具', whenToUse: '运行内部因子脚本' },
      },
    }), 'utf8')

    // When resolving config with env override for port/timeout and programmatic override for readOnly
    const resolved = resolveToolGatewayConfig({
      dshHome: dir,
      rowConfig: { toolGateway: { enabled: true, port: 8800, token: 'row-token' } },
      env: {
        DSH_TRADING_TOOL_GATEWAY_PORT: '9100',
        DSH_TRADING_TOOL_GATEWAY_ALLOWED_PRESETS: 'master,research',
        DSH_TRADING_TOOL_GATEWAY_MAX_TIMEOUT_MS: '600000',
        DSH_TRADING_TOOL_GATEWAY_DEFAULT_TIMEOUT_MS: '15000',
      },
      overrides: { readOnly: true },
    })

    // Then higher layers win deterministically, tokenFile resolves cleanly, and familyMeta merges
    expect(resolved.enabled).toBe(true)
    expect(resolved.host).toBe('0.0.0.0')
    expect(resolved.port).toBe(9100)
    expect(resolved.publicUrl).toBe('https://gw.example.com')
    expect(resolved.token).toBe('file-secret-token-value')
    expect(resolved.tokenFile).toBe(tokenFilePath)
    expect(resolved.allowedPresets).toEqual(['master', 'research'])
    expect(resolved.mcpDefaultMode).toBe('flat')
    expect(resolved.defaultTimeoutMs).toBe(15_000)
    expect(resolved.maxTimeoutMs).toBe(600_000)
    expect(resolved.policy.readOnly).toBe(true)
    expect(resolved.policy.extraFamilies).toEqual(['custom'])
    expect(resolved.policy.deniedFamilies).toEqual(['tasks'])
    expect(resolved.policy.deniedTools).toEqual(['cn_get_valuation'])
    expect(resolved.familyMeta.custom).toEqual({ label: '自定义研究工具', whenToUse: '运行内部因子脚本' })
    expect(resolved.familyMeta.cn?.label).toBe('A 股行情与账户')
  })

  it('operator: rejects invalid config files, unreadable tokenFile, and invalid ports/modes fail-closed', () => {
    // Given broken JSON config, missing explicit config, empty tokenFile, invalid port, and invalid modes
    const brokenPath = join(dir, 'broken.json')
    writeFileSync(brokenPath, '{not-json', 'utf8')
    const emptyTokenPath = join(dir, 'empty.token')
    writeFileSync(emptyTokenPath, '   \n', 'utf8')

    // When resolving invalid configurations
    // Then every malformed security/runtime setting throws synchronously
    expect(() => resolveToolGatewayConfig({
      dshHome: dir,
      env: { DSH_TRADING_TOOL_GATEWAY_CONFIG: brokenPath },
    })).toThrow(/failed to parse config file/)

    expect(() => resolveToolGatewayConfig({
      dshHome: dir,
      env: { DSH_TRADING_TOOL_GATEWAY_CONFIG: join(dir, 'missing.json') },
    })).toThrow(/config file not found/)

    expect(() => resolveToolGatewayConfig({
      dshHome: dir,
      overrides: { tokenFile: emptyTokenPath },
    })).toThrow(/is empty/)

    expect(() => resolveToolGatewayConfig({
      dshHome: dir,
      overrides: { port: 70000 },
    })).toThrow(/port/)

    expect(() => resolveToolGatewayConfig({
      dshHome: dir,
      overrides: { exposeMode: 'wildcard' as never },
    })).toThrow(/exposeMode/)

    expect(() => resolveToolGatewayConfig({
      dshHome: dir,
      overrides: { mcpDefaultMode: 'stream' as never },
    })).toThrow(/mcpDefaultMode/)

    expect(() => resolveToolGatewayConfig({
      dshHome: dir,
      overrides: { defaultTimeoutMs: 50_000, maxTimeoutMs: 10_000 },
    })).toThrow(/defaultTimeoutMs/)
  })

  it('operator: enforces allowlist vs open exposure, glob filtering, readOnly guard, and hard internal deny list', () => {
    // Given allowlist+custom policy vs open+readOnly policy
    const allowlistPolicy = {
      exposeMode: 'allowlist' as const,
      allowedFamilies: [...DEFAULT_EXPOSED_TOOL_FAMILIES],
      extraFamilies: ['partner'],
      deniedFamilies: ['tasks'],
      allowedTools: ['cn_get_*', 'partner_*', 'bash'],
      deniedTools: ['cn_get_fundamentals'],
      readOnly: false,
    }
    const openReadOnlyPolicy = {
      exposeMode: 'open' as const,
      allowedFamilies: [...DEFAULT_EXPOSED_TOOL_FAMILIES],
      extraFamilies: [],
      deniedFamilies: [],
      deniedTools: [],
      readOnly: true,
    }

    // When evaluating internal, custom, read-only, and mutating tools under both policies
    // Then internal host tools stay blocked even in open/allowedTools mode, readOnly blocks mutations but permits read-only analysis
    expect(isToolAllowedByPolicy('cn_get_ticker', allowlistPolicy)).toBe(true)
    expect(isToolAllowedByPolicy('partner_signal', allowlistPolicy)).toBe(true)
    expect(isToolAllowedByPolicy('cn_get_fundamentals', allowlistPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('tasks_list', allowlistPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('bash', allowlistPolicy)).toBe(false)

    expect(isToolAllowedByPolicy('thirdparty_quote', openReadOnlyPolicy)).toBe(true)
    expect(isToolAllowedByPolicy('screener_run', openReadOnlyPolicy)).toBe(true)
    expect(isToolAllowedByPolicy('strategy_backtest', openReadOnlyPolicy)).toBe(true)
    expect(isToolAllowedByPolicy('holdings_add', openReadOnlyPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('tasks_run', openReadOnlyPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('knowledge_export', openReadOnlyPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('crypto_place_order', openReadOnlyPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('bash', openReadOnlyPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('researcher_subagent', openReadOnlyPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('trading_batch', openReadOnlyPolicy)).toBe(false)
    expect(isToolAllowedByPolicy('cordis_eval', openReadOnlyPolicy)).toBe(false)
  })

  it('operator: validates Host and Origin allowlists including wildcard bind fail-closed and IPv6', () => {
    // Given wildcard 0.0.0.0 without allowedHosts vs configured publicUrl + allowedHosts + allowedOrigins
    const unconfiguredWildcard = { host: '0.0.0.0', publicUrl: undefined, allowedHosts: undefined }
    const configuredRemote = {
      host: '0.0.0.0',
      publicUrl: 'https://trading.example.com:8443',
      allowedHosts: ['*.internal.corp', 'fd00::1'],
    }
    const originConfig = { allowedOrigins: ['https://app.example.com', '*.console.local'] }

    // When checking Host and Origin headers across loopback, authorized remote, and unauthorized hosts
    // Then wildcard bind rejects unconfigured remote Host headers fail-closed, while explicit hosts, IPv6, and CORS origins match accurately
    expect(isHostAllowedByConfig('127.0.0.1:8899', unconfiguredWildcard)).toBe(true)
    expect(isHostAllowedByConfig('evil.com:8899', unconfiguredWildcard)).toBe(false)

    expect(isHostAllowedByConfig('trading.example.com:8443', configuredRemote)).toBe(true)
    expect(isHostAllowedByConfig('agent.internal.corp:8899', configuredRemote)).toBe(true)
    expect(isHostAllowedByConfig('badinternal.corp:8899', configuredRemote)).toBe(false)
    expect(isHostAllowedByConfig('[fd00::1]:8899', configuredRemote)).toBe(true)

    expect(isOriginAllowedByConfig(undefined, originConfig)).toBe(true)
    expect(isOriginAllowedByConfig('http://localhost:3000', originConfig)).toBe(true)
    expect(isOriginAllowedByConfig('https://app.example.com', originConfig)).toBe(true)
    expect(isOriginAllowedByConfig('https://studio.console.local:5173', originConfig)).toBe(true)
    expect(isOriginAllowedByConfig('https://evil.example.com', originConfig)).toBe(false)
  })
})
