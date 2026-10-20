/**
 * 财报前瞻 / 复盘(#18):下一份财报什么时候出、一致预期和分歧、业绩预告;过去几次财报出来后第一个交易日的涨跌,
 * 实际和预期差多少。
 *
 * 🔴 数字全部由 calc 算(earnings_reaction / earnings_surprise / consensus_dispersion,经 runTool("calc")),
 *    这里只取数、认定发布时刻、拼输入。不出目标价、不判断方向、不预测下一次。
 *
 * 来源:A 股 = 东财预约披露表(每期的正式披露日)+ 同花顺一致预期 + 东财业绩预告 + 季报累计归母净利 + 腾讯前复权日 K;
 *      美股 / 港股 = Yahoo(分季实际 vs 预期、发布时刻、下次财报日、本季一致预期)+ Yahoo 复权日 K。
 * 发布时刻(决定「反应日」是哪天):
 *   - A 股定期报告的正式披露日就是市场第一次能反应的日子 —— 晚上发的记作次日(东财公告接口实测:
 *     2026-08-14 20:41 发出的半年报,正式日期 2026-08-15),所以按「盘前」传正式日期。
 *   - 美股 / 港股按 Yahoo 记录的发布时刻换算到交易所时区:开盘前 → 当天;收盘后 → 下一个交易日;盘中 → 当天。
 *     时刻恰好是当地 00:00 的当作时刻不明,不算这一次的反应。
 * 没做的:北交所(腾讯日 K 不支持);扣除大盘涨跌(涨跌含当天大盘);营收 / 毛利趋势(个股页的财务卡已有)。
 */
import { localClock } from "../notify.ts";
import { fetchEndpoint, runTool, ServiceError, type FetchResult, type ServiceContext } from "../service.ts";
import { boardOf, klineBars } from "./abnormal.ts";
import { readRawDoc } from "./candidates.ts";
import { failedNote } from "./schedule.ts";

export type Timing = "before_open" | "during" | "after_close";
export type Market = "CN" | "US" | "HK";
/** calc 结果里界面要用的部分:数字只认 display(照抄),value 留着排序 / 判断正负 */
export interface Num { status: string; value: number | null; display: string | null; reason: string }

export interface PastReport {
  /** 报告期名称:A 股「2026年半年报」;美股 / 港股是 Yahoo 的日历季度「2Q2026」 */
  id: string;
  period: string;
  /** A 股:正式披露日;美股 / 港股:交易所当地时间 YYYY-MM-DD HH:MM */
  published: string;
  /** null = 发布时刻不明,这一次不算反应 */
  timing: Timing | null;
  reaction_day: string | null;
  /** 同一个反应日的其他报告期(合并算一次) */
  merged: string[];
  move: Num | null;
  pending: boolean;
  surprise: null | (Num & { basis: "consensus" | "forecast"; actual: number; estimate: number; low: number | null; high: number | null; position_label: string | null; unit: string });
}

export interface EarningsBriefResult {
  symbol: string;
  market: Market;
  upcoming: null | { period: string | null; label: string; date: string; days: number | null; note: string };
  consensus: null | { label: string; unit: string; mean: number; low: number | null; high: number | null; count: number | null; dispersion: Num | null; revenue_mean: number | null };
  /** A 股:下一期的业绩预告(有才给) */
  forecast: null | { period: string; notice_date: string; type: string; lower: number | null; upper: number | null; change_lower: number | null; change_upper: number | null };
  history: PastReport[];
  reaction: null | { mean_abs: Num; prior_n: number; lookback: number; latest_vs_mean: Num; latest_id: string };
  /** 最近一次的反应日就是今天、还没收盘:按最新价估算 */
  intraday: boolean;
  fetched_at: string | null;
  cached: boolean;
  generated_at: string;
  gaps: string[];
  sources: string[];
}

