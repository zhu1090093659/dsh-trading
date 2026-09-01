/**
 * Shell 面（最小结构镜像）：client-ui-knowledge 不 import
 * client-ui-trading 的内部模块（插件间协作一律走 cordis 服务 inject）。
 * readJson/writeJson 是 localStorage 纯工具（shell 同款实现，~20 行），
 * 镜像成本低于为此在服务面开洞。
 */

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