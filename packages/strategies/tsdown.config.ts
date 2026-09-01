import { defineConfig } from 'tsdown'

// 纯库包（neutral 平台，零 runtime 依赖，浏览器与 node 均可打包）
export default defineConfig({
  entry: ['src/index.ts', 'src/plugin.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
