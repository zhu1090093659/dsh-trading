/**
 * 推断的四档可信度(研究宪法 §1):报告「推断」章节每条标一档,不用高 / 中 / 低。
 * 「未核实线索」可以没有依据;其余三档必须写出依据(证据 / 计算 id 或用户资料引用)。
 * 逐条 = 表格数据行 + 顶层列表项;段落文字和下级列表(多是对上一条的展开)不单算一条。
 */
import { headingBlocks } from "../report_sections.ts";

export const INFERENCE_TIERS = ["已披露证实", "有依据的推断", "未核实线索", "被反证"] as const;
const UNVERIFIED = "未核实线索";
const BASIS = /(?<![0-9A-Za-z_-])(?:ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})(?![0-9A-Za-z_-])|\[资料:[^\]\n]+\]/;
const TABLE_ROW = /^\s*\|/;
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const TOP_ITEM = /^ ?(?:[-*+]|\d+[.、)])\s+/;
const TIER_LIST = INFERENCE_TIERS.join(" / ");

function items(body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (TABLE_ROW.test(line)) {
      if (SEPARATOR.test(line)) continue;
      if (SEPARATOR.test(lines[i + 1] ?? "")) continue;   // 表头
      out.push(line);
    } else if (TOP_ITEM.test(line)) out.push(line);
  }
  return out;
}

export function inferenceTierErrors(report: string): string[] {
  const errors: string[] = [];
  for (const block of headingBlocks(report)) {
    if (block.level > 3 || !block.title.trim().startsWith("推断")) continue;
    items(block.body).forEach((line, k) => {
      const excerpt = line.trim().slice(0, 60);
      const tiers = INFERENCE_TIERS.filter((t) => line.includes(t));
      if (!tiers.length) errors.push(`report.md「推断」第 ${k + 1} 条没标可信度(只用四档:${TIER_LIST}):${excerpt}`);
      else if (!BASIS.test(line) && !tiers.includes(UNVERIFIED)) {
        errors.push(`report.md「推断」第 ${k + 1} 条标了「${tiers[0]}」却没写依据 id(ev- / calc- / 资料引用);没有依据只能标「${UNVERIFIED}」:${excerpt}`);
      }
    });
  }
  return errors;
}
