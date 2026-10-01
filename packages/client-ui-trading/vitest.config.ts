import { defineConfig } from 'vitest/config'

// node 半的 tasks/bridge 用例已搬到 @dshtrading/bot-api；这里只剩客户端半。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
})
