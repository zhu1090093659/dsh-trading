import { packageConfig } from '../../tsdown.package.config.ts'

// 与 strategies 同款：单步 tsdown（dts: true）；index（纯类型+内存 store）与
// plugin（node 半工具插件）双入口。

export default packageConfig({
  entry: ['src/index.ts', 'src/plugin.ts'],
})
