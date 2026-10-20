/**
 * 研究分享卡(#19):一次已通过校验的个股研究 → 卡片上的几样东西。
 *
 * 只放四类:① 事实 —— 证据里的原值,带报告期和来源;② 数量 —— 证据 / 来源 / 计算 / 阶段 / 来源冲突;
 * ③ 数据缺口 —— 各阶段写下的缺口,只写「哪一项 + 哪类缺口」:名字用数据源注册表里的中文名,查不到就写原代号。
 *    模型写的原因句(detail)不上卡:又长又技术(「主信封ok」「Phase 0 无产能…」),截哪一段都可能断章取义;原因看报告的「数据缺口」。
 * ④ 合规声明(前端加)。
 * 🔴 不放报告里的结论、判读、可信度和评分,也不放目标价、买卖点 —— 卡片会被转发,离开了报告里的证据和口径说明,
 *    一句判读就成了没出处的断言。事实只取证据原值,不取派生计算(TTM、PE 消化年数这类要配口径才能读)。
 * ⚠️ 同一个数在同一期有几个来源、数值不同 → 全部并列,不替用户挑一个。
 */
import fs from "node:fs";

import { complianceGate } from "../gate.ts";
import { localClock } from "../notify.ts";
import { endpointsById, loadRegistry } from "../registry.ts";
import { assertRunId, readRunFile, runCompanyName, safePath, ServiceError, type ServiceContext } from "../service.ts";

/** 卡片上的事实:证据字段 → 名称。`cum` 是报告期累计值,`fy` 取研究那一年的一致预期 */
export const SHARE_FACTS: readonly { field: string; label: string; kind: "snapshot" | "cum" | "fy" }[] = [
  { field: "price", label: "股价", kind: "snapshot" },
  { field: "total_market_cap", label: "总市值", kind: "snapshot" },
  { field: "pe_ttm", label: "市盈率(TTM)", kind: "snapshot" },
  { field: "pb", label: "市净率", kind: "snapshot" },
  { field: "revenue_cum", label: "营业收入", kind: "cum" },
  { field: "net_profit_parent_cum", label: "归母净利润", kind: "cum" },
  { field: "eps_consensus_mean", label: "一致预期每股收益", kind: "fy" },
];

/** 缺口的类型:排在前面的更要紧,卡片放不下时先放它们 */
export const GAP_ORDER = ["source_failed", "source_partial", "upstream_missing", "insufficient_periods",
  "not_supported_market", "upstream_not_meaningful", "other", "optional_skipped"] as const;
export type GapKind = (typeof GAP_ORDER)[number];

export interface ShareValue { value: number; unit: string; source: string; id: string }
export interface ShareFact { field: string; label: string; kind: "snapshot" | "cum" | "fy"; period: string; values: ShareValue[]; analysts: number | null }
/** count:这一行合并了几处缺口(同名的合成一行) */
export interface ShareGap { operation: string; kind: GapKind; label: string; count: number }
export interface ShareCardResult {
  run_id: string;
  symbol: string;
  market: string;
  name: string | null;
  status: "complete" | "incomplete";
  finished_at: string;
  test_scenario: boolean;
  facts: ShareFact[];
  missing_facts: string[];
  counts: { evidence: number; sources: number; calculations: number | null; stages_done: number; stages_total: number; conflicts: number | null };
  gaps: ShareGap[];
}

/** 注册表里查不到的几项:计算步骤和研究流程里的核对项(实跑里出现过的) */
const OP_LABEL: Record<string, string> = {
  quarterize: "单季拆分", ttm_from_ytd: "累计值推近四季", ttm_yoy_from_ytd: "近四季同比", fx_convert: "汇率换算", identity_check: "公司身份核对",
  technical_indicators: "技术指标", chip_distribution: "筹码分布",
  "industry-chain": "产业链核对", industry_chain: "产业链核对", knowledge_conflicts: "研究记忆核对", pledge_ratio: "质押比例",
};
const OP_RE = /^[A-Za-z0-9_.-]{1,48}$/;
/** 只认自己的键:operation 写成 constructor / toString 也不会捞到原型上的东西 */
const own = (o: Record<string, string>, k: string): string => (Object.hasOwn(o, k) ? o[k]! : "");

const MAX_VALUES = 3;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 港美股累计值的期间写成「起..止」 */
const RANGE_RE = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;
/** 累计值按截止日比新旧:「起..止」取止,单日就是它本身 */
const endOf = (p: string): string => p.slice(-10);

