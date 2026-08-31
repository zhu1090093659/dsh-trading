/**
 * @dsh-trading/knowledge — 知识库数据平面核心库：
 * 数据模型 + 结构校验 + 纯函数图构建 + 内存 Store。
 *
 * 纯库包，零 Node.js 运行时依赖，浏览器端可安全打包。
 * Node 端专用工具（createKnowledgeIngestTool, createFileKnowledgeCardStore 等）
 * 请经由子路径 `@dsh-trading/knowledge/tool` 引用。
 */
export type {
  KnowledgeSourceType,
  KnowledgeCredibility,
  KnowledgeSource,
  KnowledgeFactCheck,
  KnowledgeCard,
  KnowledgeCardInput,
  GraphLinkKind,
  KnowledgeGraphNode,
  KnowledgeGraphLink,
  KnowledgeGraphData,
  BuildGraphOptions,
  KnowledgeCardStore,
} from './types.ts'

export {
  validateKnowledgeCard,
  generateCardId,
  type ValidationResult,
} from './validate.ts'

export { buildGraph } from './graph.ts'

export { createMemoryKnowledgeCardStore } from './store-memory.ts'
