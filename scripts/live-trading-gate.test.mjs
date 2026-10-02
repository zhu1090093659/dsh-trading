/**
 * live-trading-gate.mjs 自测。
 *
 * 四条规则都必须证明「真的会红」：本门禁是不变量 §13.3（实盘开关不在 agent 可写路径上）
 * 的唯一执行点，坏成恒真就等于把这条不变量退回成散文。LG4 是行为规则（真的起一份密钥、
 * 信任锚、签名授权），所以它的自测用**契约替身**注入旧语义，证明这条规则不是恒真。
 */
import { describe, expect, it } from 'vitest'
import { checkAuthorityPlane, checkDecisionSites, checkMirrors, checkRuntimeImports } from './live-trading-gate.mjs'

/** 契约替身：恢复验收发现 #1 之前的语义（缺省落在 DSH_HOME、读得到就放行）。 */
function legacyAuthorityRuntime(overrides = {}) {
  return {
    AUTHORITY_DEV_ENV: 'DSH_TRADING_AUTHORITY_DEV_SAME_UID',
    authorityDir: () => '/tmp/legacy-home/authority',
    liveTradingDecision: () => ({ granted: true, allowed: true, reason: 'granted' }),
    ...overrides,
  }
}

describe('checkMirrors（LG1）', () => {
  it('管理员：preset 资产把 liveTrading 写成 true 时报红', () => {
    // Given 一份被改写的 preset 资产文本
    const files = [{ file: 'packages/crypto/assets/preset/crypto-trader/agent.cordis.yml', text: '        dryRun: true\n        liveTrading: true\n' }]
    // When 跑镜像检查
    const problems = checkMirrors(files)
    // Then 报红并指明它只是镜像
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('LG1')
    expect(problems[0].detail).toContain('不会打开实盘')
  })

  it('管理员：全部镜像为 false 时不报红', () => {
    // Given 六处 false 镜像
    const files = [{ file: 'packages/base/src/presets.ts', text: 'config: { dryRun: true, liveTrading: false }' }]
    // When 跑镜像检查
    // Then 零问题
    expect(checkMirrors(files)).toEqual([])
  })
})

describe('checkDecisionSites（LG2）', () => {
  it('管理员：源码里出现裸判定时报红并给出改法', () => {
    // Given 一处把镜像当权威的判定
    const files = [{ file: 'packages/connector-x/src/index.ts', text: 'if (!requestedDryRun && !config.liveTrading) reject()\n' }]
    // When 跑判定点检查
    const problems = checkDecisionSites(files)
    // Then 报红并指名 liveTradingEnabled
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('LG2')
    expect(problems[0].detail).toContain('liveTradingEnabled(config.liveTrading)')
  })

  it('管理员：this.config 形态的裸判定同样报红', () => {
    // Given 服务缝形态的裸判定
    const files = [{ file: 'packages/connector-y/src/index.ts', text: 'if (!this.config.liveTrading || this.config.dryRun) throw x\n' }]
    // When 跑判定点检查
    const problems = checkDecisionSites(files)
    // Then 报红
    expect(problems).toHaveLength(1)
    expect(problems[0].detail).toContain('liveTradingEnabled(this.config.liveTrading)')
  })

  it('管理员：经 liveTradingEnabled 的判定不报红', () => {
    // Given 正确写法
    const files = [{ file: 'packages/connector-z/src/index.ts', text: 'if (!requestedDryRun && !liveTradingEnabled(config.liveTrading)) reject()\n' }]
    // When 跑判定点检查
    // Then 零问题
    expect(checkDecisionSites(files)).toEqual([])
  })
})

describe('checkRuntimeImports（LG3）', () => {
  it('管理员：运行期源码引用签署侧时报红', () => {
    // Given 一处运行期 import 签署侧
    const files = [{ file: 'packages/base/src/index.ts', text: "import { signLiveTradingGrant } from '@dshtrading/authority/sign'\n" }]
    // When 跑引用检查
    const problems = checkRuntimeImports(files)
    // Then 报红
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('LG3')
    expect(problems[0].detail).toContain('@dshtrading/authority/sign')
  })

  it('管理员：运行期源码引用测试夹具时报红', () => {
    // Given 一处运行期 import 夹具
    const files = [{ file: 'packages/connector-x/src/index.ts', text: "import { installTestAuthority } from '@dshtrading/authority/testing'\n" }]
    // When 跑引用检查
    // Then 报红
    expect(checkRuntimeImports(files)).toHaveLength(1)
  })

  it('管理员：只引用运行期入口时不报红', () => {
    // Given 合法的运行期引用
    const files = [{ file: 'packages/connector-x/src/index.ts', text: "import { liveTradingEnabled } from '@dshtrading/authority'\n" }]
    // When 跑引用检查
    // Then 零问题
    expect(checkRuntimeImports(files)).toEqual([])
  })
})
describe('checkAuthorityPlane（LG4）', () => {
  it('管理员：当前仓库的真实源码满足 LG4（显式配置 + 自铸平面被拒）', async () => {
    // Given 仓库里真实的 authority 源码，以及门禁自己造的自铸平面探针
    // When 跑 LG4
    const problems = await checkAuthorityPlane()
    // Then 零问题——这条同时是「LG4 能绿」的证据
    expect(problems).toEqual([])
  })

  it('管理员：平面目录退回 $DSH_HOME 默认时报红', async () => {
    // Given 一个恢复旧行为的契约替身（缺省解析出 home 下的目录）
    // When 跑 LG4
    const problems = await checkAuthorityPlane({ runtime: legacyAuthorityRuntime() })
    const detail = problems.map((problem) => problem.detail).join('\n')
    // Then 报红，且直指默认位置与「未配置必须拒绝」
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.every((problem) => problem.rule === 'LG4')).toBe(true)
    expect(detail).toContain('默认值')
    expect(detail).toContain('$DSH_HOME')
    expect(detail).toContain('dir-not-configured')
  })

  it('管理员：自铸平面被判成放行时报红', async () => {
    // Given 一个旧语义的替身（读得到就放行）+ 让门禁真跑自铸平面探针
    // When 跑 LG4
    const problems = await checkAuthorityPlane({ runtime: legacyAuthorityRuntime(), forge: true })
    const detail = problems.map((problem) => problem.detail).join('\n')
    // Then 报红，并指名「自铸平面被判成放行」
    expect(detail).toContain('自铸平面（同 uid 写信任锚 + 自签授权）被判成放行了')
    expect(detail).toContain('"granted":true')
  })

  it('管理员：开发形态 opt-in 的名字里没有 dev 时报红', async () => {
    // Given 一个把逃生门命名成看不出是开发形态的替身
    const sneaky = {
      AUTHORITY_DEV_ENV: 'DSH_TRADING_AUTHORITY_ALLOW_SAME_UID',
      authorityDir: () => undefined,
      liveTradingDecision: () => ({ granted: false, allowed: false, reason: 'dir-not-configured' }),
    }
    // When 跑 LG4
    const problems = await checkAuthorityPlane({ runtime: sneaky })
    const detail = problems.map((problem) => problem.detail).join('\n')
    // Then 报红：显式 opt-in 不能是一个猜不到名字的后门
    expect(detail).toContain('没有 dev')
    expect(detail).toContain('DSH_TRADING_AUTHORITY_ALLOW_SAME_UID')
  })
})