export const EXCHANGE: Record<Market, { tz: string; open: string; close: string }> = {
  CN: { tz: "Asia/Shanghai", open: "09:30", close: "15:00" },
  US: { tz: "America/New_York", open: "09:30", close: "16:00" },
  HK: { tz: "Asia/Hong_Kong", open: "09:30", close: "16:00" },
};
export const TIMING_LABEL: Record<Timing, string> = { before_open: "开盘前发布", during: "盘中发布", after_close: "收盘后发布" };
const LOOKBACK = 4;
/** 财报日、预期、预告一天里很少变:缓存 6 小时;日 K 盘中会变:10 分钟 */
const SLOW_MAX_AGE_MS = 6 * 3600 * 1000;
const KLINE_MAX_AGE_MS = 10 * 60 * 1000;
const CN_KLINE_COUNT = 500;
const NET_PROFIT = "归属于上市公司股东的净利润";

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const fin = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
/** Yahoo 的数值多是 {raw, fmt} */
const yraw = (x: unknown): number | null => (isObj(x) ? fin(x.raw) : fin(x));
const day10 = (x: unknown): string | null => (typeof x === "string" && DAY_RE.test(x) ? x.slice(0, 10) : null);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** 发布时刻(epoch 秒)→ 交易所当地时间与盘前 / 盘中 / 盘后 */
export function timingOf(epochSec: number, market: Market): { day: string; local: string; timing: Timing | null } {
  const ex = EXCHANGE[market];
  const { day, hm } = localClock(new Date(epochSec * 1000), ex.tz);
  const timing: Timing | null = hm === "00:00" ? null : hm < ex.open ? "before_open" : hm >= ex.close ? "after_close" : "during";
  return { day, local: `${day} ${hm}`, timing };
}

/** Yahoo chart 原始文件 → 按交易所当地日期的收盘序列。有复权价就整列用复权价,不和未复权价混用 */
export function yahooBars(doc: unknown, market: Market): { date: string; close: number }[] {
  const r = isObj(doc) && isObj(doc.chart) && Array.isArray(doc.chart.result) ? doc.chart.result[0] : null;
  if (!isObj(r) || !Array.isArray(r.timestamp) || !isObj(r.indicators)) return [];
  const ind = r.indicators as { quote?: { close?: unknown[] }[]; adjclose?: { adjclose?: unknown[] }[] };
  const adj = Array.isArray(ind.adjclose?.[0]?.adjclose) ? ind.adjclose![0]!.adjclose! : null;
  const useAdj = !!adj && adj.some((v) => fin(v) !== null);
  const col = useAdj ? adj! : Array.isArray(ind.quote?.[0]?.close) ? ind.quote![0]!.close! : [];
  const by = new Map<string, number>();
  (r.timestamp as unknown[]).forEach((t, i) => {
    const c = fin(col[i]);
    if (typeof t !== "number" || !Number.isFinite(t) || c === null || c <= 0) return;
    by.set(localClock(new Date(t * 1000), EXCHANGE[market].tz).day, c);
  });
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, close]) => ({ date, close }));
}

interface AppointRow { period: string; label: string; actual: string | null; appoint: string | null; first: string | null; changed: boolean }
/** 东财预约披露表原始文件 → 每期(报告期末、名称、正式披露日、预约日) */
export function parseAppoint(doc: unknown): AppointRow[] {
  const rows = isObj(doc) && isObj(doc.result) && Array.isArray(doc.result.data) ? doc.result.data : [];
  const out: AppointRow[] = [];
  const seen = new Set<string>();
  for (const r of rows as unknown[]) {
    if (!isObj(r)) continue;
    const period = day10(r.REPORT_DATE);
    if (!period || seen.has(period)) continue;
    seen.add(period);
    out.push({
      period,
      label: typeof r.REPORT_TYPE_NAME === "string" && r.REPORT_TYPE_NAME.trim() ? r.REPORT_TYPE_NAME.replace(/\s+/g, "") : period,
      actual: day10(r.ACTUAL_PUBLISH_DATE),
      appoint: day10(r.APPOINT_PUBLISH_DATE),
      first: day10(r.FIRST_APPOINT_DATE),
      changed: [r.FIRST_CHANGE_DATE, r.SECOND_CHANGE_DATE, r.THIRD_CHANGE_DATE].some((x) => day10(x) !== null),
    });
  }
  return out.sort((a, b) => b.period.localeCompare(a.period));
}

