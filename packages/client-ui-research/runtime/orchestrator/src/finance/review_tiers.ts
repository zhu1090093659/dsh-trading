/**
 * 涨停分档:复盘那天的涨停股按东财行业归类,和前两个交易日比,按只数分四档,让复盘先看集中的、再看零散的。
 *
 * 🔴 只数是事实,档位是按只数的固定规则分的:不判断能不能持续、不预测、不排名个股。
 *    「连续集中」= 今天同一行业 ≥ 3 只、前两个交易日每天也 ≥ 2 只;其余见 TIERS。
 *
 * 来源:东财涨停池(push2ex,每只带东财行业 hybk、连板数 lbc)、同花顺强势股题材标签(只取今天涨停的那几只)、
 *      上证A股指数日 K(只用来找前两个交易日)。
 * 每个行业里的个股按 连板数 → 首次封板时间 → 代码 排,排第一的就是这个行业今天的「最高板」(固定规则,不是推荐);
 * 界面另按连板数数出梯队(几只首板、几只 2 板…),看这个行业是只有一只孤零零的高标,还是有一层层跟着的。
 * 没做的:板块内「头号股贡献占比」(按市值的龙头集中度)—— 要板块成分和市值全表,东财列表接口 2026-09 起取不到。
 */
import { localClock } from "../notify.ts";
import { fetchEndpoint, ServiceError, type ServiceContext } from "../service.ts";
import { klineBars } from "./abnormal.ts";
import { readRawDoc } from "./candidates.ts";
import { SCHEDULE_TZ, failedNote } from "./schedule.ts";

export type TierId = "mainline" | "today" | "scattered" | "single";

export const TIERS: { id: TierId; label: string; rule: string }[] = [
  { id: "mainline", label: "连续集中", rule: "今天同一行业 ≥ 3 只涨停,前两个交易日每天也 ≥ 2 只" },
  { id: "today", label: "今天集中", rule: "今天同一行业 ≥ 3 只涨停,前两个交易日不是每天都 ≥ 2 只" },
  { id: "scattered", label: "零散", rule: "今天同一行业 2 只涨停" },
  { id: "single", label: "单只", rule: "今天这个行业只有 1 只涨停" },
];

export interface ZtStock {
  symbol: string; name: string; industry: string; boards: number | null;
  /** 首次封板时间 HH:MM:SS(东财 fbt);没有或格式不对是 null。同样连板数时,封得早的排前面 */
  first_seal?: string | null;
}
export interface TierStock extends ZtStock { tags: string[] }
export interface TierGroup {
  industry: string;
  tier: TierId;
  today: number;
  /** 前一、前二个交易日同一行业的涨停只数;没取到是 null */
  prev: [number | null, number | null];
  stocks: TierStock[];
  /** 这几只的同花顺题材标签里出现最多的(最多 3 个) */
  tags: { tag: string; count: number }[];
  note: string;
}

export interface ReviewTiersResult {
  date: string;
  prev_dates: [string | null, string | null];
  /** 今天涨停池里的只数;没取到是 null */
  total: number | null;
  groups: TierGroup[];
  tiers: { id: TierId; label: string; rule: string; industries: number; stocks: number }[];
  fetched_at: string | null;
  cached: boolean;
  generated_at: string;
  gaps: string[];
  source: string;
}

export const TIERS_SOURCE = "东财涨停池(按东财行业归类)、同花顺强势股题材标签";
const UNCLASSIFIED = "未分类";
/** 当天的池盘中会变:缓存最多用 5 分钟;过去的日子收盘后就不变了 */
const TODAY_MAX_AGE_MS = 5 * 60 * 1000;
const PAST_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const CLOSE_HM = "15:05";

/** 东财 fbt 是 HMMSS 的整数(92500 = 09:25:00);集合竞价到收盘以外、或分秒不合法的给 null */
export function sealTime(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 91500 || v > 150000) return null;
  const s = String(v).padStart(6, "0");
  const [h, m, sec] = [Number(s.slice(0, 2)), Number(s.slice(2, 4)), Number(s.slice(4))];
  return m > 59 || sec > 59 || h > 15 ? null : `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4)}`;
}

