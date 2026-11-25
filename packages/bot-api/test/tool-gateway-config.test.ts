/**
 * 外部工具调用网关配置与策略单元测试（BDD，零 mock）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPOSED_TOOL_FAMILIES,
  DEFAULT_TRADING_PRESETS,
  isHostAllowedByConfig,
  isMutatingToolName,
  isOriginAllowedByConfig,
  isToolAllowedByPolicy,
  resolveToolGatewayConfig,
} from '../src/tool-gateway-config.ts'
import { isLiveActionBlocked } from '../src/tool-gateway.ts'

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

  it('operator: blocks all DSH host shell/fs/subagent/code-exec tools in open+readOnly mode and scopes default presets', () => {
    // Given an open+readOnly config with default allowedPresets vs explicit ['*'] wildcard opt-in
    const openDefault = resolveToolGatewayConfig({
      dshHome: dir,
      env: {},
      overrides: { exposeMode: 'open', readOnly: true },
    })
    const openWildcard = resolveToolGatewayConfig({
      dshHome: dir,
      env: {},
      overrides: { exposeMode: 'open', allowedPresets: ['*'] },
    })

    // When testing every high-risk DSH host tool, mixed-case live actions, and default preset boundary
    const hostDangerTools = [
      'apply_patch', 'pwsh', 'subagent', 'subagent_fork', 'workflow', 'run_code',
      'plugin_manager', 'plugin_market', 'grep', 'glob', 'terminal_open', 'terminal_send',
      'user_terminal_exec', 'session_send_message', 'schedule_create', 'str_replace_editor',
      'list_subagent_models', 'wait_agent', 'send_message', 'web_fetch', 'web_search',
      'office_edit', 'enter_worktree', 'ask_user_question', 'todo_write',
    ]

    // Then all host internal tools are rejected, live/mutating checks are case-insensitive, and open mode defaults allowedPresets to trading roles
    for (const toolName of hostDangerTools) {
      expect(isToolAllowedByPolicy(toolName, openDefault.policy), toolName).toBe(false)
    }
    expect(isMutatingToolName('APPLY_PATCH')).toBe(true)
    expect(isMutatingToolName('partner_edit')).toBe(true)
    expect(isLiveActionBlocked(' CRYPTO_PLACE_ORDER ', { dryRun: false })).toBe(true)
    expect(isLiveActionBlocked('CN_CANCEL_ORDER', {})).toBe(true)
    expect(openDefault.allowedPresets).toEqual(['master', ...DEFAULT_TRADING_PRESETS.filter(p => p !== 'master')])
    expect(openWildcard.allowedPresets).toBeUndefined()
  })

  it('operator: disables descriptor for false/null/off/0 env values, parses all env flags, and rejects unknown config keys/types', () => {
    // Given env disable literals for descriptorPath, full env flag matrix, and invalid config/env cases
    for (const literal of ['false', 'null', 'none', 'off', '0', 'FALSE']) {
      const disabled = resolveToolGatewayConfig({
        dshHome: dir,
        env: { DSH_TRADING_TOOL_GATEWAY_DESCRIPTOR: literal },
      })
      expect(disabled.descriptorPath, literal).toBeNull()
    }

    const fromEnv = resolveToolGatewayConfig({
      dshHome: dir,
      env: {
        DSH_TRADING_TOOL_GATEWAY: 'off',
        DSH_TRADING_TOOL_GATEWAY_HOST: '127.0.0.1',
        DSH_TRADING_TOOL_GATEWAY_PORT: '8899',
        DSH_TRADING_TOOL_GATEWAY_TOKEN: 'env-token-value',
        DSH_TRADING_TOOL_GATEWAY_ALLOWED_HOSTS: 'a.local,*.b.local',
        DSH_TRADING_TOOL_GATEWAY_ALLOWED_ORIGINS: 'https://a.local',
        DSH_TRADING_TOOL_GATEWAY_PRESET: 'trader',
        DSH_TRADING_TOOL_GATEWAY_EXPOSE_MODE: 'open',
        DSH_TRADING_TOOL_GATEWAY_ALLOWED_FAMILIES: 'cn,us',
        DSH_TRADING_TOOL_GATEWAY_EXTRA_FAMILIES: 'custom',
        DSH_TRADING_TOOL_GATEWAY_DENIED_FAMILIES: 'tasks',
        DSH_TRADING_TOOL_GATEWAY_ALLOWED_TOOLS: 'cn_*',
        DSH_TRADING_TOOL_GATEWAY_DENIED_TOOLS: 'cn_place_order',
        DSH_TRADING_TOOL_GATEWAY_READ_ONLY: 'yes',
        DSH_TRADING_TOOL_GATEWAY_MAX_BODY_BYTES: '65536',
        DSH_TRADING_TOOL_GATEWAY_MCP: 'false',
        DSH_TRADING_TOOL_GATEWAY_MCP_MODE: 'flat',
      },
    })

    const typoConfig = join(dir, 'typo.json')
    writeFileSync(typoConfig, JSON.stringify({ allowHosts: ['example.com'] }), 'utf8')

    // When validating env parsing and malformed/typo config inputs
    // Then env values parse accurately and unknown keys, bad bool/int envs, and non-string host/preset fail closed
    expect(fromEnv.enabled).toBe(false)
    expect(fromEnv.mcpEnabled).toBe(false)
    expect(fromEnv.maxBodyBytes).toBe(65536)
    expect(fromEnv.policy.readOnly).toBe(true)
    expect(fromEnv.policy.allowedTools).toEqual(['cn_*'])
    expect(() => resolveToolGatewayConfig({ dshHome: dir, env: { DSH_TRADING_TOOL_GATEWAY_CONFIG: typoConfig } })).toThrow(/unknown config key/)
    expect(() => resolveToolGatewayConfig({ dshHome: dir, env: { DSH_TRADING_TOOL_GATEWAY_READ_ONLY: 'maybe' } })).toThrow(/invalid boolean env/)
    expect(() => resolveToolGatewayConfig({ dshHome: dir, env: { DSH_TRADING_TOOL_GATEWAY_PORT: 'not-int' } })).toThrow(/invalid integer env/)
    expect(() => resolveToolGatewayConfig({ dshHome: dir, env: {}, overrides: { host: 123 as never } })).toThrow(/must be a string/)
    expect(() => resolveToolGatewayConfig({ dshHome: dir, env: {}, overrides: { defaultPreset: 42 as never } })).toThrow(/must be a string/)
    expect(() => resolveToolGatewayConfig({ dshHome: dir, env: {}, overrides: { publicUrl: 'ftp://bad' } })).toThrow(/http: or https:/)
    expect(() => resolveToolGatewayConfig({ dshHome: dir, env: {}, overrides: { maxBodyBytes: 10 } })).toThrow(/maxBodyBytes/)
    expect(() => resolveToolGatewayConfig({ dshHome: dir, env: {}, overrides: { allowedFamilies: 'cn' as never } })).toThrow(/array of strings/)
  })
})
