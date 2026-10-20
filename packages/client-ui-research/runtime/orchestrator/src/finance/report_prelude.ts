/**
 * 报告开头的固定披露:PE 分位口径(pe_disclosure.ts)+ 口径提示(caliber_hints.ts)。
 * 都由编排器按落盘证据确定性生成;报告提示词和生产阶段 validator 用同一份,模型只负责逐字放进报告。
 */
import { loadCalcs, loadFetch, mergeEvidence, type CalcRecord, type EvidenceItem } from "../merge.ts";
import { caliberHintLines } from "./caliber_hints.ts";
import { peDisclosureLines } from "./pe_disclosure.ts";

export function reportPreludeLines(evidence: Iterable<EvidenceItem>, calcs: Iterable<CalcRecord>): string[] {
  const ev = [...evidence];
  const cs = [...calcs];
  return [...peDisclosureLines(ev, cs), ...caliberHintLines(ev, cs)];
}

/** Fixed prelude immediately after the H1, before model-written body can hide it in Markdown/HTML. */
export function reportPreludeErrors(report: string, required: readonly string[]): string[] {
  if (!required.length) return [];
  const lines = report.replace(/\r\n/g, "\n").split("\n");
  if (/^# [^<>]+$/.test(lines[0] ?? "") && lines[1] === "" && required.every((line, i) => lines[i + 2] === line)
      && lines[required.length + 2] === "") return [];
  return [`报告开头的固定披露缺失或位置不对：首行标题之后空一行，逐字放入下列可见引用块，再空一行写正文。\n${required.join("\n")}`];
}

export function reportPreludePrompt(runDir: string): string {
  const evidence = mergeEvidence(loadFetch(runDir)).evidence;
  const calcs = loadCalcs(runDir).flatMap(c => c.record ? [c.record] : []);
  const lines = reportPreludeLines(evidence, calcs);
  if (!lines.length) return "";
  const hints = caliberHintLines(evidence, calcs).length
    ? "\n其中「口径提示」是编排器按本次证据核对出的口径错位：只提示、不改变状态；正文用到相关计算时如实说明这个限制，不要写出和提示相反的判断。"
    : "";
  return `【报告开头固定披露】报告首行标题之后空一行，逐字放入以下引用块，再空一行继续正文。所引 calc id 也列入阶段 calculation_ids。不得藏到注释、代码块或末尾。${hints}\n${lines.join("\n")}`;
}
