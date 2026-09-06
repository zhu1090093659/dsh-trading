/**
 * @dshtrading/headlinearena —— 类型定义
 * Issue #66: Headline Arena 宏观研判外审与预测基准插件契约
 */

/** Headline Arena 本地存储中的单 Agent 凭据项 */
export interface HeadlineArenaAgentEntry {
  agent_id: string
  agent_name?: string | undefined
  client_secret?: string | undefined
  claim_url?: string | undefined
  pairing_code?: string | undefined
  status?: string | undefined
  token?: {
    access_token: string
    expires_at: number
  } | undefined
  challenge?: {
    challenge_id: string
    challenge_prompt: string
    submit_url?: string | undefined
  } | undefined
  [key: string]: unknown
}

/** 对应 ~/.headlinearena/credentials.json 按 origin 存储的结构 */
export interface HeadlineArenaOriginStore {
  _default_agent?: string | undefined
  _agents?: Record<string, HeadlineArenaAgentEntry> | undefined
  // 兼容早期扁平单 agent 结构
  agent_id?: string | undefined
  agent_name?: string | undefined
  client_secret?: string | undefined
  status?: string | undefined
  claim_url?: string | undefined
  pairing_code?: string | undefined
  token?: {
    access_token: string
    expires_at: number
  } | undefined
}

/** 完整的 ~/.headlinearena/credentials.json 文件结构 */
export interface HeadlineArenaStoreFile {
  _meta?: {
    last_version_check?: number | undefined
    [key: string]: unknown
  } | undefined
  [origin: string]: HeadlineArenaOriginStore | Record<string, unknown> | undefined
}

/** 预测挑战条目（金融市场或 Civic 指标） */
export interface Challenge {
  challenge_id: string
  track?: 'financial' | 'civic_forecast' | 'civic' | string | undefined
  asset?: string | undefined // 如 GC, CL, ES, ZN, BTC, CPI 等
  title?: string | undefined
  description?: string | undefined
  status?: 'open' | 'closed' | 'resolved' | string | undefined
  deadline?: string | undefined
  resolve_at?: string | undefined
  submit_hint?: string | undefined
  direction?: 'bullish' | 'bearish' | 'neutral' | string | undefined
  options?: string[] | undefined
  [key: string]: unknown
}

/** 提交预测入参 */
export interface SubmitPredictionInput {
  challenge_id: string
  direction: 'bullish' | 'bearish' | 'neutral'
  confidence: number // 0.0 ~ 1.0
  reasoning: string
  summary?: string | undefined
  dryRun?: boolean | undefined
}

/** 提交预测结果 */
export interface SubmitPredictionResult {
  ok: boolean
  dryRun?: boolean | undefined
  prediction_id?: string | undefined
  challenge_id: string
  direction: string
  confidence: number
  submitted_at: string
  message?: string | undefined
  raw_response?: unknown
}

/** 成绩单与校准指标 */
export interface AgentScorecard {
  agent_id: string
  agent_name?: string | undefined
  status?: string | undefined
  total_predictions: number
  resolved_predictions: number
  win_rate?: number | undefined
  brier_score?: number | undefined
  calibration_rating?: string | undefined
  public_profile_url?: string | undefined
  raw?: unknown
}

/** Agent 身份与激活状态 */
export interface AgentStatusResult {
  configured: boolean
  origin: string
  agent_id?: string | undefined
  agent_name?: string | undefined
  status?: string | undefined
  claimed?: boolean | undefined
  claim_url?: string | undefined
  pairing_code?: string | undefined
  credits?: number | undefined
  message?: string | undefined
}

/** 插件配置参数 */
export interface HeadlineArenaConfig {
  /** 是否启用插件功能（默认 false，需用户显式开启） */
  enabled?: boolean | undefined
  /** 是否开启模拟/只读保护模式（默认 true，不实际向远程写入预测） */
  dryRun?: boolean | undefined
  /** Headline Arena API Base Origin，默认 https://headlinearena.com */
  origin?: string | undefined
  /** 默认关注的大宗/宏观期货资产代号，如 ['GC', 'CL', 'ES', 'ZN', 'BTC'] */
  defaultAssets?: string[] | undefined
  /** 覆盖用的 Agent ID（缺省读取凭证文件中的 default agent） */
  agentId?: string | null | undefined
}
