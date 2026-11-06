/**
 * 插件设置分区（settings.section id 'plugins'）：官方插件管理整页的宿主。
 *
 * 分区只做两件事——量出自己的矩形交给 plugins-host，并把打开状态落成一句
 * 说明文案；官方页被钉进这块矩形后盖住文案，宿主没提供插件管理面时文案
 * 换成失败提示。零重写：官方页的列表、安装、启停、更新交互全部原样。
 */
import { useEffect, useRef, useState } from 'react'
import type {} from './contract/locale-keys.ts'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { attachPluginHost, type PluginHostLayout } from './plugins-host.ts'
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

export function PluginsSection({ t, getLayout }: PluginsSectionProps) {
  const anchor = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    const element = anchor.current
    if (element === null) return undefined
    const handle = attachPluginHost(element, getLayout)
    setAvailable(document.body.dataset.dshtradingPluginHost !== 'unavailable')
    return handle.detach
  }, [getLayout])

  return (
    <div className={css.host} ref={anchor} data-dshtrading-plugin-host="">
      <p className={css.hint}>
        {available === false ? t('plugins.unavailable') : t('plugins.loading')}
      </p>
    </div>
  )
}
