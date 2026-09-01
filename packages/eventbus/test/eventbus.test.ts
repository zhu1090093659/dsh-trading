/**
 * tradingEvents 服务单测（离线）：emit/revision 自增、订阅扇出、退订幂等、
 * 监听器异常隔离。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { TradingEventsService } from '../src/index.js'

function makeService(): TradingEventsService {
  return new TradingEventsService(new CordisContext() as never)
}

describe('TradingEventsService', () => {
  it('emit 自增 per-store revision（store 间独立）', () => {
    const bus = makeService()
    expect(bus.revision('indicators')).toBe(0)
    const e1 = bus.emit('indicators')
    const e2 = bus.emit('indicators')
    expect(e1).toEqual({ store: 'indicators', revision: 1 })
    expect(e2).toEqual({ store: 'indicators', revision: 2 })
    expect(bus.revision('knowledge')).toBe(0)
    bus.emit('knowledge')
    expect(bus.revision('knowledge')).toBe(1)
    expect(bus.revision('indicators')).toBe(2)
  })

  it('subscribe 扇出：全部监听器收到同一事件对象', () => {
    const bus = makeService()
    const a = vi.fn()
    const b = vi.fn()
    const offA = bus.subscribe(a)
    bus.subscribe(b)
    bus.emit('watchlists')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith({ store: 'watchlists', revision: 1 })
    offA()
    bus.emit('watchlists')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('退订幂等（重复调用不抛错）', () => {
    const bus = makeService()
    const off = bus.subscribe(vi.fn())
    off()
    expect(() => off()).not.toThrow()
  })

  it('监听器抛错不阻断其他监听器（扇出隔离）', () => {
    const bus = makeService()
    const boom = vi.fn(() => { throw new Error('boom') })
    const ok = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      bus.subscribe(boom)
      bus.subscribe(ok)
      expect(() => bus.emit('routing')).not.toThrow()
      expect(boom).toHaveBeenCalledTimes(1)
      expect(ok).toHaveBeenCalledTimes(1)
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})
