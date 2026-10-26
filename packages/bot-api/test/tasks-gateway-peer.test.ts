/**
 * 宿主 gateway 的 peer 契约用例。
 *
 * 新版宿主的 typertGateway.prepareInvocation 首行是 assertPeerLive(request.peer)：
 * 读 peer.signal.aborted，缺 peer 时抛 Cannot read properties of undefined (reading
 * 'signal')——定时任务每次起跑都在毫秒级失败，meta() 里的预设名册读取则被 catch 吞成
 * 空表（右侧栏只剩「部署默认」）。这里钉住三件事：peer 面可用时每次调用都带同一个
 * owner Peer；peer 面缺席时请求体与旧宿主逐字段一致；Peer 被宿主释放后重建而不是
 * 继续用一个死 Peer。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GatewayPeerSeat,
  TasksRunner,
  type GatewayRequest,
  type PeerFactoryLike,
  type PeerLike,
  type SessionGateway,
} from '../src/tasks/runner.ts'
import { TradingTasksService } from '../src/tasks/service.ts'
import {
  createTasksAgentsFixture,
  createTasksCommandsFixture,
  createTasksGateway,
  createTasksWorkspacesFixture,
} from './tasks-fixture.ts'

/** 记录每次网关调用的线形状（peer 在不在场、args 逐字段），再转给契约 fixture。 */
function recordCalls(gateway: SessionGateway): { gateway: SessionGateway; requests: GatewayRequest[] } {
  const requests: GatewayRequest[] = []
  const recorder: SessionGateway = {
    async invoke(request) {
      requests.push(request)
      return gateway.invoke(request)
    },
    async *stream(request) {
      requests.push(request)
      const inner = gateway.stream
      if (inner === undefined) return
      const opened = await inner.call(gateway, request)
      for await (const frame of opened) yield frame
    },
  }
  return { gateway: recorder, requests }
}

/** connection 服务的 Peer 面 fixture：记录每次铸造与释放，可对指定 Peer 施加 abort。 */
function makePeerFactory() {
  const peers: Array<{ peer: PeerLike; state: { aborted: boolean; disposed: number } }> = []
  const factory: PeerFactoryLike = {
    createPeer() {
      const state = { aborted: false, disposed: 0 }
      const peer: PeerLike = {
        signal: { get aborted() { return state.aborted } },
        async dispose() { state.disposed += 1 },
      }
      peers.push({ peer, state })
      return peer
    },
  }
  return {
    factory,
    peers,
    abort: (index = 0): void => {
      const entry = peers[index]
      if (entry !== undefined) entry.state.aborted = true
    },
  }
}

function makeRunner(calls: { gateway: SessionGateway }, seats: () => PeerLike | undefined): TasksRunner {
  const commands = createTasksCommandsFixture()
  return new TasksRunner(
    () => calls.gateway,
    () => commands.commands,
    createTasksWorkspacesFixture,
    createTasksAgentsFixture,
    seats,
  )
}

const TASK = { id: 'task-peer', title: '盘前分析', prompt: '生成日报', agentPreset: 'master', permission: 'workspace-write' }

describe('TasksRunner 的 gateway peer 契约', () => {
  it('用户 宿主提供 createPeer 时每次网关调用都带同一个 owner Peer', async () => {
    // Given 一个可铸造 Peer 的 connection 面、一个记录线形状的契约网关，和一条带预设的手动任务
    const fake = createTasksGateway()
    const calls = recordCalls(fake.gateway)
    const connection = makePeerFactory()
    const peers = new GatewayPeerSeat(() => connection.factory)
    const runner = makeRunner(calls, () => peers.current())
    // When 起跑一次执行（预设校验、建会话、重命名、权限、发 prompt），再侦查它的结局
    const sessionId = await runner.launch(TASK, 'peer-exec-1')
    fake.setRunning(sessionId, false)
    await runner.inspect(sessionId, 0)
    // Then 每次调用（含 follow 流）都带着同一个 Peer，且 Peer 只铸造一次
    expect(calls.requests.map(request => request.namespace + '/' + request.method)).toEqual([
      'agentPresets/list',
      'session/create',
      'session/rename',
      'session/prompt',
      'session/list',
      'session/follow',
    ])
    expect(connection.peers).toHaveLength(1)
    const minted = connection.peers[0]
    expect(minted?.peer).toBeDefined()
    expect(calls.requests.every(request => request.peer === minted?.peer)).toBe(true)
  })

  it('用户 宿主没有 createPeer 时请求体与旧宿主逐字段一致', async () => {
    // Given 一个只有认证栅栏、没有 createPeer 的旧 connection 面
    const fake = createTasksGateway()
    const calls = recordCalls(fake.gateway)
    const legacy: PeerFactoryLike = {}
    const peers = new GatewayPeerSeat(() => legacy)
    const runner = makeRunner(calls, () => peers.current())
    // When 起跑一次执行，再单独读一次预设名册
    await runner.launch(TASK, 'legacy-exec-1')
    expect(await runner.listAgentPresets()).toEqual([{ id: 'master' }, { id: 'preset-a' }])
    // Then 每个请求体的键序列里都没有 peer，args 线形状与修改前完全一致
    expect(calls.requests.map(request => Object.keys(request).sort())).toEqual([
      ['args', 'method', 'namespace'],
      ['args', 'method', 'namespace'],
      ['args', 'method', 'namespace'],
      ['args', 'method', 'namespace'],
      ['args', 'method', 'namespace'],
    ])
    expect(calls.requests.map(request => request.args)).toEqual([
      {},
      { request: { sessionId: 'session-legacy-exec-1', agentPreset: 'master' } },
      { request: { sessionId: 'session-legacy-exec-1', title: '盘前分析' } },
      {
        request: {
          sessionId: 'session-legacy-exec-1',
          requestId: 'dshtrading-tasks-legacy-exec-1',
          mode: 'queue',
          content: [{ type: 'text', text: '生成日报' }],
        },
      },
      {},
    ])
    expect(peers.current()).toBeUndefined()
  })
})

