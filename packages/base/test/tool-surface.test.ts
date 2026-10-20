/**
 * tool-surface 单测：裁剪必须只删「声明不要的族」，其余能力一律保留。
 *
 * 最重要的契约是 deny 语义的安全性：read / bash / skill / job_output 这类
 * 非交易工具绝不能被顺手删掉——它们是 skill、子代理、后台任务的基础设施。
 */
import { describe, expect, it } from 'vitest'
import { defineConfig } from '../src/tool-surface-config.ts'
import { familyOf, resolveDeny } from '../src/tool-surface.ts'

const schemas = [
  { name: 'cn_get_ticker' },
  { name: 'cn_get_klines' },
  { name: 'holdings_list' },
  { name: 'tasks_create' },
  { name: 'tasks_list' },
  { name: 'strategy_backtest' },
  { name: 'read' },
  { name: 'read_image' },
  { name: 'bash' },
  { name: 'skill' },
  { name: 'job_output' },
  { name: 'subagent_researcher' },
]

describe('resolveDeny', () => {
  it('按族删除且不误伤非交易工具', () => {
    const deny = resolveDeny(schemas, { denyFamilies: ['tasks'] })
    expect(deny).toEqual(['tasks_create', 'tasks_list'])
    expect(deny).not.toContain('read')
    expect(deny).not.toContain('bash')
    expect(deny).not.toContain('skill')
    expect(deny).not.toContain('job_output')
  })

  it('不存在的族展开为空（restrict 拒绝未知工具名）', () => {
    expect(resolveDeny(schemas, { denyFamilies: ['doesnotexist'] })).toEqual([])
  })

  it('具体工具名优先于族级保留', () => {
    const deny = resolveDeny(schemas, { denyTools: ['cn_get_klines'] })
    expect(deny).toEqual(['cn_get_klines'])
  })

  it('族与具体工具合并去重并排序', () => {
    const deny = resolveDeny(schemas, { denyFamilies: ['tasks'], denyTools: ['tasks_list', 'strategy_backtest'] })
    expect(deny).toEqual(['strategy_backtest', 'tasks_create', 'tasks_list'])
  })

  it('大小写与空白归一（否则会「以为裁了其实没裁」）', () => {
    const deny = resolveDeny(schemas, defineConfig({ denyFamilies: [' Tasks ', 'CN'] }))
    expect(deny).toEqual(['cn_get_klines', 'cn_get_ticker', 'tasks_create', 'tasks_list'])
  })

  it('familyOf 取首个下划线之前', () => {
    expect(familyOf('cn_get_ticker')).toBe('cn')
    expect(familyOf('read')).toBe('read')
  })
})

describe('defineConfig', () => {
  it('忽略脏输入并给出确定形状', () => {
    expect(defineConfig(undefined)).toEqual({ denyFamilies: [], denyTools: [] })
    expect(defineConfig({ denyFamilies: 'tasks' as unknown })).toEqual({ denyFamilies: [], denyTools: [] })
    expect(defineConfig({ denyFamilies: ['', '  ', 42 as unknown] })).toEqual({ denyFamilies: [], denyTools: [] })
  })
})
