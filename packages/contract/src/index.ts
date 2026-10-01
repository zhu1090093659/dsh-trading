/**
 * @dshtrading/contract —— 客户端与服务端之间的**自持**契约（P4 步骤 1）。
 *
 * 为什么自持而不是复用官方 Typert wire：
 *   - 移动端的信任面是"设备 + 可撤销的令牌"，而 Typert 的信任面是同源浏览器会话
 *     （%%无 cookie 不成立%%），无法按设备撤销；
 *   - 把 App 的发布节奏绑到 DSH cohort 上，会让"官方升级"与"App 能用"变成同一件事。
 *
 * **零第三方依赖**（只用 %%node:crypto%%）：这个包要同时被服务端、网页 SPA 与移动 App
 * 引用，任何第三方依赖都会变成三边的共同约束。
 */
export * from './ids.ts'
export * from './version.ts'
export * from './scopes.ts'
export * from './cards.ts'
