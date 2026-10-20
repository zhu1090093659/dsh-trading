/**
 * 判据到期回看:台账里的裁决点 / 证伪条件到了日子,把这段时间的事实摆出来,由用户自己判兑现没有;
 * 判过的累积成一张校准表。
 *
 * 🔴 只核对「用户写下的判据有没有兑现」,不算涨跌、不算胜率、不替用户下结论。
 *    判据是用户自己写的一句话,机器读不懂它,所以这里只做两件事:
 *    ① 到期了提醒(按交易日:定时任务只在交易日跑,周末到期的下一个交易日提醒);
 *    ② 把这段时间(从写下判据那天到今天)的公司公告标题列出来,方便对照。
 * 🔴 状态沿用台账原有的四个值,含义按类型读:
 *    裁决点   met = 兑现      broken = 没兑现
 *    证伪条件 met = 到期没触发 broken = 触发了
 *    dropped = 不再跟踪(两类一样)
 *
 * 公告来源:fetch_announcements(只有 A 股,每次最近 30 条)。港股、美股没有逐只公告来源,如实写明。
 */
import type { JobContext, JobResult, NotifyMessage } from "../notify.ts";
import { localClock } from "../notify.ts";
import type { LedgerRecord } from "../ledger.ts";
import { fetchEndpoint, ledgerList, ledgerSnapshot, type ServiceContext } from "../service.ts";
import { quoteNames } from "./events.ts";
import { heldFromLedger } from "./holdings.ts";
import { SCHEDULE_TZ, pool, quoteCodeOf } from "./schedule.ts";

export type CriterionType = "decision_point" | "falsifier";
export type CriterionStatus = "pending" | "met" | "broken" | "dropped";

export interface VerdictFact { date: string; title: string }

export interface VerdictItem {
  id: string;
  symbol: string | null;
  name: string;
  type: CriterionType;
  statement: string;
  due: string;
  /** 写下判据那天(北京时间);公告从这天开始列 */
  since: string;
  /** 0 = 今天到期 */
  overdue_days: number;
  thesis: string;
  /** 最多列 15 条,最近的在前 */
  facts: VerdictFact[];
  /** 这段时间内看到的公告总数(可能多于 facts) */
  facts_total: number;
  facts_source: string;
  /** 公告是什么时候取的(可能是两小时内的快照);没取到 / 没查 = null */
  facts_fetched_at: string | null;
  /** 公告覆盖不全、没有来源、没取到时的说明;空 = 这段时间的公告都在 */
  facts_note: string;
  /** 原记录,界面判定时整条带回去(台账更新是整条替换) */
  record: LedgerRecord;
}

export interface CalibrationRow {
  type: CriterionType;
  label: string;
  met_label: string;
  broken_label: string;
  met: number;
  broken: number;
  dropped: number;
  /** 到期没判(含今天到期) */
  due_unjudged: number;
  upcoming: number;
  no_due: number;
}

export interface JudgedItem {
  id: string;
  symbol: string | null;
  name: string;
  type: CriterionType;
  statement: string;
  due: string;
  status: Exclude<CriterionStatus, "pending">;
  judged_at: string;
  verdict_note: string;
  record: LedgerRecord;
}

export interface VerdictResult {
  today: string;
  generated_at: string;
  due: VerdictItem[];
  calibration: CalibrationRow[];
  judged: JudgedItem[];
  gaps: string[];
}

interface Ev { field?: string; value?: unknown; period?: string; record_key?: string }
interface Env { status?: string; evidence?: Ev[]; reason?: string; degraded?: string }

const ANN_SOURCE = "东方财富 · 公司公告(最近 30 条)";
const ANN_WINDOW = 30;
const FACTS_MAX = 15;
const SYMBOLS_MAX = 30;
const CONCURRENCY = 4;
const JUDGED_MAX = 20;
const NOTIFIED_KEEP = 1000;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const evsOf = (env: unknown): Ev[] => (env && typeof env === "object" && Array.isArray((env as Env).evidence) ? (env as Env).evidence! : []);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export const TYPE_LABEL: Record<CriterionType, { label: string; met: string; broken: string }> = {
  decision_point: { label: "裁决点", met: "兑现", broken: "没兑现" },
  falsifier: { label: "证伪条件", met: "到期没触发", broken: "触发了" },
};