/** 东财涨停池原始文件 → 每只;池是 null(盘前 / 休市 / 日期不对)返回 null */
export function parsePool(doc: unknown): ZtStock[] | null {
  const pool = (doc as { data?: { pool?: unknown } } | null)?.data?.pool;
  if (!Array.isArray(pool)) return null;
  const out: ZtStock[] = [];
  const seen = new Set<string>();
  for (const r of pool as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const symbol = typeof r.c === "string" && /^\d{6}$/.test(r.c) ? r.c : "";
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const industry = typeof r.hybk === "string" && r.hybk.trim() ? r.hybk.trim() : UNCLASSIFIED;
    const boards = typeof r.lbc === "number" && Number.isInteger(r.lbc) && r.lbc >= 1 ? r.lbc : null;
    out.push({ symbol, name: typeof r.n === "string" ? r.n.replace(/\s/g, "") : "", industry, boards, first_seal: sealTime(r.fbt) });
  }
  return out;
}

/** 同花顺强势股原始文件 → 代码 → 题材标签(「A+B+C」拆开) */
export function parseReasons(doc: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = (doc as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || typeof r.code !== "string" || typeof r.reason !== "string") continue;
    const tags = [...new Set(r.reason.split("+").map((t) => t.trim()).filter(Boolean))];
    if (tags.length && !out.has(r.code)) out.set(r.code, tags);
  }
  return out;
}

export function tierOf(today: number, prev: [number | null, number | null]): TierId {
  if (today >= 3) return prev.every((p) => p !== null && p >= 2) ? "mainline" : "today";
  return today === 2 ? "scattered" : "single";
}

const countBy = (stocks: ZtStock[] | null) => {
  if (!stocks) return null;
  const m = new Map<string, number>();
  for (const s of stocks) m.set(s.industry, (m.get(s.industry) ?? 0) + 1);
  return m;
};

/** 按只数分档;排序:档位 → 今天只数多的在前 → 行业名 */
export function buildTiers(today: ZtStock[], prev: [ZtStock[] | null, ZtStock[] | null], reasons: Map<string, string[]>): TierGroup[] {
  const p1 = countBy(prev[0]);
  const p2 = countBy(prev[1]);
  const by = new Map<string, ZtStock[]>();
  for (const s of today) by.set(s.industry, [...(by.get(s.industry) ?? []), s]);
  const order = new Map(TIERS.map((t, i) => [t.id, i] as const));
  const groups: TierGroup[] = [...by.entries()].map(([industry, list]) => {
    const prevCounts: [number | null, number | null] = [p1 ? p1.get(industry) ?? 0 : null, p2 ? p2.get(industry) ?? 0 : null];
    const tier = tierOf(list.length, prevCounts);
    const stocks = [...list]
      // 连板多的在前;一样多时首封早的在前(没有首封时间的排后);再按代码,保证可复算
      .sort((a, b) => (b.boards ?? 0) - (a.boards ?? 0) || (a.first_seal ?? "99").localeCompare(b.first_seal ?? "99") || a.symbol.localeCompare(b.symbol))
      .map((s) => ({ ...s, tags: reasons.get(s.symbol) ?? [] }));
    const freq = new Map<string, number>();
    for (const s of stocks) for (const t of s.tags) freq.set(t, (freq.get(t) ?? 0) + 1);
    const tags = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag, count]) => ({ tag, count }));
    const note = list.length >= 3 && prevCounts.some((p) => p === null) ? "前两个交易日的涨停池没取全,分不出是不是连续" : "";
    return { industry, tier, today: list.length, prev: prevCounts, stocks, tags, note };
  });
  return groups.sort((a, b) => order.get(a.tier)! - order.get(b.tier)! || b.today - a.today || a.industry.localeCompare(b.industry, "zh-CN"));
}

const compact = (d: string) => d.replace(/-/g, "");

