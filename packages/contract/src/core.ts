/**
 * 契约核心面：不含 id 工厂的那部分契约，客户端与本仓机检都以它为权威入口。
 *
 * 为什么这个入口排除 ids.ts：ids.ts 用 globalThis.crypto.randomUUID()（Web Crypto）生成 id，
 * 而 **Hermes（React Native 的 JS 引擎）默认没有 WebCrypto** —— 引到 id 工厂会在运行时炸
 * （这是 2026-10-01 立此入口的初因；Expo/RN 工程已于 2026-10-02 退役）。
 * 本入口真正承载的是：版本协商、作用域、卡片、推送载荷、确认策略、离线陈旧度、数据源守卫。
 *
 * 现在的消费者（2026-10-02 复核）：apps/ios-native 的契约防漂移工具链直接以本文件为权威入口
 * （scripts/gen-contract-snapshot.mjs、scripts/ios-native/check-contract-drift.mjs），
 * 并由 ContractDriftTests 断言；它同时是 tsdown 的构建入口。退役 Expo 工程不改变这一点。
 *
 * 边界靠测试守：test/core-entry.test.ts 沿相对导入走图谱，断言这里可达的源码
 * 既没有真正的 node: import，也不包含 ids.ts。
 *
 * 更正记录（2026-10-01）：本文件第一版把理由写成「ids.ts 用 node:crypto」—— 那是错的，
 * 我当时把自己 grep 到的**注释**（ids.ts 里解释"为什么不用 node:crypto"的那段）当成了 import。
 * 事实是全 src 零 node: import；真正的客户端障碍是 WebCrypto 缺席。
 */
export * from './version.ts'
export * from './scopes.ts'
export * from './cards.ts'
export * from './push.ts'
export * from './confirm.ts'
export * from './offline.ts'
export * from './source-guard.ts'
