/**
 * tool-batch 单测：批量入口的两个硬契约。
 *
 * 1. **不能绕过执行管线**——子调用必须经 dispatch 回调（内部走 ctx.tools.execute），
 *    而不是直接调工具 definition；审批闸门与工具日志因此对批量调用同样生效。
 * 2. **bindings 必须无损 JSON 且名字可移植**——非法名或与保留全局同名的工具要
 *    被跳过，不能因为一个工具而让整个批处理命名空间失败。
 */
import { describe, expect, it, vi } from 'vitest'
import { BINDING_GLOBAL, buildBindings, isPortableName, toJsonResult } from '../src/tool-batch.ts'

describe('isPortableName', () => {
  it('接受常规工具名', () => {
    for (const name of ['cn_get_ticker', 'holdings_list', 'fx_get', '_x', 'a1']) {
      expect(isPortableName(name)).toBe(true)
    }
  })

  it('拒绝含点/连字符/空格与数字开头', () => {
    for (const name of ['a.b', 'a-b', 'a b', '1a', '']) {
      expect(isPortableName(name)).toBe(false)
    }
  })
})

describe('buildBindings', () => {
  const schemas = [
    { name: 'cn_get_ticker' },
    { name: 'holdings_list' },
    { name: 'bad-name' },
    { name: BINDING_GLOBAL },
  ]

  it('只为合法且非保留名的工具建函数', () => {
    const dispatch = vi.fn(async () => ({ ok: 1 }))
    const [ns] = buildBindings(schemas, dispatch, isPortableName)
    expect(Object.keys(ns.functions).sort()).toEqual(['cn_get_ticker', 'holdings_list'])
    expect(ns.global).toBe(BINDING_GLOBAL)
  })

  it('子调用经 dispatch 回调（即执行管线），不是直接执行', async () => {
    const dispatch = vi.fn(async (name: string, args: unknown) => ({ name, args }))
    const [ns] = buildBindings(schemas, dispatch, isPortableName)
    await ns.functions.cn_get_ticker({ symbol: '002714' })
    expect(dispatch).toHaveBeenCalledWith('cn_get_ticker', { symbol: '002714' })
  })

  it('缺省参数归一为 {}', async () => {
    const dispatch = vi.fn(async () => null)
    const [ns] = buildBindings(schemas, dispatch, isPortableName)
    await ns.functions.holdings_list(undefined)
    expect(dispatch).toHaveBeenCalledWith('holdings_list', {})
  })
})

describe('toJsonResult', () => {
  it('优先取结构化 value', () => {
    expect(toJsonResult({ value: { a: 1 }, content: [{ type: 'text', text: 'x' }] })).toEqual({ a: 1 })
  })

  it('无 value 时拼 text 块', () => {
    expect(toJsonResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })

  it('失败时返回错误文本而不是抛错', () => {
    expect(toJsonResult({ error: { message: 'denied by gate' } })).toBe('denied by gate')
    expect(toJsonResult({ error: 'UNKNOWN_TOOL' })).toBe('UNKNOWN_TOOL')
  })

  it('空结果返回 null', () => {
    expect(toJsonResult({})).toBeNull()
  })
})
