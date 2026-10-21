import { packageConfig } from '../../tsdown.package.config.ts'

// 【提案】单步 tsdown（dts: true），官方两段式 tsc -b 不采纳（S5 评审结论 2）。
// cordis 必须保持外部裸说明符：dts 生成器会把类型专用外部包解析成 ./node_modules/.pnpm/...
// 相对路径，那会让本包 lib/index.d.ts 里的 `declare module '@deepseek-ai/cordis'` 变成新的
// ambient 模块而不是 augmentation（消费方 Context 身份分裂，2026-10-08 实测 router 7 条
// TS2379/TS2339）。共享口径的 neverBundle 已覆盖全部 @deepseek-ai/*，这里不再单列。

export default packageConfig({
  entry: ['src/index.ts'],
})
