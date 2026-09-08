import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dshHomeDir } from '../src/index.ts'

describe('dshHomeDir', () => {
  it('未设 DSH_HOME 时缺省 ~/.dsh', () => {
    expect(dshHomeDir({})).toBe(join(homedir(), '.dsh'))
    expect(dshHomeDir()).toBe(join(homedir(), '.dsh'))
  })

  it('空白（含纯空白字符）DSH_HOME 视为未设', () => {
    expect(dshHomeDir({ DSH_HOME: '' })).toBe(join(homedir(), '.dsh'))
    expect(dshHomeDir({ DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh'))
  })

  it('非空白 DSH_HOME 优先，按 CWD 解析相对路径', () => {
    expect(dshHomeDir({ DSH_HOME: '/tmp/dsh-a' })).toBe('/tmp/dsh-a')
    const cwd = process.cwd()
    expect(dshHomeDir({ DSH_HOME: 'rel-home' })).toBe(resolve(cwd, 'rel-home'))
  })

  it('支持 ~ 与 ~/ 展开', () => {
    expect(dshHomeDir({ DSH_HOME: '~' })).toBe(homedir())
    expect(dshHomeDir({ DSH_HOME: '~/.dsh-trading' })).toBe(join(homedir(), '.dsh-trading'))
  })
})