export async function reviewTiers(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<ReviewTiersResult> {
  const date = query.date ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD");
  }
  if (query.refresh !== undefined && query.refresh !== "1") throw new ServiceError("bad_query", "refresh 只能是 1");
  const clock = localClock(now, SCHEDULE_TZ);
  const gaps: string[] = [];
  const fetchedAt: string[] = [];
  let cached = false;

  /** 取一个端点;缓存是那天收盘前取的(池还没定)就重新取 */
  const get = async (endpoint: string, args: Record<string, unknown>, day: string, symbol?: string) => {
    const fresh = query.refresh === "1" && day === date;
    const live = day >= clock.day;
    const consistency = fresh ? { mode: "fresh" as const } : { mode: "prefer_cache" as const, max_age_ms: live ? TODAY_MAX_AGE_MS : PAST_MAX_AGE_MS };
    let r = await fetchEndpoint(ctx, { endpoint, symbol, args, consistency, signal });
    if (r.cached && !live) {
      const at = localClock(new Date(r.fetched_at), SCHEDULE_TZ);
      if (at.day < day || (at.day === day && at.hm < CLOSE_HM)) r = await fetchEndpoint(ctx, { endpoint, symbol, args, consistency: { mode: "fresh" }, signal });
    }
    return r;
  };
  const docOf = (r: { envelope: unknown; out_dir: string }) => {
    const evs = (r.envelope as { evidence?: { raw_ref?: unknown }[] })?.evidence;
    const ref = (Array.isArray(evs) ? evs : []).map((e) => (typeof e?.raw_ref === "string" ? e.raw_ref : "")).find(Boolean);
    return ref ? readRawDoc(ctx, r.out_dir, ref) : null;
  };
  const pool = async (day: string): Promise<{ stocks: ZtStock[] | null; note: string }> => {
    try {
      const r = await get("em_zt_pool", { date: compact(day) }, day);
      const env = r.envelope as { status?: string };
      if (env?.status === "failed") return { stocks: null, note: failedNote(env) };
      if (day === date) { fetchedAt.push(r.fetched_at); cached ||= r.cached; }
      return { stocks: parsePool(docOf(r)), note: "" };
    } catch (e) {
      if (signal.aborted) throw e;
      return { stocks: null, note: e instanceof Error ? e.message.slice(0, 60) : "" };
    }
  };

  const [todayPool, reasonDoc, prevDates] = await Promise.all([
    pool(date),
    get("ths_hot_reason", { date }, date).then((r) => ((r.envelope as { status?: string })?.status === "failed" ? null : docOf(r))).catch((e) => { if (signal.aborted) throw e; return null; }),
    // 前两个交易日:从上证A股指数日 K 的日期里找。参数和异动接近度取的一样(100 根),共用一份缓存
    fetchEndpoint(ctx, { endpoint: "tx_kline", symbol: "sh000002", args: { count: 100 }, consistency: { mode: "prefer_cache", max_age_ms: TODAY_MAX_AGE_MS }, signal })
      .then((r) => klineBars(ctx, r.envelope, r.out_dir).map((b) => b.date).filter((d) => d < date).slice(-2).reverse())
      .catch((e) => { if (signal.aborted) throw e; return [] as string[]; }),
  ]);
  const prevDays: [string | null, string | null] = [prevDates[0] ?? null, prevDates[1] ?? null];
  if (!prevDays[0] || !prevDays[1]) gaps.push("前两个交易日没找到(上证A股指数日 K 没取到),「连续集中」分不出来");
  const prevPools = await Promise.all(prevDays.map((d) => (d ? pool(d) : Promise.resolve({ stocks: null, note: "" }))));
  prevDays.forEach((d, i) => { if (d && !prevPools[i]!.stocks) gaps.push(`${d} 的涨停池没取到${prevPools[i]!.note ? `(${prevPools[i]!.note})` : ""},「连续集中」分不出来`); });
  const reasons = parseReasons(reasonDoc);
  if (!reasonDoc) gaps.push("同花顺题材标签没取到,只按东财行业分");

  let groups: TierGroup[] = [];
  if (!todayPool.stocks) gaps.unshift(todayPool.note ? `${date} 的涨停池没取到(${todayPool.note}),没法分档` : `${date} 的涨停池是空的(盘前、休市日或日期不对时如此),没法分档`);
  else groups = buildTiers(todayPool.stocks, [prevPools[0]!.stocks, prevPools[1]!.stocks], reasons);

  fetchedAt.sort();
  return {
    date,
    prev_dates: prevDays,
    total: todayPool.stocks ? todayPool.stocks.length : null,
    groups,
    tiers: TIERS.map((t) => {
      const g = groups.filter((x) => x.tier === t.id);
      return { ...t, industries: g.length, stocks: g.reduce((n, x) => n + x.today, 0) };
    }),
    fetched_at: fetchedAt[0] ?? null,
    cached,
    generated_at: now.toISOString(),
    gaps,
    source: TIERS_SOURCE,
  };
}
