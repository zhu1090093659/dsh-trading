import { packageConfig } from '../../tsdown.package.config.ts'

export default packageConfig({
  entry: [
    'src/index.ts',
    'src/fx.ts',
    'src/tool.ts',
    'src/plugin.ts',
  ],
  platform: 'neutral',
})
