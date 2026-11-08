/**
 * 插件设置分区（settings.section id 'plugins'）：官方插件管理整页的宿主。
 *
 * 分区只做两件事——量出自己的矩形交给 plugins-host，并把打开状态落成一句
 * 说明文案；官方页被钉进这块矩形后盖住文案，宿主没提供插件管理面时文案
 * 换成失败提示。零重写：官方页的列表、安装、启停、更新交互全部原样。
 *
 * 官方页是懒加载的：等它进 DOM 超过 PANEL_TIMEOUT_MS 就换成可重试的说明——
 * 慢和坏要分得开，而不是让用户盯着「正在打开」猜。重试重新走一次借壳。
 *
 * 容器用 data-dshtrading-plugin-anchor 而不是与 body 状态标志同名：同名属性会
 * 让 document.querySelector('[data-dshtrading-plugin-host]') 把 body 一起挑出来。
 */
import { useEffect, useRef, useState } from 'react'
import type {} from './contract/locale-keys.ts'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { attachPluginHost, waitForPluginPanel, type PluginHostLayout } from './plugins-host.ts'
import css from './plugins-section.module.css'

/** 注册侧注入面：layout 服务惰性取用（apply 时序不保证）。 */
export interface PluginsSectionInjected {
  getLayout: () => PluginHostLayout | undefined
}

/** Props the renderer binds for the section. */
export type PluginsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dshtrading.settings'>
  & InjectFace<PluginsSectionInjected>

/** 分区此刻该显示什么：等待、已就位、宿主没提供、等超时、有页面但被布局遮住。 */
type Phase = 'loading' | 'on' | 'unavailable' | 'timeout' | 'blocked'

export function PluginsSection({ t, getLayout }: PluginsSectionProps) {
  const anchor = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const element = anchor.current
    if (element === null) return undefined
    setPhase('loading')
    const handle = attachPluginHost(element, getLayout)
    if (document.body.dataset.dshtradingPluginHost === 'unavailable') {
      setPhase('unavailable')
      return handle.detach
    }
    const wait = waitForPluginPanel(setPhase)
    return () => {
      wait.cancel()
      handle.detach()
    }
  }, [getLayout, attempt])

  return (
    <div className={css.host} ref={anchor} data-dshtrading-plugin-anchor="">
      {phase === 'on' ? null : (
        <div className={css.fallback}>
          <p className={css.hint}>
            {phase === 'unavailable'
              ? t('plugins.unavailable')
              : phase === 'timeout'
                ? t('plugins.timeout')
                : phase === 'blocked' ? t('plugins.blocked') : t('plugins.loading')}
          </p>
          {phase === 'timeout' || phase === 'blocked' ? (
            <button
              type="button"
              className={css.retry}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t('plugins.retry')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
