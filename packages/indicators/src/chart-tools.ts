/**
 * 图表激活名册的 Agent 工具面（issue #63）：indicator_list / indicator_activate /
 * indicator_deactivate。与 tool.ts 的 indicator_author 同层（host 平面注册，
 * 会话隔离铁律不破）；写入成功后经 onWritten/onDeleted 回调接线 tradingEvents
 * emit('chart')（接线在 plugin.ts）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CustomIndicatorStore } from './custom.ts'
import type { ChartActivationStore } from './chart-activations.ts'
import { clampActivationParams, defaultActivationInstance, resolveIndicatorSpec } from './chart-activations.ts'
import { presetDefinitions } from './presets.ts'

export interface IndicatorListToolOptions {
  customStore?: CustomIndicatorStore | undefined
  chartStore?: ChartActivationStore | undefined
}

/** indicator_list：枚举预置 + 自定义指标全清单与当前激活名册。 */
export function createIndicatorListTool(options: IndicatorListToolOptions) {
  const { customStore, chartStore } = options
  return defineTool({
    name: 'indicator_list',
    description:
      'List all chart indicators available for the trading GUI: preset indicators and user-authored custom indicators, '
      + 'each with id, title, pane placement (main/sub), parameter schema (key/label/default/min/max), and optional description. '
      + 'Also reports the currently active chart roster (activated instances with their live parameters). '
      + 'Use this before indicator_author (duplicate check) or indicator_activate (pick ids and params).',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const presets = presetDefinitions().map(d => ({
        id: d.id,
        title: d.title,
        pane: d.pane,
        params: d.params.map(p => ({ key: p.key, label: p.label, default: p.default, min: p.min, max: p.max })),
      }))
      const custom = customStore !== undefined
        ? (await customStore.list()).map(r => ({
          id: r.id,
          title: r.title,
          pane: r.pane,
          params: r.params.map(p => ({ key: p.key, label: p.label, default: p.default, min: p.min, max: p.max })),
          description: r.description,
        }))
        : []
      const active = chartStore !== undefined ? await chartStore.list() : []
      return JSON.stringify({ presets, custom, active })
    },
  })
}

export interface IndicatorActivateToolOptions {
  customStore?: CustomIndicatorStore | undefined
  chartStore: ChartActivationStore
  /** 可选：挂载成功后的回调（plugin 接线 emit('chart')）。 */
  onWritten?: (id: string) => void
}

/** indicator_activate：把指标挂上用户图（已激活则更新参数）。 */
export function createIndicatorActivateTool(options: IndicatorActivateToolOptions) {
  const { customStore, chartStore, onWritten } = options
  return defineTool({
    name: 'indicator_activate',
    description:
      'Mount an indicator onto the user\'s open chart (the GUI renders it live over SSE; no reload needed). '
      + 'The id must be a preset indicator or a custom indicator authored via indicator_author. '
      + 'Activating an already-active id updates its parameters in place (one instance per id). '
      + 'Optionally pass paramsJson to override schema defaults; values are clamped to each parameter\'s min/max. '
      + 'Use indicator_list to discover ids and parameter schemas.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Indicator id to mount (preset like "ma"/"macd", or custom id authored via indicator_author)',
      },
      paramsJson: {
        type: 'string',
        description: 'Optional JSON object of parameter overrides, e.g. {"fast":12,"slow":26,"signal":9}. Missing keys use schema defaults.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { id?: unknown; paramsJson?: unknown }
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) {
        throw new Error('indicator_activate: id is required')
      }
      const spec = await resolveIndicatorSpec(id, customStore)
      if (spec === undefined) {
        const available = [
          ...presetDefinitions().map(d => d.id),
          ...customStore !== undefined ? (await customStore.list()).map(r => r.id) : [],
        ]
        throw new Error('indicator_activate: unknown indicator id ' + JSON.stringify(id)
          + ' — available ids: ' + available.join(', ')
          + '. Custom ids require authoring via indicator_author first')
      }

      let overrides: Record<string, number> = {}
      if (typeof args.paramsJson === 'string' && args.paramsJson.trim()) {
        try {
          const parsed: unknown = JSON.parse(args.paramsJson)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return '[indicator_activate] paramsJson must be a JSON object of parameter overrides'
          }
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'number' && Number.isFinite(value)) overrides[key] = value
          }
        } catch {
          return '[indicator_activate] Validation failed: paramsJson is not valid JSON (' + args.paramsJson + ')'
        }
      }

      const params = clampActivationParams(spec.params, overrides)
      await chartStore.activate({ id, params })
      onWritten?.(id)

      const paramText = spec.params.map(p => (p.key + '=' + params[p.key])).join(', ')
      return '[indicator_activate] Mounted "' + spec.title + '" (id: ' + id + ', pane: ' + spec.pane
        + (paramText ? ', params: ' + paramText : '') + ') on the chart. '
        + 'The GUI chart renders it live via the SSE invalidation channel.'
    },
  })
}

export interface IndicatorDeactivateToolOptions {
  chartStore: ChartActivationStore
  /** 可选：摘除成功后的回调（plugin 接线 emit('chart')）。 */
  onDeleted?: (id: string, removed: boolean) => void
}

/** indicator_deactivate：把指标从用户图上摘除（定义保留在指标库）。 */
export function createIndicatorDeactivateTool(options: IndicatorDeactivateToolOptions) {
  const { chartStore, onDeleted } = options
  return defineTool({
    name: 'indicator_deactivate',
    description:
      'Unmount an indicator from the user\'s open chart (roster refreshes live over SSE). '
      + 'This only removes the active chart instance — the indicator definition stays in the library '
      + '(use indicator_delete to remove a custom indicator definition entirely). '
      + 'Use indicator_list to see the currently active roster.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Indicator id to unmount from the chart',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { id?: unknown }
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) {
        throw new Error('indicator_deactivate: id is required')
      }
      const removed = await chartStore.deactivate(id)
      onDeleted?.(id, removed)
      return JSON.stringify({
        ok: true,
        removed,
        note: removed
          ? 'Unmounted "' + id + '" from the chart (definition kept in the library).'
          : '"' + id + '" has no active chart instance (see indicator_list for the active roster).',
      })
    },
  })
}

/** 激活工具族的共享依赖面（plugin 与单测注入用）。 */
export interface ChartToolDeps {
  customStore?: CustomIndicatorStore | undefined
  chartStore: ChartActivationStore
}

/** 便捷工厂：一次创建三个激活名册工具。 */
export function createChartActivationTools(deps: ChartToolDeps) {
  return {
    list: createIndicatorListTool(deps),
    activate: createIndicatorActivateTool(deps),
    deactivate: createIndicatorDeactivateTool(deps),
  }
}

// defaultActivationInstance 供 author 工具的「创作即上图」路径复用（tool.ts 引）。
export { defaultActivationInstance }
