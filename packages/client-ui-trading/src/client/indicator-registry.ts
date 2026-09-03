/**
 * 行情视图的本地指标注册表（模块单例，页面生命周期）。指标 definition
 * 的来源有两个：指标插件（client-ui-indicators 经 tradingIndicators 服务
 * 提供，index.ts 桥接合并）与未来的用户自定义加载；插件未安装时注册表
 * 为空，行情视图零指标正常工作（sanitizer 对未知 id 天然免疫）。
 */
import { createIndicatorRegistry } from '@dshtrading/indicators'

export const indicators = createIndicatorRegistry()

/**
 * 自定义指标 id 跟踪（issue #30 删除入口）：从桥加载时登记、删除成功时移除；
 * 指标选择器 UI 据此只给自定义行渲染删除按钮（预置/插件指标不可删）。
 */
const customIds = new Set<string>()

export function markCustomIndicator(id: string): void {
  customIds.add(id)
}

export function unmarkCustomIndicator(id: string): void {
  customIds.delete(id)
}

export function isCustomIndicator(id: string): boolean {
  return customIds.has(id)
}
