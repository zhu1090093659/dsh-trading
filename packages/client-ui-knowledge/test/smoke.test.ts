/**
 * 冒烟测试：node half 可加载（空 apply 不抛）。client 半的行为（视图注册）
 * 依赖真实宿主验证；知识图谱与存储的契约单测在 @dshtrading/knowledge 包内。
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('@dshtrading/client-ui-knowledge node half', () => {
  it('apply 为宿主 loader 占位，调用不抛', () => {
    expect(() => apply()).not.toThrow()
  })
})
