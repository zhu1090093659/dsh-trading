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
  it('管理员：按族删除且不误伤非交易工具', () => {
    // Given 十二个工具 schema，含任务族与 read/bash/skill/job_output 基础设施工具
    // When 只拒任务族
    // Then 只有任务族被删，基础设施工具一个不少
    const deny = resolveDeny(schemas, { denyFamilies: ['tasks'] })
    expect(deny).toEqual(['tasks_create', 'tasks_list'])
    expect(deny).not.toContain('read')
    expect(deny).not.toContain('bash')
    expect(deny).not.toContain('skill')
    expect(deny).not.toContain('job_output')
  })

  it('管理员：不存在的族展开为空（restrict 拒绝未知工具名）', () => {
    // Given 一个没有工具的前缀族
    // When 拒该族
    // Then 展开为空数组，不产出未知工具名
    expect(resolveDeny(schemas, { denyFamilies: ['doesnotexist'] })).toEqual([])
  })

  it('管理员：具体工具名优先于族级保留', () => {
    // Given 只点名一个具体工具
    // When 解析拒绝清单
    // Then 只删这一个工具
    const deny = resolveDeny(schemas, { denyTools: ['cn_get_klines'] })
    expect(deny).toEqual(['cn_get_klines'])
  })

  it('管理员：族与具体工具合并去重并排序', () => {
    // Given 同时给族级 tasks 与具体工具（其中一个是族内成员）
    // When 解析拒绝清单
    // Then 合并去重后按字典序排列
    const deny = resolveDeny(schemas, { denyFamilies: ['tasks'], denyTools: ['tasks_list', 'strategy_backtest'] })
    expect(deny).toEqual(['strategy_backtest', 'tasks_create', 'tasks_list'])
  })

  it('管理员：大小写与空白归一（否则会「以为裁了其实没裁」）', () => {
    // Given 带空格与大写的族名配置
    // When 经 defineConfig 归一后解析拒绝清单
    // Then 归一化后照常删对应工具
    const deny = resolveDeny(schemas, defineConfig({ denyFamilies: [' Tasks ', 'CN'] }))
    expect(deny).toEqual(['cn_get_klines', 'cn_get_ticker', 'tasks_create', 'tasks_list'])
  })

  it('管理员：familyOf 取首个下划线之前', () => {
    // Given 带前缀的工具名与不带下划线的工具名
    // When 取族名
    // Then 取首个下划线之前的部分，无下划线时整名即族名
    expect(familyOf('cn_get_ticker')).toBe('cn')
    expect(familyOf('read')).toBe('read')
  })
})

describe('defineConfig', () => {
  it('管理员：忽略脏输入并给出确定形状', () => {
    // Given undefined、字符串族名、含空串/空白/数字的族名列表
    // When 归一为配置
    // Then 一律给出空的两个清单，不抛错
    expect(defineConfig(undefined)).toEqual({ denyFamilies: [], denyTools: [] })
    expect(defineConfig({ denyFamilies: 'tasks' as unknown })).toEqual({ denyFamilies: [], denyTools: [] })
    expect(defineConfig({ denyFamilies: ['', '  ', 42 as unknown] })).toEqual({ denyFamilies: [], denyTools: [] })
  })
})
