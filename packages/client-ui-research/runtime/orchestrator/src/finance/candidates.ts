/**
 * 候选池:在一个范围(自选 / 持仓 / 某个指数的成分股)里,按用户设的条件逐只核对。
 *
 * 🔴 只排除、不排名:每只、每个条件都给出 满足 / 不满足 / 缺数据 和实际的值;结果按代码排,
 *    不按任何指标排序,不打分,不说该买哪只。「全部满足」只表示过了用户自己设的条件。
 * 🔴 缺数据既不算满足也不算不满足,单独成一组。腾讯行情把空值写成 0(源函数 `_f`),
 *    所以市盈率、市净率、总市值的 0 记为缺数据(这三项不可能真的是 0);市盈率为负是亏损,是真实的值。
 * 🔴 范围和指标各写明来源与时间;取不到的写进 gaps,不当成「不满足」。
 *
 * 来源(都是已接好的端点,不新增数据源):
 *   范围:台账里的自选 / 持仓;中证 / 国证官网的指数成分文件(index_constituents)。
 *         成分全表在取数器落盘的 extracted 文件里,信封里的证据只列前 30 只 —— 读不到全表时只核对这几只并写进 gaps。
 *   指标:腾讯批量行情(tx_quotes_batch),每次 50 只(取数参数数组的上限)。
 *   ST:腾讯行情里的证券简称。交易所给 ST / *ST 的标记就写在简称里,退市整理期的简称带「退」。
 *   东财选股接口 2026-10-08 实测能通,但它在服务器上筛完只回符合的,看不到「哪一条缺数据」;
 *   东财列表类接口 9 月以来又时常不可用,所以不用。
 */
import fs from "node:fs";
import { fetchEndpoint, ledgerList, ledgerSnapshot, safePath, ServiceError, type ServiceContext } from "../service.ts";
import { isCnFundOrBond } from "./events.ts";
import { heldFromLedger } from "./holdings.ts";
import { failedNote, pool, quoteCodeOf, rowsOf, symbolOfQuoteKey } from "./schedule.ts";

export const INDEX_UNIVERSES = [
  { id: "hs300", code: "000300", provider: "csi", label: "沪深300" },
  { id: "a500", code: "000510", provider: "csi", label: "中证A500" },
  { id: "zz500", code: "000905", provider: "csi", label: "中证500" },
  { id: "zz1000", code: "000852", provider: "csi", label: "中证1000" },
  { id: "zz2000", code: "932000", provider: "csi", label: "中证2000" },
  { id: "sz50", code: "000016", provider: "csi", label: "上证50" },
  { id: "kc50", code: "000688", provider: "csi", label: "科创50" },
  { id: "cyb", code: "399006", provider: "cni", label: "创业板指" },
] as const;
const LEDGER_UNIVERSES = [{ id: "watch", label: "我的自选" }, { id: "position", label: "我的持仓" }] as const;
export const UNIVERSES: { id: string; label: string }[] = [...LEDGER_UNIVERSES, ...INDEX_UNIVERSES].map((u) => ({ id: u.id, label: u.label }));

/** 可设区间的指标。`div` 把腾讯给的单位换成界面上的单位(成交额:万元 → 亿元)。用除法:乘 1e-4 会让 70000 万元变成 7.000000000000001 亿,卡在上限 7 外面 */
export const METRICS = {
  pe_ttm: { label: "市盈率(TTM)", unit: "倍", field: "pe_ttm", zeroIsMissing: true, div: 1 },
  pb: { label: "市净率", unit: "倍", field: "pb", zeroIsMissing: true, div: 1 },
  market_cap: { label: "总市值", unit: "亿元", field: "market_cap", zeroIsMissing: true, div: 1 },
  amount: { label: "成交额", unit: "亿元", field: "turnover_amount", zeroIsMissing: false, div: 1e4 },
  turnover: { label: "换手率", unit: "%", field: "turnover_rate", zeroIsMissing: false, div: 1 },
} as const;
export type MetricId = keyof typeof METRICS;
const METRIC_IDS = Object.keys(METRICS) as MetricId[];

