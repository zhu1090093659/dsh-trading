// 客户端半共享构建 base：client-ui-knowledge / client-ui-settings / client-ui-strategies /
// client-ui-updater 四包摘掉各自的 `const ID` 行后逐字节相同。
// 与本 base 并列的 tsdown.client.package.string.mjs 只差 CSS 文本是否包 Buffer。
import { createClientBundleConfig as create } from './tsdown.client.preset.mjs'

export const createClientBundleConfig = (ID) => create(ID, { cssCodeFrom: 'buffer' })
