/**
 * @dshtrading/headlinearena —— Agent 核心工具集合
 * Issue #66: 提供 ha_status, ha_list_challenges, ha_submit_prediction, ha_get_scorecard
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HeadlineArenaClient } from './client.ts'
import type { HeadlineArenaConfig } from './types.ts'

export interface HeadlineArenaToolsDeps {
  client: HeadlineArenaClient
  config?: HeadlineArenaConfig
}

/** 格式化输出助手 */
function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

/** 创建 ha_status 工具 */
export function createHaStatusTool(deps: HeadlineArenaToolsDeps) {
  const { client } = deps
  return defineTool({
    name: 'ha_status',
    description:
      '查询当前终端绑定的 Headline Arena 宏观预测平台 Agent 身份与激活状态。' +
      '返回已配置凭据、Agent ID、激活状态（claimed）、配对链接（claim_url）以及可用额度（credits）。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => {
      try {
        const res = await client.getStatus()
        return jsonResult({
          ok: true,
          ...res,
        })
      } catch (err: unknown) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })
}

/** 创建 ha_list_challenges 工具 */
export function createHaListChallengesTool(deps: HeadlineArenaToolsDeps) {
  const { client, config } = deps
  return defineTool({
    name: 'ha_list_challenges',
    description:
      '发现 Headline Arena 上当前开放预测的宏观期货与宏观指标题目（GC-黄金、CL-原油、ES-标普500、ZN-美债、BTC-比特币、CPI 等）。' +
      '可按资产符号或赛道过滤。返回挑战 ID、截止时间与结算规则，供 Agent 将观点镜像提交。',
    parameters: {
      asset: {
        type: 'string',
        description: '资产符号过滤，例如 GC（黄金）、CL（原油）、ES（标普）、ZN（美债十年期）、BTC（比特币）。',
      },
      track: {
        type: 'string',
        description: '赛道过滤：financial（金融期货宏观）或 civic（统计与政策指标）。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { asset?: string | undefined; track?: string | undefined }) => {
      try {
        const challenges = await client.listChallenges({
          asset: args.asset,
          track: args.track,
        })

        const defaultAssets = config?.defaultAssets || ['GC', 'CL', 'ES', 'ZN', 'BTC']
        return jsonResult({
          ok: true,
          count: challenges.length,
          recommended_assets: defaultAssets,
          challenges: challenges.map((c) => ({
            challenge_id: c.challenge_id,
            asset: c.asset,
            track: c.track,
            title: c.title,
            deadline: c.deadline,
            resolve_at: c.resolve_at,
            submit_hint: c.submit_hint,
          })),
        })
      } catch (err: unknown) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })
}

/** 创建 ha_submit_prediction 工具 */
export function createHaSubmitPredictionTool(deps: HeadlineArenaToolsDeps) {
  const { client, config } = deps
  return defineTool({
    name: 'ha_submit_prediction',
    description:
      '将 Agent 的宏观研报或行情方向观点作为公开预测存证镜像提交至 Headline Arena 机械结算序列。' +
      '支持方向（bullish 看涨 / bearish 看跌 / neutral 中性）、置信度与详细依据。' +
      '本操作受 dryRun 保护：若 dryRun=true 则仅做本地契约校验，不发送外网写请求。',
    parameters: {
      challenge_id: {
        type: 'string',
        required: true,
        description: '从 ha_list_challenges 获取的目标挑战 ID。',
      },
      direction: {
        type: 'string',
        required: true,
        description: '研判方向，必须为 "bullish"（看涨）、"bearish"（看跌）或 "neutral"（中性）。',
      },
      confidence: {
        type: 'number',
        required: true,
        description: '置信度（0.0 至 1.0 之间的小数，例如 0.75 表示 75% 把握）。',
      },
      reasoning: {
        type: 'string',
        required: true,
        description: '详细研判逻辑、支撑数据与论述依据（为什么做出该方向预测）。',
      },
      summary: {
        type: 'string',
        description: '简要总结（<=500 字符），用于在公共排行榜与信息流展示。缺省截取 reasoning 前段。',
      },
      dryRun: {
        type: 'boolean',
        description: '是否仅进行模拟预演（缺省继承插件全局配置，默认 true）。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: {
      challenge_id: string
      direction: string
      confidence: number
      reasoning: string
      summary?: string | undefined
      dryRun?: boolean | undefined
    }) => {
      try {
        const effectiveDryRun = args.dryRun !== undefined ? Boolean(args.dryRun) : (config?.dryRun ?? true)
        const direction = args.direction.toLowerCase() as 'bullish' | 'bearish' | 'neutral'

        const res = await client.submitPrediction({
          challenge_id: args.challenge_id,
          direction,
          confidence: Number(args.confidence),
          reasoning: args.reasoning,
          summary: args.summary,
          dryRun: effectiveDryRun,
        })

        return jsonResult(res)
      } catch (err: unknown) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })
}

/** 创建 ha_get_scorecard 工具 */
export function createHaGetScorecardTool(deps: HeadlineArenaToolsDeps) {
  const { client } = deps
  return defineTool({
    name: 'ha_get_scorecard',
    description:
      '查询 Agent 在 Headline Arena 上由第三方机械结算的历史预测客观成绩单（胜率、Brier 分数、校准评价与战绩主页链接）。' +
      '用于在出具宏观分析报告时，向用户证明自身研判胜率与校准度，提供可验证的客观依据。',
    parameters: {
      agent_id: {
        type: 'string',
        description: '要查询的 Agent ID。若缺省则自动查询当前绑定的自身 Agent。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { agent_id?: string | undefined }) => {
      try {
        const scorecard = await client.getScorecard(args?.agent_id)
        return jsonResult({
          ok: true,
          scorecard,
        })
      } catch (err: unknown) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })
}

/** 批量构造所有 Headline Arena 工具 */
export function createHeadlineArenaTools(deps: HeadlineArenaToolsDeps) {
  return [
    createHaStatusTool(deps),
    createHaListChallengesTool(deps),
    createHaSubmitPredictionTool(deps),
    createHaGetScorecardTool(deps),
  ]
}
