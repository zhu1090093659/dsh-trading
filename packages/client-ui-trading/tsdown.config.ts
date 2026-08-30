import { defineConfig } from 'tsdown'

// node 半：与 connector/client-ui-settings 同款单步 tsdown（dts: true）。
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
