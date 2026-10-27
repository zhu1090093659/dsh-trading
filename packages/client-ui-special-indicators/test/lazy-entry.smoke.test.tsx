/**
 * 懒加载入口冒烟（jsdom）：tradingStageViews 注册的 render 组件经
 * LazySpecialIndicatorsView 动态 import 视图本体（视图 + lightweight-charts
 * 推迟到 tab 首访才执行）。异步落地后真实视图照常接管：status 握手、
 * 未配置分支占位渲染。零 mock：桥 fetch 为契约化 fake（真实 Response）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LazySpecialIndicatorsView } from '../src/client/LazySpecialIndicatorsView.tsx'
import { zh } from '../src/client/locales.ts'
import type { SpecialIndicatorsLocaleKey } from '../src/client/contract.ts'

/** 与 dsh-client-locale 插值器同口径的 {name} 替换（测试面，不做 $$ 转义）。 */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/{(w+)}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

const t = (key: SpecialIndicatorsLocaleKey, params?: Record<string, unknown>): string => interpolate(zh[key], params)

/** 契约化 fake fetch：status 回报未配置（懒加载面只需握手路由）。 */
function installUnconfiguredFetch() {
  const calls: string[] = []
  const impl = async (input: string | URL | Request): Promise<Response> => {
    calls.push(String(input))
    return new Response(
      JSON.stringify({ ok: true, configured: false, baseUrl: 'https://finance.example.test', username: '' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const original = globalThis.fetch
  globalThis.fetch = impl as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

let restoreFetch: () => void = () => undefined

afterEach(() => {
  restoreFetch()
  cleanup()
})

describe('特殊指标懒加载入口', () => {
  it('用户打开特殊指标 tab 时视图模块异步落地并照常接管渲染', async () => {
    // Given: 桥 status 回报未配置
    const fake = installUnconfiguredFetch()
    restoreFetch = fake.restore
    // When: 经懒加载壳打开视图
    render(<LazySpecialIndicatorsView t={t} view="special-indicators" />)
    // Then: 动态 import 落地后真实视图接管：status 握手并渲染未配置引导占位
    // 等待窗口按「视图本体 + lightweight-charts 的 transform 落地」定，不用默认 1s：
    // fallback=null 让落地前渲染为空，满载 runner 上 1s 不够（2026-10-24 nightly ubuntu
    // 红成「找不到『特殊指标未配置』」而 body 只有空 div）。
    expect(await screen.findByText('特殊指标未配置', undefined, { timeout: 5_000 })).toBeTruthy()
    expect(fake.calls.some((u) => u.endsWith('/dshtrading/api/special-indicators/status'))).toBe(true)
  })
})
