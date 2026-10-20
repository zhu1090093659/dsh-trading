/**
 * 金融包的**阶段专属校验**(Plugin.stageValidators)。
 *
 * 🔴 这两段原本写死在 Core 的 `validator.ts` 里:`if (stage === "profile")` 核报价新鲜度、
 * `if (stage === "risk")` 核权威冲突覆盖与反证引用。它们是彻头彻尾的垂类规则 ——
 * 换个垂类既拿不到自己该有的核验,Core 又会对不存在的阶段名空跑(全审 r4-P2)。
 * ⚠️ 纯净度词表**看不见**这类耦合(英文阶段名 + 英文字段名),所以它在"0 分"下藏了很久。
 */
import type { StageValidationContext } from "../plugin.ts";
import type { RunView } from "../validator.ts";
import { financeQuoteDecision } from "./quote_freshness.ts";
import { identityCheck } from "./identity.ts";
import { inferenceTierErrors } from "./inference_tiers.ts";
import { reportPreludeErrors, reportPreludeLines } from "./report_prelude.ts";

type SourceConflictEntry = { field?: string; period?: string; kind?: string; values?: { ref_id?: string }[] };

/** profile:agent 写的报价判定必须与从证据推导出来的一致(不许自己编一个更好看的) */
function validateProfile(ctx: StageValidationContext): string[] {
  const run = ctx.run as unknown as RunView;
  const errors: string[] = [];
  const d = financeQuoteDecision(run);
  const expected = d.decision === "missing" ? "unknown_unverified" : d.decision;
  if (ctx.output.quote_decision !== expected) {
    errors.push(`quote_decision 应为 ${expected}(${d.reason}),agent 写的是 ${String(ctx.output.quote_decision)}`);
  }
  // 港美股:两个来源的公司名对不上(或缺名称)必须明写缺口,不许当作已核实
  if (run.region !== undefined && run.region !== "CN") {
    const id = identityCheck(run);
    const gaps = (ctx.output.gaps as { operation?: unknown }[] | undefined) ?? [];
    if (!id.ok && !gaps.some((g) => g.operation === "identity_check")) {
      errors.push(`公司身份没核实(${id.reason}):profile 必须写一条 operation=identity_check 的缺口`);
    }
  }
  return errors;
}

/** risk:权威冲突必须逐条被 source_conflicts 覆盖;反证引用的 id 必须真实存在 */
function validateRisk(ctx: StageValidationContext): string[] {
  const errors: string[] = [];
  const listed = (ctx.output.source_conflicts as SourceConflictEntry[] | undefined) ?? [];
  for (const c of ctx.run.conflicts) {
    // 同字段同期可能有好几组冲突(按币种分组后,CNY 一组、HKD 一组):按证据 id 找**覆盖这一组**的那条,
    // 只取第一条会让第二组被误报「缺证据 id」(审计第二轮,A8 修复引入)
    const ids = c.values.map((v) => v.id);
    const coverage = (x: SourceConflictEntry) => { const refs = new Set((x.values ?? []).map((v) => v.ref_id)); return ids.filter((id) => refs.has(id)).length; };
    const same = listed.filter((x) => x.field === c.field && x.period === c.period);
    const entry = same.find((x) => coverage(x) === ids.length) ?? same.sort((a, b) => coverage(b) - coverage(a))[0];
    if (!entry) { errors.push(`risk.source_conflicts 未覆盖权威冲突 ${c.field}@${c.period}(见 conflicts.json)`); continue; }
    if (entry.kind !== "source") errors.push(`risk.source_conflicts ${c.field}@${c.period} 是权威冲突,kind 必须为 "source"(实际 ${String(entry.kind)})`);
    const refs = new Set((entry.values ?? []).map((v) => v.ref_id));
    const missing = c.values.map((v) => v.id).filter((id) => !refs.has(id));
    if (missing.length) errors.push(`risk.source_conflicts ${c.field}@${c.period} 的 values 未列出权威冲突全部证据 id(缺 ${missing.join(",")})`);
  }
  for (const ce of (ctx.output.counter_evidence as { evidence_ids?: string[] }[] | undefined) ?? []) {
    for (const id of ce.evidence_ids ?? []) {
      if (!ctx.run.evidenceIds.has(id) && !ctx.run.calcIds.has(id)) errors.push(`risk.counter_evidence 引用了不存在的 id ${id}`);
    }
  }
  return errors;
}

export const FINANCE_STAGE_VALIDATORS: Record<string, (ctx: StageValidationContext) => string[]> = {
  profile: validateProfile,
  risk: validateRisk,
  report: (ctx) => {
    const run = ctx.run as RunView;
    const report = run.report ?? "";
    return [...reportPreludeErrors(report, reportPreludeLines(run.evidence.values(), run.calcById.values())), ...inferenceTierErrors(report)];
  },
};
