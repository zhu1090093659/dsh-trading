import { defineConfig } from 'tsdown'

// 两个入口：运行期（index，只读只验签）与签署期（sign，运营 CLI 与测试专用）。
// 运行期包**不得** import ./sign —— 见 test/authority.test.ts 的依赖方向断言。
export default defineConfig({
  entry: ['src/index.ts', 'src/sign.ts', 'src/testing.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
