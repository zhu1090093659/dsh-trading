/**
 * 图表激活名册 host SSOT 同步（issue #63，wireHostWatchlistSync 同款模式）：
 *
 * - 启动同步：GET /chart/indicators → host 有行则以 host 为准覆盖本地 observable；
 *   host 为空且本地 localStorage 有存量 → 一次性迁移导入（POST /chart/indicators/import，
 *   host 非空时服务端拒绝，幂等）→ 重拉 host。
 * - 变更 host-first：togglePreset / setParams / removeInstance 先写 host，成功后才
 *   更新本地 observable（localStorage 由原 store 持久化，降级为缓存镜像）。
 * - SSE：'chart' 失效信号 → 重拉 host 覆盖本地（indicator_activate/deactivate 工具
 *   写入、indicators/plugin emit 或其它标签页变更）。
 *
 * 语义保持：host 行不过 sanitize（与 chart-state 创建不 sanitize 同裁决）——未知 id
 * 实例对 UI 天然不可见（选择器按 definition 名册渲染），注册表就位后自动生效。
 * host 写入边界的 clamp 已在桥与工具层完成，客户端照单全收。
 */
import type { ChartStateStore } from './chart-state.ts'
import { indicators } from './indicator-registry.ts'
import {
  fetchChartActivations,
  importChartActivations,
  putChartActivation,
  removeChartActivation,
  subscribeTradingEvents,
} from './api.ts'

export interface HostChartSyncOptions {
  chart: ChartStateStore
}

/** 启动 host 同步 + 变更接管 + SSE 订阅；返回清理函数（插件卸载语义）。 */
export function wireHostChartSync(options: HostChartSyncOptions): () => void {
  const { chart } = options

  const syncFromHost = async (): Promise<void> => {
    try {
      const instances = await fetchChartActivations()
      chart.set({ instances })
    } catch {
      /* 桥不可用 → 本地镜像维持现状（不劣于升级前） */
    }
  }

  const boot = async (): Promise<void> => {
    try {
      const host = await fetchChartActivations()
      if (host.length > 0) {
        // host 已有激活行 → host 为准（可能来自工具写入或另一标签页）。
        chart.set({ instances: host })
        return
      }
      // host 为空 → 一次性迁移本地 localStorage 存量激活名册（幂等，服务端拒绝即跳过）。
      const local = chart.getSnapshot().instances
      if (local.length > 0) {
        const imported = await importChartActivations(local)
        if (imported) {
          chart.set({ instances: await fetchChartActivations() })
        }
        // 导入被拒（host 非空竞态）→ 拉一次 host 兜底对齐。
        else {
          await syncFromHost()
        }
      }
    } catch {
      /* 迁移/同步失败不阻断启动 */
    }
  }
  void boot()

  // 变更接管：host-first（成功后才更新本地 observable；localStorage 由原方法持久化为镜像）。
  const originalToggle = chart.togglePreset.bind(chart)
  chart.togglePreset = (id: string): void => {
    void (async () => {
      // 目标状态在本地翻转前判定：未激活 → 挂载（schema 默认参数）；已激活 → 摘除。
      const willActivate = !chart.isActive(id)
      const ok = willActivate
        ? await putChartActivation(id, defaultParamsFor(id))
        : await removeChartActivation(id)
      if (ok) originalToggle(id)
      else console.warn('[dsh-trading] chart toggle failed on host — local state unchanged')
    })()
  }
  const originalSetParams = chart.setParams.bind(chart)
  chart.setParams = (id: string, params: Record<string, number>): void => {
    void (async () => {
      const ok = await putChartActivation(id, params)
      if (ok) originalSetParams(id, params)
      else console.warn('[dsh-trading] chart param update failed on host — local state unchanged')
    })()
  }
  const originalRemove = chart.removeInstance.bind(chart)
  chart.removeInstance = (id: string): void => {
    void (async () => {
      const ok = await removeChartActivation(id)
      if (ok) originalRemove(id)
      else console.warn('[dsh-trading] chart instance removal failed on host — local state unchanged')
    })()
  }

  // SSE 失效信号：工具写入（indicator_activate 等）或其它标签页变更 → 重拉覆盖。
  return subscribeTradingEvents({
    chart: () => { void syncFromHost() },
  })
}

/** schema 默认参数（与 togglePreset 的 registry.defaultParams 同源；未知 id → 空）。 */
function defaultParamsFor(id: string): Record<string, number> | undefined {
  const definition = indicators.get(id)
  return definition !== undefined ? indicators.defaultParams(definition) : {}
}
