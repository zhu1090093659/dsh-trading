import { packageConfig } from '../../tsdown.package.config.ts'

// node 半：与 connector/client-ui-settings 同款单步 tsdown（dts: true）。
// 浏览器半由 tsdown.client.config.mjs 构建（lib/client.js）。

export default packageConfig({
  entry: ['src/index.ts', 'src/client/locales.ts'],
})
