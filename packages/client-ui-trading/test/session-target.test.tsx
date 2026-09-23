/**
 * 活动会话读面桥冒烟（0.1.7）：session 作用域 slot 的 inject 工厂把框架解析的
 * sessionId 交给采集件，采集件零渲染投影进 holder；会话切换跟随，卸载清回
 * undefined（「发给 Agent」据此定位填充目标，无目标时由 fill-composer 显式报错，
 * 禁止猜会话）。
 *
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionTargetHolder, SessionTargetProbe } from '../src/client/session-target.ts'

describe('活动会话采集件 SessionTargetProbe（发给 Agent 目标定位）', () => {
  afterEach(() => { cleanup() })

  it('用户打开会话时 sessionId 写入 holder，离开会话后清回 undefined', () => {
    // Given 一个空 holder 与 activity session-1 的采集件
    const holder = createSessionTargetHolder()
    expect(holder.current).toBeUndefined()

    // When 采集件挂载（框架把 session-1 经 inject 面传入）
    const view = render(<SessionTargetProbe sessionId="session-1" holder={holder} />)

    // Then holder 读到 session-1；采集件卸载后清回 undefined
    expect(holder.current).toBe('session-1')
    view.unmount()
    expect(holder.current).toBeUndefined()
  })

  it('用户从一个会话切到另一个时 holder 跟随新的 sessionId', () => {
    // Given 采集件先挂在 session-1
    const holder = createSessionTargetHolder()
    const view = render(<SessionTargetProbe sessionId="session-1" holder={holder} />)
    expect(holder.current).toBe('session-1')

    // When 会话切换，框架以 session-2 重挂采集件
    view.rerender(<SessionTargetProbe sessionId="session-2" holder={holder} />)

    // Then holder 只保留最新的活动会话
    expect(holder.current).toBe('session-2')
  })

  it('用户没有活动会话时 holder 保持 undefined（宁报错不猜会话）', () => {
    // Given 一个空 holder
    const holder = createSessionTargetHolder()

    // When 采集件以无会话（undefined）挂载
    render(<SessionTargetProbe sessionId={undefined} holder={holder} />)

    // Then holder 保持 undefined，填入阶段据此显式报错
    expect(holder.current).toBeUndefined()
  })
})
