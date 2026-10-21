import { packageConfig } from '../../tsdown.package.config.ts'

// 纯库包（neutral 平台）：node 与浏览器两侧都能打包。
// 裸 specifier 由共享口径的 deps.neverBundle 保证，见根 tsdown.package.config.ts。

export default packageConfig({
  entry: [
    'src/index.ts',
    'src/tool.ts',
    'src/plugin.ts',
  ],
  platform: 'neutral',
})
