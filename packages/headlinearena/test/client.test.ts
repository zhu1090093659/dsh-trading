import { describe, expect, it, vi } from 'vitest'
import { HeadlineArenaClient } from '../src/client.ts'

describe('HeadlineArenaClient', () => {
  it('未配置 client_secret 时 getAccessToken 应当抛出清晰提示', async () => {
    const client = new HeadlineArenaClient({
      creds: { agent_id: 'no-secret-bot' },
    })
    await expect(client.getAccessToken()).rejects.toThrow('未配置 Headline Arena 凭据')
  })

  it('有效缓存的 token 应当直接复用，不发起网络请求', async () => {
    const mockFetch = vi.fn()
    const now = Math.floor(Date.now() / 1000)
    const client = new HeadlineArenaClient({
      creds: {
        agent_id: 'test-bot',
        client_secret: 'secret-123',
        token: {
          access_token: 'cached-token-abc',
          expires_at: now + 3600,
        },
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    const token = await client.getAccessToken()
    expect(token).toBe('cached-token-abc')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('token 过期时应调用 /agent/auth/token 刷新', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      text: async () => JSON.stringify({ access_token: 'fresh-token-xyz', expires_in: 900 }),
      headers: new Headers(),
    })

    const client = new HeadlineArenaClient({
      creds: {
        agent_id: 'test-bot',
        client_secret: 'secret-123',
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    const token = await client.getAccessToken()
    expect(token).toBe('fresh-token-xyz')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callUrl = mockFetch.mock.calls[0][0]
    expect(callUrl).toContain('/api/v1/agent/auth/token')
  })

  it('listChallenges 能正确解析并按 asset 过滤', async () => {
    const mockChallenges = [
      { id: 'ch_gc_01', asset: 'GC', title: 'Gold Daily', track: 'financial' },
      { id: 'ch_cl_01', asset: 'CL', title: 'Crude Oil Daily', track: 'financial' },
      { id: 'ch_cpi_01', asset: 'CPI', title: 'US CPI Forecast', track: 'civic' },
    ]

    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      text: async () => JSON.stringify({ challenges: mockChallenges }),
      headers: new Headers(),
    })

    const client = new HeadlineArenaClient({
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    const all = await client.listChallenges()
    expect(all).toHaveLength(3)

    // 按资产过滤
    const gcOnly = all.filter((c) => c.asset === 'GC')
    expect(gcOnly).toHaveLength(1)
    expect(gcOnly[0].challenge_id).toBe('ch_gc_01')
  })

  describe('submitPrediction 校验与执行', () => {
    it('无效方向应抛出错误', async () => {
      const client = new HeadlineArenaClient()
      await expect(
        client.submitPrediction({
          challenge_id: 'ch_1',
          direction: 'flying' as any,
          confidence: 0.8,
          reasoning: 'test',
        })
      ).rejects.toThrow('方向无效')
    })

    it('越界置信度应抛出错误', async () => {
      const client = new HeadlineArenaClient()
      await expect(
        client.submitPrediction({
          challenge_id: 'ch_1',
          direction: 'bullish',
          confidence: 1.5,
          reasoning: 'test',
        })
      ).rejects.toThrow('置信度 confidence 必须在 0.0 至 1.0 之间')
    })

    it('缺少 reasoning 应抛出错误', async () => {
      const client = new HeadlineArenaClient()
      await expect(
        client.submitPrediction({
          challenge_id: 'ch_1',
          direction: 'bullish',
          confidence: 0.7,
          reasoning: '   ',
        })
      ).rejects.toThrow('必须提供研判依据')
    })

    it('dryRun 模式下应本地成功，绝不发起远程网络请求', async () => {
      const mockFetch = vi.fn()
      const client = new HeadlineArenaClient({
        fetchFn: mockFetch as unknown as typeof fetch,
      })

      const res = await client.submitPrediction({
        challenge_id: 'ch_gold_100',
        direction: 'bullish',
        confidence: 0.85,
        reasoning: '地缘政治升温与央行购金持续放量支撑黄金突破新高。',
        dryRun: true,
      })

      expect(res.ok).toBe(true)
      expect(res.dryRun).toBe(true)
      expect(res.challenge_id).toBe('ch_gold_100')
      expect(res.direction).toBe('bullish')
      expect(res.confidence).toBe(0.85)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('真实提交模式应构造正确的 payload 并调用 /eval/predictions', async () => {
      const mockFetch = vi.fn()
        // 1. token 请求
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify({ access_token: 'auth-token-1', expires_in: 900 }),
          headers: new Headers(),
        })
        // 2. predictions 请求
        .mockResolvedValueOnce({
          status: 201,
          text: async () => JSON.stringify({ ok: true, prediction_id: 'pred_real_999' }),
          headers: new Headers(),
        })

      const client = new HeadlineArenaClient({
        creds: {
          agent_id: 'macro-trader',
          client_secret: 'sec-999',
        },
        fetchFn: mockFetch as unknown as typeof fetch,
      })

      const res = await client.submitPrediction({
        challenge_id: 'ch_es_01',
        direction: 'bearish',
        confidence: 0.65,
        reasoning: '非农薪资超预期，降息预期降温，标普估值面临挤压。',
        dryRun: false,
      })

      expect(res.ok).toBe(true)
      expect(res.dryRun).toBe(false)
      expect(res.prediction_id).toBe('pred_real_999')
      expect(mockFetch).toHaveBeenCalledTimes(2)

      const predCall = mockFetch.mock.calls[1]
      expect(predCall[0]).toContain('/api/v1/eval/predictions')
      const sentPayload = JSON.parse(predCall[1].body)
      expect(sentPayload.challenge_id).toBe('ch_es_01')
      expect(sentPayload.direction).toBe('bearish')
      expect(sentPayload.confidence).toBe(0.65)
    })
  })

  it('getScorecard 应正确获取或降级返回结构', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      text: async () =>
        JSON.stringify({
          agent_id: 'score-agent',
          total_predictions: 42,
          resolved_predictions: 38,
          win_rate: 0.684,
          brier_score: 0.182,
          calibration_rating: 'well_calibrated',
        }),
      headers: new Headers(),
    })

    const client = new HeadlineArenaClient({
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    const card = await client.getScorecard('score-agent')
    expect(card.agent_id).toBe('score-agent')
    expect(card.total_predictions).toBe(42)
    expect(card.win_rate).toBe(0.684)
    expect(card.brier_score).toBe(0.182)
    expect(card.calibration_rating).toBe('well_calibrated')
  })
})
