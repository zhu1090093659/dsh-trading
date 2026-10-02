/**
 * 设备注册表落盘（文件后端）行为测试：真文件、真权限位、真崩溃形态，无 mock 无 sleep。
 *
 * 为什么必须对着真文件跑：这条通路的失效形态**都不是异常**——「设备没写进去」表现为下次启动
 * 空表（所有人静默失联）、「密钥明文落盘」表现为文件里多了一段谁都读得到的字符串、「写不是
 * 原子的」表现为崩溃后留下半截 JSON。它们全都「看起来在跑」，所以判据只能是磁盘上真实的那几个
 * 字节与权限位。
 *
 * 重启语义（同一路径再造一个注册表实例）在这里先钉一遍，edge-registry-restart.test.ts 里再用
 * 真实 edge 进程端到端验一遍：真进程才知道「重启用的是不是同一个文件」。
 */
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEVICE_REGISTRY_FILE_MODE,
  createDeviceRegistry,
  type DeviceRegistry,
  type Scope,
} from '../src/edge.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 一个落盘注册表 + 「重启」（同一路径再造一个实例）。 */
function fixture() {
  const dir = tempDir('edge-registry-')
  const storePath = join(dir, 'devices.json')
  let tick = 1_700_000_000_000
  return {
    dir,
    storePath,
    registry: createDeviceRegistry({ now: () => (tick += 1000), storePath }),
    /** 模拟 edge 重启：同一文件路径、新的注册表实例（新进程里的那一刻）。 */
    reopen: () => createDeviceRegistry({ now: () => 1_800_000_000_000, storePath }),
  }
}

/** 真配对流程拿一台设备（不碰注册表内部结构）。 */
function pair(registry: DeviceRegistry, scopes?: readonly Scope[]) {
  const { code } = registry.issuePairingCode()
  const redeemed = registry.redeem({ code, name: 'phone', ...(scopes === undefined ? {} : { scopes }) })
  if ('error' in redeemed) throw new Error('配对失败：' + redeemed.error)
  return { id: redeemed.device.id, token: redeemed.device.id + '.' + redeemed.secret, secret: redeemed.secret }
}

