/**
 * tool-surface 配置归一：接受宽松输入（未知键、非字符串、空值都可能来自
 * preset 的 config 对象），产出确定形状，避免族名大小写或空白差异造成
 * 「以为裁掉了其实没裁」。
 */
import type { ToolSurfaceConfig } from './tool-surface.ts'

function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim())
    .filter(v => v.length > 0)
}

export function defineConfig(raw: unknown): Required<ToolSurfaceConfig> {
  const source = (raw ?? {}) as Record<string, unknown>
  return {
    denyFamilies: strings(source.denyFamilies).map(v => v.toLowerCase()),
    denyTools: strings(source.denyTools),
  }
}
