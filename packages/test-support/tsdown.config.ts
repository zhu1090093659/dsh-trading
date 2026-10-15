import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  // vitest 是本包唯一的运行期 import，且在 devDependencies 里（消费方自带 vitest）；
  // tsdown 默认只外置 dependencies/peerDependencies，不显式外置会把 vitest 的模块
  // 图拷进 lib/node_modules（实测 48 个文件 600 kB）。
  external: ['vitest'],
  fixedExtension: false,
})
