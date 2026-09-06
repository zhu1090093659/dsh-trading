/**
 * @dshtrading/headlinearena —— 本地凭据存取模块
 * Issue #66 & 铁律 #5：不内置密钥，凭据由用户本地持有 (~/.headlinearena/credentials.json)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  HeadlineArenaAgentEntry,
  HeadlineArenaOriginStore,
  HeadlineArenaStoreFile,
} from './types.ts'

export const DEFAULT_ORIGIN = 'https://headlinearena.com'

/** 获取凭据目录：优先读取 HA_HOME，否则使用 ~/.headlinearena */
export function getCredentialsDir(): string {
  const customHome = process.env.HA_HOME
  if (customHome && customHome.trim()) {
    return path.resolve(customHome.trim())
  }
  return path.join(os.homedir(), '.headlinearena')
}

/** 获取凭据文件绝对路径 */
export function getCredentialsFilePath(): string {
  return path.join(getCredentialsDir(), 'credentials.json')
}

/** 规范化 origin（去除尾部斜杠与 /api/v1 路径） */
export function normalizeOrigin(raw?: string | undefined): string {
  if (!raw || !raw.trim()) return DEFAULT_ORIGIN
  let norm = raw.trim().replace(/\/+$/, '')
  if (norm.endsWith('/api/v1')) {
    norm = norm.slice(0, -'/api/v1'.length)
  }
  return norm
}

/** 读取整个 credentials.json 文件，失败或不存在返回空对象 */
export function readStoreFile(filePath = getCredentialsFilePath()): HeadlineArenaStoreFile {
  try {
    if (!fs.existsSync(filePath)) return {}
    const text = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(text) as HeadlineArenaStoreFile
  } catch {
    return {}
  }
}

/** 将凭证存入文件 */
export function writeStoreFile(store: HeadlineArenaStoreFile, filePath = getCredentialsFilePath()): void {
  try {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 })
  } catch {
    // 忽略写入失败（例如沙箱只读环境），仅作尽力持久化
  }
}

/**
 * 迁移与规范化 origin 节点（如果旧版为扁平格式，迁移至 _agents 结构）
 */
function normalizeOriginStore(storeNode: unknown): HeadlineArenaOriginStore {
  if (!storeNode || typeof storeNode !== 'object') {
    return {}
  }
  const org = storeNode as HeadlineArenaOriginStore
  if (org._agents && typeof org._agents === 'object') {
    return org
  }

  // 扁平结构迁移
  if (org.agent_id) {
    const defaultId = org.agent_id
    const entry: HeadlineArenaAgentEntry = {
      agent_id: defaultId,
      agent_name: org.agent_name,
      client_secret: org.client_secret,
      status: org.status,
      claim_url: org.claim_url,
      pairing_code: org.pairing_code,
      token: org.token,
    }
    return {
      _default_agent: defaultId,
      _agents: {
        [defaultId]: entry,
      },
    }
  }

  return {
    _agents: {},
  }
}

/**
 * 解析并加载当前生效的 Agent 凭证
 * 优先级：
 * 1. 环境变量 HA_AGENT_ID + HA_CLIENT_SECRET
 * 2. 凭据文件 (~/.headlinearena/credentials.json)
 */
export function loadCredentials(
  options?: { origin?: string | undefined; agentId?: string | undefined; filePath?: string | undefined } | undefined
): HeadlineArenaAgentEntry | null {
  const origin = normalizeOrigin(options?.origin || process.env.HA_BASE_URL)
  const envAgentId = options?.agentId || process.env.HA_AGENT_ID
  const envSecret = process.env.HA_CLIENT_SECRET

  // 如果环境变量显式提供了两者
  if (envAgentId && envSecret) {
    return {
      agent_id: envAgentId,
      client_secret: envSecret,
    }
  }

  const store = readStoreFile(options?.filePath)
  const orgRaw = store[origin]
  const org = normalizeOriginStore(orgRaw)

  const targetId = envAgentId || org._default_agent
  if (targetId && org._agents?.[targetId]) {
    const entry = org._agents[targetId]
    // 允许环境变量覆盖 secret
    if (envSecret) {
      return { ...entry, client_secret: envSecret }
    }
    return entry
  }

  // 如果文件里是单 agent 扁平老格式
  if (org.agent_id && (org.agent_id === targetId || !targetId)) {
    return {
      agent_id: org.agent_id,
      agent_name: org.agent_name,
      client_secret: envSecret || org.client_secret,
      claim_url: org.claim_url,
      pairing_code: org.pairing_code,
      status: org.status,
      token: org.token,
    }
  }

  // 仅有 envAgentId 缺少 secret
  if (envAgentId) {
    return {
      agent_id: envAgentId,
    }
  }

  return null
}

/**
 * 更新或缓存某个 Agent 的 Token
 */
export function updateCachedToken(
  agentId: string,
  token: { access_token: string; expires_at: number },
  options?: { origin?: string | undefined; filePath?: string | undefined } | undefined
): void {
  const origin = normalizeOrigin(options?.origin || process.env.HA_BASE_URL)
  const store = readStoreFile(options?.filePath)
  const org = normalizeOriginStore(store[origin])

  if (!org._agents) {
    org._agents = {}
  }
  const entry = org._agents[agentId] || { agent_id: agentId }
  entry.token = token
  org._agents[agentId] = entry
  if (!org._default_agent) {
    org._default_agent = agentId
  }

  store[origin] = org
  writeStoreFile(store, options?.filePath)
}
