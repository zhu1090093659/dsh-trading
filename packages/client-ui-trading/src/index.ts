/**
 * client-ui-trading host half: deliberate no-op（2026-10-01 P1 三平面拆包）。
 *
 * 本包原来的 node 半是 /dshtrading/api 行情桥 + SSE + 定时任务服务；那些代码整体
 * 搬到了 @dshtrading/bot-api（bot API 平面，bot 与 GUI 都装）。这里保留同名包与
 * 空 apply 桩，是为了不动行 id 与 name（行 id 是跨版本公共契约，见
 * scripts/patch-id-freeze.json 与 Agent Note 2026-10-01-three-plane-package-split）。
 *
 * 全部行为在 src/client/（React 视图 + 客户端 api/store），随 @dshtrading/gui bundle 装载。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'client-ui-trading'

export function apply(_ctx: Context): void {}
