/**
 * scope 三平面（P4 步骤 1）：read / command / control。
 *
 * %%control%% **永不默认签发**：它是"停掉一切"的开关（kill/pause/flatten），
 * 默认给出等于把紧急刹车交给每个新设备。这条与 P2 edge 的规则是同一条裁决，
 * 这里的定义是**线上面**的权威词汇，P2 的 edge 实现应当引用它（跨包改造另开一次变更）。
 *
 * @module @dshtrading/contract/scopes
 */
/** 三个平面。 */
export const SCOPE_PLANES = ['read', 'command', 'control'] as const

export type ScopePlane = (typeof SCOPE_PLANES)[number]

/** 默认签发的平面（配对时给的）。 */
export const DEFAULT_SCOPE_PLANES: readonly ScopePlane[] = ['read']

/** 需要显式授予的平面。 */
export const EXPLICIT_SCOPE_PLANES: readonly ScopePlane[] = ['control']

/** 判定一个字符串是不是合法平面。 */
export function isScopePlane(value: unknown): value is ScopePlane {
  return typeof value === 'string' && (SCOPE_PLANES as readonly string[]).includes(value)
}

/**
 * 过滤出"可以默认签发"的平面：无论请求里怎么写，control 都被剔除。
 * @param requested - 请求的作用域。
 */
export function grantableByDefault(requested: readonly string[]): ScopePlane[] {
  const wanted = new Set<ScopePlane>([...requested.filter(isScopePlane), ...DEFAULT_SCOPE_PLANES])
  // 按 SCOPE_PLANES 的声明顺序输出：稳定顺序是契约的一部分（客户端可以依赖它做 diff）
  return SCOPE_PLANES.filter((plane) => wanted.has(plane) && !EXPLICIT_SCOPE_PLANES.includes(plane))
}
