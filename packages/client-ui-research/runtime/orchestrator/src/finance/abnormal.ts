/**
 * 异动接近度:自选里的 A 股离交易所「异常波动 / 严重异常波动」标准还有多远。
 *
 * 🔴 纯规则计算:不判断方向、不预测、不给买卖建议。达到标准时交易所会自动公告,
 *    这里只按公开规则推算,一律以交易所公告为准。
 *
 * 规则出处 —— 2026 年修订版交易规则(2026-04-24 发布,2026-07-06 起施行;2026-10-08 逐条核对官网原文):
 *   上交所《交易规则》5.4.2 / 5.4.3 / 5.4.5(主板)、6.10 / 6.11 / 6.12(科创板);
 *   深交所《交易规则》5.4.1 / 5.4.3 / 5.4.4 / 5.4.5(主板、创业板);
 *   北交所《交易规则》5.4.2 – 5.4.5。
 *   - 累计偏离值 = (期末收盘价 / 期初前收盘价 − 1)×100% − (基准指数期末收盘 / 期初前收盘 − 1)×100%;
 *     期间有除权除息的按调整后的价格算(这里用前复权日 K)。⚠️ 是区间涨幅之差,不是每天的偏离值相加。
 *   - 「连续 N 个交易日内」:截至当天、长度 1 到 N 天的任一区间达到即算。
 *   - 达到后交易所公告,指标从公告的次一交易日起重新计算;停牌的从复牌之日起重新计算。
 *   - 没有涨跌幅限制的交易日不纳入计算:沪深是新股上市后前 5 个交易日,北交所是上市首日;退市整理期也不算。
 *   - 2026-07-06 起主板 ST 股涨跌幅限制改为 10%,异常波动标准与主板其他股票相同(原来是 ±12%)。
 *   基准指数:沪市主板 上证A股指数、科创板 科创50、深市主板 深证A股指数、创业板 创业板综合指数、北交所 北证50。
 *
 * 没算的(如实写进 gaps):
 *   - 沪深主板「连续 3 日日均换手率是前 5 日的 30 倍、且累计换手率达 20%」这一条:腾讯日 K 没有换手率。
 *   - 北交所:腾讯 K 线不支持北交所,北证50 也取不到。
 *   - 基金、债券、B 股、港股、美股:不适用这套股票标准,或基准不同。
 */
import { localClock } from "../notify.ts";
import { fetchEndpoint, ledgerList, ServiceError, type ServiceContext } from "../service.ts";
import { readRawDoc } from "./candidates.ts";
import { isCnFundOrBond, quoteNames } from "./events.ts";
import { SCHEDULE_TZ, failedNote, pool, quoteCodeOf } from "./schedule.ts";

export type Board = "sh_main" | "star" | "sz_main" | "chinext" | "bse";

export interface BoardRule {
  label: string;
  index: { code: string; label: string };
  /** 3 个交易日内累计偏离 ±abn% 为异常波动 */
  abn: number;
  /** 10 个交易日内几次同向异常波动构成严重异常波动 */
  count: number;
  /** 10 / 30 个交易日内的累计偏离标准:[向上, 向下] */
  sev10: [number, number];
  sev30: [number, number];
  /** 上市后多少个交易日没有涨跌幅限制(不纳入计算) */
  noLimitDays: number;
}

export const BOARD_RULES: Record<Board, BoardRule> = {
  sh_main: { label: "沪市主板", index: { code: "sh000002", label: "上证A股指数" }, abn: 20, count: 4, sev10: [100, -50], sev30: [200, -70], noLimitDays: 5 },
  star: { label: "科创板", index: { code: "sh000688", label: "科创50" }, abn: 30, count: 3, sev10: [100, -50], sev30: [200, -70], noLimitDays: 5 },
  sz_main: { label: "深市主板", index: { code: "sz399107", label: "深证A股指数" }, abn: 20, count: 4, sev10: [100, -50], sev30: [200, -70], noLimitDays: 5 },
  chinext: { label: "创业板", index: { code: "sz399102", label: "创业板综合指数" }, abn: 30, count: 3, sev10: [100, -50], sev30: [200, -70], noLimitDays: 5 },
  bse: { label: "北交所", index: { code: "bj899050", label: "北证50" }, abn: 40, count: 3, sev10: [150, -60], sev30: [300, -75], noLimitDays: 1 },
};

