import { useEffect, useRef, useState } from 'react'
import type { ResearchLocaleKey } from './contract.ts'
import css from './research-view.module.css'
interface WorkbenchModule { mount(container: HTMLElement): () => void }
export interface ResearchViewProps { t: (key: ResearchLocaleKey) => string }
/** Native content mount, using the same host origin and no iframe. */
export function ResearchView({ t }: ResearchViewProps) {
  const target = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let disposed = false
    let unmount: (() => void) | undefined
    setError(false)
    setLoading(true)
    // The host loader owns the shell; this ES module owns research dependencies.
    const url = '/dshtrading/api/research/assets/workbench.js'
    void (import(/* @vite-ignore */ url) as Promise<WorkbenchModule>).then(module => {
      if (disposed || target.current === null) return
      unmount = module.mount(target.current)
      setLoading(false)
    }).catch(error => {
      console.error('[research] workspace module failed to load', error)
      if (!disposed) { setError(true); setLoading(false) }
    })
    return () => { disposed = true; unmount?.() }
  }, [attempt])
  return <section className={css.root} data-dshtrading-research="" data-research-state={error ? 'error' : loading ? 'loading' : 'native'}>
    <div className={css.mount} ref={target} data-dshtrading-research-mount="" />
    {(loading || error) && <div className={css.message} role={error ? 'alert' : 'status'}>
      <p>{t(error ? 'rv.error' : 'rv.loading')}</p>
      {error && <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('rv.action.retry')}</button>}
    </div>}
  </section>
}
