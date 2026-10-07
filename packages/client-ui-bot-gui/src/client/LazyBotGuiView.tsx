import { Suspense, lazy } from 'react'
import type { BotGuiViewProps } from './BotGuiView.tsx'

const BotGuiView = lazy(() => import('./BotGuiView.tsx').then((m) => ({ default: m.BotGuiView })))

export function LazyBotGuiView(props: BotGuiViewProps): JSX.Element {
  return (
    <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>{props.t('bot.loading')}</div>}>
      <BotGuiView {...props} />
    </Suspense>
  )
}
