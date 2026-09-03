import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 逻辑测试走 node；渲染冒烟测试文件内 @vitest-environment jsdom 指定
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
})
