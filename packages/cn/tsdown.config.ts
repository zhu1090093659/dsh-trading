import { defineConfig } from 'tsdown'

// bundle 包无运行时 API，构建只为维持 files 白名单里的 lib 产物统一。
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
