import { packageConfig } from '../../tsdown.package.config.ts'

export default packageConfig({
  entry: ['src/index.ts'],
  // vitest 是本包唯一的运行期 import，且在 devDependencies 里（消费方自带 vitest）；
  // 不外置会把 vitest 的模块图拷进 lib/node_modules（实测 48 个文件 600 kB）。
  // @dshtrading/api 由共享口径的 scope 规则覆盖，无需重复声明。
  deps: { neverBundle: ['vitest'] },
})