/** 读运行目录里的一个 JSON 文件:不是普通文件(目录、管道这类一读就卡住的)或读不出来都当没有;符号链接 safePath 已拒 */
function runJson(ctx: ServiceContext, id: string, ...seg: string[]): unknown {
  const p = safePath(ctx, "runs", id, ...seg);
  if (!fs.existsSync(p) || !fs.lstatSync(p).isFile()) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

interface Ev { id: string; field: string; value: number; unit: string; period: string; source: string }
function evidenceOf(doc: unknown): { items: Ev[]; total: number; sources: number } {
  const rows = Array.isArray(doc) ? doc : isObj(doc) && Array.isArray(doc.evidence) ? doc.evidence : [];
  const items: Ev[] = [];
  const sources = new Set<string>();
  for (const r of rows as unknown[]) {
    if (!isObj(r)) continue;
    if (typeof r.source === "string" && r.source) sources.add(r.source);
    const value = fin(r.value);
    if (value === null || typeof r.field !== "string" || typeof r.period !== "string" || typeof r.id !== "string") continue;
    items.push({ id: r.id, field: r.field, value, unit: typeof r.unit === "string" ? r.unit : "", period: r.period, source: typeof r.source === "string" ? r.source : "" });
  }
  return { items, total: rows.length, sources: sources.size };
}

/** 一项事实:取最新一期(一致预期取研究那一年);同期的值去重后并列(最多 3 个),同一个值每个来源各留一条,界面合并成「值(来源甲、来源乙)」 */
export function pickFacts(items: Ev[], fy: string): { facts: ShareFact[]; missing: string[] } {
  const facts: ShareFact[] = [];
  const missing: string[] = [];
  for (const def of SHARE_FACTS) {
    const rows = items.filter((e) => e.field === def.field && (def.kind === "fy" ? e.period === fy : DAY_RE.test(e.period) || (def.kind === "cum" && RANGE_RE.test(e.period))));
    const period = def.kind === "fy" ? fy : rows.reduce((m, e) => (endOf(e.period) > endOf(m) || (endOf(e.period) === endOf(m) && e.period > m) ? e.period : m), "");
    const at = rows.filter((e) => e.period === period);
    if (!at.length) { missing.push(def.label); continue; }
    const seen = new Map<string, ShareValue[]>();
    for (const e of [...at].sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id))) {
      const k = `${e.value}|${e.unit}`;
      const same = seen.get(k) ?? [];
      // 两个来源给出同一个值是互相印证,来源都要留(审查 R3-5)
      if (!same.some((v) => v.source === e.source)) same.push({ value: e.value, unit: e.unit, source: e.source, id: e.id });
      seen.set(k, same);
    }
    const values = [...seen.values()].slice(0, MAX_VALUES).flat();
    let analysts: number | null = null;
    if (def.kind === "fy") {
      const src = new Set(values.map((v) => v.source));
      const n = items.find((e) => e.field === "eps_analyst_count" && e.period === period && src.has(e.source));
      analysts = n ? n.value : null;
    }
    facts.push({ field: def.field, label: def.label, kind: def.kind, period, values, analysts });
  }
  return { facts, missing };
}

/** 港美股的当前财年:财年不跟自然年(苹果 FY 截止 9 月),一致预期源只给当前财年与下一财年,取其中较早的一年 */
export function currentFy(market: string, items: Ev[]): string | null {
  if (market !== "US" && market !== "HK") return null;
  const fys = items.filter((e) => e.field === "eps_consensus_mean" && /^FY\d{4}$/.test(e.period)).map((e) => e.period).sort();
  return fys[0] ?? null;
}

