import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // parser 测试走 node；卡片渲染测试文件内 @vitest-environment jsdom 指定
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
})