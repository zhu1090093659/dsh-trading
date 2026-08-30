/**
 * 行情视图的本地指标注册表（模块单例，页面生命周期）。指标 definition
 * 的来源有两个：指标插件（client-ui-indicators 经 tradingIndicators 服务
 * 提供，index.ts 桥接合并）与未来的用户自定义加载；插件未安装时注册表
 * 为空，行情视图零指标正常工作（sanitizer 对未知 id 天然免疫）。
 */
import { createIndicatorRegistry } from '@dsh-trading/indicators'

export const indicators = createIndicatorRegistry()