describe('设备注册表落盘', () => {
  it('管理员：配对后设备落盘 —— 只有 sha256 散列、没有明文密钥，权限 0600', () => {
    // Given 一个文件后端的注册表与一台按真配对流程兑换的设备（显式要了 command）
    const f = fixture()
    const device = pair(f.registry, ['command'])
    // When 读盘上的原始字节
    const raw = readFileSync(f.storePath, 'utf8')
    const onDisk = JSON.parse(raw) as { version: number; devices: { id: string; name: string; scopes: string[]; secretHash: string; createdAtMs: number }[] }
    // Then 文件里是这台设备的完整事实，而密钥只有散列 —— 明文一次都不落盘
    expect(onDisk.version).toBe(1)
    expect(onDisk.devices).toHaveLength(1)
    expect(onDisk.devices[0]).toMatchObject({ id: device.id, name: 'phone', scopes: ['read', 'command'] })
    expect(onDisk.devices[0]?.secretHash).toBe(createHash('sha256').update(device.secret).digest('hex'))
    expect(raw).not.toContain(device.secret)
    // 权限 0600：连密钥散列都不给同组读（部署形态里 edge 与核心同组）
    expect(statSync(f.storePath).mode & 0o777).toBe(DEVICE_REGISTRY_FILE_MODE)
    // 散列就是鉴权比对用的那一份：同一条凭据在内存里也过得去
    expect(f.registry.authenticate('Bearer ' + device.token)).toHaveProperty('device')
  })

  it('管理员：每次授权变更都是同目录 temp + rename（旧 inode 不被改写、不留残件、权限仍是 0600）', () => {
    // Given 一台已落盘并已授予 control 的设备，以及一个钉住**当前 inode** 的硬链接哨兵
    const f = fixture()
    const device = pair(f.registry, ['command'])
    expect(f.registry.grantControl(device.id)).toBe(true)
    const sentinel = join(f.dir, 'sentinel.json')
    linkSync(f.storePath, sentinel)
    const before = readFileSync(sentinel, 'utf8')
    expect(before).toContain('"control"')
    // When 收回 control（一次真实的授权变更，必须重新落盘）
    expect(f.registry.revokeControl(device.id)).toBe(true)
    // Then 哨兵还是旧内容 —— 说明写的是「新文件 + rename」，不是原地 truncate+write
    // （原地改写会让哨兵跟着变；rename 换掉目录项，旧 inode 从此没人写）
    expect(readFileSync(sentinel, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(f.storePath, 'utf8'))).toMatchObject({ devices: [{ scopes: ['read', 'command'] }] })
    // 临时文件已经 rename 掉：目录里不留 .tmp- 残件（残件会被下次启动当成垃圾，也可能被人误读）
    expect(readdirSync(f.dir).filter((name) => name.includes('.tmp-'))).toEqual([])
    // rename 换的是新文件，权限必须还是 0600（不能因为换了 inode 就放宽）
    expect(statSync(f.storePath).mode & 0o777).toBe(DEVICE_REGISTRY_FILE_MODE)
  })

  it('管理员：注册表文件不存在时是空表（首次启动的正常状态），而且读不产生写', () => {
    // Given 一个指向不存在文件的路径
    const f = fixture()
    // When 造一个注册表实例
    const opened = f.reopen()
    // Then 空表、任何令牌都鉴权失败、文件仍然不存在（只读不落盘）
    expect(existsSync(f.storePath)).toBe(false)
    expect(opened.list()).toEqual([])
    expect(opened.authenticate('Bearer dev_0123456789abcdef.not-a-secret')).toEqual({ error: 'invalid' })
    expect(existsSync(f.storePath)).toBe(false)
  })

  it('管理员：注册表文件损坏或形态认不出时拒绝启动（fail-closed，不许静默当空表）', () => {
    // Given 九种「读不懂」的文件形态（配对码/密钥都合法，坏在结构上）
    const f = fixture()
    const good = { id: 'dev_0123456789abcdef', name: 'phone', scopes: ['read'], secretHash: 'a'.repeat(64), createdAtMs: 1 }
    const payloads: [string, string][] = [
      ['不是 JSON', '{这不是 JSON'],
      ['顶层是数组', '[]'],
      ['没有版本字段', JSON.stringify({ devices: [] })],
      ['版本认不出', JSON.stringify({ version: 2, devices: [] })],
      ['devices 不是数组', JSON.stringify({ version: 1, devices: {} })],
      ['设备 id 形态不合法', JSON.stringify({ version: 1, devices: [{ ...good, id: 'nope' }] })],
      ['作用域认不出', JSON.stringify({ version: 1, devices: [{ ...good, scopes: ['admin'] }] })],
      ['secretHash 不是散列', JSON.stringify({ version: 1, devices: [{ ...good, secretHash: 'plain-secret' }] })],
      ['同一台设备出现两次', JSON.stringify({ version: 1, devices: [good, good] })],
    ]
    const swallowed: string[] = []
    // When 逐个把它们当成注册表来启动
    for (const [why, text] of payloads) {
      writeFileSync(f.storePath, text)
      try {
        f.reopen()
        swallowed.push(why)
      } catch (error) {
        // Then 每一种都抛错，且消息点出文件路径与 fail-closed 的理由
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain(f.storePath)
        expect(message).toContain('拒绝启动')
      }
    }
    // 没有任何一种被当成空表放过（空表 = 全部设备静默失联）
    expect(swallowed).toEqual([])
  })

  it('管理员：收回 control 只改那一个平面 —— 重启后设备还在、其余作用域还在、control 没了', () => {
    // Given 一台 read+command+control 的设备
    const f = fixture()
    const device = pair(f.registry, ['command'])
    expect(f.registry.grantControl(device.id)).toBe(true)
    expect(f.registry.list()[0]?.scopes).toEqual(['read', 'command', 'control'])
    // When 只收回 control，然后用同一路径再造一个注册表（模拟 edge 重启）
    expect(f.registry.revokeControl(device.id)).toBe(true)
    const reopened = f.reopen()
    const auth = reopened.authenticate('Bearer ' + device.token)
    // Then 设备仍在册、凭据仍然有效，但平面只剩 read+command（撤销跨重启存活）
    expect('device' in auth ? auth.device.scopes : null).toEqual(['read', 'command'])
    expect(reopened.list().map((entry) => entry.id)).toEqual([device.id])
  })

  it('管理员：整台设备作废后从盘上消失（重启不会复活它），其余设备不受影响', () => {
    // Given 两台设备，其中一台要被整台作废
    const f = fixture()
    const doomed = pair(f.registry, ['command'])
    const keeper = pair(f.registry)
    // When 作废第一台，然后重启
    expect(f.registry.revoke(doomed.id)).toBe(true)
    const reopened = f.reopen()
    // Then 第二台照旧（鉴权、平面都在），第一台连鉴权都过不去，盘上也不再出现它的 id
    expect(reopened.authenticate('Bearer ' + keeper.token)).toHaveProperty('device')
    expect(reopened.authenticate('Bearer ' + doomed.token)).toEqual({ error: 'invalid' })
    expect(readFileSync(f.storePath, 'utf8')).not.toContain(doomed.id)
    expect(reopened.list().map((entry) => entry.id)).toEqual([keeper.id])
  })

  it('管理员：不在册的设备收回 control 返回 false（没有可撤的东西，不当成成功）', () => {
    // Given 一个只有一台设备的注册表
    const f = fixture()
    const device = pair(f.registry)
    // When 对一个从未配对的 id 与一个已作废的 id 收回 control
    f.registry.revoke(device.id)
    // Then 两次都是 false，且盘上没有多出任何设备
    expect(f.registry.revokeControl('dev_ffffffffffffffff')).toBe(false)
    expect(f.registry.revokeControl(device.id)).toBe(false)
    expect(JSON.parse(readFileSync(f.storePath, 'utf8'))).toMatchObject({ devices: [] })
  })

  it('管理员：不给落盘路径时仍是纯内存注册表（既有接口与行为不变）', () => {
    // Given 一个没有 storePath 的注册表（旧调用方的用法）
    const dir = tempDir('edge-registry-mem-')
    const registry = createDeviceRegistry({ now: () => 1_700_000_000_000 })
    // When 配对一台设备
    const device = pair(registry)
    // Then 内存里照常可用，而磁盘上一个文件都没产生
    expect(registry.authenticate('Bearer ' + device.token)).toHaveProperty('device')
    expect(readdirSync(dir)).toEqual([])
  })
})