export function verdictLabel(type: CriterionType, status: CriterionStatus): string {
  if (status === "pending") return "待判";
  if (status === "dropped") return "不再跟踪";
  return status === "met" ? TYPE_LABEL[type].met : TYPE_LABEL[type].broken;
}

const typeOf = (r: LedgerRecord): CriterionType | null => (r.type === "decision_point" || r.type === "falsifier" ? r.type : null);
const statusOf = (r: LedgerRecord): CriterionStatus => (r.status === "met" || r.status === "broken" || r.status === "dropped" ? r.status : "pending");

/** 写下判据那天(北京时间)。created_at 缺失或坏掉时退回到期日前 30 天 */
export function sinceDay(r: LedgerRecord, due: string): string {
  const t = Date.parse(str(r.created_at));
  const created = Number.isFinite(t) ? localClock(new Date(t), SCHEDULE_TZ).day : "";
  if (created && created <= due) return created;
  const d = new Date(`${due}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

/** 到期没判的判据(含今天到期),到期早的在前 */
export function dueCriteria(criteria: LedgerRecord[], today: string): LedgerRecord[] {
  return criteria
    .filter((r) => typeOf(r) && statusOf(r) === "pending" && isDay(r.due) && r.due <= today)
    .sort((a, b) => str(a.due).localeCompare(str(b.due)) || str(a.created_at).localeCompare(str(b.created_at)));
}

export function calibration(criteria: LedgerRecord[], today: string): CalibrationRow[] {
  return (["decision_point", "falsifier"] as const).map((type) => {
    const rows = criteria.filter((r) => typeOf(r) === type);
    const pending = rows.filter((r) => statusOf(r) === "pending");
    return {
      type, label: TYPE_LABEL[type].label, met_label: TYPE_LABEL[type].met, broken_label: TYPE_LABEL[type].broken,
      met: rows.filter((r) => statusOf(r) === "met").length,
      broken: rows.filter((r) => statusOf(r) === "broken").length,
      dropped: rows.filter((r) => statusOf(r) === "dropped").length,
      due_unjudged: pending.filter((r) => isDay(r.due) && r.due <= today).length,
      upcoming: pending.filter((r) => isDay(r.due) && r.due > today).length,
      no_due: pending.filter((r) => !isDay(r.due)).length,
    };
  });
}

export function judgedList(criteria: LedgerRecord[], nameOf: (s: string) => string): JudgedItem[] {
  return criteria
    .filter((r) => typeOf(r) && statusOf(r) !== "pending")
    .sort((a, b) => str(b.judged_at).localeCompare(str(a.judged_at)) || str(b.updated_at).localeCompare(str(a.updated_at)))
    .slice(0, JUDGED_MAX)
    .map((r) => ({
      id: r.id, symbol: str(r.symbol) || null, name: str(r.symbol) ? nameOf(str(r.symbol)) : "", type: typeOf(r)!,
      statement: str(r.statement), due: str(r.due), status: statusOf(r) as JudgedItem["status"],
      judged_at: str(r.judged_at), verdict_note: str(r.verdict_note), record: r,
    }));
}

/**
 * 一只 A 股的公告 → 这段时间内的标题。
 * 来源每次只给最近 30 条:取满 30 条而最早一条还晚于起点时,说明起点之后还有没看到的,写进 note。
 * 超过 15 条只列最近的;总数放 total,界面和提醒都按 total 说「共 N 条」。
 */
export function factsFromAnnouncements(env: unknown, since: string, today: string): { facts: VerdictFact[]; total: number; note: string } {
  const rows = evsOf(env).filter((e) => e.field === "announcement_title" && typeof e.value === "string" && isDay(e.period));
  const inWindow = rows.filter((e) => e.period! >= since && e.period! <= today)
    .sort((a, b) => b.period!.localeCompare(a.period!))
    .map((e) => ({ date: e.period!, title: String(e.value) }));
  const oldest = rows.reduce<string | null>((m, e) => (m === null || e.period! < m ? e.period! : m), null);
  const note = rows.length >= ANN_WINDOW && oldest && oldest > since ? `来源只给最近 ${ANN_WINDOW} 条,${oldest} 以前的公告没看到` : "";
  return { facts: inWindow.slice(0, FACTS_MAX), total: inWindow.length, note };
}

/** 不点「重新取数」时,公告快照最多用 2 小时:写着「这段时间没有公告」的旧快照会让人照着它判 */
export const ANN_MAX_AGE_MS = 2 * 3600_000;
type Consistency = { mode: "fresh" } | { mode: "prefer_cache"; max_age_ms: number };
type Facts = { facts: VerdictFact[]; total: number; source: string; note: string; fetched_at: string | null };
const noFacts = (source: string, note: string): Facts => ({ facts: [], total: 0, source, note, fetched_at: null });

/** 给到期的判据收集公告(A 股、按代码只取一次);返回 id → 事实 */
async function collectFacts(ctx: ServiceContext, items: { record: LedgerRecord; since: string }[], today: string, consistency: Consistency, signal: AbortSignal):
  Promise<{ byId: Map<string, Facts>; gaps: string[] }> {
  const byId = new Map<string, Facts>();
  const gaps: string[] = [];
  const cnSymbols = [...new Set(items.map((i) => str(i.record.symbol)).filter((s) => /^\d{6}$/.test(s)))];
  const checked = cnSymbols.slice(0, SYMBOLS_MAX);
  const envs = new Map<string, { env: Env; at: string } | null>();
  await pool(checked, CONCURRENCY, async (s) => {
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "fetch_announcements", symbol: s, consistency, signal });
      const env = r.envelope as Env;
      envs.set(s, env.status === "failed" ? null : { env, at: r.fetched_at });
    } catch (e) {
      if (signal.aborted) throw e;
      envs.set(s, null);
    }
  });
  if (cnSymbols.length > checked.length) gaps.push(`公告只查了前 ${SYMBOLS_MAX} 只 A 股,另有 ${cnSymbols.length - checked.length} 只没查`);
  for (const { record, since } of items) {
    const s = str(record.symbol);
    if (!s) { byId.set(record.id, noFacts("", "这条判据没写代码,没有可对照的公告")); continue; }
    if (!/^\d{6}$/.test(s)) { byId.set(record.id, noFacts("", "港股 / 美股目前没有逐只公告来源,请自己核对")); continue; }
    if (!envs.has(s)) { byId.set(record.id, noFacts(ANN_SOURCE, "超出本次查询上限,没查")); continue; }
    const got = envs.get(s);
    if (!got) { byId.set(record.id, noFacts(ANN_SOURCE, "公告没取到")); continue; }
    const f = factsFromAnnouncements(got.env, since, today);
    byId.set(record.id, { ...f, source: ANN_SOURCE, fetched_at: got.at, note: f.note || (f.total ? "" : "来源里这段时间没有公告") });
  }
  return { byId, gaps };
}

function namesFrom(ctx: ServiceContext): Map<string, string> {
  const snap = ledgerSnapshot(ctx);
  const recs = snap.records;
  const names = new Map<string, string>();
  const named = [...heldFromLedger(recs, snap.issues), ...(recs.trade ?? []), ...(recs.watch ?? [])];
  for (const r of named) if (str(r.symbol) && str(r.name) && !names.has(str(r.symbol))) names.set(str(r.symbol), str(r.name));
  return names;
}

/** 台账没写名字的代码,用一次腾讯批量行情补(取不到就显示代码) */
async function fillNames(ctx: ServiceContext, names: Map<string, string>, symbols: string[], consistency: Consistency, signal: AbortSignal): Promise<void> {
  const missing = [...new Set(symbols.filter((s) => s && !names.has(s)))];
  if (!missing.length) return;
  try {
    const r = await fetchEndpoint(ctx, { endpoint: "tx_quotes_batch", args: { codes: missing.map(quoteCodeOf) }, consistency, signal });
    for (const [s, n] of quoteNames(r.envelope)) if (missing.includes(s)) names.set(s, n);
  } catch (e) {
    if (signal.aborted) throw e;
  }
}

export async function verdictReview(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<VerdictResult> {
  const consistency: Consistency = query.refresh === "1" ? { mode: "fresh" } : { mode: "prefer_cache", max_age_ms: ANN_MAX_AGE_MS };
  const today = localClock(now, SCHEDULE_TZ).day;
  const recs = ledgerList(ctx);
  const criteria = recs.criterion ?? [];
  const theses = new Map((recs.thesis ?? []).map((t) => [t.id, str(t.title)]));
  const names = namesFrom(ctx);
  await fillNames(ctx, names, criteria.map((r) => str(r.symbol)), consistency, signal);
  const nameOf = (s: string) => names.get(s) ?? "";

  const due = dueCriteria(criteria, today).map((r) => ({ record: r, since: sinceDay(r, str(r.due)) }));
  const { byId, gaps } = await collectFacts(ctx, due, today, consistency, signal);
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return {
    today,
    generated_at: now.toISOString(),
    due: due.map(({ record: r, since }) => {
      const f = byId.get(r.id) ?? noFacts("", "");
      return {
        id: r.id, symbol: str(r.symbol) || null, name: str(r.symbol) ? nameOf(str(r.symbol)) : "", type: typeOf(r)!,
        statement: str(r.statement), due: str(r.due), since, overdue_days: dayDiff(today, str(r.due)),
        thesis: theses.get(str(r.thesis_id)) ?? "", facts: f.facts, facts_total: f.total, facts_source: f.source, facts_fetched_at: f.fetched_at, facts_note: f.note, record: r,
      };
    }),
    calibration: calibration(criteria, today),
    judged: judgedList(criteria, nameOf),
    gaps,
  };
}

// ---------------------------------------------------------------- 定时任务

/** 已提醒过的「id|到期日」:改了到期日的会在新日子再提醒一次 */
interface VerdictState { notified?: string[] }
const keyOf = (r: { id: string; due?: unknown }) => `${r.id}|${str(r.due)}`;

export function verdictMessage(day: string, fresh: VerdictItem[], olderPending: number): NotifyMessage {
  const lines: string[] = [];
  for (const it of fresh.slice(0, 10)) {
    const who = it.symbol ? `${it.name ? `${it.name} ` : ""}${it.symbol} ` : "";
    const text = it.statement.length > 60 ? `${it.statement.slice(0, 60)}…` : it.statement;
    lines.push(`${who}${TYPE_LABEL[it.type].label} 到期 ${it.due}:${text}`);
    if (it.facts.length) lines.push(`  ${it.since} 以来公告 ${it.facts_total} 条,最近:${it.facts[0]!.date} ${it.facts[0]!.title.slice(0, 40)}`);
    if (it.facts_note) lines.push(`  ${it.facts_note}`);
  }
  if (fresh.length > 10) lines.push(`另有 ${fresh.length - 10} 条,见事件日历页`);
  if (olderPending) lines.push(`另有 ${olderPending} 条早先到期、还没判`);
  lines.push("到「事件日历」页对照后,标记兑现与否");
  return { title: `判据到期 ${day}`, lines, link: "/calendar", dedupeKey: `verdict_due:${day}` };
}

export async function verdictDue(j: JobContext): Promise<JobResult> {
  const prev = (j.state && typeof j.state === "object" ? j.state : {}) as VerdictState;
  const notified = new Set(prev.notified ?? []);
  const recs = ledgerList(j.ctx);
  const due = dueCriteria(recs.criterion ?? [], j.day);
  if (!due.length) return { messages: [], note: "没有到期的判据" };
  // 手动「立即运行」列出全部到期没判的;定时只报新到期的,免得同一条天天推
  const fresh = j.manual ? due : due.filter((r) => !notified.has(keyOf(r)));
  if (!fresh.length) return { messages: [], note: `没有新到期的判据(还有 ${due.length} 条到期没判)` };

  const r = await verdictReview(j.ctx, { refresh: "1" }, j.signal, j.now);
  const freshIds = new Set(fresh.map((x) => x.id));
  const items = r.due.filter((x) => freshIds.has(x.id));
  const message = verdictMessage(j.day, items, due.length - items.length);
  return {
    messages: [message],
    state: { notified: [...new Set([...items.map((x) => keyOf(x)), ...notified])].slice(0, NOTIFIED_KEEP) } satisfies VerdictState,
  };
}
