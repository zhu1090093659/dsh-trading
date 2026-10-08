/**
 * @dshtrading/base — 市场无关核心 bundle（README 架构决策：共享行唯一拥有者）。
 *
 * 本切片承载两块实质内容：
 *   1. `dsh-trading-base-gate` 插件（本模块）：统一审批监听器 —— 挂在
 *      `tools/pre-execute` waterfall（S4 结论的事件面；签名/返回形状以
 *      dsh core packages/core/tools/src/index.ts 的 Events 声明为准：
 *      `(exec, next) => Promise<PreToolDecision>`，`{kind:'ask'}` 交宿主
 *      approval 面裁决）。对命中 `LIVE_ACTION_GATE_PATTERN`（下单/撤单 +
 *      `crypto_set_leverage` 等会改变真实风险参数的实盘动作）且参数
 *      `dryRun !== true` 的调用返回 `{kind:'ask'}`，其余一律 `next()` 放行，
 *      绝不代替下游策略直接 allow。
 *   2. `cordis.patch.yml`（由 package.json 的 `dsh.bundle.patch` 声明）：
 *      insert-only 共享行 —— 本插件行 + `agent-preset-registry` 覆盖行
 *      （0.1.7 cohort：registry 行接管部署默认预设 default=master；headless 宿主
 *      没有该行，由部署方在 profile 层 insert，铁律 #1）。
 *
 * **fail-closed 是特性**：headless 部署没有审批应答者 —— dsh core 的
 * `serviceAsk`（core/tools/src/index.ts）在 approval 服务缺失、无 agent、
 * 无审批通道三种情况下都把 ask 降级为 deny。也就是说：无人在场时，凡走到
 * 本闸门的实盘请求必然被拒，绝不静默放行。实盘的第一道闸门是连接器/kit 的
 * 人工签署的实盘授权（@dshtrading/authority）；approval 只覆盖交互形态（S4 铁律 3 修订）。
 *
 * @module @dshtrading/base
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { migrateLegacyTradingHome } from '@dshtrading/dsh-home'

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
 * 实盘动作工具名模式（跨市场统一词汇：`<market>_<action>_order`，如
 * `crypto_place_order`）。工具名是模型面向词汇，用短市场前缀
 * （crypto/us/cn/hk/futures/global；global 为预防性收口——纯数据市场无下单工具）；
 * `dsh-trading-` 前缀只属于插件名/patch 行 id，不进工具名（与 crypto_get_ticker
 * 等只读工具一致）。锚定首尾 + 市场段枚举，避免误拦同名他方工具。
 *
 * **P7（合约交易 Tier 2，2026-10-08）**：集合从「下单/撤单」扩为「一切会改变交易所
 * 真实风险参数的实盘动作」——首例是合约杠杆/保证金模式变更 `crypto_set_leverage`
 * （调大杠杆等于放大强平风险，必须先过审批）。新增同类动作时加进本模式，
 * 不要让一个实盘动作绕过审批面。
 */
export const LIVE_ACTION_GATE_PATTERN = /^(?:(?:crypto|us|cn|hk|futures|global)_(?:place|cancel)_order|crypto_set_leverage)$/

/** 旧名（语义已扩为实盘动作集合）：新代码用 {@link LIVE_ACTION_GATE_PATTERN}。 */
export const ORDER_GATE_PATTERN = LIVE_ACTION_GATE_PATTERN

export function isLiveActionGateTool(toolName: string): boolean {
  return LIVE_ACTION_GATE_PATTERN.test(toolName)
}

/** 旧名，等价于 {@link isLiveActionGateTool}。 */
export function isOrderGateTool(toolName: string): boolean {
  return isLiveActionGateTool(toolName)
}

/** 只读取 dryRun 标志，args 形状不信任（工具自校验 schema，闸门只做保守判断）。 */
interface GateArgs {
  dryRun?: unknown
}

/**
 * 纯判定：这次工具调用是否需要用户审批。
 *
 * - 非实盘动作工具 → undefined（不拦截）；
 * - 实盘动作且 `dryRun === true` → undefined（模拟不改变交易所状态，无需审批）；
 * - 其余（dryRun 缺省/false/形状异常）→ `{kind:'ask'}`。
 *   缺省也 ask 是故意的保守面：工具 schema 的 dryRun 默认 true 在工具层生效，
 *   闸门层只认显式 `true`；宁可在交互形态多问一次，不在实盘形态漏拦一次。
 *
 * 返回 undefined 时调用方必须 `next()` 继续 waterfall —— 本监听器永不直接
 * 返回 allow，避免越过宿主其他策略层。
 */
export function decideLiveActionGate(toolName: string, args: unknown): PreToolDecision | undefined {
  if (!isLiveActionGateTool(toolName)) return undefined
  const dryRun = (args as GateArgs | null | undefined)?.dryRun
  if (dryRun === true) return undefined
  return {
    kind: 'ask',
    reason:
      `live trading action "${toolName}" was called without explicit dryRun=true (live trading intent); `
      + 'the dsh-trading safety gate requires user approval (README iron rule #3). '
      + 'Note: headless deployments with no approver will deny this call — fail closed by design.',
  }
}

/** 旧名，等价于 {@link decideLiveActionGate}。 */
export function decideOrderGate(toolName: string, args: unknown): PreToolDecision | undefined {
  return decideLiveActionGate(toolName, args)
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
    const decision = decideLiveActionGate(exec.name, exec.arguments)
    return decision ?? next()
  }
}

/**
 * 插件入口：按配置挂统一审批监听器（不声明 inject —— 事件面无需 tools 服务）。
 *
 * 启动副作用：旧 home 一次性数据迁移（2026-09-08 审查 H4）。base 是 base patch
 * 的首个 insert 行，早于所有 trading 数据 store 的构造与首读；解析 home 与
 * `~/.dsh` 同源时零动作，语义见 {@link migrateLegacyTradingHome}。测试进程不
 * 迁移（vitest 会直接执行 apply()，迁移属宿主启动行为）。
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (process.env.VITEST === undefined && process.env.NODE_ENV !== 'test') {
    try {
      migrateLegacyTradingHome({ log: message => console.warn(message) })
    } catch (error) {
      console.warn('[dsh-trading/base] legacy home migration skipped:', error)
    }
  }
  ctx.on('tools/pre-execute', createGateListener())
}