describe('GatewayPeerSeat 的 Peer 生命周期', () => {
  it('用户 缓存的 Peer 被宿主释放后重建并释放旧 Peer', async () => {
    // Given 一个已经铸造并缓存了 Peer 的座位
    const connection = makePeerFactory()
    const peers = new GatewayPeerSeat(() => connection.factory)
    const first = peers.current()
    // When 宿主释放那个 Peer（signal 已 abort），随后再次取座
    connection.abort()
    const second = peers.current()
    // Then 重建出新 Peer、旧 Peer 被释放，且新 Peer 继续被复用
    expect(first).toBeDefined()
    expect(second).not.toBe(first)
    expect(connection.peers.map(entry => entry.state.disposed)).toEqual([1, 0])
    expect(peers.current()).toBe(second)
    expect(connection.peers).toHaveLength(2)
  })

  it('用户 插件 teardown 后座位释放 Peer 并停止复用', async () => {
    // Given 一个持有 Peer 的座位
    const connection = makePeerFactory()
    const peers = new GatewayPeerSeat(() => connection.factory)
    const peer = peers.current()
    // When 插件 teardown 调 dispose
    peers.dispose()
    // Then 缓存 Peer 被释放，座位不再交出它
    expect(connection.peers[0]?.state.disposed).toBe(1)
    expect(peers.current()).not.toBe(peer)
    expect(connection.peers).toHaveLength(2)
  })
})

describe('TradingTasksService 的预设名册', () => {
  let dir: string
  const disposed: TradingTasksService[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-tasks-peer-'))
  })

  afterEach(() => {
    for (const service of disposed.splice(0)) service.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('用户 名册读取失败降级为空表且同一故障段只留一条告警', async () => {
    // Given 一个名册读取会失败的网关、一个可铸造 Peer 的 connection 面，和一条收集告警的缝
    const requests: GatewayRequest[] = []
    let failing = true
    const gateway: SessionGateway = {
      async invoke(request) {
        requests.push(request)
        if (request.namespace !== 'agentPresets') return {}
        if (failing) throw Object.assign(new Error('gateway/peer-disposed'), { code: 'gateway/peer-disposed' })
        return { presets: [{ id: 'master' }] }
      },
    }
    const connection = makePeerFactory()
    const peers = new GatewayPeerSeat(() => connection.factory)
    const warnings: string[] = []
    const service = new TradingTasksService({
      ledgerPath: join(dir, 'ledger-v1.json'),
      gateway: () => gateway,
      peer: () => peers.current(),
      warn: (message, detail) => { warnings.push(message + ' ' + detail) },
    })
    disposed.push(service)
    // When 名册一直失败时连拉两次，然后恢复一次，再失败一次
    const first = await service.meta()
    const second = await service.meta()
    // Then 名册降级为空表（UI 只显示部署默认），两次失败只留一条告警
    expect(first.agentPresets).toEqual([])
    expect(second.agentPresets).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('agent preset roster unavailable')
    failing = false
    const recovered = await service.meta()
    // Then 恢复后名册回到宿主给的全表，新的一段故障重新留一条痕迹
    expect(recovered.agentPresets).toEqual([{ id: 'master' }])
    failing = true
    await service.meta()
    expect(warnings).toHaveLength(2)
    // Then 四次调用都带着同一个 owner Peer
    expect(requests).toHaveLength(4)
    expect(connection.peers).toHaveLength(1)
    expect(requests.every(request => request.peer === connection.peers[0]?.peer)).toBe(true)
  })
})
