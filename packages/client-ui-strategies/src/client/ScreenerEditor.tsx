/**
 * 选股器编辑器（选股器管理，2026-09-07）：新建/编辑选股器的表单面板。
 *
 * 与 StrategyEditor 同构，差异：columns 行编辑（key/label/format）+ evaluate
 * 源码 textarea（单时点截面判断，无信号序列语义）；无期限字段（记录恒 'swing'）。
 * 「校验」走浏览器 Worker 版 validateCustomScreener，「保存」本地预校验后桥 PUT
 * （host vm 复校验）。编辑内置选股器时经 builtinScreenerRecord 预填自包含源码。
 */
import { useMemo, useState } from 'react'
import {
  BUILTIN_SCREENER_IDS,
  validateCustomScreener,
  type StrategyParamSpec,
} from '@dshtrading/strategies'
import type { CustomScreenerRecord } from '@dshtrading/strategies'
import type { ScreenerColumnSpec } from '@dshtrading/strategies'
import type { StrategyLocaleKey } from './contract.ts'
import css from './StrategyEditor.module.css'

export interface ScreenerEditorSaveInput {
  id: string
  title: string
  summary: string
  paramsJson: string
  columnsJson: string
  evaluateSource: string
  overridesScreener: boolean
}

export interface ScreenerEditorProps {
  t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string
  /** 编辑初值；null = 新建。 */
  initial: CustomScreenerRecord | null
  /** 保存回调（桥 PUT）；返回 null = 桥不可达。 */
  onSave: (input: ScreenerEditorSaveInput) => Promise<{ ok: true } | { ok: false; reason: string } | null>
  onClose: () => void
  /** 保存成功后的额外动作（父组件刷新名册）。 */
  onSaved: () => void
}

interface ParamRow {
  key: string
  label: string
  default: string
  min: string
  max: string
  step: string
}

interface ColumnRow {
  key: string
  label: string
  format: '' | 'percent' | 'number'
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

function rowsFromColumnsJson(columnsJson: string): ColumnRow[] {
  try {
    const parsed = JSON.parse(columnsJson) as ScreenerColumnSpec[]
    if (!Array.isArray(parsed)) return []
    return parsed.map((c) => ({
      key: String(c.key ?? ''),
      label: String(c.label ?? ''),
      format: c.format === 'percent' || c.format === 'number' ? c.format : '',
    }))
  } catch {
    return []
  }
}

export function ScreenerEditor({ t, initial, onSave, onClose, onSaved }: ScreenerEditorProps) {
  const isEdit = initial !== null
  const [id, setId] = useState(initial?.id ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [summary, setSummary] = useState(initial?.summary ?? '')
  const [rows, setRows] = useState<ParamRow[]>(() => rowsFromParamsJson(initial?.paramsJson ?? '[]'))
  const [cols, setCols] = useState<ColumnRow[]>(() => rowsFromColumnsJson(initial?.columnsJson ?? '[]'))
  const [source, setSource] = useState(initial?.evaluateSource ?? '')
  const [busy, setBusy] = useState<'' | 'validating' | 'saving'>('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const idIsBuiltin = useMemo(() => BUILTIN_SCREENER_IDS.has(id.trim().toLowerCase()), [id])

  const buildInput = (): ScreenerEditorSaveInput | { error: string } => {
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
    const columns: ScreenerColumnSpec[] = []
    for (const col of cols) {
      const key = col.key.trim()
      if (!key) continue
      columns.push(col.format === '' ? { key, label: col.label.trim() || key } : { key, label: col.label.trim() || key, format: col.format })
    }
    if (columns.length === 0) {
      return { error: `${t('sv.mgmt.field.columns')}: ${t('sv.mgmt.fieldRequired')}` }
    }
    return {
      id: trimmedId,
      title: title.trim(),
      summary: summary.trim(),
      paramsJson: JSON.stringify(params),
      columnsJson: JSON.stringify(columns),
      evaluateSource: source,
      overridesScreener: idIsBuiltin,
    }
  }

  const validateCurrent = async (): Promise<string | undefined> => {
    const input = buildInput()
    if ('error' in input) return input.error
    const result = await validateCustomScreener({
      id: input.id,
      title: input.title,
      horizon: 'swing',
      summary: input.summary,
      paramsJson: input.paramsJson,
      columnsJson: input.columnsJson,
      evaluateSource: input.evaluateSource,
      createdAt: initial?.createdAt ?? Date.now(),
    })
    return result.ok ? undefined : result.reason
  }

  const handleValidate = async () => {
    setBusy('validating')
    setNotice(null)
    try {
      const reason = await validateCurrent()
      setNotice(reason ? { kind: 'error', text: reason } : { kind: 'ok', text: t('sv.mgmt.validationOkScreener') })
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
    if (!isEdit && input.overridesScreener) {
      if (!window.confirm(t('sv.mgmt.confirmOverrideScreener'))) return
    }
    setBusy('saving')
    setNotice(null)
    try {
      const reason = await validateCurrent()
      if (reason !== undefined) {
        setNotice({ kind: 'error', text: reason })
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
  const updateCol = (index: number, patch: Partial<ColumnRow>) => {
    setCols((prev) => prev.map((col, i) => (i === index ? { ...col, ...patch } : col)))
  }

  return (
    <div className={css.overlay} role="dialog" aria-modal="true">
      <div className={css.panel}>
        <div className={css.panelHeader}>
          <span className={css.panelTitle}>{t('sv.mgmt.editorTitleScreener')}{isEdit ? ` · ${initial!.id}` : ''}</span>
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
              placeholder="scr.custom-momentum"
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('sv.mgmt.field.title')}</span>
            <input className={css.fieldInput} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <span />
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

        <div className={css.field}>
          <span className={css.fieldLabel}>{t('sv.mgmt.field.columns')}</span>
          <div className={css.paramTable}>
            <div className={css.columnHeadRow}>
              <span>{t('sv.mgmt.param.key')}</span>
              <span>{t('sv.mgmt.param.label')}</span>
              <span>{t('sv.mgmt.column.format')}</span>
              <span />
            </div>
            {cols.map((col, index) => (
              <div key={index} className={css.columnRow}>
                <input className={css.paramCell} value={col.key} onChange={(e) => updateCol(index, { key: e.target.value })} />
                <input className={css.paramCell} value={col.label} onChange={(e) => updateCol(index, { label: e.target.value })} />
                <select
                  className={css.paramCell}
                  value={col.format}
                  onChange={(e) => updateCol(index, { format: e.target.value as ColumnRow['format'] })}
                >
                  <option value="">number</option>
                  <option value="percent">percent</option>
                </select>
                <button
                  type="button"
                  className={css.paramRemove}
                  title={t('sv.mgmt.removeParam')}
                  onClick={() => setCols((prev) => prev.filter((_, i) => i !== index))}
                >✕</button>
              </div>
            ))}
            <button
              type="button"
              className={css.addParamBtn}
              onClick={() => setCols((prev) => [...prev, { key: '', label: '', format: '' }])}
            >+ {t('sv.mgmt.addColumn')}</button>
          </div>
        </div>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('sv.mgmt.field.evaluate')}</span>
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
