import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_ORIGIN,
  loadCredentials,
  normalizeOrigin,
  readStoreFile,
  updateCachedToken,
  writeStoreFile,
} from '../src/store.ts'

describe('Headline Arena Store', () => {
  it('normalizeOrigin 应正确去除结尾斜杠与 /api/v1', () => {
    expect(normalizeOrigin()).toBe(DEFAULT_ORIGIN)
    expect(normalizeOrigin('https://headlinearena.com/')).toBe('https://headlinearena.com')
    expect(normalizeOrigin('https://headlinearena.com/api/v1')).toBe('https://headlinearena.com')
    expect(normalizeOrigin('https://headlinearena.com/api/v1/')).toBe('https://headlinearena.com')
  })

  it('读取不存在的文件应返回空对象而不抛错', () => {
    const fakePath = path.join(os.tmpdir(), `ha-test-non-exist-${Date.now()}.json`)
    expect(readStoreFile(fakePath)).toEqual({})
  })

  it('正确解析多 agent 结构与 default agent', () => {
    const tmpFile = path.join(os.tmpdir(), `ha-test-store-${Date.now()}.json`)
    const mockStore = {
      'https://headlinearena.com': {
        _default_agent: 'agent-123',
        _agents: {
          'agent-123': {
            agent_id: 'agent-123',
            agent_name: 'test-macro-bot',
            client_secret: 'sec-abc',
          },
          'agent-456': {
            agent_id: 'agent-456',
            agent_name: 'second-bot',
            client_secret: 'sec-def',
          },
        },
      },
    }
    writeStoreFile(mockStore, tmpFile)

    const credsDefault = loadCredentials({ filePath: tmpFile })
    expect(credsDefault?.agent_id).toBe('agent-123')
    expect(credsDefault?.agent_name).toBe('test-macro-bot')
    expect(credsDefault?.client_secret).toBe('sec-abc')

    const credsSpecific = loadCredentials({ filePath: tmpFile, agentId: 'agent-456' })
    expect(credsSpecific?.agent_id).toBe('agent-456')
    expect(credsSpecific?.client_secret).toBe('sec-def')

    // 清理
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  })

  it('旧版扁平 credentials 结构应能无缝解析并兼容', () => {
    const tmpFile = path.join(os.tmpdir(), `ha-test-flat-${Date.now()}.json`)
    const mockFlat = {
      'https://headlinearena.com': {
        agent_id: 'flat-agent-888',
        agent_name: 'legacy-bot',
        client_secret: 'legacy-sec',
        status: 'active',
      },
    }
    writeStoreFile(mockFlat, tmpFile)

    const creds = loadCredentials({ filePath: tmpFile })
    expect(creds?.agent_id).toBe('flat-agent-888')
    expect(creds?.client_secret).toBe('legacy-sec')
    expect(creds?.status).toBe('active')

    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  })

  it('updateCachedToken 应能正确持久化 token', () => {
    const tmpFile = path.join(os.tmpdir(), `ha-test-token-${Date.now()}.json`)
    updateCachedToken('agent-007', { access_token: 'tok-xyz', expires_at: 123456 }, { filePath: tmpFile })

    const creds = loadCredentials({ filePath: tmpFile, agentId: 'agent-007' })
    expect(creds?.agent_id).toBe('agent-007')
    expect(creds?.token?.access_token).toBe('tok-xyz')

    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  })
})