interface ForecastRow { period: string; notice_date: string; type: string; lower: number | null; upper: number | null; change_lower: number | null; change_upper: number | null }
/** 东财业绩预告(取数器 extracted 表)→ 归母净利那一行,同一报告期取最新公告的 */
export function parseForecasts(doc: unknown): Map<string, ForecastRow> {
  const rows = isObj(doc) && Array.isArray(doc.rows) ? doc.rows : [];
  const out = new Map<string, ForecastRow>();
  for (const r of rows as unknown[]) {
    if (!isObj(r) || r.indicator !== NET_PROFIT) continue;
    const period = day10(r.report_date);
    const notice = day10(r.notice_date);
    if (!period || !notice) continue;
    const prev = out.get(period);
    if (prev && prev.notice_date >= notice) continue;
    out.set(period, {
      period, notice_date: notice, type: typeof r.forecast_type === "string" ? r.forecast_type : "",
      lower: fin(r.amount_lower), upper: fin(r.amount_upper), change_lower: fin(r.change_pct_lower), change_upper: fin(r.change_pct_upper),
    });
  }
  return out;
}

interface YahooQuarter { id: string; period: string; actual: number | null; estimate: number | null; reported: number | null }
interface YahooParsed {
  quarters: YahooQuarter[];
  next: { date: string; estimate: boolean | null } | null;
  current: { id: string | null; period: string | null };
  trend0q: { period: string | null; avg: number | null; low: number | null; high: number | null; count: number | null; revenue: number | null } | null;
  currency: string;
}
/** Yahoo quoteSummary(earnings / earningsTrend / earningsHistory)原始文件 */
export function parseYahoo(doc: unknown): YahooParsed | null {
  const qs = isObj(doc) && isObj(doc.quoteSummary) && Array.isArray(doc.quoteSummary.result) ? doc.quoteSummary.result[0] : null;
  if (!isObj(qs)) return null;
  const chart = isObj(qs.earnings) && isObj(qs.earnings.earningsChart) ? qs.earnings.earningsChart : {};
  const quarters: YahooQuarter[] = [];
  for (const q of (Array.isArray(chart.quarterly) ? chart.quarterly : []) as unknown[]) {
    if (!isObj(q)) continue;
    const period = isObj(q.periodEndDate) ? day10(q.periodEndDate.fmt) : null;
    const id = typeof q.date === "string" && q.date ? q.date : period;
    if (!id || !period) continue;
    quarters.push({ id, period, actual: yraw(q.actual), estimate: yraw(q.estimate), reported: isObj(q.reportedDate) ? fin(q.reportedDate.raw) : null });
  }
  const nd = Array.isArray(chart.earningsDate) ? chart.earningsDate[0] : null;
  const nextDate = isObj(nd) ? day10(nd.fmt) : null;
  const trend = isObj(qs.earningsTrend) && Array.isArray(qs.earningsTrend.trend) ? qs.earningsTrend.trend as unknown[] : [];
  const t0 = trend.find((t) => isObj(t) && t.period === "0q");
  const ee = isObj(t0) && isObj(t0.earningsEstimate) ? t0.earningsEstimate : null;
  const re = isObj(t0) && isObj(t0.revenueEstimate) ? t0.revenueEstimate : null;
  const hist = isObj(qs.earningsHistory) && Array.isArray(qs.earningsHistory.history) ? qs.earningsHistory.history as unknown[] : [];
  const cur = hist.map((h) => (isObj(h) && typeof h.currency === "string" ? h.currency : "")).find(Boolean) ?? "";
  return {
    quarters: quarters.sort((a, b) => b.period.localeCompare(a.period)),
    next: nextDate ? { date: nextDate, estimate: typeof chart.isEarningsDateEstimate === "boolean" ? chart.isEarningsDateEstimate : null } : null,
    current: { id: typeof chart.currentCalendarQuarter === "string" ? chart.currentCalendarQuarter : null, period: isObj(chart.currentPeriodEndDate) ? day10(chart.currentPeriodEndDate.fmt) : null },
    trend0q: ee ? { period: isObj(t0) ? day10(t0.endDate) : null, avg: yraw(ee.avg), low: yraw(ee.low), high: yraw(ee.high), count: yraw(ee.numberOfAnalysts), revenue: re ? yraw(re.avg) : null } : null,
    currency: /^[A-Z]{3}$/.test(cur) ? cur : "",
  };
}

