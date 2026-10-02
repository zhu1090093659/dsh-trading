/**
 * 首屏流程（P4 ④）：配对输入 → session-manager.pair() → 安全存储 → 显示 scopes / 错误。
 *
 * 这个模块存在的理由：**App.tsx 只渲染，不判**。
 *   - 陈旧度：offline.ts → 契约 offlineView（过期数据不渲染数据本身）；
 *   - 确认档位：confirm.ts → 契约 ACTION_CONFIRM（control 类一律 biometric，未知动作 fail closed）；
 *   - 版本与能力：session.ts → 契约 negotiateVersion（服务端能力头原文进来，客户端不自行判兼容）；
 *   - 令牌与地址：session-manager / credential-store（只进安全存储，且与配对地址绑定）。
 *
 * 三条不变量：
 *   1. **失败不静默**：服务端返回的 code/message 原样进快照，界面直接显示；
 *   2. **未配对就是未配对**：state='unpaired' 是明确状态（不是空屏）；此时不建客户端、不发请求；
 *   3. **换设备先清缓存**：配对成功与断开都会清掉上一台设备留下的数据（陈旧度从 unknown 重新开始），
 *      免得把上一台设备看到的持仓当成这台设备的现状。
 */
import { CAPS_HEADER, ACTION_SCOPE, type ActionKind } from '@dshtrading/contract/core'
import type { ApiClient } from './api.ts'
import { gateForAction, type GateDecision, type Platform } from './confirm.ts'
import { offlineBanner, type OfflineBanner, type StalenessBudgets } from './offline.ts'
import { normalizeBaseUrl } from './pairing.ts'
import type { StoredDevice } from './credential-store.ts'
import type { SessionManager } from './session-manager.ts'
import { describeHandshake, handshake } from './session.ts'

/** 一条失败（配对、取状态、断开）：码与文案都来自产生它的那一层，UI 不猜。 */
export interface FlowError {
  readonly code: string
  readonly message: string
}

export type ConnectionState = 'unpaired' | 'pairing' | 'paired'

/** control 类动作的闸门视图：档位来自契约，作用域来自配对时服务端签发的 scopes。 */
export interface ControlGateView {
  readonly action: ActionKind
  readonly decision: GateDecision
  /** 契约 ACTION_SCOPE 给出的平面（kill ⇒ control）。 */
  readonly scope: string
  /** 服务端签发的作用域里有没有它（没有 = 该动作会被 edge 403）。 */
  readonly granted: boolean
}

/** 首屏可渲染的全部状态。state='unpaired' 就是"未配对"，不是空屏。 */
export interface HomeSnapshot {
  readonly state: ConnectionState
  /** 最近一次失败（配对/取状态/断开）。成功或未发生时为 null。 */
  readonly error: FlowError | null
  /** 已绑定的 bot 基址（未配对为 null）。 */
  readonly baseUrl: string | null
  readonly deviceId: string | null
  readonly scopes: readonly string[]
  /** scopes 的显示形式（'read、command'；未配对为 ''）。 */
  readonly scopesText: string
  /** 到期提示：如实说明令牌什么时候失效（见 EXPIRY_HINT）。 */
  readonly expiryHint: string
  /** 最近一次成功响应声明的服务端能力（解析后）。 */
  readonly caps: readonly string[]
  /** 能力头原文；null = 服务端这次没声明能力（与"声明了空集合"不同）。 */
  readonly capsHeader: string | null
  /** 契约协商结论（在契约里判，这里只存结论）；没取到能力头时为 ''。 */
  readonly contractText: string
  /** 服务端运行状态的人话（取不到时为 ''）。 */
  readonly stateText: string
  /** 最近一次成功取状态的时刻（本地时钟）；从未成功为 null。 */
  readonly lastSyncAtMs: number | null
  /** 最近一次取状态失败（原样保留；数据仍按陈旧度展示）。 */
  readonly lastSyncError: FlowError | null
  /** 离线/陈旧度横幅（判据在契约 offlineView；永远有值：无数据是 notice）。 */
  readonly banner: OfflineBanner<unknown>
  /** 控制动作闸门（默认取最要紧的 kill）。 */
  readonly control: ControlGateView
}

