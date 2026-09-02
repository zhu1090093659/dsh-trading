#!/usr/bin/env node
/**
 * 一次性数据清洗：移除知识卡片 tags 中的非主题词污染（作者名 tag、时间段 tag）。
 *
 * 背景（2026-09-02，Agent Note 2026-09-02-journal-agents-knowledge-recall）：
 * 批量导入把 UP 主名（与 source.author 同值）与「2026H1」这类时间段写进了受控主题
 * tags——212/215 卡共用同一组 tag，标签过滤与图谱聚类失效。
 *
 * 清洗规则：
 *   1) tag 与 source.author 完全相等（trim + 大小写不敏感）→ 移除；
 *   2) tag 匹配 /^\d{4}(H1|H2|Q[1-4])$/i（时间段）→ 移除；
 *   3) 清洗后 tags 为空的卡片兜底为 ['未分类']（validate 要求 tags 非空）。
 *
 * 默认 dry-run 只打印报告；--apply 才写回：写前自动备份
 * cards.json.bak-clean-tags-<ts>，tmp+rename 原子写。
 *
 * 注意：knowledge file store 在 DSH 进程内有一次加载缓存且不失效——必须在
 * 没有 DSH 实例运行时执行 --apply，否则运行中实例的旧缓存会在下次 save 时
 * 把清洗结果覆盖回去。
 */
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const fileIdx = argv.indexOf('--file')
const file = fileIdx > -1 ? argv[fileIdx + 1] : path.join(os.homedir(), '.dsh', 'knowledge', 'cards.json')

const PERIOD_TAG_RE = /^\d{4}(H1|H2|Q[1-4])$/i

const raw = JSON.parse(await readFile(file, 'utf8'))
if (!Array.isArray(raw)) {
  console.error(`[clean-knowledge-author-tags] ${file} 不是卡片数组，中止`)
  process.exit(1)
}

let touchedCards = 0
let removedAuthorTags = 0
let removedPeriodTags = 0
const fallbackCards = []

const cleaned = raw.map((card) => {
  const author = String(card?.source?.author ?? '').trim().toLowerCase()
  const tags = Array.isArray(card?.tags) ? card.tags.map((t) => String(t)) : []
  const kept = []
  for (const tag of tags) {
    const t = tag.trim()
    if (author !== '' && t.toLowerCase() === author) {
      removedAuthorTags += 1
      continue
    }
    if (PERIOD_TAG_RE.test(t)) {
      removedPeriodTags += 1
      continue
    }
    kept.push(t)
  }
  if (tags.length - kept.length === 0) return card
  touchedCards += 1
  let finalTags = kept
  if (kept.length === 0) {
    finalTags = ['未分类']
    fallbackCards.push(card?.id ?? '(no id)')
  }
  return { ...card, tags: finalTags }
})

console.log(`[clean-knowledge-author-tags] 模式: ${apply ? 'APPLY（写回）' : 'DRY-RUN（只报告）'}`)
console.log(`目标文件: ${file}`)
console.log(`扫描卡片: ${raw.length}`)
console.log(`移除作者名 tag: ${removedAuthorTags}`)
console.log(`移除时间段 tag: ${removedPeriodTags}`)
console.log(`改动卡片: ${touchedCards}`)
if (fallbackCards.length > 0) console.log(`兜底「未分类」的卡片: ${fallbackCards.join(', ')}`)

if (!apply) {
  console.log('dry-run 结束；确认无误后加 --apply 写回')
  process.exit(0)
}

const backup = `${file}.bak-clean-tags-${new Date().toISOString().replace(/[:.]/g, '-')}`
await copyFile(file, backup)
const tmp = `${file}.tmp.${process.pid}`
await writeFile(tmp, JSON.stringify(cleaned, null, 2), 'utf8')
await rename(tmp, file)
console.log(`已备份原文件: ${backup}`)
console.log('已写回清洗结果')
