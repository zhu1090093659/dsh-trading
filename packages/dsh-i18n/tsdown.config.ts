import { packageConfig } from '../../tsdown.package.config.ts'

// node 半：host no-op apply + 类型产物（client-ui-settings 同款单步 tsdown）。
// 浏览器半由 tsdown.client.config.mjs 构建（lib/client.js）。

export default packageConfig({
  entry: ['src/index.ts'],
})
