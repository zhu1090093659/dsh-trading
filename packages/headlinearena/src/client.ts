/**
 * @dshtrading/headlinearena —— REST API 客户端
 * Issue #66: 负责与 Headline Arena 平台进行通信（Token 认证、挑战发现、预测镜像、成绩单查询）
 */

import type {
  AgentScorecard,
  AgentStatusResult,
  Challenge,
  HeadlineArenaAgentEntry,
  SubmitPredictionInput,
  SubmitPredictionResult,
} from './types.ts'
import { normalizeOrigin, updateCachedToken } from './store.ts'

export interface HeadlineArenaClientOptions {
  origin?: string | undefined
  creds?: HeadlineArenaAgentEntry | null | undefined
  fetchFn?: typeof fetch | undefined
  timeoutMs?: number | undefined
}

export class HeadlineArenaClient {
  public readonly origin: string
  private creds: HeadlineArenaAgentEntry | null
  private fetchFn: typeof fetch
  private timeoutMs: number

  constructor(options?: HeadlineArenaClientOptions | undefined) {
    this.origin = normalizeOrigin(options?.origin || process.env.HA_BASE_URL)
    this.creds = options?.creds || null
    this.fetchFn = options?.fetchFn || globalThis.fetch
    this.timeoutMs = options?.timeoutMs || 15_000
  }

  /** 获取当前配置的凭证 */
  getCredentials(): HeadlineArenaAgentEntry | null {
    return this.creds
  }

  /** 更新凭据 */
  setCredentials(creds: HeadlineArenaAgentEntry | null): void {
    this.creds = creds
  }

