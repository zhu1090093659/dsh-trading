/**
 * @vitest-environment jsdom
 * 机器人控制台视图渲染与交互冒烟测试：
 * - 渲染未配置引导态
 * - 渲染多机器人切换下拉框与切换
 * - 渲染卡片区块（DeskHome / Positions / Escalation 等）
 * - ACTION_CONFIRM 强确认逻辑（control 类动作弹窗拦截）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BotGuiView } from '../src/client/BotGuiView.tsx'
import { zh } from '../src/client/locales.ts'
import type { Card } from '../src/client/contract.ts'

function installMemoryStorage(kind: 'localStorage' | 'sessionStorage') {
  const store = new Map<string, string>()
  const fake = {
    getItem: (k: string): string | null => (store.has(k) ? (store.get(k) ?? null) : null),
    setItem: (k: string, v: string): void => { store.set(k, v) },
    removeItem: (k: string): void => { store.delete(k) },
    clear: (): void => { store.clear() },
    key: (i: number): string | null => [...store.keys()][i] ?? null,
    get length(): number { return store.size },
  }
  const original = Object.getOwnPropertyDescriptor(window, kind)
  Object.defineProperty(window, kind, { value: fake, configurable: true })
  return {
    store,
    restore: (): void => {
      if (original !== undefined) Object.defineProperty(window, kind, original)
    },
  }
}

let restoreStorage: () => void = () => undefined
let restoreFetch: () => void = () => undefined

beforeEach(() => {
  const storage = installMemoryStorage('localStorage')
  restoreStorage = storage.restore
})

afterEach(() => {
  restoreFetch()
  restoreStorage()
  cleanup()
})

function t(key: string, params?: Record<string, unknown>): string {
  let str = (zh as Record<string, string>)[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v))
    }
  }
  return str
}

describe('机器人控制台视图交互', () => {
  it('用户未配置机器人时显示引导占位', async () => {
    // Given: /status 返回空列表
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/status')) {
        return new Response(JSON.stringify({ bots: [] }))
      }
      return new Response('{}', { status: 404 })
    }) as typeof globalThis.fetch
    restoreFetch = () => { globalThis.fetch = originalFetch }

    // When: 挂载视图
    render(<BotGuiView t={t} view="bot" />)

    // Then: 出现未配置提示
    await waitFor(() => {
      expect(screen.getByText(zh['bot.unconfigured.title'])).toBeDefined()
    })
  })

  it('用户已配置机器人时渲染机器人列表与卡片', async () => {
    // Given: 两台机器人与测试卡片
    const originalFetch = globalThis.fetch
    const cardsAlpha: Card[] = [
      {
        cardId: 'card-1',
        cardType: 'desk-summary',
        revision: 1,
        fallbackText: 'Alpha Running Smoothly',
        fields: [{ key: 'status', label: '运行状态', kind: 'status', value: 'RUNNING' }],
        actions: [],
      },
    ]

    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/status')) {
        return new Response(
          JSON.stringify({
            bots: [
              { name: 'alpha', configured: true },
              { name: 'beta', configured: true },
            ],
          }),
        )
      }
      if (u.includes('/alpha/cards')) {
        return new Response(JSON.stringify({ cards: cardsAlpha }))
      }
      if (u.includes('/beta/cards')) {
        return new Response(JSON.stringify({ cards: [] }))
      }
      return new Response('{}', { status: 404 })
    }) as typeof globalThis.fetch
    restoreFetch = () => { globalThis.fetch = originalFetch }

    // When: 挂载视图
    render(<BotGuiView t={t} view="bot" />)

    // Then: 看到标题与下拉框，且卡片渲染出 fallbackText
    await waitFor(() => {
      expect(screen.getByText('Alpha Running Smoothly')).toBeDefined()
    })
    expect(screen.getByLabelText(/选择机器人/)).toBeDefined()
  })

  it('用户点击高危控制按钮时触发强确认并在取消时中止指令', async () => {
    // Given: 处于 alpha 机器人，点击 pause 控制按钮
    const originalFetch = globalThis.fetch
    let commandCalled = false

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/status')) {
        return new Response(JSON.stringify({ bots: [{ name: 'alpha', configured: true }] }))
      }
      if (u.includes('/alpha/cards')) {
        return new Response(JSON.stringify({ cards: [] }))
      }
      if (u.includes('/commands') && init?.method === 'POST') {
        commandCalled = true
        return new Response(JSON.stringify({ ok: true }))
      }
      return new Response('{}')
    }) as typeof globalThis.fetch
    restoreFetch = () => { globalThis.fetch = originalFetch }

    const originalConfirm = window.confirm
    window.confirm = () => false

    try {
      render(<BotGuiView t={t} view="bot" />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'pause' })).toBeDefined()
      })

      // When: 点击 pause
      const pauseBtn = screen.getByRole('button', { name: 'pause' })
      fireEvent.click(pauseBtn)

      // Then: 取消操作，未发起 POST commands
      expect(commandCalled).toBe(false)
    } finally {
      window.confirm = originalConfirm
    }
  })

  it('用户在强确认弹窗点击确定后发送控制指令', async () => {
    // Given: window.confirm 返回 true
    const originalFetch = globalThis.fetch
    let capturedBody = ''

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/status')) {
        return new Response(JSON.stringify({ bots: [{ name: 'alpha', configured: true }] }))
      }
      if (u.includes('/alpha/cards')) {
        return new Response(JSON.stringify({ cards: [] }))
      }
      if (u.includes('/commands') && init?.method === 'POST') {
        capturedBody = String(init?.body ?? '')
        return new Response(JSON.stringify({ ok: true }))
      }
      return new Response('{}')
    }) as typeof globalThis.fetch
    restoreFetch = () => { globalThis.fetch = originalFetch }

    const originalConfirm = window.confirm
    window.confirm = () => true

    try {
      render(<BotGuiView t={t} view="bot" />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'pause' })).toBeDefined()
      })

      // When: 点击 pause
      const pauseBtn = screen.getByRole('button', { name: 'pause' })
      fireEvent.click(pauseBtn)

      // Then: 发送了 POST 指令
      await waitFor(() => {
        expect(capturedBody).toContain('"action":"pause"')
      })
    } finally {
      window.confirm = originalConfirm
    }
  })
})