export type CheckState = "met" | "unmet" | "missing";
export interface CandidateCheck { id: string; state: CheckState; value: number | null; shown: string }
export interface CandidateRow { symbol: string; name: string; verdict: CheckState; checks: CandidateCheck[] }
export interface CandidateCondition { id: string; label: string; source: string }
export interface CandidateResult {
  universe: { id: string; label: string; size: number; as_of: string | null; source: string };
  quotes: { source: string; fetched_at: string | null; cached: boolean };
  conditions: CandidateCondition[];
  rows: CandidateRow[];
  counts: Record<CheckState, number>;
  generated_at: string;
  gaps: string[];
}

interface Ev { field?: string; value?: unknown; period?: string; note?: string; record_key?: string; raw_ref?: string }
interface Env { status?: string; evidence?: Ev[]; reason?: string; degraded?: string; extra?: { stale?: unknown } }

export const QUOTE_CHUNK = 50;
const CONCURRENCY = 4;
/** 没有成交的只数占到这么多,说明是开盘前 / 非交易时段,不是停牌 */
const HALT_ALL_SHARE = 0.8;
const LIMIT = 1e9;

const evsOf = (env: unknown): Ev[] => (env && typeof env === "object" && Array.isArray((env as Env).evidence) ? (env as Env).evidence! : []);
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** 成分文件里的简称有全角空格补齐(「南  玻A」) */
const tidyName = (s: string) => s.replace(/[\s　]+/g, "");

/** 交易所的 ST 标记写在简称里:ST、*ST(早年还有 SST、S*ST);退市整理期简称以「退」结尾(2020 年以前是「退市」开头) */
export const isStName = (name: string): boolean => /^(?:S\*?|\*)?ST|^退市|退$/.test(tidyName(name));

export interface Range { min: number | null; max: number | null }

function parseBound(raw: string | undefined, what: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || Math.abs(v) > LIMIT) throw new ServiceError("bad_query", `${what} 不是合法数字:${raw.slice(0, 20)}`);
  return v;
}

/** 查询串 → 各指标的区间(没设的指标不出现)。下限大于上限直接报错,不悄悄对调 */
export function parseRanges(query: Record<string, string>): Partial<Record<MetricId, Range>> {
  const out: Partial<Record<MetricId, Range>> = {};
  for (const id of METRIC_IDS) {
    const m = METRICS[id];
    const min = parseBound(query[`${id}_min`], `${m.label}下限`);
    const max = parseBound(query[`${id}_max`], `${m.label}上限`);
    if (min === null && max === null) continue;
    if (min !== null && max !== null && min > max) throw new ServiceError("bad_query", `${m.label}的下限 ${min} 大于上限 ${max}`);
    out[id] = { min, max };
  }
  return out;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4))));
const withUnit = (v: string, unit: string) => (unit === "%" ? `${v}%` : `${v} ${unit}`);

export function rangeLabel(id: MetricId, r: Range): string {
  const m = METRICS[id];
  if (r.min !== null && r.max !== null) return `${m.label} ${withUnit(`${fmt(r.min)}–${fmt(r.max)}`, m.unit)}`;
  if (r.min !== null) return `${m.label} ≥ ${withUnit(fmt(r.min), m.unit)}`;
  return `${m.label} ≤ ${withUnit(fmt(r.max!), m.unit)}`;
}

/** 显示用的值:成交额不到 1 亿写成万元,市盈率为负注明亏损 */
export function showMetric(id: MetricId, v: number): string {
  if (id === "amount") return Math.abs(v) >= 1 ? `${v.toFixed(2)} 亿元` : `${Math.round(v * 1e4)} 万元`;
  const s = withUnit(v.toFixed(2), METRICS[id].unit);
  return id === "pe_ttm" && v < 0 ? `${s}(亏损)` : s;
}

export interface QuoteRow { name: string; fields: Record<string, number | null>; halted: boolean }

/**
 * 一只的全部条件 → 每条的状态。`haltKnown=false`(开盘前,全都还没成交)时停牌那条记缺数据,
 * 成交额 / 换手率是 0 的也记缺数据 —— 那是还没开始交易,不是真的没成交。
 */