interface CalcOut { status: string; value: number | null; unit: string; reason: string; details: Record<string, unknown>; display: string | null }
const numOf = (o: { status?: unknown; value?: unknown; display?: unknown; reason?: unknown } | null | undefined): Num => ({
  status: typeof o?.status === "string" ? o.status : "error",
  value: fin(o?.value),
  display: typeof o?.display === "string" ? o.display : null,
  reason: typeof o?.reason === "string" ? o.reason : "",
});

const evsOf = (r: FetchResult | null) => (r && Array.isArray((r.envelope as { evidence?: unknown }).evidence) ? (r.envelope as { evidence: Record<string, unknown>[] }).evidence : []);
const rawRefOf = (r: FetchResult | null, prefix = "raw/") => evsOf(r).map((e) => (typeof e.raw_ref === "string" ? e.raw_ref : "")).find((x) => x.startsWith(prefix)) ?? "";

export async function earningsBrief(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<EarningsBriefResult> {
  const symbol = String(query.symbol ?? "").trim().toUpperCase();
  // 和取数器的 global 判别一致:4–5 位数字或 .HK 后缀 = 港股,其余按美股代码
  if (!/^(?:\d{6}|\d{4,5}|\d{1,5}\.HK|[A-Z][A-Z0-9.\-]{0,9})$/.test(symbol)) throw new ServiceError("bad_query", "symbol 要写 A 股 6 位代码、港股 4–5 位代码(或 .HK 后缀)或美股代码");
  if (query.refresh !== undefined && query.refresh !== "1") throw new ServiceError("bad_query", "refresh 只能是 1");
  const fresh = query.refresh === "1";
  /** 缺口按代码里的先后排,不按并发取数 / 计算谁先回来:异步的在发起时就占好位置 */
  const gapAt: [number, string][] = [];
  let seq = 0;
  const gap = (msg: string, at = seq++) => { gapAt.push([at, msg]); };
  const fetchedAt: string[] = [];
  let cached = false;

  const get = async (label: string, endpoint: string, args: Record<string, unknown> | undefined, maxAge: number): Promise<FetchResult | null> => {
    const at = seq++;
    try {
      const r = await fetchEndpoint(ctx, { endpoint, symbol, args, signal, consistency: fresh ? { mode: "fresh" } : { mode: "prefer_cache", max_age_ms: maxAge } });
      const env = r.envelope as { status?: string; evidence?: unknown[] };
      if (env.status === "failed" || !Array.isArray(env.evidence) || !env.evidence.length) {
        gap(`${label}没取到(${failedNote(env) || "没有数据"})`, at);
        return null;
      }
      fetchedAt.push(r.fetched_at);
      if (r.cached) cached = true;
      return r;
    } catch (e) {
      if (e instanceof ServiceError && e.code === "cancelled") throw e;
      gap(`${label}没取到(${e instanceof Error ? e.message.slice(0, 80) : String(e)})`, at);
      return null;
    }
  };
  const calc = async (what: string, fn: string, args: Record<string, unknown>): Promise<CalcOut | null> => {
    const at = seq++;
    try {
      const r = await runTool(ctx, "calc", { fn, args }, signal) as { ok?: boolean; result?: CalcOut; error?: string };
      if (r?.ok && isObj(r.result)) return r.result;
      gap(`${what}没算出来(${typeof r?.error === "string" ? r.error.slice(0, 80) : "计算没返回结果"})`, at);
    } catch (e) {
      if (e instanceof ServiceError && e.code === "cancelled") throw e;
      gap(`${what}没算出来(${e instanceof Error ? e.message.slice(0, 80) : String(e)})`, at);
    }
    return null;
  };

  let market: Market;
  let upcoming: EarningsBriefResult["upcoming"] = null;
  let consensus: EarningsBriefResult["consensus"] = null;
  let forecast: EarningsBriefResult["forecast"] = null;
  /** 交给 calc 的事件(按报告期)与各期的实际 vs 预期输入 */
  let events: { id: string; period: string; date: string; published: string; timing: Timing | null }[] = [];
  const surpriseIn = new Map<string, { basis: "consensus" | "forecast"; args: Record<string, unknown>; unit: string }>();
  let bars: { date: string; close: number }[] = [];
  let sources: string[];

  if (/^\d{6}$/.test(symbol)) {
    market = "CN";
    sources = ["东财预约披露表", "同花顺一致预期", "东财业绩预告", "季报累计归母净利", "腾讯前复权日 K"];
    const today = localClock(now, EXCHANGE.CN.tz).day;
    const bse = boardOf(symbol) === "bse";
    if (bse) gap("北交所:腾讯日 K 不支持,财报后的涨跌没算");
    const [disc, est, fc, kl] = await Promise.all([
      get("预约披露日", "next_disclosure", undefined, SLOW_MAX_AGE_MS),
      get("一致预期", "fetch_estimates", undefined, SLOW_MAX_AGE_MS),
      get("业绩预告", "earnings_forecast", undefined, SLOW_MAX_AGE_MS),
      bse ? Promise.resolve(null) : get("日 K", "tx_kline", { count: CN_KLINE_COUNT }, KLINE_MAX_AGE_MS),
    ]);
    const appoint = disc ? parseAppoint(readRawDoc(ctx, disc.out_dir, rawRefOf(disc))) : [];
    if (disc && !appoint.length) gap("预约披露表的原始文件读不到,财报日没列");
    const published = appoint.filter((a) => a.actual);
    const latestPeriod = published[0]?.period ?? "";
    const next = appoint.filter((a) => !a.actual && a.appoint && a.period > latestPeriod).sort((a, b) => a.period.localeCompare(b.period))[0];
    if (next?.appoint) {
      const days = daysBetween(today, next.appoint);
      upcoming = {
        period: next.period, label: next.label, date: next.appoint, days,
        note: [
          "东财预约披露日,公司可以改期,以交易所公告为准",
          next.first && next.first !== next.appoint ? `首次预约 ${next.first},已改期` : next.changed ? "预约日改过" : "",
          days < 0 ? "预约日已过,还没看到实际披露" : "",
        ].filter(Boolean).join(";"),
      };
    } else if (disc && appoint.length) gap("下一期的预约披露日还没公布");
    events = published.slice(0, 8).map((a) => ({ id: a.label, period: a.period, date: a.actual!, published: a.actual!, timing: "before_open" as Timing }));

    // 一致预期是全年的(FY),不是这一季的
    // 下一期预约日还没公布时按已披露的最新一期推:年报出了算下一年,否则还是这一年(不能用今天的年份:1–4 月年报还没出)
    const fy = upcoming?.period ? upcoming.period.slice(0, 4)
      : latestPeriod ? String(Number(latestPeriod.slice(0, 4)) + (latestPeriod.endsWith("-12-31") ? 1 : 0))
      : today.slice(0, 4);
    const pick = (field: string) => fin(evsOf(est).find((e) => e.field === field && e.period === `FY${fy}`)?.value);
    const mean = pick("eps_consensus_mean");
    if (est && mean === null) gap(`同花顺没有 FY${fy} 的一致预期`);
    if (mean !== null) {
      consensus = { label: `FY${fy} 全年每股收益一致预期(全年的,不是这一季的)`, unit: "元/股", mean, low: pick("eps_consensus_min"), high: pick("eps_consensus_max"), count: pick("eps_analyst_count"), dispersion: null, revenue_mean: null };
    }

    const forecasts = fc ? parseForecasts(readRawDoc(ctx, fc.out_dir, rawRefOf(fc, "raw/extracted_"))) : new Map<string, ForecastRow>();
    const upFc = upcoming?.period ? forecasts.get(upcoming.period) : undefined;
    if (upFc) forecast = upFc;
    // 过去几期有业绩预告的:实际归母净利 vs 预告区间(只在有预告时取季报)
    const withFc = events.filter((e) => { const f = forecasts.get(e.period); return f && f.lower !== null && f.upper !== null; });
    if (withFc.length) {
      const fr = await get("季报累计归母净利", "fetch_financials", undefined, SLOW_MAX_AGE_MS);
      for (const e of withFc) {
        const f = forecasts.get(e.period)!;
        const actual = fin(evsOf(fr).find((x) => x.field === "net_profit_parent_cum" && x.period === e.period)?.value);
        if (actual === null) { if (fr) gap(`${e.id} 的实际归母净利没取到,和业绩预告没比`); continue; }
        surpriseIn.set(e.id, { basis: "forecast", unit: "元", args: { actual, low: Math.min(f.lower!, f.upper!), high: Math.max(f.lower!, f.upper!), unit: "元" } });
      }
    }
    bars = kl ? klineBars(ctx, kl.envelope, kl.out_dir) : [];
  } else {
    sources = ["Yahoo 分析师预期与历史财报", "Yahoo 复权日 K"];
    const [ya, kl] = await Promise.all([
      get("分析师预期与历史财报", "yahoo_analyst_estimates", undefined, SLOW_MAX_AGE_MS),
      get("日 K", "yahoo_kline", { interval: "1d", range_: "2y" }, KLINE_MAX_AGE_MS),
    ]);
    const envMarket = String((ya?.envelope as { market?: unknown } | undefined)?.market ?? (kl?.envelope as { market?: unknown } | undefined)?.market ?? "");
    market = envMarket === "HK" || /^\d{4,5}$|\.HK$/.test(symbol) ? "HK" : "US";
    const today = localClock(now, EXCHANGE[market].tz).day;
    const y = ya ? parseYahoo(readRawDoc(ctx, ya.out_dir, rawRefOf(ya))) : null;
    if (ya && !y) gap("Yahoo 原始文件读不到,财报日和历史没列");
    if (y?.next) {
      const days = daysBetween(today, y.next.date);
      upcoming = {
        period: y.current.period, label: y.current.id ? `${y.current.id}(日历季度${y.current.period ? `,截至 ${y.current.period}` : ""})` : "下一次财报",
        date: y.next.date, days,
        note: [
          y.next.estimate === true ? "Yahoo 标注为估计日期" : y.next.estimate === false ? "Yahoo 标注为公司公布的日期" : "",
          "盘前还是盘后没注明,以公司公告为准",
          days < 0 ? "日期已过,Yahoo 还没更新" : "",
        ].filter(Boolean).join(";"),
      };
    } else if (y) gap("Yahoo 没有下一次财报日");
    const t = y?.trend0q;
    if (t && t.avg !== null) {
      if (y?.current.period && t.period && t.period !== y.current.period) gap(`Yahoo 本季预期的截止日 ${t.period} 和下一份财报的报告期 ${y.current.period} 对不上`);
      consensus = { label: `本季每股收益一致预期${t.period ? `(截至 ${t.period})` : ""}`, unit: y?.currency ?? "", mean: t.avg, low: t.low, high: t.high, count: t.count, dispersion: null, revenue_mean: t.revenue };
    } else if (y) gap("Yahoo 没有本季的一致预期");
    for (const q of y?.quarters ?? []) {
      if (q.reported === null) { gap(`${q.id} 没有发布时刻,财报后的涨跌没算`); continue; }
      const tm = timingOf(q.reported, market);
      if (!tm.timing) gap(`${q.id} 的发布时刻不明(当地 00:00),财报后的涨跌没算`);
      events.push({ id: q.id, period: q.period, date: tm.day, published: tm.local, timing: tm.timing });
      if (q.actual !== null && q.estimate !== null) surpriseIn.set(q.id, { basis: "consensus", unit: y!.currency, args: { actual: q.actual, estimate: q.estimate, unit: y!.currency } });
    }
    bars = kl ? yahooBars(readRawDoc(ctx, kl.out_dir, rawRefOf(kl)), market) : [];
    if (kl && !bars.length) gap("Yahoo 日 K 的原始文件读不到,财报后的涨跌没算");
  }

  // ---------------- 计算:全部交给 calc ----------------
  const timed = events.filter((e) => e.timing !== null);
  const [reaction, dispersion, ...surprises] = await Promise.all([
    timed.length && bars.length >= 2
      ? calc("财报后的涨跌", "earnings_reaction", { klines: bars, events: timed.map((e) => ({ id: e.id, date: e.date, timing: e.timing })), lookback: LOOKBACK })
      : Promise.resolve(null),
    consensus && consensus.low !== null && consensus.high !== null
      ? calc("一致预期分歧", "consensus_dispersion", { low: consensus.low, mean: consensus.mean, high: consensus.high })
      : Promise.resolve(null),
    ...[...surpriseIn.entries()].map(([id, s]) => calc(`${id} 实际和预期的偏差`, "earnings_surprise", s.args).then((r) => [id, r] as const)),
  ]);
  if (consensus && dispersion) consensus.dispersion = numOf(dispersion);
  const surpriseOut = new Map(surprises.filter((x): x is readonly [string, CalcOut] => !!x && !!x[1]).map(([id, r]) => [id, r]));

  type Rx = { id: string; ids: string[]; status: string; value: number | null; display: string | null; reason: string; reaction_day: string | null; pending: boolean };
  const rxs = (isObj(reaction?.details) && Array.isArray(reaction!.details.reactions) ? reaction!.details.reactions : []) as Rx[];
  const rxOf = new Map<string, Rx>();
  for (const r of rxs) for (const id of Array.isArray(r.ids) ? r.ids : []) rxOf.set(id, r);

  const history: PastReport[] = events.slice(0, 6).map((e) => {
    const rx = rxOf.get(e.id);
    const s = surpriseIn.get(e.id);
    const so = surpriseOut.get(e.id);
    const d = isObj(so?.details) ? so!.details : {};
    return {
      id: e.id, period: e.period, published: e.published, timing: e.timing,
      reaction_day: rx?.reaction_day ?? null,
      merged: rx ? rx.ids.filter((x) => x !== e.id) : [],
      move: rx ? numOf(rx) : null,
      pending: rx?.pending === true,
      surprise: s && so ? {
        ...numOf(so), basis: s.basis, unit: s.unit,
        actual: fin(d.actual) ?? 0, estimate: fin(d.estimate) ?? 0, low: fin(d.low), high: fin(d.high),
        position_label: typeof d.position_label === "string" ? d.position_label : null,
      } : null,
    };
  });
  const rd = isObj(reaction?.details) ? reaction!.details : null;
  const latestRx = rxs[0];
  const clock = localClock(now, EXCHANGE[market].tz);
  const result: EarningsBriefResult = {
    symbol, market, upcoming, consensus, forecast, history,
    reaction: reaction && rd ? {
      mean_abs: numOf(reaction), prior_n: fin(rd.prior_n) ?? 0, lookback: LOOKBACK,
      latest_vs_mean: numOf(isObj(rd.latest_abs_over_mean) ? rd.latest_abs_over_mean : null),
      latest_id: typeof rd.latest_id === "string" ? rd.latest_id : "",
    } : null,
    intraday: !!latestRx?.reaction_day && latestRx.reaction_day === clock.day && clock.hm < EXCHANGE[market].close,
    fetched_at: fetchedAt.length ? [...fetchedAt].sort()[0]! : null,
    cached,
    generated_at: now.toISOString(),
    gaps: gapAt.sort((a, b) => a[0] - b[0]).map((x) => x[1]),
    sources,
  };
  if (!events.length && !result.gaps.length) result.gaps.push("没有找到已披露的财报");
  return result;
}