/** 6 位代码 → 板块;基金、债券、B 股返回 null */
export function boardOf(symbol: string): Board | null {
  if (/^60\d{4}$/.test(symbol)) return "sh_main";
  if (/^68[89]\d{3}$/.test(symbol)) return "star";
  if (/^00[0-3]\d{3}$/.test(symbol)) return "sz_main";
  if (/^30[0-2]\d{3}$/.test(symbol)) return "chinext";
  if (/^(?:92\d|43\d|83\d|87\d|88\d)\d{3}$/.test(symbol)) return "bse";
  return null;
}

export interface Bar { date: string; close: number }
export type Dir = "up" | "down";
export interface Trigger { date: string; kind: "abnormal" | "severe"; dir: Dir; why: string }

/** 一条标准在当天的状态:up / down 是所有可算区间里最大的向上 / 最大的向下累计偏离(%) */
export interface Crit {
  days: number;
  up: number | null;
  down: number | null;
  limit: [number, number];
  /** 今天这条已经达到(交易所会公告) */
  reached: Dir | null;
}

export interface Proximity {
  as_of: string;
  /** 异常波动指标从哪天起算(上次达到的次一交易日 / 复牌日 / 能算的第一天) */
  since: string;
  abnormal: Crit;
  severe10: Crit;
  severe30: Crit;
  /** 最近 10 个交易日里已有几次同向异常波动(不含今天),need = 第几次构成严重异常波动 */
  same_dir: { up: number; down: number; need: number };
  /** 按规则推算出的、最近 30 个交易日里达到过的标准(含今天) */
  recent: Trigger[];
  /** 0–1+:离最近那条标准有多近(1 = 达到) */
  level: number;
  notes: string[];
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

interface Row { date: string; close: number; prev: number; idx: number; idxPrev: number; resumed: boolean }

/**
 * 按交易所规则逐日推算。stock / index 是前复权日收盘,按日期升序。
 * `listedInRange`:stock 第一根就是上市首日 —— 前 noLimitDays 根不纳入计算。
 */
export function proximity(stock: Bar[], index: Bar[], rule: BoardRule, opts: { listedInRange?: boolean } = {}): Proximity | { error: string } {
  const idxDates = index.map((b) => b.date);
  const idxPos = new Map(idxDates.map((d, i) => [d, i] as const));
  const notes: string[] = [];
  const rows: (Row | null)[] = [];
  let idxMissing = 0;
  for (let j = 1; j < stock.length; j++) {
    const cur = stock[j]!;
    const prev = stock[j - 1]!;
    const p = idxPos.get(cur.date);
    if (p === undefined || p === 0 || !(prev.close > 0) || !(cur.close > 0)) {
      if (p === undefined && cur.date >= (idxDates[0] ?? "")) idxMissing += 1;
      rows.push(null);
      continue;
    }
    // 上一根 K 线比上一个指数交易日还晚 ⇒ 指数缺了那天:这一天的指数涨跌跨了两天,对不上,也不算
    if (prev.date > idxDates[p - 1]!) { rows.push(null); continue; }
    // 上一根 K 线比上一个指数交易日早 ⇒ 中间停过牌,复牌日起重新计算
    const resumed = idxDates[p - 1] !== prev.date;
    rows.push({ date: cur.date, close: cur.close, prev: prev.close, idx: index[p]!.close, idxPrev: index[p - 1]!.close, resumed });
  }
  if (idxMissing) notes.push(`${rule.index.label}缺 ${idxMissing} 个交易日的数据,缺的那几天和紧接着的一天不算`);
  // rows[k] 对应 stock[k+1];上市前 noLimitDays 个交易日(stock[0..n-1])不纳入 ⇒ 区间最早从 stock[n] 开始
  const firstStart = opts.listedInRange ? Math.max(0, rule.noLimitDays - 1) : 0;
  if (opts.listedInRange) notes.push(`上市不久,上市后前 ${rule.noLimitDays} 个交易日没有涨跌幅限制,不算`);

  const cum = (a: number, t: number) => {
    const s = rows[a]!;
    const e = rows[t]!;
    return r4((e.close / s.prev - 1) * 100 - (e.idx / s.idxPrev - 1) * 100);
  };
  const scan = (from: number, t: number) => {
    let up: number | null = null;
    let down: number | null = null;
    for (let a = from; a <= t; a++) {
      const v = cum(a, t);
      if (v > 0 && (up === null || v > up)) up = v;
      if (v < 0 && (down === null || v < down)) down = v;
    }
    return { up, down };
  };

  let abnStart = firstStart;
  let sevStart = firstStart;
  const abnHits: { t: number; dir: Dir }[] = [];
  const triggers: (Trigger & { t: number })[] = [];
  let last: { t: number; abnormal: Crit; severe10: Crit; severe30: Crit; same: { up: number; down: number }; since: number } | null = null;

  for (let t = 0; t < rows.length; t++) {
    const row = rows[t];
    if (!row) { abnStart = Math.max(abnStart, t + 1); sevStart = Math.max(sevStart, t + 1); continue; }
    if (t < firstStart) continue;
    if (row.resumed) { abnStart = Math.max(abnStart, t); sevStart = Math.max(sevStart, t); }

    const a3 = scan(Math.max(abnStart, t - 2), t);
    const hitUp = a3.up !== null && a3.up >= rule.abn;
    const hitDown = a3.down !== null && a3.down <= -rule.abn;
    let abnDir: Dir | null = null;
    if (hitUp && hitDown) abnDir = a3.up! / rule.abn >= -a3.down! / rule.abn ? "up" : "down";
    else if (hitUp) abnDir = "up";
    else if (hitDown) abnDir = "down";

    const lo = Math.max(sevStart, t - 9);
    const same = {
      up: abnHits.filter((h) => h.t >= lo && h.dir === "up").length,
      down: abnHits.filter((h) => h.t >= lo && h.dir === "down").length,
    };
    const s10 = scan(lo, t);
    const s30 = scan(Math.max(sevStart, t - 29), t);
    const s10Dir: Dir | null = s10.up !== null && s10.up >= rule.sev10[0] ? "up" : s10.down !== null && s10.down <= rule.sev10[1] ? "down" : null;
    const s30Dir: Dir | null = s30.up !== null && s30.up >= rule.sev30[0] ? "up" : s30.down !== null && s30.down <= rule.sev30[1] ? "down" : null;
    const countDir: Dir | null = abnDir && same[abnDir] + 1 >= rule.count ? abnDir : null;

    last = {
      t,
      since: Math.max(abnStart, t - 2),
      abnormal: { days: 3, ...a3, limit: [rule.abn, -rule.abn], reached: abnDir },
      severe10: { days: 10, ...s10, limit: rule.sev10, reached: s10Dir },
      severe30: { days: 30, ...s30, limit: rule.sev30, reached: s30Dir },
      same,
    };

    if (abnDir) {
      const v = abnDir === "up" ? a3.up! : a3.down!;
      triggers.push({ t, date: row.date, kind: "abnormal", dir: abnDir, why: `3 个交易日内累计偏离 ${sign(v)}%(标准 ±${rule.abn}%)` });
      abnHits.push({ t, dir: abnDir });
      abnStart = t + 1;
    }
    const sevWhy: string[] = [];
    if (countDir) sevWhy.push(`10 个交易日内第 ${rule.count} 次${countDir === "up" ? "向上" : "向下"}异常波动`);
    if (s10Dir) sevWhy.push(`10 个交易日内累计偏离 ${sign(s10Dir === "up" ? s10.up! : s10.down!)}%(标准 ${sign(rule.sev10[0])}% / ${rule.sev10[1]}%)`);
    if (s30Dir) sevWhy.push(`30 个交易日内累计偏离 ${sign(s30Dir === "up" ? s30.up! : s30.down!)}%(标准 ${sign(rule.sev30[0])}% / ${rule.sev30[1]}%)`);
    if (sevWhy.length) {
      triggers.push({ t, date: row.date, kind: "severe", dir: (countDir ?? s10Dir ?? s30Dir)!, why: sevWhy.join(";") });
      sevStart = t + 1;
    }
  }
  if (!last) return { error: opts.listedInRange && rows.length <= firstStart ? `上市后前 ${rule.noLimitDays} 个交易日不纳入计算` : "能算的交易日不够" };
  const firstUsable = rows.findIndex((r, k) => r && k >= firstStart);
  if (rows.length - firstUsable < 30) notes.push(`能算的只有 ${rows.length - firstUsable} 个交易日,30 日那条按已有的天数算`);
  const recentFrom = last.t - 29;
  return {
    as_of: rows[last.t]!.date,
    since: rows[last.since]!.date,
    abnormal: last.abnormal,
    severe10: last.severe10,
    severe30: last.severe30,
    same_dir: { ...last.same, need: rule.count },
    recent: triggers.filter((x) => x.t >= recentFrom).map(({ t: _t, ...x }) => x),
    level: r4(Math.max(critRatio(last.abnormal), critRatio(last.severe10), critRatio(last.severe30))),
    notes,
  };
}

const sign = (v: number) => `${v > 0 ? "+" : ""}${Number(v.toFixed(2))}`;

// ---------------------------------------------------------------- 视图

export interface AbnormalRow {
  symbol: string;
  name: string;
  board: Board;
  board_label: string;
  index_label: string;
  result: Proximity | null;
  /** 没算出来的原因 */
  skipped: string | null;
}

export interface AbnormalResult {
  rows: AbnormalRow[];
  rules: { board: Board; label: string; index: string; abn: number; count: number; sev10: [number, number]; sev30: [number, number] }[];
  as_of: string | null;
  /** 最后一根 K 线是今天、还没收盘 —— 按最新价估算,收盘后才是正式口径 */
  intraday: boolean;
  fetched_at: string | null;
  cached: boolean;
  generated_at: string;
  gaps: string[];
  source: string;
}

export const ABN_MAX = 60;
/** 取多少根日 K:30 日窗口 + 往前推算「上次达到后重新计算」需要的余量 */
export const KLINE_COUNT = 80;
const INDEX_COUNT = 100;
const CONCURRENCY = 4;
/** 盘中 K 线会变:缓存最多用 10 分钟 */
const MAX_AGE_MS = 10 * 60 * 1000;
export const RULE_SOURCE = "上交所 / 深交所 / 北交所《交易规则》(2026 年修订,2026-07-06 起施行)";

interface Env { status?: string; evidence?: { raw_ref?: unknown }[]; reason?: string }

/** 腾讯 K 线信封 → 日收盘序列(全表在取数器落盘的 extracted 文件里) */
export function klineBars(ctx: Pick<ServiceContext, "dataRoot">, env: unknown, outDir: string): Bar[] {
  const evs = env && typeof env === "object" && Array.isArray((env as Env).evidence) ? (env as Env).evidence! : [];
  const ref = evs.map((e) => (typeof e.raw_ref === "string" ? e.raw_ref : "")).find((r) => r.startsWith("raw/extracted_"));
  const doc = ref ? readRawDoc(ctx, outDir, ref) as { rows?: unknown } | null : null;
  const by = new Map<string, number>();
  for (const r of (Array.isArray(doc?.rows) ? doc!.rows : []) as { date?: unknown; close?: unknown }[]) {
    if (!r || typeof r !== "object") continue;
    const d = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "";
    const c = typeof r.close === "number" && Number.isFinite(r.close) && r.close > 0 ? r.close : null;
    if (d && c !== null) by.set(d, c);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, close]) => ({ date, close }));
}