export function checkRow(q: QuoteRow | undefined, ranges: Partial<Record<MetricId, Range>>, opts: { excludeSt: boolean; excludeHalted: boolean; haltKnown: boolean }): CandidateCheck[] {
  const checks: CandidateCheck[] = [];
  for (const id of METRIC_IDS) {
    const r = ranges[id];
    if (!r) continue;
    const m = METRICS[id];
    const raw = q?.fields[m.field] ?? null;
    if (raw === null || (m.zeroIsMissing && raw === 0)) {
      checks.push({ id, state: "missing", value: null, shown: q ? "来源没给" : "没取到" });
      continue;
    }
    if (!opts.haltKnown && raw === 0 && (id === "amount" || id === "turnover")) {
      checks.push({ id, state: "missing", value: null, shown: "还没有成交数据" });
      continue;
    }
    const v = raw / m.div;
    const ok = (r.min === null || v >= r.min) && (r.max === null || v <= r.max);
    checks.push({ id, state: ok ? "met" : "unmet", value: v, shown: showMetric(id, v) });
  }
  if (opts.excludeSt) {
    const name = q?.name ?? "";
    if (!name) checks.push({ id: "st", state: "missing", value: null, shown: "没取到简称" });
    else checks.push({ id: "st", state: isStName(name) ? "unmet" : "met", value: null, shown: isStName(name) ? `简称是「${tidyName(name)}」` : "不是 ST" });
  }
  if (opts.excludeHalted) {
    if (!q) checks.push({ id: "halted", state: "missing", value: null, shown: "没取到" });
    else if (!opts.haltKnown) checks.push({ id: "halted", state: "missing", value: null, shown: "还没有成交数据" });
    else checks.push({ id: "halted", state: q.halted ? "unmet" : "met", value: null, shown: q.halted ? "当天没有成交" : "有成交" });
  }
  return checks;
}

/** 有一条不满足就排除;没有不满足、但有缺数据的单独一组;其余全部满足 */
export const verdictOf = (checks: CandidateCheck[]): CheckState =>
  checks.some((c) => c.state === "unmet") ? "unmet" : checks.some((c) => c.state === "missing") ? "missing" : "met";

