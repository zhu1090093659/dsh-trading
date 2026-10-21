import { packageConfig } from '../../tsdown.package.config.ts'

// bundle 包无运行时 API，构建只为维持 files 白名单里的 lib 产物统一。

export default packageConfig({
  entry: ['src/index.ts'],
})