/** 注册表标题的短名:「东财个股基本面(股本 / 市值…)」→「东财个股基本面」,「管制与准入 · 美方名单…」→「管制与准入」 */
export function shortTitle(title: string): string {
  return title.split(/[(（]| · /)[0]!.trim();
}

/**
 * 各阶段的缺口合并:按卡片上显示的名字合成一行(取更要紧的那类),数清合了几处,按要紧程度排。
 * 同一项写法不同(industry-chain / industry_chain)算一处;几句上不了卡的都归「其他」,合成「其他 N 处」。
 */
export function mergeGaps(stages: unknown[], titles: Record<string, string> = {}): ShareGap[] {
  const by = new Map<string, { gap: Omit<ShareGap, "count">; ops: Set<string> }>();
  for (const st of stages) {
    if (!isObj(st) || !Array.isArray(st.gaps)) continue;
    for (const g of st.gaps as unknown[]) {
      if (!isObj(g) || typeof g.operation !== "string" || !g.operation.trim()) continue;
      const kind: GapKind = (GAP_ORDER as readonly string[]).includes(String(g.reason_code)) ? g.reason_code as GapKind : "other";
      // operation 是模型写的:不像代号(中文长句、超长)就不上卡,归到「其他」
      let label = own(titles, g.operation) || own(OP_LABEL, g.operation) || (OP_RE.test(g.operation) ? g.operation : "其他");
      // 卡片会被转发:缺口名过一遍产出红线,命中的也归「其他」
      if (label !== "其他" && !complianceGate(label).ok) label = "其他";
      const op = g.operation.trim().toLowerCase().replace(/-/g, "_");
      const prev = by.get(label);
      if (!prev) by.set(label, { gap: { operation: g.operation, kind, label }, ops: new Set([op]) });
      else {
        prev.ops.add(op);
        if (GAP_ORDER.indexOf(kind) < GAP_ORDER.indexOf(prev.gap.kind)) prev.gap = { ...prev.gap, operation: g.operation, kind };
      }
    }
  }
  return [...by.values()]
    .map(({ gap, ops }) => ({ ...gap, label: ops.size > 1 ? `${gap.label} ${ops.size} 处` : gap.label, count: ops.size }))
    .sort((a, b) => GAP_ORDER.indexOf(a.kind) - GAP_ORDER.indexOf(b.kind));
}

export async function shareCard(ctx: ServiceContext, query: Record<string, string>): Promise<ShareCardResult> {
  const id = assertRunId(query.run_id);
  const manifestText = readRunFile(ctx, id, "manifest.json");
  if (manifestText === null) throw new ServiceError("not_found", `没有这次研究:${id}`);
  // 报告没通过最终校验就不出卡片:和报告正文同一个判据
  if (readRunFile(ctx, id, "report.md") === null) throw new ServiceError("report_not_ready", "这次研究的报告还没通过校验,不能生成分享卡");
  let m: Record<string, unknown>;
  try { m = JSON.parse(manifestText) as Record<string, unknown>; } catch { throw new ServiceError("report_not_ready", "这次研究的运行记录读不出来"); }

  const stageList = (Array.isArray(m.stages) ? m.stages : []).filter(isObj).map((s) => ({ stage: String(s.stage ?? ""), status: String(s.status ?? "") }));
  const stages = stageList.filter((s) => /^[a-z_]{1,40}$/.test(s.stage)).map((s) => runJson(ctx, id, "stages", `${s.stage}.json`));
  const ev = evidenceOf(runJson(ctx, id, "evidence.json"));
  const finished = String(m.finished_at);
  const fy = currentFy(String(m.market ?? ""), ev.items) ?? `FY${localClock(new Date(finished), "Asia/Shanghai").day.slice(0, 4)}`;
  const { facts, missing } = pickFacts(ev.items, fy);
  const conflicts = runJson(ctx, id, "conflicts.json");
  const nConflicts = isObj(conflicts) && Array.isArray(conflicts.id_conflicts) && Array.isArray(conflicts.source_conflicts)
    ? conflicts.id_conflicts.length + conflicts.source_conflicts.length : null;

  // 卡片会被转发:名称和缺口说明是外来 / 模型写的文字,过一遍产出红线,命中的退回成代号
  let name = runCompanyName(ctx, id);
  if (name && !complianceGate(name).ok) name = null;
  const reg = loadRegistry(ctx.repoRoot);
  const titles = Object.fromEntries(Object.entries(reg ? endpointsById(reg) : {}).map(([k, d]) => [k, shortTitle(String(d.title ?? ""))]));
  const gaps = mergeGaps(stages, titles);

  return {
    run_id: id,
    symbol: String(m.symbol ?? ""),
    market: String(m.market ?? ""),
    name,
    status: m.status === "incomplete" ? "incomplete" : "complete",
    finished_at: finished,
    test_scenario: m.test_scenario === true,
    facts,
    missing_facts: missing,
    counts: {
      evidence: fin(m.evidence_count) ?? ev.total,
      sources: ev.sources,
      calculations: fin(m.calculation_count),
      stages_done: stageList.filter((s) => s.status === "complete").length,
      stages_total: stageList.length,
      conflicts: nConflicts,
    },
    gaps,
  };
}
