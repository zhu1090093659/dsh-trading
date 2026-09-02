/**
 * Polling hook with tab-visibility pause: interval timers run only while the
 * document is visible (public endpoints stay gentle when the tab is parked).
 */
import { useEffect, useRef } from 'react'

export function usePoll(poll: (() => Promise<void> | void) | null | undefined, intervalMs: number, deps: readonly unknown[]): void {
  const pollRef = useRef(poll)
  pollRef.current = poll

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = (): void => {
      if (document.visibilityState === 'visible' && typeof pollRef.current === 'function') {
        void pollRef.current()
      }
    }
    tick()
    timer = setInterval(tick, intervalMs)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