  /** 构造完整的 API v1 端点 URL */
  private api(path: string): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    return `${this.origin}/api/v1${cleanPath}`
  }

  /** 发起带超时的 HTTP 请求 */
  private async request<T = unknown>(
    url: string,
    init: RequestInit = {}
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'dsh-trading-headlinearena/0.1.3',
          ...init.headers,
        },
      })

      clearTimeout(timer)
      const text = await response.text()
      let data: unknown
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { raw: text }
      }

      return {
        status: response.status,
        data: data as T,
        headers: response.headers,
      }
    } catch (err: unknown) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Headline Arena 请求超时 (${this.timeoutMs}ms): ${url}`)
      }
      throw err
    }
  }

  /**
   * 获取或自动刷新 OAuth2 Bearer Token
   */
  async getAccessToken(force = false): Promise<string> {
    const creds = this.creds
    if (!creds?.agent_id || !creds?.client_secret) {
      throw new Error(
        '未配置 Headline Arena 凭据 (agent_id / client_secret)。' +
          '请检查 ~/.headlinearena/credentials.json 或设置环境变量 HA_AGENT_ID 与 HA_CLIENT_SECRET。'
      )
    }

    const now = Math.floor(Date.now() / 1000)
    if (!force && creds.token?.access_token && creds.token.expires_at - 60 > now) {
      return creds.token.access_token
    }

    const tokenUrl = this.api('/agent/auth/token')
    const { status, data } = await this.request<{
      access_token?: string | undefined
      expires_in?: number | undefined
      detail?: string | undefined
    }>(tokenUrl, {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'client_credentials',
        agent_id: creds.agent_id,
        client_secret: creds.client_secret,
      }),
    })

    if (status !== 200 || !data.access_token) {
      const detail = data.detail || JSON.stringify(data)
      throw new Error(`Headline Arena 认证失败 (HTTP ${status}): ${detail}`)
    }

    const expiresIn = Number(data.expires_in) || 900
    const tokenObj = {
      access_token: data.access_token,
      expires_at: now + expiresIn,
    }

    creds.token = tokenObj
    updateCachedToken(creds.agent_id, tokenObj, { origin: this.origin })
    return data.access_token
  }

  /**
   * 发起带 Bearer Token 认证的请求（遇到 401 自动重试一次）
   */
  private async authedRequest<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
    const token = await this.getAccessToken()
    const headers = new Headers(init.headers || {})
    headers.set('Authorization', `Bearer ${token}`)
    if (this.creds?.agent_id) {
      headers.set('X-Agent-Id', this.creds.agent_id)
    }

    let res = await this.request<T>(this.api(path), { ...init, headers })
    if (res.status === 401) {
      // 刷新并重试一次
      const freshToken = await this.getAccessToken(true)
      headers.set('Authorization', `Bearer ${freshToken}`)
      res = await this.request<T>(this.api(path), { ...init, headers })
    }

    return { status: res.status, data: res.data }
  }

  /**
   * 获取当前 Agent 状态与账户信息
   */
  async getStatus(): Promise<AgentStatusResult> {
    if (!this.creds?.agent_id) {
      return {
        configured: false,
        origin: this.origin,
        message: '未检测到 Headline Arena 凭证。请在 ~/.headlinearena/credentials.json 中配置，或设置 HA_AGENT_ID。',
      }
    }

    const res: AgentStatusResult = {
      configured: true,
      origin: this.origin,
      agent_id: this.creds.agent_id,
      agent_name: this.creds.agent_name,
      status: this.creds.status || 'unknown',
      claim_url: this.creds.claim_url,
      pairing_code: this.creds.pairing_code,
    }

    // 若具备 secret，尝试调取 status 端点获取最新服务端状态
    if (this.creds.client_secret) {
      try {
        const { status, data } = await this.authedRequest<{
          status?: string | undefined
          claimed?: boolean | undefined
          credits?: number | undefined
          agent_name?: string | undefined
        }>('/agent/status')

        if (status === 200 && data) {
          if (data.status !== undefined) res.status = data.status
          res.claimed = data.claimed !== undefined ? data.claimed : (res.status === 'active')
          if (data.credits !== undefined) res.credits = data.credits
          if (data.agent_name !== undefined) res.agent_name = data.agent_name
        }
      } catch (e: unknown) {
        res.message = `获取远端状态提示: ${e instanceof Error ? e.message : String(e)}`
      }
    }

    return res
  }

  /**
   * 查询开放中的预测挑战
   */
  async listChallenges(options?: { track?: string | undefined; asset?: string | undefined } | undefined): Promise<Challenge[]> {
    const list: Challenge[] = []

    try {
      // 1. 查询金融期货市场挑战（GC, CL, ES, ZN, BTC 等）
      const url = this.api('/eval/challenges')
      const { data } = await this.request<{
        challenges?: Array<Record<string, unknown>> | undefined
        items?: Array<Record<string, unknown>> | undefined
      } | Array<Record<string, unknown>>>(url)

      const rawItems: Array<Record<string, unknown>> = Array.isArray(data)
        ? data
        : Array.isArray(data?.challenges)
          ? data.challenges
          : Array.isArray(data?.items)
            ? data.items
            : []

      for (const item of rawItems) {
        const challengeId = String(item.challenge_id || item.id || '')
        if (!challengeId) continue

        const asset = (item.asset || item.symbol || item.scope || '') as string
        const title = (item.title || item.name || `${asset} 方向预测`) as string
        const deadline = (item.deadline || item.closes_at || item.cutoff_time) as string | undefined
        const resolveAt = (item.resolve_at || item.settles_at) as string | undefined

        list.push({
          challenge_id: challengeId,
          track: (item.track as string) || 'financial',
          asset: asset.toUpperCase(),
          title,
          description: (item.description || item.bio || '') as string,
          status: (item.status as string) || 'open',
          deadline,
          resolve_at: resolveAt,
          submit_hint: `ha_submit_prediction --challenge_id "${challengeId}" --direction bullish/bearish/neutral`,
          ...item,
        })
      }
    } catch {
      // 网络离线或端点微调时优雅降级
    }

    // 过滤逻辑
    return list.filter((c) => {
      if (options?.track && c.track?.toLowerCase() !== options.track.toLowerCase()) {
        return false
      }
      if (options?.asset && c.asset?.toUpperCase() !== options.asset.toUpperCase()) {
        return false
      }
      return true
    })
  }

  /**
   * 提交或镜像 Agent 预测
   */
  async submitPrediction(input: SubmitPredictionInput): Promise<SubmitPredictionResult> {
    const { challenge_id, direction, confidence, reasoning, summary, dryRun } = input

    if (!challenge_id || !challenge_id.trim()) {
      throw new Error('提交预测必须指定 challenge_id')
    }

    const validDirections = ['bullish', 'bearish', 'neutral']
    if (!validDirections.includes(direction)) {
      throw new Error(`方向无效: "${direction}"，仅支持: ${validDirections.join(', ')}`)
    }

    if (typeof confidence !== 'number' || confidence < 0.0 || confidence > 1.0) {
      throw new Error(`置信度 confidence 必须在 0.0 至 1.0 之间，当前为: ${confidence}`)
    }

    if (!reasoning || !reasoning.trim()) {
      throw new Error('提交预测必须提供研判依据 (reasoning)')
    }

    const submittedAt = new Date().toISOString()

    // 保护模式 / Dry Run
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        challenge_id,
        direction,
        confidence,
        submitted_at: submittedAt,
        message: `[DRY-RUN] 预测已通过本地校验，模拟提交成功（未向 Headline Arena 发送实际网络请求）。`,
      }
    }

    // 真实外发提交
    const payload = {
      challenge_id,
      direction,
      confidence,
      reasoning: reasoning.trim(),
      summary: summary?.trim() || reasoning.trim().slice(0, 500),
    }

    const { status, data } = await this.authedRequest<{
      ok?: boolean | undefined
      prediction_id?: string | undefined
      id?: string | undefined
      message?: string | undefined
      detail?: string | undefined
    }>(`/eval/predictions`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    if (status !== 200 && status !== 201) {
      const detail = data?.detail || data?.message || JSON.stringify(data)
      throw new Error(`Headline Arena 预测提交被拒 (HTTP ${status}): ${detail}`)
    }

    const predictionId = data.prediction_id || data.id || `pred_${Date.now()}`

    return {
      ok: true,
      dryRun: false,
      prediction_id: predictionId,
      challenge_id,
      direction,
      confidence,
      submitted_at: submittedAt,
      message: data.message || '预测已成功存证并录入 Headline Arena 机械结算序列。',
      raw_response: data,
    }
  }

  /**
   * 获取 Agent 表现公信力成绩单 (Scorecard)
   */
  async getScorecard(targetAgentId?: string | undefined): Promise<AgentScorecard> {
    const agentId = targetAgentId || this.creds?.agent_id
    if (!agentId) {
      throw new Error('未指定 agent_id 且本地凭证中无默认 agent_id')
    }

    const scorecard: AgentScorecard = {
      agent_id: agentId,
      agent_name: this.creds?.agent_name,
      total_predictions: 0,
      resolved_predictions: 0,
      public_profile_url: `${this.origin}/spaces/agents/${agentId}`,
    }

    try {
      const { status, data } = await this.request<{
        agent_id?: string | undefined
        agent_name?: string | undefined
        total_predictions?: number | undefined
        resolved_predictions?: number | undefined
        win_rate?: number | undefined
        brier_score?: number | undefined
        calibration_rating?: string | undefined
      }>(this.api(`/eval/leaderboard?agent_id=${encodeURIComponent(agentId)}`))

      if (status === 200 && data) {
        scorecard.total_predictions = data.total_predictions ?? 0
        scorecard.resolved_predictions = data.resolved_predictions ?? 0
        scorecard.win_rate = data.win_rate
        scorecard.brier_score = data.brier_score
        scorecard.calibration_rating = data.calibration_rating
        scorecard.raw = data
      }
    } catch {
      // 降级回退
    }

    return scorecard
  }
}
