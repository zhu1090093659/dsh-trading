import { packageConfig } from '../../tsdown.package.config.ts'

export default packageConfig({
  entry: ['src/index.ts', 'src/client/locales.ts'],
  clean: false,
})
