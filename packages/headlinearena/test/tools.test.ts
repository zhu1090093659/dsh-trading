import { describe, expect, it, vi } from 'vitest'
import { HeadlineArenaClient } from '../src/client.ts'
import {
  createHaGetScorecardTool,
  createHaListChallengesTool,
  createHaStatusTool,
  createHaSubmitPredictionTool,
  createHeadlineArenaTools,
} from '../src/tools.ts'

describe('Headline Arena Tools', () => {
  const mockClient = new HeadlineArenaClient({
    creds: {
      agent_id: 'tool-test-agent',
      agent_name: 'test-agent',
      status: 'active',
    },
  })

  it('createHeadlineArenaTools 应返回 4 个核心工具', () => {
    const tools = createHeadlineArenaTools({ client: mockClient })
    expect(tools).toHaveLength(4)
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['ha_status', 'ha_list_challenges', 'ha_submit_prediction', 'ha_get_scorecard'])
  })

  it('ha_status 工具应返回结构化状态', async () => {
    const statusTool = createHaStatusTool({ client: mockClient })
    const resultJson = await statusTool.execute({})
    const result = JSON.parse(String(resultJson))
    expect(result.ok).toBe(true)
    expect(result.agent_id).toBe('tool-test-agent')
    expect(result.configured).toBe(true)
  })

  it('ha_list_challenges 应返回挑战列表及推荐资产', async () => {
    const spy = vi.spyOn(mockClient, 'listChallenges').mockResolvedValueOnce([
      {
        challenge_id: 'ch_gold',
        asset: 'GC',
        track: 'financial',
        title: 'Gold Daily',
      },
    ])

    const listTool = createHaListChallengesTool({
      client: mockClient,
      config: { defaultAssets: ['GC', 'CL', 'ES'] },
    })

    const resultJson = await listTool.execute({ asset: 'GC' })
    const result = JSON.parse(String(resultJson))

    expect(result.ok).toBe(true)
    expect(result.count).toBe(1)
    expect(result.recommended_assets).toEqual(['GC', 'CL', 'ES'])
    expect(result.challenges[0].challenge_id).toBe('ch_gold')
    spy.mockRestore()
  })

  it('ha_submit_prediction 默认应继承 config.dryRun=true 保护模式', async () => {
    const spy = vi.spyOn(mockClient, 'submitPrediction')

    const submitTool = createHaSubmitPredictionTool({
      client: mockClient,
      config: { dryRun: true },
    })

    const resultJson = await submitTool.execute({
      challenge_id: 'ch_btc_01',
      direction: 'bullish',
      confidence: 0.9,
      reasoning: '链上储备持续流出，减半后供应冲击显现。',
    })

    const result = JSON.parse(String(resultJson))
    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        challenge_id: 'ch_btc_01',
        direction: 'bullish',
        confidence: 0.9,
        dryRun: true,
      })
    )
    spy.mockRestore()
  })

  it('ha_get_scorecard 应查询并返回成绩单', async () => {
    const spy = vi.spyOn(mockClient, 'getScorecard').mockResolvedValueOnce({
      agent_id: 'tool-test-agent',
      total_predictions: 10,
      resolved_predictions: 8,
      win_rate: 0.75,
      brier_score: 0.15,
      calibration_rating: 'excellent',
    })

    const scoreTool = createHaGetScorecardTool({ client: mockClient })
    const resultJson = await scoreTool.execute({})
    const result = JSON.parse(String(resultJson))

    expect(result.ok).toBe(true)
    expect(result.scorecard.agent_id).toBe('tool-test-agent')
    expect(result.scorecard.win_rate).toBe(0.75)
    spy.mockRestore()
  })
})
