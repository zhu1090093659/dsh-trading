/**
 * live-trading-gate.mjs 纯函数自测。
 *
 * 三条规则都必须证明「真的会红」：本门禁是不变量 §13.3（实盘开关不在 agent 可写路径上）
 * 的唯一执行点，坏成恒真就等于把这条不变量退回成散文。
 */
import { describe, expect, it } from 'vitest'
import { checkDecisionSites, checkMirrors, checkRuntimeImports } from './live-trading-gate.mjs'

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
