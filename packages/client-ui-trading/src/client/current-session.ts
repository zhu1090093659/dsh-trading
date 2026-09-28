/**
 * 当前会话读面（0.1.7）。
 *
 * 0.1.7 把客户端 Session 多实例共存落到服务面：`SessionListState` 删除了
 * `current` 字段，selection 内化进 `UiWorkspaceService`（私有），插件服务面
 * 没有公开读法。官方 ui-layout（DocumentTitle）与 ui-workspace
 * （WorkspaceBrowser / mainSessionId）在同一世代一律按「mainView 引用计数 > 0」
 * 解出主视图会话——dsh-client-ui-session 把 `mainView` 声明进
 * `SessionReferenceSourceMap`，主视图 retain 的会话计数为正。
 *
 * 本仓 cohort 未直接依赖 dsh-client-ui-session（该类型增补不在解析面），
 * 故按结构读取并本地收窄；语义与官方一致：找不到即「无当前会话」。
 * HomeHistory 的 blank 可见性与 ChatResizeHandle 的在场判定共用此读法。
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'

/** 从会话列表快照解出主视图当前会话 id；无 mainView 保留时为 undefined。 */
export function currentSessionId(list: SessionListState): string | undefined {
  for (const session of Object.values(list.byId)) {
    const retainedBy = session.retainedBy as Readonly<Record<string, number | undefined>>
    if ((retainedBy.mainView ?? 0) > 0) return session.id
  }
  return undefined
}