export async function abnormalWatch(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<AbnormalResult> {
  if (query.refresh !== undefined && query.refresh !== "1") throw new ServiceError("bad_query", "refresh 只能是 1");
  const consistency = query.refresh === "1" ? { mode: "fresh" as const } : { mode: "prefer_cache" as const, max_age_ms: MAX_AGE_MS };
  const gaps: string[] = [];
  const recs = ledgerList(ctx, "watch").watch ?? [];
  const seen = new Set<string>();
  const list: { symbol: string; name: string }[] = [];
  for (const r of recs) {
    const s = typeof r.symbol === "string" ? r.symbol : "";
    if (!s || seen.has(s)) continue;
    seen.add(s);
    list.push({ symbol: s, name: typeof r.name === "string" ? r.name : "" });
  }
  const label = (m: { symbol: string; name: string }) => (m.name ? `${m.name} ${m.symbol}` : m.symbol);
  const other = list.filter((m) => !/^\d{6}$/.test(m.symbol));
  const funds = list.filter((m) => /^\d{6}$/.test(m.symbol) && isCnFundOrBond(m.symbol));
  const bShares = list.filter((m) => /^\d{6}$/.test(m.symbol) && !isCnFundOrBond(m.symbol) && boardOf(m.symbol) === null);
  const bse = list.filter((m) => /^\d{6}$/.test(m.symbol) && boardOf(m.symbol) === "bse");
  let stocks = list.filter((m) => { const b = /^\d{6}$/.test(m.symbol) ? boardOf(m.symbol) : null; return b !== null && b !== "bse"; });
  if (other.length) gaps.push(`港股 / 美股 ${other.slice(0, 8).map(label).join("、")}${other.length > 8 ? ` 等 ${other.length} 只` : ""}:不适用 A 股的异常波动标准`);
  if (funds.length) gaps.push(`基金 / 债券 ${funds.slice(0, 8).map(label).join("、")}${funds.length > 8 ? ` 等 ${funds.length} 只` : ""}:不适用股票的异常波动标准,没算`);
  if (bShares.length) gaps.push(`${bShares.map(label).join("、")}:B 股或无法识别的代码,没算`);
  if (bse.length) gaps.push(`北交所 ${bse.map(label).join("、")}:腾讯 K 线不支持北交所、北证50 也取不到,没算(标准是 3 日 ±40%)`);
  if (stocks.length > ABN_MAX) { gaps.push(`只算了前 ${ABN_MAX} 只 A 股,另有 ${stocks.length - ABN_MAX} 只没算`); stocks = stocks.slice(0, ABN_MAX); }
  if (stocks.some((m) => { const b = boardOf(m.symbol); return b === "sh_main" || b === "sz_main"; })) {
    gaps.push("沪深主板「换手率放大 30 倍且累计换手 20%」这一条没算:日 K 里没有换手率");
  }

  const fetchedAt: string[] = [];
  let cached = false;
  const kline = async (code: string): Promise<{ bars: Bar[]; note: string }> => {
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "tx_kline", symbol: code, args: { count: code.length > 6 ? INDEX_COUNT : KLINE_COUNT }, consistency, signal });
      const env = r.envelope as Env;
      if (env?.status === "failed") return { bars: [], note: failedNote(env) };
      fetchedAt.push(r.fetched_at);
      cached ||= r.cached;
      return { bars: klineBars(ctx, env, r.out_dir), note: "" };
    } catch (e) {
      if (signal.aborted) throw e;
      return { bars: [], note: e instanceof Error ? e.message.slice(0, 60) : "" };
    }
  };

  const boards = [...new Set(stocks.map((m) => boardOf(m.symbol)!))];
  const indexBars = new Map<Board, { bars: Bar[]; note: string }>();
  await pool(boards, CONCURRENCY, async (b) => { indexBars.set(b, await kline(BOARD_RULES[b].index.code)); });
  for (const b of boards) {
    const got = indexBars.get(b)!;
    if (!got.bars.length) gaps.push(`${BOARD_RULES[b].index.label}没取到${got.note ? `(${got.note})` : ""},${BOARD_RULES[b].label}的都没算`);
  }

  // 台账里没写名字的用一次批量行情补
  const nameless = stocks.filter((m) => !m.name);
  if (nameless.length) {
    const r = await fetchEndpoint(ctx, { endpoint: "tx_quotes_batch", args: { codes: nameless.slice(0, 50).map((m) => quoteCodeOf(m.symbol)) }, signal }).catch(() => undefined);
    const names = r ? quoteNames(r.envelope) : new Map<string, string>();
    for (const m of nameless) m.name = names.get(m.symbol) ?? "";
  }

  const failed: string[] = [];
  const reasons = new Set<string>();
  const rows = await pool(stocks, CONCURRENCY, async (m): Promise<AbnormalRow> => {
    const board = boardOf(m.symbol)!;
    const rule = BOARD_RULES[board];
    const base = { symbol: m.symbol, name: m.name, board, board_label: rule.label, index_label: rule.index.label };
    const idx = indexBars.get(board)!;
    if (!idx.bars.length) return { ...base, result: null, skipped: `${rule.index.label}没取到` };
    if (/退$|^退市/.test(m.name.replace(/\s/g, ""))) return { ...base, result: null, skipped: "退市整理期不纳入计算" };
    const got = await kline(m.symbol);
    if (!got.bars.length) { failed.push(m.symbol); if (got.note) reasons.add(got.note); return { ...base, result: null, skipped: "日 K 没取到" }; }
    // 拿到的根数比要的少、又晚于指数开头 ⇒ 第一根是上市首日(也可能是长期停牌后复牌,一并按上市处理并写明)
    const listedInRange = got.bars.length < KLINE_COUNT && got.bars[0]!.date > (idx.bars[0]?.date ?? "");
    const res = proximity(got.bars, idx.bars, rule, { listedInRange });
    if ("error" in res) return { ...base, result: null, skipped: res.error };
    return { ...base, result: res, skipped: null };
  });
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  if (failed.length) gaps.push(`日 K 没取到 ${failed.length} 只${reasons.size ? `(${[...reasons].join(";")})` : ""}`);

  const asOf = rows.map((r) => r.result?.as_of ?? "").filter(Boolean).sort().pop() ?? null;
  const clock = localClock(now, SCHEDULE_TZ);
  const intraday = asOf === clock.day && clock.hm < "15:00";
  const stale = rows.filter((r) => r.result && asOf && r.result.as_of < asOf);
  if (stale.length) gaps.push(`${stale.map((r) => label(r)).slice(0, 8).join("、")}的最新日 K 早于 ${asOf}(可能停牌),按它自己的最后一个交易日算`);
  fetchedAt.sort();
  return {
    rows,
    rules: boards.map((b) => { const r = BOARD_RULES[b]; return { board: b, label: r.label, index: r.index.label, abn: r.abn, count: r.count, sev10: r.sev10, sev30: r.sev30 }; }),
    as_of: asOf,
    intraday,
    fetched_at: fetchedAt[0] ?? null,
    cached,
    generated_at: now.toISOString(),
    gaps,
    source: RULE_SOURCE,
  };
}

