import { packageConfig } from '../../tsdown.package.config.ts'

// 纯库包（neutral 平台，零 runtime 依赖，浏览器与 node 均可打包）

export default packageConfig({
  entry: ['src/index.ts', 'src/plugin.ts'],
  platform: 'neutral',
})
