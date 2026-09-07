/**
 * 策略编辑器（策略管理，2026-09-07）：新建/编辑策略的表单面板。
 *
 * - 元数据（id/title/horizon/summary）+ 参数规格行编辑 + compute 源码 textarea。
 * - 「校验」走浏览器 Worker 版 validateCustomStrategy（多场景试算 + 信号序列），
 *   即时反馈不落盘；「保存」先本地预校验再交桥 PUT（host 侧 vm 沙箱复校验，
 *   通过才落盘）——两侧校验器同源（validate.ts），结果一致。
 * - 新建时 id 撞内置范式 → confirm 确认后带 overridesBuiltin 提交（桥的
 *   TRADING_STRATEGY_OVERRIDE_CONFIRM 闸门要求显式确认位）；编辑内置同理。
 */
import { useMemo, useState } from 'react'
import {
  BUILTIN_STRATEGY_IDS,
  validateCustomStrategy,
  type StrategyHorizon,
  type StrategyParamSpec,
} from '@dshtrading/strategies'
import type { CustomStrategyRecord } from '@dshtrading/strategies'
import type { StrategyLocaleKey } from './contract.ts'
import css from './StrategyEditor.module.css'

export interface StrategyEditorSaveInput {
  id: string
  title: string
  horizon: StrategyHorizon
  summary: string
  paramsJson: string
  computeSource: string
  overridesBuiltin: boolean
}

export interface StrategyEditorProps {
  t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string
  /** 编辑初值；null = 新建。 */
  initial: CustomStrategyRecord | null
  /** 保存回调（桥 PUT）；返回 null = 桥不可达。 */
  onSave: (input: StrategyEditorSaveInput) => Promise<{ ok: true } | { ok: false; reason: string } | null>
  onClose: () => void
  /** 保存成功后的额外动作（父组件刷新名册）。 */
  onSaved: () => void
}

const HORIZONS: readonly StrategyHorizon[] = ['short', 'swing', 'long']

interface ParamRow {
  key: string
  label: string
  default: string
  min: string
  max: string
  step: string
}

function rowsFromParamsJson(paramsJson: string): ParamRow[] {
  try {
    const parsed = JSON.parse(paramsJson) as StrategyParamSpec[]
    if (!Array.isArray(parsed)) return []
    return parsed.map((p) => ({
      key: String(p.key ?? ''),
      label: String(p.label ?? ''),
      default: String(p.default ?? ''),
      min: String(p.min ?? ''),
      max: String(p.max ?? ''),
      step: String(p.step ?? 1),
    }))
  } catch {
    return []
  }
}

