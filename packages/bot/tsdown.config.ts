import { defineConfig } from 'tsdown'

// bundle 包本体没有运行时 API；两个子入口是 bot surface 自己的行：
// ./startup 解析 bot 的 CLI 参数并提供 botStartup，./http 用自带的 node:http
// 传输行提供 webServer/connection（不踩官方 web 栈，见 cordis.patch.yml 头注）。
export default defineConfig({
  entry: ['src/index.ts', 'src/startup.ts', 'src/http.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
