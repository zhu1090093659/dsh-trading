/**
 * @dsh-trading/base — 市场无关核心 bundle（README 架构决策：共享行唯一拥有者）。
 *
 * 本切片承载两块实质内容：
 *   1. `dsh-trading-base-gate` 插件（本模块）：统一审批监听器 —— 挂在
 *      `tools/pre-execute` waterfall（S4 结论的事件面；签名/返回形状以
 *      dsh core packages/core/tools/src/index.ts 的 Events 声明为准：
 *      `(exec, next) => Promise<PreToolDecision>`，`{kind:'ask'}` 交宿主
 *      approval 面裁决）。对 `/^dsh-trading-.*_(place|cancel)_order$/` 且参数
 *      `dryRun !== true` 的调用返回 `{kind:'ask'}`，其余一律 `next()` 放行，
 *      绝不代替下游策略直接 allow。
 *   2. `cordis.patch.yml`（由 package.json 的 `dsh.bundle.patch` 声明）：
 *      insert-only 共享行 —— 本插件行 + `agent-presets` 行（headless 宿主没有
 *      该行，S3 证实必须由本层 insert；统一 preset root 归 base 所有，铁律 #1）。
 *
 * **fail-closed 是特性**：headless 部署没有审批应答者 —— dsh core 的
 * `serviceAsk`（core/tools/src/index.ts）在 approval 服务缺失、无 agent、
 * 无审批通道三种情况下都把 ask 降级为 deny。也就是说：无人在场时，凡走到
 * 本闸门的实盘请求必然被拒，绝不静默放行。实盘的第一道闸门是连接器/kit 的
 * 显式 `liveTrading` 开关；approval 只覆盖交互形态（S4 铁律 3 修订）。
 *
 * @module @dsh-trading/base
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

/**
 * Cordis 插件名 = patch 行 id（TEMPLATES §8）。base 是共享行唯一拥有者，
 * 行 id 用 `dsh-trading-base-gate` 市场无关命名空间，绝不与市场行冲突。
 */
export const name = 'dsh-trading-base-gate'

export interface Config {
  /** 统一审批闸门开关；false 时完全不挂监听器（仅测试/显式降级用）。 */
  enabled: boolean
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
})

/**
 * 下单/撤单工具名模式（跨市场统一词汇：`<market>_<action>_order`，如
 * `crypto_place_order`）。工具名是模型面向词汇，用短市场前缀（crypto/us/cn/hk）；
 * `dsh-trading-` 前缀只属于插件名/patch 行 id，不进工具名（与 crypto_get_ticker
 * 等只读工具一致）。锚定首尾 + 市场段枚举，避免误拦同名他方工具。
 */
export const ORDER_GATE_PATTERN = /^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/

export function isOrderGateTool(toolName: string): boolean {
  return ORDER_GATE_PATTERN.test(toolName)
}

/** 只读取 dryRun 标志，args 形状不信任（工具自校验 schema，闸门只做保守判断）。 */
interface GateArgs {
  dryRun?: unknown
}

/**
 * 纯判定：这次工具调用是否需要用户审批。
 *
 * - 非下单/撤单工具 → undefined（不拦截）；
 * - 下单/撤单且 `dryRun === true` → undefined（模拟单无需审批）；
 * - 其余（dryRun 缺省/false/形状异常）→ `{kind:'ask'}`。
 *   缺省也 ask 是故意的保守面：工具 schema 的 dryRun 默认 true 在工具层生效，
 *   闸门层只认显式 `true`；宁可在交互形态多问一次，不在实盘形态漏拦一次。
 *
 * 返回 undefined 时调用方必须 `next()` 继续 waterfall —— 本监听器永不直接
 * 返回 allow，避免越过宿主其他策略层。
 */
export function decideOrderGate(toolName: string, args: unknown): PreToolDecision | undefined {
  if (!isOrderGateTool(toolName)) return undefined
  const dryRun = (args as GateArgs | null | undefined)?.dryRun
  if (dryRun === true) return undefined
  return {
    kind: 'ask',
    reason:
      `order tool "${toolName}" was called without explicit dryRun=true (live trading intent); `
      + 'the dsh-trading safety gate requires user approval (README iron rule #3). '
      + 'Note: headless deployments with no approver will deny this call — fail closed by design.',
  }
}

/**
 * waterfall 监听器工厂（独立导出便于单测直接驱动 next() 契约，
 * 官方参照：packages/hooks/hooks-codex 的 pre-execute 桥）。
 */
export function createGateListener(): (
  this: unknown,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision> {
  return async (exec, next) => {
    const decision = decideOrderGate(exec.name, exec.arguments)
    return decision ?? next()
  }
}

/** 插件入口：按配置挂统一审批监听器（不声明 inject —— 事件面无需 tools 服务）。 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  ctx.on('tools/pre-execute', createGateListener())
}