export interface HomeFlowOptions {
  readonly manager: SessionManager
  /** 注入时钟（陈旧度要用；测试里可控）。 */
  readonly now: () => number
  /** 陈旧度预算；缺省 DEFAULT_BUDGETS。 */
  readonly budgets?: StalenessBudgets
  /** 平台（决定确认档位；首屏语境默认移动端）。 */
  readonly platform?: Platform
  /** 配对时上报的设备名（服务端截断到 64 字符）。 */
  readonly deviceName?: string
}

export interface HomeFlow {
  /** 当前快照（同步；渲染用）。 */
  snapshot(): HomeSnapshot
  /** 启动时读一次安全存储：有凭据 ⇒ 已配对，没有 ⇒ 未配对（不建客户端）。 */
  restore(): Promise<HomeSnapshot>
  /** 用输入的基址与一次性配对码配对；成功落库并显示 scopes，失败原样显示 code/message。 */
  pair(input: { readonly baseUrl: string; readonly code: string; readonly name?: string }): Promise<HomeSnapshot>
  /** 断开：清掉本机凭据与缓存数据。 */
  forget(): Promise<HomeSnapshot>
  /** 取状态（需要已配对；未配对返回 null，不发任何请求）。 */
  client(): Promise<ApiClient | null>
  /** 调一次 /a0/status：验证令牌可用 + 刷新服务端状态与数据时刻（失败保留旧快照，让陈旧度说话）。 */
  sync(): Promise<HomeSnapshot>
  /** 某个动作需要什么确认（判据在契约，不在 App）。 */
  controlGate(action: ActionKind): GateDecision
}

/** 陈旧度预算（客户端策略；契约只规定分档语义，不规定秒数）。 */
export const DEFAULT_BUDGETS: StalenessBudgets = { freshMs: 30_000, staleMs: 5 * 60_000, ttlMs: 30 * 60_000 }

/** 未配对时的默认设备名（App 目前不读设备型号，先如实写一个固定名）。 */
const DEFAULT_DEVICE_NAME = 'dsh-trading mobile'

/** 本地快照的 sourceId（与 bot 远端数据区分；跨源不混由 data-source 守卫负责）。 */
const REMOTE_SOURCE_ID = 'bot'

/**
 * 到期提示（**如实，不编倒计时**）：edge 的配对响应只有 deviceId/secret/scopes，
 * 设备记录只有 createdAtMs（edge.ts:61-68），**没有到期字段**；让令牌失效的动作只有
 * 桌面端的 revoke（revoke-device，属 control 类，移动端要生物识别）。
 */
const EXPIRY_HINT = '设备令牌没有到期时间：桌面端撤销或本机「断开」前一直有效'

/** 从 /a0/status 的响应体里取"运行状态"的人话；形状不对就返回 ''（不猜）。 */
function stateTextOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const state = (data as Record<string, unknown>).state
  if (state === null || typeof state !== 'object') return ''
  const record = state as Record<string, unknown>
  if (record.killed === true) return '已停机（kill 已触发）'
  if (record.paused === true) return '已暂停'
  return '运行中'
}

/**
 * 建一条首屏流程。
 * @param options - 会话管理器、时钟与预算。
 */
