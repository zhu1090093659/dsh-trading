import { defineConfig } from 'tsdown'

// 单入口微包（仅 dshHomeDir 纯函数），与 watchlist 同款 tsdown 配置。
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
