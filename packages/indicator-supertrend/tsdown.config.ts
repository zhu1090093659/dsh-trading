import { packageConfig } from '../../tsdown.package.config.ts'

// node 半：client-ui-indicators 同款单步 tsdown（dts: true）。

export default packageConfig({
  entry: ['src/index.ts'],
  clean: false,
})
