// 客户端半共享构建 base：client-ui-indicators / indicator-supertrend 两包摘掉各自的
// `const ID` 行后逐字节相同。与 tsdown.client.package.buffer.mjs 的唯一差异是 CSS 文本
// 直接给字符串、不包 Buffer（lightningcss 的 `code` 两者都收，实测产物相同）。
import { createClientBundleConfig as create } from './tsdown.client.preset.mjs'

export const createClientBundleConfig = (ID) => create(ID, { cssCodeFrom: 'string' })