export function StrategyEditor({ t, initial, onSave, onClose, onSaved }: StrategyEditorProps) {
  const isEdit = initial !== null
  const [id, setId] = useState(initial?.id ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [horizon, setHorizon] = useState<StrategyHorizon>(initial?.horizon ?? 'short')
  const [summary, setSummary] = useState(initial?.summary ?? '')
  const [rows, setRows] = useState<ParamRow[]>(() => rowsFromParamsJson(initial?.paramsJson ?? '[]'))
  const [source, setSource] = useState(initial?.computeSource ?? '')
  const [busy, setBusy] = useState<'' | 'validating' | 'saving'>('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const idIsBuiltin = useMemo(() => BUILTIN_STRATEGY_IDS.has(id.trim().toLowerCase()), [id])

  const buildInput = (): StrategyEditorSaveInput | { error: string } => {
    const trimmedId = id.trim().toLowerCase()
    if (!trimmedId) return { error: `${t('sv.mgmt.field.id')}: ${t('sv.mgmt.fieldRequired')}` }
    const params: StrategyParamSpec[] = []
    for (const row of rows) {
      const key = row.key.trim()
      if (!key) continue
      const def = Number(row.default)
      const min = Number(row.min)
      const max = Number(row.max)
      const step = Number(row.step)
      if (!Number.isFinite(def) || !Number.isFinite(min) || !Number.isFinite(max)) {
        return { error: `${t('sv.mgmt.field.params')} [${key}]: ${t('sv.mgmt.fieldRequired')}` }
      }
      params.push({
        key,
        label: row.label.trim() || key,
        default: def,
        min: min,
        max: max,
        step: Number.isFinite(step) && step > 0 ? step : 1,
      })
    }
    return {
      id: trimmedId,
      title: title.trim(),
      horizon,
      summary: summary.trim(),
      paramsJson: JSON.stringify(params),
      computeSource: source,
      // 编辑内置 = 覆盖语义；新建撞内置 = 显式确认后覆盖。
      overridesBuiltin: idIsBuiltin,
    }
  }

  const handleValidate = async () => {
    const input = buildInput()
    if ('error' in input) {
      setNotice({ kind: 'error', text: input.error })
      return
    }
    setBusy('validating')
    setNotice(null)
    try {
      const result = await validateCustomStrategy({
        id: input.id,
        title: input.title,
        horizon: input.horizon,
        summary: input.summary,
        paramsJson: input.paramsJson,
        computeSource: input.computeSource,
        createdAt: initial?.createdAt ?? Date.now(),
      })
      setNotice(
        result.ok
          ? { kind: 'ok', text: t('sv.mgmt.validationOk') }
          : { kind: 'error', text: result.reason },
      )
    } finally {
      setBusy('')
    }
  }

  const handleSave = async () => {
    const input = buildInput()
    if ('error' in input) {
      setNotice({ kind: 'error', text: input.error })
      return
    }
    if (!isEdit && input.overridesBuiltin) {
      if (!window.confirm(t('sv.mgmt.confirmOverride'))) return
    }
    // 本地预校验（Worker 试算）先行，给出即时反馈；host 侧保存时还会 vm 复校验。
    setBusy('saving')
    setNotice(null)
    try {
      const pre = await validateCustomStrategy({
        id: input.id,
        title: input.title,
        horizon: input.horizon,
        summary: input.summary,
        paramsJson: input.paramsJson,
        computeSource: input.computeSource,
        createdAt: initial?.createdAt ?? Date.now(),
      })
      if (!pre.ok) {
        setNotice({ kind: 'error', text: pre.reason })
        return
      }
      const result = await onSave(input)
      if (result === null) {
        setNotice({ kind: 'error', text: t('sv.mgmt.saveFailed') })
        return
      }
      if (!result.ok) {
        setNotice({ kind: 'error', text: `${t('sv.mgmt.saveFailed')}: ${result.reason}` })
        return
      }
      onSaved()
      onClose()
    } finally {
      setBusy('')
    }
  }

  const updateRow = (index: number, patch: Partial<ParamRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  return (
    <div className={css.overlay} role="dialog" aria-modal="true">
      <div className={css.panel}>
        <div className={css.panelHeader}>
          <span className={css.panelTitle}>{t('sv.mgmt.editorTitle')}{isEdit ? ` · ${initial!.id}` : ''}</span>
          <button type="button" className={css.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={css.formGrid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('sv.mgmt.field.id')}</span>
            <input
              className={css.fieldInput}
              value={id}
              disabled={isEdit}
              onChange={(e) => setId(e.target.value)}
              placeholder="ema-stop-takeprofit"
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('sv.mgmt.field.title')}</span>
            <input className={css.fieldInput} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('sv.mgmt.field.horizon')}</span>
            <select
              className={css.fieldInput}
              value={horizon}
              onChange={(e) => setHorizon(e.target.value as StrategyHorizon)}
            >
              {HORIZONS.map((h) => (
                <option key={h} value={h}>{t(`sv.horizon.${h}` as StrategyLocaleKey)}</option>
              ))}
            </select>
          </label>
        </div>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('sv.mgmt.field.summary')}</span>
          <input className={css.fieldInput} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>

        <div className={css.field}>
          <span className={css.fieldLabel}>{t('sv.mgmt.field.params')}</span>
          <div className={css.paramTable}>
            <div className={css.paramHeadRow}>
              <span>{t('sv.mgmt.param.key')}</span>
              <span>{t('sv.mgmt.param.label')}</span>
              <span>{t('sv.mgmt.param.default')}</span>
              <span>{t('sv.mgmt.param.min')}</span>
              <span>{t('sv.mgmt.param.max')}</span>
              <span>{t('sv.mgmt.param.step')}</span>
              <span />
            </div>
            {rows.map((row, index) => (
              <div key={index} className={css.paramRow}>
                <input className={css.paramCell} value={row.key} onChange={(e) => updateRow(index, { key: e.target.value })} />
                <input className={css.paramCell} value={row.label} onChange={(e) => updateRow(index, { label: e.target.value })} />
                <input className={css.paramCell} type="number" value={row.default} onChange={(e) => updateRow(index, { default: e.target.value })} />
                <input className={css.paramCell} type="number" value={row.min} onChange={(e) => updateRow(index, { min: e.target.value })} />
                <input className={css.paramCell} type="number" value={row.max} onChange={(e) => updateRow(index, { max: e.target.value })} />
                <input className={css.paramCell} type="number" value={row.step} onChange={(e) => updateRow(index, { step: e.target.value })} />
                <button
                  type="button"
                  className={css.paramRemove}
                  title={t('sv.mgmt.removeParam')}
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                >✕</button>
              </div>
            ))}
            <button
              type="button"
              className={css.addParamBtn}
              onClick={() => setRows((prev) => [...prev, { key: '', label: '', default: '0', min: '0', max: '100', step: '1' }])}
            >+ {t('sv.mgmt.addParam')}</button>
          </div>
        </div>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('sv.mgmt.field.source')}</span>
          <textarea
            className={css.sourceArea}
            value={source}
            spellCheck={false}
            onChange={(e) => setSource(e.target.value)}
            rows={12}
          />
        </label>

        {notice !== null && (
          <div className={notice.kind === 'ok' ? css.noticeOk : css.noticeError}>{notice.text}</div>
        )}

        <div className={css.actionBar}>
          <button type="button" className={css.secondaryBtn} disabled={busy !== ''} onClick={() => { void handleValidate() }}>
            {busy === 'validating' ? t('sv.mgmt.validating') : t('sv.mgmt.validate')}
          </button>
          <div className={css.actionSpacer} />
          <button type="button" className={css.secondaryBtn} onClick={onClose}>{t('sv.mgmt.cancel')}</button>
          <button type="button" className={css.primaryBtn} disabled={busy !== ''} onClick={() => { void handleSave() }}>
            {busy === 'saving' ? t('sv.mgmt.validating') : t('sv.mgmt.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
