import { packageConfig } from '../../tsdown.package.config.ts'

// 与 connector-eastmoney 同款：单步 tsdown（dts: true），官方两段式 tsc -b 不采纳（S5 评审结论 2）。

export default packageConfig({
  entry: [
    'src/index.ts',
    'src/dataplane.ts',
    'src/global-plugin.ts',
  ],
})
