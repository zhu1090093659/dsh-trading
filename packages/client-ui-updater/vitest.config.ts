import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 纯 node 逻辑测试（semver / service / 假 profile 应用管线）。
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
