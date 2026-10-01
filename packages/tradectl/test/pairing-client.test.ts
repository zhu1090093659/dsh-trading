/**
 * 配对客户端流程测试（P4 步骤 4 客户端一半）：
 * **对着真实的设备注册表**（进程内）跑，不用 HTTP、不打桩注册表逻辑；存储用契约假件。
 */
import { describe, expect, it } from 'vitest'
import { createDeviceRegistry } from '../src/edge.ts'
import { authorizationFor, createPairingClient, type SecureStorage } from '../src/pairing-client.ts'

const T0 = 1_700_000_000_000

/** 契约假件：只实现"保存/读取/删除"三个文档化动作，并在内存里留痕以便断言。 */
function fakeStorage(): SecureStorage & { readonly items: Map<string, string>; readonly saves: string[] } {
  const items = new Map<string, string>()
  const saves: string[] = []
  return {
    items,
    saves,
    async save(key, value) {
      saves.push(key)
      items.set(key, value)
    },
    async load(key) {
      return items.get(key)
    },
    async remove(key) {
      items.delete(key)
    },
  }
}

function fixture(pairingTtlMs?: number) {
  let tick = T0
  const registry = createDeviceRegistry({ now: () => (tick += 1), ...(pairingTtlMs === undefined ? {} : { pairingTtlMs }) })
  const storage = fakeStorage()
  const client = createPairingClient({
    // 端口形状是**线上面**（{ deviceId, secret }），注册表返回的是 { device, secret }。
    // 这一层映射就是"进程内调用/未来的 HTTP handler"要做的事 —— 写在测试里，顺带说明端口契约。
    // （第一版直接透传 registry.redeem，于是 deviceId 恒为 undefined；测试文件不在 tsc 范围内，
    //   这个形状不匹配只在运行时暴露 —— 已记进检查点。）
    transport: {
      redeem: async (input) => {
        const result = registry.redeem(input)
        return 'error' in result ? result : { deviceId: result.device.id, secret: result.secret }
      },
    },
    storage,
  })
  return { registry, storage, client, advance: (ms: number) => { tick += ms } }
}

describe('配对客户端流程', () => {
  it('管理员：用一次性配对码完成配对，密钥进安全存储、返回可用的 Authorization', async () => {
    // Given 一个由驾驶舱签发的配对码
    const f = fixture()
    const { code } = f.registry.issuePairingCode()
    // When 手机兑换
    const outcome = await f.client.pair({ code, name: 'iPhone' })
    // Then 成功、授权头可用、密钥已交安全存储（模块自己不留明文）
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.authorization.startsWith('Bearer dev_')).toBe(true)
    expect(f.storage.saves).toEqual(['dshtrading.device'])
    expect(await f.client.authorization()).toBe(outcome.authorization)
    // 且该设备在注册表里是 read 平面（配对永不签发 control）
    expect(f.registry.list()[0]?.scopes).toEqual(['read'])
  })

  it('管理员：同一个码不能用第二次，且失败不给"重试"的错觉', async () => {
    // Given 一个已用掉的码
    const f = fixture()
    const { code } = f.registry.issuePairingCode()
    await f.client.pair({ code, name: 'iPhone' })
    // When 再兑换一次
    const second = await f.client.pair({ code, name: 'iPhone' })
    // Then 明确失败并给出人话（要重试就换新码）
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe('PAIRING_CODE_UNKNOWN')
    expect(second.message).toContain('重新生成')
  })

  it('管理员：过期码给出可操作的提示', async () => {
    // Given 一个已过期的码（TTL 1ms，推进 10ms）
    const f = fixture(1)
    const { code } = f.registry.issuePairingCode()
    f.advance(10)
    // When 兑换
    const outcome = await f.client.pair({ code, name: 'iPhone' })
    // Then 提示过期
    expect(outcome).toEqual({ ok: false, code: 'PAIRING_CODE_EXPIRED', message: '配对码已过期，请在驾驶舱重新生成' })
  })

  it('管理员：被 revoke 后 forget 清掉本地密钥，回到未配对（而不是继续拿旧密钥重试）', async () => {
    // Given 一台已配对后又撤销的设备
    const f = fixture()
    const { code } = f.registry.issuePairingCode()
    const paired = await f.client.pair({ code, name: 'iPhone' })
    expect(paired.ok).toBe(true)
    const deviceId = f.registry.list()[0]?.id ?? ''
    f.registry.revoke(deviceId)
    // When 收到 401 后调用 forget
    await f.client.forget()
    // Then 本地不再有授权头
    expect(await f.client.authorization()).toBeUndefined()
  })

  it('管理员：authorizationFor 的拼接格式与 edge 的解析约定一致', () => {
    // Given 一组设备 id 与密钥
    // When 拼头
    const header = authorizationFor('dev_abc', 'sec_123')
    // Then 形如 Bearer <id>.<secret>（edge 按第一个点切分）
    expect(header).toBe('Bearer dev_abc.sec_123')
    expect(header.slice('Bearer '.length).split('.')[0]).toBe('dev_abc')
  })
})
