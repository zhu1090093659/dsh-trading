/**
 * 确定性验收回放（D12）：把 2026-08-31 多市场联合验收的手工判据固化为离线、
 * 可复跑、退出码驱动的用例。
 *
 * 与历史验收的关系：`spikes/acceptance-all/REPORT.md` 的 a–f 是**手工一次性**
 * 结论（真起 profile、真装插件、依赖机器），无法回归。这里保留其中**与模型无关**
 * 的判据（角色装配完整性、市场隔离、审批闸门、贡献确定性），输入用各市场包的
 * 真实 `getPresetContribution()`（纯读资产，不联网、不装插件）。需要真宿主启动
 * 的项（boot exit code、roster broken）不在本套件内，仍由 profile 演练覆盖。
 *
 * 冻结样本：本文件是「参考判据」——改动角色装配或闸门词汇时必须同步这里的期望，
 * 因此它同时是变更的回归门与意图声明。
 */
import { describe, expect, it } from 'vitest'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import { DELEGATE_PRESETS, MARKETS, PRESET_IDS, composePresets } from '../src/presets.js'
import { LIVE_ACTION_GATE_PATTERN, decideLiveActionGate } from '../src/index.js'
import { getPresetContribution as crypto } from '../../crypto/src/index.js'
import { getPresetContribution as us } from '../../us/src/index.js'
import { getPresetContribution as cn } from '../../cn/src/index.js'
import { getPresetContribution as hk } from '../../hk/src/index.js'

/** 四个已安装市场的真实贡献（与历史验收同一输入形状）。 */
const realContributions = async () => Promise.all([crypto(), us(), cn(), hk()])

describe('deterministic acceptance replay', () => {
  it('user 四市场装配出四个角色且行 id 唯一（对应历史验收 b/c）', async () => {
    // Given 四市场真实贡献
    const contributions = await realContributions()
    // When 装配预设
    const presets = composePresets(contributions)
    // Then 四个角色齐备、每个角色的行 id 唯一（重复 id 会被宿主 loader 静默塌缩）
    expect(presets.map((preset) => preset.id)).toEqual([...PRESET_IDS, ...DELEGATE_PRESETS.map((preset) => preset.id)])
    for (const preset of presets) {
      const ids = preset.plugins.map((row) => row.id)
      expect(new Set(ids).size, preset.id).toBe(ids.length)
    }
  })

  it('user 装配结果与贡献顺序无关（可复跑的前提）', async () => {
    // Given 同样的四个市场、不同的输入顺序
    const contributions = await realContributions()
    // When 分别装配
    const forward = composePresets(contributions)
    const backward = composePresets([...contributions].reverse())
    // Then 结果一致（否则验收结论不可复现）
    expect(backward).toEqual(forward)
  })

  it('user 每个市场只在自己的 kit 行里出现一次（对应历史验收 c 的市场隔离）', async () => {
    // Given 四市场装配出的 trader
    const trader = composePresets(await realContributions()).find((preset) => preset.id === 'trader')!
    // When 读取其行 id
    const rows = trader.plugins.map((row) => row.id)
    // Then 每个市场的 kit 行恰一次（单包双市场多实例隔离的前提）
    for (const market of ['crypto', 'us', 'cn', 'hk'] as const) {
      expect(rows.filter((id) => id === 'dsh-trading-' + market + '-kit'), market).toHaveLength(1)
    }
  })

  it('user 未安装市场时装配不崩且明确告知无行情能力', () => {
    // Given 零市场贡献
    // When 装配
    const presets = composePresets([])
    // Then 四个角色仍在，且 persona 明确声明「无可引用行情」（绝不假装能报价）
    expect(presets.map((preset) => preset.id)).toEqual([...PRESET_IDS, ...DELEGATE_PRESETS.map((preset) => preset.id)])
    const persona = presets[0]!.plugins.find((row) => row.id === 'persona')!
    expect(String(persona.config?.prefix)).toContain('never claim quote capability')
  })

  it('user 闸门覆盖每个市场的下单与撤单（对应历史验收 d 的闸门抽查）', () => {
    // Given 本仓声明的市场清单
    // When 逐个构造下单/撤单工具名并询问闸门
    // Then 每个市场的实盘动作都被识别（缺一个就是一条绕过路径）
    for (const market of MARKETS) {
      expect(LIVE_ACTION_GATE_PATTERN.test(market + '_place_order'), market).toBe(true)
      expect(LIVE_ACTION_GATE_PATTERN.test(market + '_cancel_order'), market).toBe(true)
    }
    // And 只读行情工具绝不进闸门（否则会把只读查询变成审批负担）
    expect(LIVE_ACTION_GATE_PATTERN.test('crypto_get_ticker')).toBe(false)
  })

  it('user 未显式 dryRun 的实盘动作要求审批，显式模拟直接放行', () => {
    // Given 一笔未标 dryRun 的下单与一笔显式 dryRun=true 的下单
    // When 询问闸门
    const live = decideLiveActionGate('crypto_place_order', { symbol: 'BTCUSDT' })
    const simulated = decideLiveActionGate('crypto_place_order', { symbol: 'BTCUSDT', dryRun: true })
    // Then 前者要求审批，后者放行（模拟不改变交易所状态）
    expect(live).toMatchObject({ kind: 'ask' })
    expect(simulated).toBeUndefined()
  })

  it('user 参考装配的每个角色都通过宿主注册表行校验（broken=null 的等价判据）', async () => {
    // Given 四市场真实装配
    const presets = composePresets(await realContributions())
    // When 逐角色交给宿主注册表校验行清单
    // Then 没有一个角色因行配置非法而 broken
    for (const preset of presets) {
      expect(entryListProblem(preset.plugins, preset.id), preset.id).toBeUndefined()
    }
  })

  it('user 每个角色的 persona 都带证据契约与语言要求（评审口径的回归冻结）', async () => {
    // Given 四市场装配
    const presets = composePresets(await realContributions())
    // When 读每个角色的 persona 前缀
    // Then 证据契约、四态判定与「用用户语言回答」都在（这些是长期契约）
    for (const preset of presets) {
      const persona = preset.plugins.find((row) => row.id === 'persona')!
      const prefix = String(persona.config?.prefix)
      expect(prefix, preset.id).toContain('source grade, verdict, anchor')
      expect(prefix, preset.id).toContain('supported | contradicted | mixed | insufficient')
      expect(prefix, preset.id).toContain('Always reply in the language the user writes in')
    }
  })
})
