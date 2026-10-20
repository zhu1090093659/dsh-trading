/**
 * 事件日历:自选和持仓未来 N 天(默认 30)的公司事件 + 自己台账里到期的裁决点 / 复核 / 待办,排成一条时间轴。
 *
 * 🔴 只列来源给的日期和事实,不打风险分、不排名、不说该怎么做。
 * 🔴 每一行都带来源和取数时间;取不到的写进 gaps,不当成"这段时间没事件"。
 *
 * 来源(都是已接好的端点,不新增数据源):
 *   A 股:next_disclosure(定期报告预约披露日)、em_lockup_expiry(限售解禁)、em_dividend_history(除权除息日)
 *   美股:us_anchor_earnings(Nasdaq 财报日,区分预估日)
 *   港股:目前没有逐只的事件来源 —— 如实写进 gaps
 *   A 股基金 / 债券(1、5 开头的 6 位码):上面三个来源只覆盖股票,不查,写进 gaps
 *   名字:台账里没写名字的,用一次腾讯批量行情补上(取不到就只显示代码)
 *   宏观:macro_calendar(华尔街见闻全球宏观日历,只取最高重要度)
 */
import { localClock } from "../notify.ts";
import type { LedgerRecord } from "../ledger.ts";
import { fetchEndpoint, ledgerSnapshot, type ServiceContext } from "../service.ts";
import type { Consistency } from "../snapshot.ts";
import { SCHEDULE_TZ, failedNote, pool, quoteCodeOf, symbolOfQuoteKey } from "./schedule.ts";
import { heldFromLedger } from "./holdings.ts";

export type EventKind = "disclosure" | "lockup" | "dividend" | "earnings" | "macro" | "criterion" | "review" | "action";

export interface CalendarEvent {
  date: string;
  kind: EventKind;
  symbol: string | null;
  name: string;
  title: string;
  detail: string[];
  source: string;
  fetched_at: string | null;
  estimated?: boolean;
  /** 台账记录 id(裁决点 / 论点 / 待办) */
  ref?: string;
}

export interface CalendarResult {
  window: { from: string; to: string; days: number };
  generated_at: string;
  symbols: { symbol: string; name: string; origin: ("自选" | "持有")[] }[];
  events: CalendarEvent[];
  /** 已经过了日子还没处理的:台账里没判的裁决点、没复核的论点、没做的待办;以及过了预约日还没披露的定期报告 */
  overdue: CalendarEvent[];
  gaps: string[];
}

interface Ev { field?: string; value?: unknown; period?: string; note?: string; record_key?: string; symbol?: string; fetched_at?: string }
interface Env { status?: string; evidence?: Ev[]; degraded?: string; reason?: string }

export const CN_MAX = 30;
const CONCURRENCY = 4;
export const DAYS_DEFAULT = 30;
/** 不点「重新取数」时,上次取的表最多用 6 小时:预约披露表这类每天会变,用几天前的旧表会把已经披露的报告说成「过了预约日还没披露」 */
export const CAL_MAX_AGE_MS = 6 * 3600_000;
const DAYS_MIN = 7;
const DAYS_MAX = 90;

const evsOf = (env: unknown): Ev[] => (env && typeof env === "object" && Array.isArray((env as Env).evidence) ? (env as Env).evidence! : []);
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 沪深 1、5 开头的 6 位码是基金(ETF / LOF)或债券,不是股票;预约披露、解禁、分红这几张表只有股票 */
export const isCnFundOrBond = (symbol: string): boolean => /^[15]\d{5}$/.test(symbol);

