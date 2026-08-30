/**
 * 冒烟测试：node half 可加载（空 apply 不抛）。client 半的行为（服务
 * 提供、预置注册）依赖真实宿主验证；注册表与预置的契约单测在
 * @dsh-trading/indicators 包内。
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('@dsh-trading/client-ui-indicators node half', () => {
  it('apply 为宿主 loader 占位，调用不抛', () => {
    expect(() => apply(undefined as never)).not.toThrow()
  })
})
