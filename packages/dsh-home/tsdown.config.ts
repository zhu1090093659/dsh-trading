import { packageConfig } from '../../tsdown.package.config.ts'

// 单入口微包（仅 dshHomeDir 纯函数），与 watchlist 同款 tsdown 配置。

export default packageConfig({
  entry: ['src/index.ts'],
})
