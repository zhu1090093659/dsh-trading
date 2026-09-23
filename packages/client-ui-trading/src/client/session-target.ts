/**
 * 活动会话读面桥（0.1.7）。
 *
 * 0.1.7 官方把「当前会话」选择内化进 uiWorkspace（UiWorkspaceService.selection
 * 私有），ISessions 面不再有 list.current / open，插件服务面没有公开读法。
 * 但 session 作用域 slot 的 inject 工厂会收到框架解析的 sessionId
 * （dsh-client-ui-renderer 的 runInject：scope binding 的 key 作为首个参数，
 * 结果按 entry × binding 记忆化）。本模块挂一个零渲染的
 * conversation.input.left 条目，把活动会话 id 投影到插件本地 holder，
 * 供「发给 Agent」定位填充目标；无会话时组件卸载把 holder 清回 undefined——
 * 宁显式报错，不猜会话（猜错会把行情写进错误的 composer）。
 *
 * 这是官方 slot 契约上的薄扩展层，不复制官方选择状态：holder 只读、只投影
 * 当前活动会话 id。
 */
import * as React from 'react'

/** 活动会话 id 的插件本地读面（`current` 由采集件写入）。 */
export interface SessionTargetHolder {
  current: string | undefined
}

/** 建一个空 holder（插件 apply 时创建，注入采集件与 fillComposer 共享同一实例）。 */
export function createSessionTargetHolder(): SessionTargetHolder {
  return { current: undefined }
}

/** 采集件自己的注入面（inject 工厂按 session 作用域收到 sessionId，回传组件）。 */
export interface SessionTargetProbeInjected {
  sessionId: string | undefined
  holder: SessionTargetHolder
}

/** 零渲染采集件：挂载写 holder，卸载（或无会话）清回 undefined。 */
export function SessionTargetProbe({ sessionId, holder }: SessionTargetProbeInjected): null {
  React.useEffect(() => {
    holder.current = sessionId
    return () => {
      if (holder.current === sessionId) holder.current = undefined
    }
  }, [sessionId, holder])
  return null
}
