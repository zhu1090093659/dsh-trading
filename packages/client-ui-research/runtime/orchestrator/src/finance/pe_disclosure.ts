/** PE percentile provenance is a financial disclosure, not a Core numeric rule. */
import type { CalcRecord, EvidenceItem } from "../merge.ts";

function sourceLabel(items: EvidenceItem[]): string {
  if (!items.length) return "未核实";
  return [...new Set(items.map(e => /^[a-zA-Z0-9._-]{1,64}$/.test(e.source) ? e.source : "未核实"))].sort().join(" / ");
}

/** A 股 = 证券宝 pe_ttm_traded_history_points;港美股 = 百度 pe_ttm_points */
const HISTORY_FIELDS = ["pe_ttm_traded_history_points", "pe_ttm_points"];

export function peDisclosureLines(evidence: Iterable<EvidenceItem>, calcs: Iterable<CalcRecord>): string[] {
  const byId = new Map([...evidence].map(e => [e.id, e]));
  const lines: string[] = [];
  for (const c of calcs) {
    // Disk records are not schema-validated yet. The production validator owns
    // their errors; this additional disclosure must not interrupt that repair path.
    if (c?.function !== "percentile_rank" || c.output?.status !== "ok" || !/^calc-[a-f0-9]{16}$/.test(c.calculation_id ?? "")) continue;
    const refs = (Array.isArray(c.inputs_refs) ? c.inputs_refs : []).filter(r => r?.ref_type === "evidence").flatMap(r => byId.get(r.ref_id) ? [byId.get(r.ref_id)!] : []);
    const spec = c.inputs?.history as { history_csv?: { column?: unknown; raw_ref?: unknown } } | undefined;
    if (!refs.some(e => ["pe_ttm", "pe_ttm_latest", ...HISTORY_FIELDS].includes(e.field)) && !["peTTM", "pe_ttm"].includes(String(spec?.history_csv?.column))) continue;
    const current = refs.filter(e => (e.field === "pe_ttm" || e.field === "pe_ttm_latest") && e.value === c.inputs?.current);
    const history = refs.filter(e => HISTORY_FIELDS.includes(e.field) && e.raw_ref === spec?.history_csv?.raw_ref);
    lines.push(`> PE 分位口径：当前值来源 ${sourceLabel(current)}；历史序列来源 ${sourceLabel(history)}；跨来源或不同财务口径的分位仅供对照，不代表同源精确比较。[${c.calculation_id}]`);
  }
  return [...new Set(lines)].sort();
}

// 放进报告开头、生产校验与提示词:见 report_prelude.ts(与口径提示合成同一段固定披露)
