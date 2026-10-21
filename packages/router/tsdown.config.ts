import { packageConfig } from '../../tsdown.package.config.ts'

// 与 connector-okx 同款：单步 tsdown（dts: true），官方两段式 tsc -b 不采纳（S5 评审结论 2）。
// 本包的 cosmokit 只有类型导入；裸 specifier 由共享口径的 deps.neverBundle 保证（见根
// tsdown.package.config.ts），故 peer 声明与构建产物两侧都不会指向 .pnpm 相对路径。

export default packageConfig({
  entry: ['src/index.ts', 'src/catalog.ts'],
})
