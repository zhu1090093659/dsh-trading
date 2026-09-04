import { defineConfig } from 'tsdown'

// node 半：host no-op apply + 类型产物（dsh-i18n 同款单步 tsdown）。
// 浏览器半由 tsdown.client.config.mjs 构建（lib/client.js）。
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: false,
  unbundle: true,
  fixedExtension: false,
})
