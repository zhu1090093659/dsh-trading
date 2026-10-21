/**
 * tool-batch 单测：批量入口的两个硬契约。
 *
 * 1. **不能绕过执行管线**——子调用必须经 dispatch 回调（内部走 ctx.tools.execute），
 *    而不是直接调工具 definition；审批闸门与工具日志因此对批量调用同样生效。
 * 2. **bindings 必须无损 JSON 且名字可移植**——非法名或与保留全局同名的工具要
 *    被跳过，不能因为一个工具而让整个批处理命名空间失败。
 *
 * 子调用用真实记录数组核对，不引入通用 spy 工具。
 */
import { describe, expect, it } from 'vitest'
import { BINDING_GLOBAL, buildBindings, isPortableName, toJsonResult } from '../src/tool-batch.ts'

interface RecordedCall {
  name: string
  args: unknown
}

/** 手写记录器：每次子调用落进真实数组，供断言核对调用名与参数。 */
function recordingDispatch(answer: (name: string, args: unknown) => unknown): {
  dispatch: (name: string, args: unknown) => Promise<unknown>
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  return {
    calls,
    dispatch: async (name, args) => {
      calls.push({ name, args })
      return answer(name, args)
    },
  }
}

describe('isPortableName', () => {
  it('用户：接受常规工具名', () => {
    // Given 合法标识符形态的工具名（含下划线、数字结尾）
    // When 逐个判定可移植性
    // Then 全部接受
    for (const name of ['cn_get_ticker', 'holdings_list', 'fx_get', '_x', 'a1']) {
      expect(isPortableName(name)).toBe(true)
    }
  })

  it('用户：拒绝含点/连字符/空格与数字开头', () => {
    // Given 点、连字符、空格、数字开头与空串这些非法形态
    // When 逐个判定可移植性
    // Then 全部拒绝
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

  it('用户：只为合法且非保留名的工具建函数', () => {
    // Given 四个 schema：两个合法名、一个含连字符、一个与保留全局同名
    // When 构建 bindings
    // Then 只有两个合法名成为函数，全局名仍是保留的 tools
    const { dispatch } = recordingDispatch(() => ({ ok: 1 }))
    const [ns] = buildBindings(schemas, dispatch, isPortableName)
    expect(Object.keys(ns.functions).sort()).toEqual(['cn_get_ticker', 'holdings_list'])
    expect(ns.global).toBe(BINDING_GLOBAL)
  })

  it('用户：子调用经 dispatch 回调（即执行管线），不是直接执行', async () => {
    // Given 记录每次子调用的 dispatch
    const { dispatch, calls } = recordingDispatch((name, args) => ({ name, args }))
    const [ns] = buildBindings(schemas, dispatch, isPortableName)
    // When 通过 binding 调用一个工具
    await ns.functions.cn_get_ticker({ symbol: '002714' })
    // Then 调用带着工具名与原始参数穿过 dispatch（审批与日志因此生效）
    expect(calls).toEqual([{ name: 'cn_get_ticker', args: { symbol: '002714' } }])
  })

  it('用户：缺省参数归一为 {}', async () => {
    // Given 记录每次子调用的 dispatch
    const { dispatch, calls } = recordingDispatch(() => null)
    const [ns] = buildBindings(schemas, dispatch, isPortableName)
    // When 不传参数调用 binding
    await ns.functions.holdings_list(undefined)
    // Then 传给 dispatch 的是空对象而不是 undefined
    expect(calls).toEqual([{ name: 'holdings_list', args: {} }])
  })
})

describe('toJsonResult', () => {
  it('用户：优先取结构化 value', () => {
    // Given 同时带 value 与 text 块的执行结果
    // When 压成可 JSON 化的返回值
    // Then value 优先于文本块
    expect(toJsonResult({ value: { a: 1 }, content: [{ type: 'text', text: 'x' }] })).toEqual({ a: 1 })
  })

  it('用户：无 value 时拼 text 块', () => {
    // Given 只有两个 text 块、没有 value 的结果
    // When 压成可 JSON 化的返回值
    // Then 文本块按换行拼接
    expect(toJsonResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })

  it('用户：失败时返回错误文本而不是抛错', () => {
    // Given 结构化错误与字符串错误两种失败结果
    // When 压成可 JSON 化的返回值
    // Then 都取错误消息文本，不抛错
    expect(toJsonResult({ error: { message: 'denied by gate' } })).toBe('denied by gate')
    expect(toJsonResult({ error: 'UNKNOWN_TOOL' })).toBe('UNKNOWN_TOOL')
  })

  it('用户：空结果返回 null', () => {
    // Given 既无 value 也无 content、error 的结果
    // When 压成可 JSON 化的返回值
    // Then 返回 null
    expect(toJsonResult({})).toBeNull()
  })
})
