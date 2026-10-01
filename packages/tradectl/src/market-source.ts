/**
 * 行情源并存契约（P3 步骤 4 后半）：让 streaming 源与既有的
 * tradingMarketDataRegistry / tradingMarketRouter **并存**，而 23 个既有连接器
 * **一行都不用改**。
 *
 * 卡片原文："可选 capabilities() 声明 snapshot-only vs streaming，**缺席按
 * snapshot-only**"。这条规则的用意是**默认安全**：一个连接器没声明能力时，我们必须
 * 假设它只会快照——如果反过来默认它能推流，那么任何"还没跟上新契约"的连接器都会在
 * 运行时被当成推流源，然后在一个没人注意的路径上给出不完整的数据。
 *
 * 所以本模块做三件事：
 *   1. 能力探测：对象上有 capabilities() 且显式声明 streaming 才算流式，其余（缺席、
 *      抛错、字段缺失、类型不对）**一律按 snapshot-only**；
 *   2. 流式适配：把流式源接到与既有 registry/router 同形的**结构面**上（只依赖
 *      register/unregister 这类最小形状，不 import 它们的类型）；
 *   3. 快照回退：snapshot-only 的连接器走原来的路径，适配器**不碰**它（零改动）。
 *
 * @module @dshtrading/tractl/market-source
 */
/** 连接器可选声明的能力（缺席即 snapshot-only）。 */
export interface MarketCapabilities {
  readonly streaming?: boolean
  /** 推流时使用的通道标识（诊断用）。 */
  readonly channel?: string
}

/** 最小结构面：既有 registry 只需要 register/unregister 这类形状。 */
export interface MarketSourceRegistryLike {
  register(source: { readonly market: string; readonly channel: string }): () => void
  list(): readonly { readonly market: string; readonly channel: string }[]
}

/** 一次能力探测的结果。 */
export interface CapabilityVerdict {
  readonly streaming: boolean
  readonly channel: string
  /** 为什么这么判（诊断与审计都要能看到理由）。 */
  readonly reason: string
}

/**
 * 探测一个连接器/服务的能力。**任何异常路径都落到 snapshot-only**。
 * @param service - 可能是连接器、可能是服务对象、也可能什么都没有。
 * @param fallbackChannel - 快照通道名。
 */
export function probeCapabilities(service: unknown, fallbackChannel = 'snapshot'): CapabilityVerdict {
  if (service === null || typeof service !== 'object') {
    return { streaming: false, channel: fallbackChannel, reason: 'no service: snapshot-only' }
  }
  const candidate = (service as { capabilities?: unknown }).capabilities
  if (typeof candidate !== 'function') {
    return { streaming: false, channel: fallbackChannel, reason: 'no capabilities() method: snapshot-only (absence means snapshot-only by contract)' }
  }
  let declared: unknown
  try {
    declared = (candidate as () => unknown).call(service)
  } catch (error) {
    return {
      streaming: false,
      channel: fallbackChannel,
      reason: 'capabilities() threw (' + (error instanceof Error ? error.message : String(error)) + '): snapshot-only',
    }
  }
  if (declared === null || typeof declared !== 'object') {
    return { streaming: false, channel: fallbackChannel, reason: 'capabilities() returned a non-object: snapshot-only' }
  }
  const streaming = (declared as MarketCapabilities).streaming
  if (streaming !== true) {
    return { streaming: false, channel: fallbackChannel, reason: 'capabilities().streaming is not literally true: snapshot-only' }
  }
  const channel = (declared as MarketCapabilities).channel
  return {
    streaming: true,
    channel: typeof channel === 'string' && channel !== '' ? channel : 'stream',
    reason: 'capabilities().streaming === true',
  }
}

/** 一个市场源（流式或快照）在适配器里的登记项。 */
export interface RegisteredSource {
  readonly market: string
  readonly channel: string
  readonly streaming: boolean
}

/**
 * 把一组市场源接到既有 registry 上：流式的注册为 streaming 源，其余**原样留在
 * 快照路径上**（不做任何包装、不改动传入对象）。
 * @param registry - 与既有 registry 同形的最小结构面。
 * @param sources - market -> 连接器/服务。
 */
export function attachMarketSources(
  registry: MarketSourceRegistryLike,
  sources: Readonly<Record<string, unknown>>,
): { readonly registered: readonly RegisteredSource[]; readonly snapshotOnly: readonly string[]; dispose(): void } {
  const disposers: (() => void)[] = []
  const registered: RegisteredSource[] = []
  const snapshotOnly: string[] = []
  for (const market of Object.keys(sources).sort()) {
    const verdict = probeCapabilities(sources[market])
    if (!verdict.streaming) {
      snapshotOnly.push(market)
      continue
    }
    const source = { market, channel: verdict.channel }
    disposers.push(registry.register(source))
    registered.push({ market, channel: verdict.channel, streaming: true })
  }
  return {
    registered,
    snapshotOnly,
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

/**
 * 一个进程内的最小 registry（与既有 registry 的 register/list 同形），供测试与
 * 单机形态使用；生产里由既有的 tradingMarketDataRegistry 承担。
 */
export function createMemorySourceRegistry(): MarketSourceRegistryLike & { readonly size: number } {
  const items: { market: string; channel: string }[] = []
  return {
    register(source) {
      items.push(source)
      return () => {
        const index = items.indexOf(source)
        if (index >= 0) items.splice(index, 1)
      }
    },
    list: () => items.slice(),
    get size() {
      return items.length
    },
  }
}
