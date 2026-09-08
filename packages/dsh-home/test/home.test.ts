import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dshHomeDir } from '../src/index.ts'

describe('dshHomeDir', () => {
  it('未设 DSH_HOME 时缺省 ~/.dsh', () => {
    expect(dshHomeDir({})).toBe(join(homedir(), '.dsh'))
    expect(dshHomeDir({ DSH_HOME: undefined })).toBe(join(homedir(), '.dsh'))
  })

  it('空白（含纯空白字符）DSH_HOME 视为未设', () => {
    expect(dshHomeDir({ DSH_HOME: '' })).toBe(join(homedir(), '.dsh'))
    expect(dshHomeDir({ DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh'))
  })

  it('非空白 DSH_HOME 优先，相对路径按 CWD 解析', () => {
    // 期望值用同一 resolve 语义计算：Windows 会把 /tmp 映到当前盘符（CI 实证），
    // 逐平台与实现自洽，不写死 POSIX 字面量。
    expect(dshHomeDir({ DSH_HOME: '/tmp/dsh-a' })).toBe(resolve('/tmp/dsh-a'))
    expect(dshHomeDir({ DSH_HOME: 'rel-home' })).toBe(resolve(process.cwd(), 'rel-home'))
  })

  it('缺省读 process.env：与显式传入同环境结果一致（对导出 DSH_HOME 的 shell 也确定）', () => {
    expect(dshHomeDir()).toBe(dshHomeDir({ DSH_HOME: process.env.DSH_HOME }))
  })

  it('支持 ~ 与 ~/ 展开', () => {
    expect(dshHomeDir({ DSH_HOME: '~' })).toBe(homedir())
    expect(dshHomeDir({ DSH_HOME: '~/.dsh-trading' })).toBe(join(homedir(), '.dsh-trading'))
  })
})