// ---------------------------------------------------------------- 提醒

/** 自选变化提醒里附的一段:达到或接近(≥ 七成)标准的。不到的不写,省得刷屏 */
export function abnormalLines(res: AbnormalResult): string[] {
  const near = res.rows.filter((r) => r.result && r.result.level >= 0.7);
  if (!near.length) return [];
  const lines = [`离交易所异常波动标准较近的(按规则推算,以交易所公告为准${res.intraday ? ";盘中按最新价估算" : ""}):`];
  for (const r of near.slice(0, 8)) {
    const p = r.result!;
    const crits = [p.abnormal, p.severe10, p.severe30];
    const hit = crits.filter((c) => c.reached);
    // 没达到的写最接近的那条(可能是 10 日 / 30 日,不一定是 3 日)
    const near1 = crits.reduce((a, c) => (critRatio(c) > critRatio(a) ? c : a));
    // 只有盘中、且是最新那天才说「今天」;停牌的按它自己的最后一个交易日写日期
    const when = p.as_of === res.as_of && res.intraday ? "今天" : `${p.as_of} `;
    const what = hit.length
      ? `${when}已达到:${hit.map((c) => `${c.days} 日 ${sign(c.reached === "up" ? c.up! : c.down!)}%`).join("、")}`
      : `${near1.days} 日 ${showPair(near1)}(标准 ${limitText(near1)})`;
    lines.push(`${r.name ? `${r.name} ` : ""}${r.symbol} ${what}`);
  }
  if (near.length > 8) lines.push(`另有 ${near.length - 8} 只,见自选页`);
  return lines;
}

/** 离这条标准有多近:向上 / 向下取更近的那边,1 = 达到 */
export const critRatio = (c: Crit) => Math.max(c.up !== null ? c.up / c.limit[0] : 0, c.down !== null ? c.down / c.limit[1] : 0);
const limitText = (c: Crit) => (c.limit[0] === -c.limit[1] ? `±${c.limit[0]}%` : `${sign(c.limit[0])}% / ${c.limit[1]}%`);
const showPair = (c: Crit) => [c.up !== null ? `${sign(c.up)}%` : "", c.down !== null ? `${sign(c.down)}%` : ""].filter(Boolean).join(" / ") || "0%";