/** 腾讯批量行情信封 → 代码到行情 */
export function quoteRows(env: unknown): Map<string, QuoteRow> {
  const stale = new Set((Array.isArray((env as Env | undefined)?.extra?.stale) ? (env as Env).extra!.stale as unknown[] : []).map((k) => symbolOfQuoteKey(String(k))));
  const out = new Map<string, QuoteRow>();
  for (const r of rowsOf(env)) {
    const sym = symbolOfQuoteKey(r.key);
    const fields: Record<string, number | null> = {};
    for (const [k, e] of Object.entries(r.f)) fields[k] = numOf(e.value);
    const name = str(r.f.security_name?.value) || r.note.replace(/\(.*$/, "").trim();
    out.set(sym, { name, fields, halted: stale.has(sym) });
  }
  return out;
}

/**
 * 读取数器落盘的文件(信封里的证据只带摘要,全表在 raw/ 下)。
 * 只认 `raw/<文件名>.json`,再经 safePath 限定在本次取数目录里;文件没了(快照比落盘文件活得久)或读不了返回 null。
 */
export function readRawDoc(ctx: Pick<ServiceContext, "dataRoot">, outDir: string, rawRef: string): unknown {
  if (!/^raw\/[\w.()+\-]+\.json$/.test(rawRef)) return null;
  try { return JSON.parse(fs.readFileSync(safePath(ctx, outDir, rawRef), "utf8")); } catch { return null; }
}

/** 指数成分:先读取数器落盘的全表,读不到再退回信封里的前几只 */
export function indexMembers(ctx: Pick<ServiceContext, "dataRoot">, env: unknown, outDir: string): { members: { symbol: string; name: string }[]; total: number | null; as_of: string | null; full: boolean } {
  const evs = evsOf(env);
  const count = evs.find((e) => e.field === "index_member_count");
  const total = numOf(count?.value);
  const as_of = str(count?.period) || null;
  const doc = readRawDoc(ctx, outDir, str(count?.raw_ref)) as { rows?: { code?: unknown; name?: unknown }[] } | null;
  if (doc && Array.isArray(doc.rows)) {
    const members = doc.rows.map((r) => ({ symbol: String(r?.code ?? ""), name: tidyName(String(r?.name ?? "")) })).filter((m) => /^\d{6}$/.test(m.symbol));
    if (members.length) return { members, total, as_of, full: true };
  }
  const members = evs.filter((e) => e.field === "index_member").map((e) => {
    const [code, ...rest] = str(e.value).split(/\s+/);
    return { symbol: code ?? "", name: tidyName(rest.join("")) };
  }).filter((m) => /^\d{6}$/.test(m.symbol));
  return { members, total, as_of, full: false };
}

const uniqSorted = (list: { symbol: string; name: string }[]) => {
  const by = new Map<string, { symbol: string; name: string }>();
  for (const m of list) if (!by.has(m.symbol)) by.set(m.symbol, m);
  return [...by.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
};

export async function candidatePool(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<CandidateResult> {
  const uid = query.universe ?? "watch";
  const uni = UNIVERSES.find((u) => u.id === uid);
  if (!uni) throw new ServiceError("bad_query", `没有这个范围:${uid.slice(0, 20)}`);
  const ranges = parseRanges(query);
  const excludeSt = query.exclude_st === "1";
  const excludeHalted = query.exclude_halted === "1";
  // 一个条件都没设时人人「全部满足」,这张表没有意义
  if (!Object.keys(ranges).length && !excludeSt && !excludeHalted) throw new ServiceError("bad_query", "至少设一个条件");
  const consistency = query.refresh === "1" ? { mode: "fresh" as const } : undefined;
  const gaps: string[] = [];

  // ── 范围 ──
  let members: { symbol: string; name: string }[] = [];
  let asOf: string | null = null;
  let uniSource = "我的台账";
  const idx = INDEX_UNIVERSES.find((u) => u.id === uid);
  if (idx) {
    uniSource = `${idx.provider === "csi" ? "中证" : "国证"}指数官网成分文件`;
    let env: Env | undefined;
    let outDir = "";
    try {
      // 「重新取数」不重取成分文件:成分半年才调一次,官网文件又慢(实测 1–5 秒,偶尔 40 秒超时),端点自带一天的缓存
      const r = await fetchEndpoint(ctx, { endpoint: "index_constituents", symbol: idx.code, args: { provider: idx.provider }, signal });
      env = r.envelope as Env;
      outDir = r.out_dir;
    } catch (e) {
      if (signal.aborted) throw e;
      env = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
    }
    if (!env || env.status === "failed") gaps.push(`${idx.label}成分没取到${failedNote(env) ? `(${failedNote(env)})` : ""}`);
    else {
      const got = indexMembers(ctx, env, outDir);
      members = got.members;
      asOf = got.as_of;
      if (!got.full) gaps.push(`${idx.label}成分全表没读到,只核对了来源列出的前 ${got.members.length} 只${got.total ? `(共 ${got.total} 只)` : ""}`);
      else if (got.total !== null && got.total !== got.members.length) gaps.push(`${idx.label}成分文件写的是 ${got.total} 只,读到 ${got.members.length} 只`);
    }
  } else {
    // 「我的持仓」= 交易流水重放后还持有的(加上还没迁成流水的旧持有记录),不是台账里出现过的全部代码
    const listed = uid === "position" ? (() => { const s = ledgerSnapshot(ctx); return heldFromLedger(s.records, s.issues); })() : (ledgerList(ctx)[uid] ?? []).map((r) => ({ symbol: str(r.symbol), name: str(r.name) }));
    const all = uniqSorted(listed.filter((m) => m.symbol));
    const funds = all.filter((m) => /^\d{6}$/.test(m.symbol) && isCnFundOrBond(m.symbol));
    const other = all.filter((m) => !/^\d{6}$/.test(m.symbol));
    members = all.filter((m) => /^\d{6}$/.test(m.symbol) && !isCnFundOrBond(m.symbol));
    const label = (m: { symbol: string; name: string }) => (m.name ? `${m.name} ${m.symbol}` : m.symbol);
    if (funds.length) gaps.push(`基金 / 债券 ${funds.map(label).join("、")}:没有市盈率这类指标,没核对`);
    if (other.length) gaps.push(`港股 / 美股 ${other.map(label).join("、")}:候选池暂只支持 A 股,没核对`);
  }
  members = uniqSorted(members);

  // ── 指标 ──
  const quotes = new Map<string, QuoteRow>();
  const failed: string[] = [];
  const fetchedAt: string[] = [];
  let cached = false;
  const chunks: { symbol: string; name: string }[][] = [];
  for (let i = 0; i < members.length; i += QUOTE_CHUNK) chunks.push(members.slice(i, i + QUOTE_CHUNK));
  const reasons = new Set<string>();
  await pool(chunks, CONCURRENCY, async (chunk) => {
    let env: Env | undefined;
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "tx_quotes_batch", args: { codes: chunk.map((m) => quoteCodeOf(m.symbol)) }, ...(consistency ? { consistency } : {}), signal });
      env = r.envelope as Env;
      if (env?.status !== "failed") { fetchedAt.push(r.fetched_at); cached ||= r.cached; }
    } catch (e) {
      if (signal.aborted) throw e;
      env = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
    }
    if (!env || env.status === "failed") {
      failed.push(...chunk.map((m) => m.symbol));
      if (failedNote(env)) reasons.add(failedNote(env));
      return;
    }
    for (const [sym, q] of quoteRows(env)) quotes.set(sym, q);
  });
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  if (failed.length) gaps.push(`腾讯行情没取到 ${failed.length} 只${reasons.size ? `(${[...reasons].join(";")})` : ""}`);
  const failedSet = new Set(failed);
  const noRow = members.filter((m) => !quotes.has(m.symbol) && !failedSet.has(m.symbol));
  if (noRow.length) gaps.push(`腾讯行情没有返回 ${noRow.length} 只:${noRow.slice(0, 8).map((m) => m.symbol).join("、")}${noRow.length > 8 ? " 等" : ""}(代码可能已变更)`);

  // 开盘前 / 非交易时段:几乎所有票都没有成交,这时「没有成交」说明不了停牌。
  // 只数少(自选只有几只)时看不出「几乎所有」,但全都没有成交同样说明不了
  const got = [...quotes.values()];
  const staleShare = got.length ? got.filter((q) => q.halted).length / got.length : 0;
  const haltKnown = !(staleShare === 1 || (got.length >= 10 && staleShare >= HALT_ALL_SHARE));
  if (!haltKnown) {
    const what = [excludeHalted ? "停牌这一条" : "", ranges.amount ? "成交额" : "", ranges.turnover ? "换手率" : ""].filter(Boolean);
    if (what.length) gaps.push(`这次行情里几乎都没有成交(开盘前或非交易时段),${what.join("、")}没法判断,记为缺数据`);
  }

  const quoteSource = "腾讯行情";
  const conditions: CandidateCondition[] = [
    ...METRIC_IDS.filter((id) => ranges[id]).map((id) => ({ id, label: rangeLabel(id, ranges[id]!), source: quoteSource })),
    ...(excludeSt ? [{ id: "st", label: "排除 ST / *ST / 退市整理", source: `${quoteSource}里的证券简称` }] : []),
    ...(excludeHalted ? [{ id: "halted", label: "排除当天没有成交的(停牌)", source: quoteSource }] : []),
  ];
  const rows: CandidateRow[] = members.map((m) => {
    const q = quotes.get(m.symbol);
    const checks = checkRow(q, ranges, { excludeSt, excludeHalted, haltKnown });
    return { symbol: m.symbol, name: q?.name ? tidyName(q.name) : m.name, verdict: verdictOf(checks), checks };
  });
  const counts: Record<CheckState, number> = { met: 0, unmet: 0, missing: 0 };
  for (const r of rows) counts[r.verdict] += 1;
  fetchedAt.sort();
  return {
    universe: { id: uni.id, label: uni.label, size: members.length, as_of: asOf, source: uniSource },
    quotes: { source: quoteSource, fetched_at: fetchedAt[0] ?? null, cached },
    conditions, rows, counts, generated_at: now.toISOString(), gaps,
  };
}
