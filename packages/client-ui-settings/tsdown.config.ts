import { defineConfig } from 'tsdown'

// node 半：与 connector 同款单步 tsdown（dts: true）。
// 浏览器半由 tsdown.client.config.mjs 构建（lib/client.js），bundle 脚本负责两者 + 重命名。
export default defineConfig({
  entry: ['src/index.ts', 'src/client/locales.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: false,
  unbundle: true,
  fixedExtension: false,
})