/** 腾讯批量行情 → 代码到名字(note 形如「宁德时代(sz300750)」) */
export function quoteNames(env: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of evsOf(env)) {
    const sym = symbolOfQuoteKey(str(e.record_key));
    const name = str(e.note).replace(/\(.*$/, "").trim();
    if (sym && name && !out.has(sym)) out.set(sym, name);
  }
  return out;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 报告期 → 定期报告名 */
export function reportName(period: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(period);
  if (!m) return "定期报告";
  return `${m[1]} ${({ "03": "一季报", "06": "半年报", "09": "三季报", "12": "年报" } as Record<string, string>)[m[2]!] ?? "定期报告"}`;
}

const fmtNum = (n: number, digits = 2) => n.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const noteKV = (note: string): Record<string, string> =>
  Object.fromEntries(note.split(/[;；]/).map((s) => s.split("=")).filter((p) => p.length >= 2).map(([k, ...v]) => [k!.trim(), v.join("=").trim()]));

type Named = (symbol: string) => string;

/** A 股预约披露。返回 [窗口内的事件, 已过预约日还没披露的] */
export function disclosureEvents(symbol: string, env: unknown, from: string, to: string, nameOf: Named): { events: CalendarEvent[]; overdue: CalendarEvent[] } {
  const out = { events: [] as CalendarEvent[], overdue: [] as CalendarEvent[] };
  for (const e of evsOf(env)) {
    if (e.field !== "next_report_appoint_date" || !isDay(e.value)) continue;
    const ev: CalendarEvent = {
      date: e.value, kind: "disclosure", symbol, name: nameOf(symbol),
      title: `${reportName(str(e.period))}预约披露`,
      detail: ["预约日可能提前或推迟,以公司公告为准"],
      source: "东方财富 · 定期报告预约披露表", fetched_at: e.fetched_at ?? null,
    };
    // 「过了预约日还没披露」只在取表那天已经过了预约日时才说:预约日当天或更早取的表,看不到当天的披露;取数时间不明也不说
    const fetchedDay = typeof e.fetched_at === "string" && Number.isFinite(Date.parse(e.fetched_at)) ? localClock(new Date(e.fetched_at), SCHEDULE_TZ).day : "";
    if (e.value < from) { if (fetchedDay > e.value) out.overdue.push({ ...ev, title: `${reportName(str(e.period))}已过预约披露日,还没披露`, detail: ["以公司公告为准;推迟披露会另发公告"] }); }
    else if (e.value <= to) out.events.push(ev);
  }
  return out;
}

/**
 * 限售解禁。只用「实际解禁数量」。
 * ⚠️ 旧缓存里还有 `lockup_shares`(口径不清,不是解禁数量)和按占流通股比例算的 `lockup_ratio_of_total`;
 *    2026-10-10 起端点不再出 lockup_shares、比例改成占总股本(审计第三轮 B2)。这里只用实际解禁数量,新旧缓存都不受影响。
 */
export function lockupEvents(symbol: string, env: unknown, from: string, to: string, nameOf: Named): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const seen = new Set<string>();
  for (const e of evsOf(env)) {
    if (e.field !== "lockup_able_shares" || !isDay(e.period) || e.period < from || e.period > to) continue;
    const type = str(e.note).replace(/^(待解禁|历史解禁)[:：]/, "");
    const key = `${e.period}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = numOf(e.value);
    out.push({
      date: e.period, kind: "lockup", symbol, name: nameOf(symbol), title: "限售股解禁",
      detail: [n == null ? "实际解禁数量:没取到" : `实际解禁 ${fmtNum(n)} 万股`, ...(type ? [`类型:${type}`] : [])],
      source: "东方财富 · 限售解禁", fetched_at: e.fetched_at ?? null,
    });
  }
  return out;
}

/**
 * 除权除息。period 是除权除息日(东财 EX_DIVIDEND_DATE)。
 * 派现是**每 10 股**(东财 PRETAX_BONUS_RMB,与 IMPL_PLAN_PROFILE「10派X元」一致),个股页也按每 10 股显示。
 * 字段名 2026-10-09 起是 `dividend_pretax_per_10_shares`;之前叫 `dividend_pretax_per_share`(名字错、值相同),缓存里的旧名照认。
 */
export function dividendEvents(symbol: string, env: unknown, from: string, to: string, nameOf: Named): CalendarEvent[] {
  const byDay = new Map<string, { cash: number | null; transfer: number | null; bonus: number | null; plan: string; fetched_at: string | null }>();
  for (const e of evsOf(env)) {
    if (!isDay(e.period) || e.period < from || e.period > to) continue;
    const row = byDay.get(e.period) ?? { cash: null, transfer: null, bonus: null, plan: "", fetched_at: e.fetched_at ?? null };
    if (e.field === "dividend_pretax_per_10_shares" || e.field === "dividend_pretax_per_share") row.cash = numOf(e.value);
    else if (e.field === "transfer_per_10_shares") row.transfer = numOf(e.value);
    else if (e.field === "bonus_per_10_shares") row.bonus = numOf(e.value);
    else continue;
    row.plan ||= noteKV(str(e.note))["进度"] ?? "";
    byDay.set(e.period, row);
  }
  return [...byDay.entries()].map(([date, r]) => {
    const parts = [
      r.cash ? `每 10 股派 ${fmtNum(r.cash, 4)} 元(税前)` : "",
      r.bonus ? `每 10 股送 ${fmtNum(r.bonus, 4)} 股` : "",
      r.transfer ? `每 10 股转增 ${fmtNum(r.transfer, 4)} 股` : "",
    ].filter(Boolean);
    return {
      date, kind: "dividend" as const, symbol, name: nameOf(symbol), title: "除权除息日",
      detail: [parts.join(",") || "方案明细没取到", ...(r.plan ? [`进度:${r.plan}`] : [])],
      source: "东方财富 · 分红送转", fetched_at: r.fetched_at,
    };
  });
}

/** 美股财报日。Nasdaq 页面带 * 的是交易所 / Zacks 预估日,不是公司确认日 */
export function earningsEvents(env: unknown, from: string, to: string, nameOf: Named): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const e of evsOf(env)) {
    if (e.field !== "us_anchor_earnings_date" || !isDay(e.value) || e.value < from || e.value > to) continue;
    const symbol = str(e.symbol) || str(e.record_key);
    const estimated = str(e.note).includes("预估日");
    const fiscal = isDay(e.period) ? `财季止 ${e.period}` : "";
    out.push({
      date: e.value, kind: "earnings", symbol, name: nameOf(symbol), title: "财报日",
      detail: [estimated ? "预估日(交易所 / Zacks 口径),不是公司确认的日期" : "Nasdaq 页面日期,是否经公司确认未核实", "日期按美东时间", ...(fiscal ? [fiscal] : [])],
      source: "Nasdaq · 财报日", fetched_at: e.fetched_at ?? null, estimated,
    });
  }
  return out;
}

/**
 * 来源对没有具体时刻的条目统一填 12:02(2026-10-08 实测:活动类条目和 M2、社融这类不定时公布的数据都是 12:02),
 * 写出来会像真的定在中午,所以当成没有时刻。
 */
const MACRO_NO_TIME = new Set(["00:00", "12:02"]);

/** 宏观日历:只取最高重要度。时间是来源给的北京时间 */
export function macroEvents(env: unknown, from: string, to: string): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const e of evsOf(env)) {
    if (e.field !== "macro_event" || !isDay(e.period) || e.period < from || e.period > to || typeof e.value !== "string" || !e.value.trim()) continue;
    const kv = noteKV(str(e.note));
    const time = /\d{2}:\d{2}/.exec(kv.time ?? "")?.[0];
    out.push({
      date: e.period, kind: "macro", symbol: null, name: kv.country ?? "", title: e.value.trim(),
      detail: [
        ...(time && !MACRO_NO_TIME.has(time) ? [`北京时间 ${time}`] : []),
        ...(kv.forecast ? [`预期 ${kv.forecast}${kv.unit ?? ""}`] : []),
        ...(kv.previous ? [`前值 ${kv.previous}${kv.unit ?? ""}`] : []),
      ],
      source: "华尔街见闻 · 全球宏观日历", fetched_at: e.fetched_at ?? null,
    });
  }
  return out;
}

/** 台账里自己写的日子:裁决点 / 证伪条件的到期日、论点复核日、待办到期日。只算还没处理的 */
export function ledgerEvents(recs: Record<string, LedgerRecord[]>, from: string, to: string, nameOf: Named): { events: CalendarEvent[]; overdue: CalendarEvent[] } {
  const out = { events: [] as CalendarEvent[], overdue: [] as CalendarEvent[] };
  const push = (ev: CalendarEvent) => {
    if (ev.date < from) out.overdue.push(ev);
    else if (ev.date <= to) out.events.push(ev);
  };
  for (const r of recs.criterion ?? []) {
    if (!isDay(r.due) || (r.status && r.status !== "pending")) continue;
    const sym = str(r.symbol) || null;
    push({
      date: r.due, kind: "criterion", symbol: sym, name: sym ? nameOf(sym) : "",
      title: r.type === "falsifier" ? "证伪条件到期" : "裁决点到期", detail: [str(r.statement)].filter(Boolean),
      source: "我的台账", fetched_at: null, ref: str(r.id),
    });
  }
  for (const r of recs.thesis ?? []) {
    if (!isDay(r.review_by) || (r.status && r.status !== "active")) continue;
    const sym = str(r.symbol) || null;
    push({ date: r.review_by, kind: "review", symbol: sym, name: sym ? nameOf(sym) : "", title: "论点复核日", detail: [str(r.title)].filter(Boolean), source: "我的台账", fetched_at: null, ref: str(r.id) });
  }
  for (const r of recs.action ?? []) {
    if (!isDay(r.due) || (r.status && r.status !== "open")) continue;
    const sym = str(r.symbol) || null;
    push({ date: r.due, kind: "action", symbol: sym, name: sym ? nameOf(sym) : "", title: "待办到期", detail: [str(r.title)].filter(Boolean), source: "我的台账", fetched_at: null, ref: str(r.id) });
  }
  return out;
}

const KIND_ORDER: EventKind[] = ["criterion", "review", "action", "disclosure", "earnings", "dividend", "lockup", "macro"];
export const sortEvents = (a: CalendarEvent, b: CalendarEvent) =>
  a.date.localeCompare(b.date) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || String(a.symbol ?? "").localeCompare(String(b.symbol ?? ""));


export async function eventCalendar(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<CalendarResult> {
  const daysRaw = Number(query.days ?? DAYS_DEFAULT);
  const days = Number.isInteger(daysRaw) ? Math.min(DAYS_MAX, Math.max(DAYS_MIN, daysRaw)) : DAYS_DEFAULT;
  const consistency: Consistency = query.refresh === "1" ? { mode: "fresh" } : { mode: "prefer_cache", max_age_ms: CAL_MAX_AGE_MS };
  const from = localClock(now, SCHEDULE_TZ).day;
  const to = addDays(from, days);

  const snap = ledgerSnapshot(ctx);
  const recs = snap.records;
  const symbols = new Map<string, { symbol: string; name: string; origin: ("自选" | "持有")[] }>();
  // 持有排在前面:A 股只查前 CN_MAX 只时,先保证持有的。持有 = 交易流水重放后还持有的(含还没迁成流水的旧持有记录)
  const held: { symbol?: unknown; name?: unknown }[] = heldFromLedger(recs, snap.issues);
  for (const [rows, label] of [[held, "持有"], [recs.watch ?? [], "自选"]] as const) {
    for (const r of rows) {
      const s = str(r.symbol);
      if (!s) continue;
      const cur = symbols.get(s) ?? { symbol: s, name: "", origin: [] };
      cur.name ||= str(r.name);
      if (!cur.origin.includes(label)) cur.origin.push(label);
      symbols.set(s, cur);
    }
  }
  const nameOf: Named = (s) => symbols.get(s)?.name ?? "";
  const list = [...symbols.values()];
  const nameless = list.filter((s) => !s.name);
  if (nameless.length) {
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "tx_quotes_batch", args: { codes: nameless.map((s) => quoteCodeOf(s.symbol)) }, consistency, signal });
      const names = quoteNames(r.envelope);
      for (const s of nameless) s.name = names.get(s.symbol) ?? "";
    } catch (e) {
      if (signal.aborted) throw e;   // 名字只是显示用,取不到就显示代码
    }
  }
  const cnAll = list.filter((s) => /^\d{6}$/.test(s.symbol));
  const cnOther = cnAll.filter((s) => isCnFundOrBond(s.symbol));
  const cn = cnAll.filter((s) => !isCnFundOrBond(s.symbol));
  const us = list.filter((s) => /^[A-Z]/.test(s.symbol));
  const hk = list.filter((s) => /\.HK$/.test(s.symbol));
  const checkedCn = cn.slice(0, CN_MAX);

  const events: CalendarEvent[] = [];
  const overdue: CalendarEvent[] = [];
  const gaps: string[] = [];
  const label = (s: string) => (nameOf(s) ? `${nameOf(s)} ${s}` : s);
  const get = async (endpoint: string, symbol: string | undefined, args?: Record<string, unknown>): Promise<Env | undefined> => {
    try {
      const r = await fetchEndpoint(ctx, { endpoint, ...(symbol ? { symbol } : {}), ...(args ? { args } : {}), consistency, signal });
      return r.envelope as Env;
    } catch (e) {
      if (signal.aborted) throw e;
      return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
    }
  };

  const CN_SOURCES: [string, string, (s: string, env: unknown) => void][] = [
    ["next_disclosure", "预约披露", (s, env) => { const r = disclosureEvents(s, env, from, to, nameOf); events.push(...r.events); overdue.push(...r.overdue); }],
    ["em_lockup_expiry", "限售解禁", (s, env) => events.push(...lockupEvents(s, env, from, to, nameOf))],
    ["em_dividend_history", "分红送转", (s, env) => events.push(...dividendEvents(s, env, from, to, nameOf))],
  ];
  const jobs: (() => Promise<void>)[] = [];
  for (const s of checkedCn) {
    for (const [endpoint, what, take] of CN_SOURCES) {
      jobs.push(async () => {
        const env = await get(endpoint, s.symbol);
        if (!env || env.status === "failed") gaps.push(`${label(s.symbol)} ${what}:没取到${failedNote(env) ? `(${failedNote(env)})` : ""}`);
        else take(s.symbol, env);
      });
    }
  }
  if (us.length) {
    jobs.push(async () => {
      const tickers = us.map((s) => s.symbol);
      const env = await get("us_anchor_earnings", undefined, { tickers: tickers.join(",") });
      if (!env || env.status === "failed") { gaps.push(`美股财报日:没取到${failedNote(env) ? `(${failedNote(env)})` : ""}`); return; }
      const got = new Set(evsOf(env).filter((e) => e.field === "us_anchor_earnings_date").map((e) => str(e.symbol) || str(e.record_key)));
      for (const t of tickers) if (!got.has(t)) gaps.push(`${label(t)} 财报日:没取到`);
      events.push(...earningsEvents(env, from, to, nameOf));
    });
  }
  if (query.macro !== "0") {
    jobs.push(async () => {
      const env = await get("macro_calendar", undefined, { start: from, end: to, min_importance: 3 });
      if (!env || env.status === "failed") gaps.push(`宏观日历:没取到${failedNote(env) ? `(${failedNote(env)})` : ""}`);
      else events.push(...macroEvents(env, from, to));
    });
  }
  await pool(jobs, CONCURRENCY, (j) => j());
  if (signal.aborted) throw signal.reason ?? new Error("aborted");

  if (cn.length > checkedCn.length) gaps.push(`A 股只查了前 ${CN_MAX} 只(持有优先),另有 ${cn.length - checkedCn.length} 只没查`);
  if (cnOther.length) gaps.push(`基金 / 债券 ${cnOther.map((s) => label(s.symbol)).join("、")}:预约披露、解禁、分红这几个来源只有股票,没查`);
  if (hk.length) gaps.push(`港股 ${hk.map((s) => label(s.symbol)).join("、")}:目前没有可用的逐只事件来源,没查`);

  const led = ledgerEvents(recs, from, to, nameOf);
  events.push(...led.events);
  overdue.push(...led.overdue);
  events.sort(sortEvents);
  overdue.sort(sortEvents);
  gaps.sort();
  return { window: { from, to, days }, generated_at: now.toISOString(), symbols: list, events, overdue, gaps };
}
