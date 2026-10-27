/**
 * 知识库导入 / 导出的纯函数面（可 node 单测，不 import react）。
 *
 * 视图与单测共用同一份实现：导出文件名、导出文本、计划摘要、文件文本解析包装。
 * 落盘格式与去重语义全部来自 @dshtrading/knowledge 的 bundle 模块，本模块只负责
 * 「UI 要的那几个数 / 那一段文本」，不复制任何判定逻辑——同一事实只有一个家。
 */
import {
  createKnowledgeBundle,
  parseKnowledgeBundle,
  serializeKnowledgeBundle,
  type KnowledgeCard,
  type KnowledgeImportPlan,
} from '@dshtrading/knowledge'

/** 两位补零（月份从 0 起、时间各段都可能是一位数）。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 导出文件名：'knowledge-YYYYMMDD-HHmmss.json'（本地时间）。
 *
 * 用本地时间而不是 UTC：文件名是给人看、给人找的，用户按自己墙上的时间认文件；
 * 文件内部 meta.exportedAt 才是 UTC 的绝对时刻。
 */
export function exportKnowledgeFileName(now: Date): string {
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  return `knowledge-${date}-${time}.json`
}

/** 导出文本：卡片列表 → bundle → 落盘文本（换行与缩进口径见 serializeKnowledgeBundle）。 */
export function exportKnowledgeText(cards: readonly KnowledgeCard[], now: Date): string {
  return serializeKnowledgeBundle(createKnowledgeBundle(cards, { now }))
}

/** 导入预览要显示的五个计数（预览面板与结果提示共用同一份口径）。 */
export function importPlanSummary(plan: KnowledgeImportPlan): {
  create: number
  update: number
  skip: number
  dropped: number
  invalid: number
} {
  return {
    create: plan.create.length,
    update: plan.update.length,
    skip: plan.skipped.length,
    dropped: plan.droppedRelated.length,
    invalid: plan.invalid.length,
  }
}

/**
 * 解析文件文本（薄包装）。
 *
 * 保持单一解析入口：视图只经这里碰 bundle 文本，将来换解析实现或加护栏时
 * 视图与单测一起跟着走，不会出现「预览用一种读法、写库用另一种读法」。
 */
export function parseImportFileText(text: string): ReturnType<typeof parseKnowledgeBundle> {
  return parseKnowledgeBundle(text)
}
