/**
 * Shell 面（最小结构镜像）：client-ui-strategies 不 import
 * client-ui-trading 的内部模块（插件间协作一律走 cordis 服务 inject），
 * 这里只镜像视图用到的纯类型/纯函数面——类型漂移的代价是编译期可见，
 * 行为面（fetch/SSE）全部经 tradingBridge 服务。
 *
 * readJson/writeJson 是 localStorage 纯工具（shell 同款实现，~20 行），
 * 镜像成本低于为此在服务面开洞。
 */

/** shell selection store 的最小形状面（hook selector 的输入类型）。 */
export interface SelectionState {
  instrument: { market: string; symbol: string; name?: string } | null
}

/** localStorage read that survives unavailable storage (privacy mode) and corrupt JSON. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** localStorage write that survives unavailable storage. */
export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — session-only degradation */
  }
}