export function createHomeFlow(options: HomeFlowOptions): HomeFlow {
  const budgets = options.budgets ?? DEFAULT_BUDGETS
  const platform: Platform = options.platform ?? 'mobile'
  const deviceName = options.deviceName ?? DEFAULT_DEVICE_NAME

  let state: ConnectionState = 'unpaired'
  let error: FlowError | null = null
  let device: StoredDevice | null = null
  let caps: readonly string[] = []
  let capsHeader: string | null = null
  let lastSync: { readonly data: unknown; readonly atMs: number; readonly sourceId: string } | null = null
  let lastSyncError: FlowError | null = null

  /** 从契约 ACTION_SCOPE 取平面，再对一次服务端签发的 scopes —— 判据不在 App。 */
  function controlViewOf(action: ActionKind, scopes: readonly string[]): ControlGateView {
    const scope = ACTION_SCOPE[action]
    return { action, decision: gateForAction(action, platform), scope, granted: scopes.includes(scope) }
  }

  function snapshot(): HomeSnapshot {
    const scopes = device === null ? [] : device.scopes
    const contractText = capsHeader === null ? '' : describeHandshake(handshake({ headers: { [CAPS_HEADER]: capsHeader } }))
    return {
      state,
      error,
      baseUrl: device === null ? null : device.baseUrl,
      deviceId: device === null ? null : device.deviceId,
      scopes,
      scopesText: scopes.join('、'),
      expiryHint: device === null ? '' : EXPIRY_HINT,
      caps,
      capsHeader,
      contractText,
      stateText: stateTextOf(lastSync === null ? null : lastSync.data),
      lastSyncAtMs: lastSync === null ? null : lastSync.atMs,
      lastSyncError,
      banner: offlineBanner(lastSync ?? undefined, options.now(), budgets),
      control: controlViewOf('kill', scopes),
    }
  }

  /**
   * 失败后按**存储里的事实**定位状态：失败的尝试不改动已有凭据，
   * 所以不能一律把自己当成"未配对"（那会让界面否认一份仍然存在的凭据）。
   */
  async function resyncStateFromStore(): Promise<void> {
    device = await options.manager.current()
    state = device === null ? 'unpaired' : 'paired'
  }

  /** 清掉与某台设备绑定的缓存数据（换设备/断开时用）。 */
  function clearCachedData(): void {
    caps = []
    capsHeader = null
    lastSync = null
    lastSyncError = null
  }

  return {
    snapshot,

    async restore() {
      const stored = await options.manager.current()
      device = stored
      state = stored === null ? 'unpaired' : 'paired'
      error = null
      if (stored === null) clearCachedData()
      return snapshot()
    },

    async pair(input) {
      const baseUrl = normalizeBaseUrl(input.baseUrl)
      if (baseUrl === '') {
        // 空地址连请求都发不出去（fetch 会 reject），这里先说清楚，别让用户看网络错误码
        error = { code: 'PAIR_BASE_URL_EMPTY', message: '请先填写 bot 基址，例如 http://192.168.1.10:3081' }
        await resyncStateFromStore()
        return snapshot()
      }
      state = 'pairing'
      error = null
      let outcome: Awaited<ReturnType<SessionManager['pair']>>
      try {
        outcome = await options.manager.pair({ baseUrl, code: input.code, name: input.name ?? deviceName })
      } catch (thrown) {
        // 落库失败（如 Keychain 写入被拒）也必须离开"正在配对"，不能停在半路
        error = { code: 'PAIR_FAILED', message: thrown instanceof Error ? thrown.message : String(thrown) }
        await resyncStateFromStore()
        return snapshot()
      }
      if (!outcome.ok) {
        error = { code: outcome.code, message: outcome.message }
        await resyncStateFromStore()
        return snapshot()
      }
      device = outcome.session.device
      state = 'paired'
      clearCachedData()
      return snapshot()
    },

    async forget() {
      try {
        await options.manager.forget()
      } catch (thrown) {
        // 解绑失败**不能装作成功**：重读存储，按事实说话
        error = { code: 'FORGET_FAILED', message: thrown instanceof Error ? thrown.message : String(thrown) }
        await resyncStateFromStore()
        return snapshot()
      }
      device = null
      state = 'unpaired'
      error = null
      clearCachedData()
      return snapshot()
    },

    async client() {
      // 未配对 ⇒ null（session-manager 读存储，没凭据就不建客户端，也不会发请求）
      return options.manager.client()
    },

    async sync() {
      const stored = await options.manager.current()
      device = stored
      if (stored === null) {
        state = 'unpaired'
        clearCachedData()
        return snapshot()
      }
      state = 'paired'
      const api = await options.manager.client()
      if (api === null) {
        // 存储里刚有、这里建不出来：按未配对处理并说清楚
        state = 'unpaired'
        device = null
        clearCachedData()
        error = { code: 'CLIENT_UNAVAILABLE', message: '凭据读不出来，请重新配对' }
        return snapshot()
      }
      const result = await api.get<unknown>('/a0/status')
      if (result.ok) {
        caps = result.caps
        capsHeader = result.capsHeader
        lastSync = { data: result.data, atMs: options.now(), sourceId: REMOTE_SOURCE_ID }
        lastSyncError = null
      } else {
        // 失败不改数据，只记错误 —— "数据变旧"由契约陈旧度表达，不在这里另判一套
        lastSyncError = { code: result.code, message: result.message }
      }
      return snapshot()
    },

    controlGate: (action) => gateForAction(action, platform),
  }
}
