/**
 * 金融垂类的**定时任务**:按北京时间、只在 A 股交易日跑,结果进收件箱 / 推送(机制在 Core `notify.ts`)。
 *
 * 三个任务都**只报事实**:指数涨跌、涨停家数、资金流前几名、自选的涨跌和新公告标题、到期的判据和期间公告。
 * 🔴 不写「建议关注」「可以买」一类的话,不给评分 —— 推送是事实摘要 + 本机链接,判断留给用户回到页面上看。
 *
 * 门判定:周末直接不跑(不联网);工作日查交易日历,`is_today_trading_day` 那条证据的日期必须就是今天,
 * 对不上或取不到一律 unavailable —— Core 会当天不跑并说明,不把「查不到」当成「开市」。
 */
import type { GateResult, JobContext, JobResult, NotifyMessage, ScheduleDef } from "../notify.ts";
import { fetchEndpoint, ledgerList, pageQuery, type PageResult } from "../service.ts";
import { calendarFromEnvelope } from "./session.ts";
import { verdictDue } from "./verdicts.ts";

export const SCHEDULE_TZ = "Asia/Shanghai";

interface Ev { field?: string; value?: unknown; period?: string; note?: string; record_key?: string; unit?: string }
interface Env { status?: string; evidence?: Ev[]; errors?: { source?: string }[] }

const evs = (env: unknown): Ev[] => (env && typeof env === "object" && Array.isArray((env as Env).evidence) ? (env as Env).evidence! : []);
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 长表透视成一行一个 record_key;同 key 同字段取资料期最新的那条(与界面 rows() 同一口径) */
export function rowsOf(env: unknown): { key: string; note: string; f: Record<string, Ev> }[] {
  const by = new Map<string, { key: string; note: string; f: Record<string, Ev> }>();
  for (const e of evs(env)) {
    if (!e.record_key || !e.field) continue;
    const r = by.get(e.record_key) ?? { key: e.record_key, note: e.note ?? "", f: {} };
    const prev = r.f[e.field];
    if (!prev || String(e.period ?? "") > String(prev.period ?? "")) r.f[e.field] = e;
    if (!r.note && e.note) r.note = e.note;
    by.set(e.record_key, r);
  }
  return [...by.values()];
}

/**
 * 取数失败的简短原因,写进缺口用。取数器把原因写在 errors[](来源 + 报错原文);
 * 只有调用方自己接住异常时才有 reason。报错原文很长(带主机名、超时秒数),这里只留来源和一句话。
 */
export function failedNote(env: unknown): string {
  const e = (env && typeof env === "object" ? env : {}) as { reason?: unknown; degraded?: unknown; errors?: unknown };
  const own = typeof e.reason === "string" && e.reason ? e.reason : typeof e.degraded === "string" ? e.degraded : "";
  if (own) return own.slice(0, 80);
  const first = Array.isArray(e.errors) ? (e.errors as unknown[]).find((x): x is { source?: unknown; error?: unknown } => !!x && typeof x === "object") : undefined;
  if (!first) return "";
  const msg = typeof first.error === "string" ? first.error : "";
  const kind = /time[sd]? ?out/i.test(msg) ? "超时" : /connection|connect|resolve|getaddrinfo/i.test(msg) ? "连不上" : msg.slice(0, 60);
  return [typeof first.source === "string" ? first.source : "", kind].filter(Boolean).join(" ").slice(0, 80);
}

const scalarOf = (env: unknown, field: string): number | null => numOf(evs(env).find((e) => e.field === field && !e.record_key)?.value);

const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const yi = (yuan: number) => `${yuan > 0 ? "+" : ""}${(yuan / 1e8).toFixed(1)} 亿`;

// ---------------------------------------------------------------- 门判定

/** 计划时区下是星期几(0 = 周日) */
function weekdayOf(now: Date): number {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULE_TZ, weekday: "short" }).format(now);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

export function gateFromCalendar(env: unknown, day: string): GateResult {
  const facts = env && typeof env === "object" ? calendarFromEnvelope(env as never) : null;
  if (!facts) {
    const src = (env as Env | null)?.errors?.map((e) => e?.source).filter(Boolean)[0];
    return { status: "unavailable", reason: `拿不到 A 股交易日历${src ? `(数据源 ${src} 没取到)` : ""}` };
  }
  const period = evs(env).find((e) => e.field === "is_today_trading_day")?.period;
  if (period !== day) return { status: "unavailable", reason: `交易日历的日期(${period ?? "缺失"})和今天(${day})对不上` };
  return facts.is_today_trading_day ? { status: "open" } : { status: "closed", reason: "今天 A 股休市" };
}

async function financeGate(g: { ctx: JobContext["ctx"]; day: string; now: Date; signal: AbortSignal }): Promise<GateResult> {
  const wd = weekdayOf(g.now);
  if (wd === 0 || wd === 6) return { status: "closed", reason: "周末休市" };
  // 日历端点要一个主体,只用来定位市场(与每日复盘页同一个写法)
  const r = await fetchEndpoint(g.ctx, { endpoint: "fetch_trade_calendar", symbol: "300308", consistency: { mode: "fresh" }, signal: g.signal });
  return gateFromCalendar(r.envelope, g.day);
}

// ---------------------------------------------------------------- 收盘摘要

const A_INDEX = /^(?:sh|sz|bj)\d{6}$/;

export function closeDigestMessage(page: PageResult, indices: unknown, day: string): NotifyMessage {
  const ctx = page.context ?? {};
  const reviewDay = typeof ctx.review_date === "string" ? ctx.review_date : null;
  const lines: string[] = [];
  lines.push(reviewDay ? `复盘日 ${reviewDay}${typeof ctx.review_reason === "string" ? `(${ctx.review_reason})` : ""}` : `复盘日没确定:${String(ctx.error ?? "拿不到交易日历")}`);

  const idx = rowsOf(indices).filter((r) => A_INDEX.test(r.key)).flatMap((r) => {
    const c = numOf(r.f.change_pct?.value);
    return c === null ? [] : [{ name: r.note.replace(/\(.*$/, "").trim() || r.key, c, period: r.f.change_pct?.period ?? "" }];
  });
  if (idx.length) {
    const periods = [...new Set(idx.map((x) => x.period).filter(Boolean))];
    lines.push(`指数 ${idx.map((x) => `${x.name} ${pct(x.c)}`).join(" · ")}${periods.length === 1 && periods[0] !== reviewDay ? `(行情日 ${periods[0]})` : ""}`);
  } else lines.push("指数:没取到");

  const block = (id: string) => page.blocks.find((b) => b.id === id);
  const usable = (id: string) => { const b = block(id); return b && (b.status === "ok" || b.status === "partial") ? b.envelope : undefined; };

  const sent = usable("sentiment");
  const zt = scalarOf(sent, "limit_up_count"), zb = scalarOf(sent, "break_board_count"), dt = scalarOf(sent, "limit_down_count");
  lines.push(sent && (zt !== null || dt !== null) ? `涨停 ${zt ?? "—"} · 炸板 ${zb ?? "—"} · 跌停 ${dt ?? "—"}` : "涨停 / 跌停:没取到");

  const pool = usable("zt_pool");
  const ladder = rowsOf(pool).flatMap((r) => { const d = numOf(r.f.pool_limit_days?.value); return d === null ? [] : [{ d, name: r.note.split(/\s+/)[1] ?? r.key }]; });
  if (ladder.length) {
    const top = Math.max(...ladder.map((x) => x.d));
    const who = ladder.filter((x) => x.d === top).map((x) => x.name);
    lines.push(`最高连板 ${top} 板(${who.slice(0, 3).join("、")}${who.length > 3 ? ` 等 ${who.length} 只` : ""})`);
  } else if (!pool) lines.push("涨停梯队:没取到");

  const flow = usable("board_flow");
  // 东财不通时页面会换新浪(字段 board_net_sina):口径是流入 − 流出,不叫「主力」,标题要说清(第四轮审计 B1)
  const sina = rowsOf(flow).some((r) => r.f.board_net_sina);
  const boards = rowsOf(flow).flatMap((r) => {
    const n = numOf((sina ? r.f.board_net_sina : r.f.board_main_net_today)?.value);
    return n === null ? [] : [{ n, name: r.note.replace(/\s*排名.*$/, "").trim() || r.key }];
  }).sort((a, b) => b.n - a.n);
  if (boards.length) {
    // 这个源只给当日:复盘日不是今天时,说明资金流是今天的
    const tag = (reviewDay && reviewDay !== day ? "(今天的)" : "") + (sina ? "(新浪口径)" : "");
    const word = sina ? "板块净" : "主力净";
    const ins = boards.filter((x) => x.n > 0).slice(0, 3), outs = boards.filter((x) => x.n < 0).slice(-3).reverse();
    if (ins.length) lines.push(`${word}流入前三${tag} ${ins.map((x) => `${x.name} ${yi(x.n)}`).join("、")}`);
    if (outs.length) lines.push(`${word}流出前三${tag} ${outs.map((x) => `${x.name} ${yi(x.n)}`).join("、")}`);
  } else lines.push("板块资金流:没取到");

  const dragon = usable("dragon");
  // 只数优先用取数层按全量去重的那个数(记录多时逐条只列净买额两头,从逐条数会少算)
  const listedN = scalarOf(dragon, "dragon_tiger_market_stocks") ?? new Set(evs(dragon).map((e) => e.record_key?.split("|")[0]).filter(Boolean)).size;
  // 龙虎榜收盘后要等交易所公布:这时取到的是空表,不能写成「上榜 0 只」
  lines.push(!dragon ? "龙虎榜:没取到" : listedN ? `龙虎榜 上榜 ${listedN} 只` : "龙虎榜:还没有数据(可能还没公布)");

  const key = reviewDay ?? day;
  return { title: `收盘摘要 ${key}`, lines, link: "/daily-review", dedupeKey: `close_digest:${key}` };
}

async function closeDigest(j: JobContext): Promise<JobResult> {
  const [page, idx] = await Promise.all([
    pageQuery(j.ctx, { query: "review", refresh: true, signal: j.signal }),
    fetchEndpoint(j.ctx, { endpoint: "tx_quotes_batch", consistency: { mode: "fresh" }, signal: j.signal }).then((r) => r.envelope).catch(() => undefined),
  ]);
  if (page.blocks.every((b) => b.status === "missing" || b.status === "failed") && !idx) throw new Error("复盘数据和指数都没取到");
  return { messages: [closeDigestMessage(page, idx, j.day)] };
}

// ---------------------------------------------------------------- 自选变化

/** 台账规范形(600519 / 00700.HK / AAPL)→ 腾讯批量行情入参 */
export function quoteCodeOf(symbol: string): string {
  if (/^\d{6}$/.test(symbol)) return symbol;
  const hk = /^(\d{5})\.HK$/.exec(symbol);
  return hk ? `hk${hk[1]}` : `us${symbol}`;
}

/** 腾讯 record_key → 台账规范形 */
export function symbolOfQuoteKey(key: string): string {
  const cn = /^(?:sh|sz|bj)?(\d{6})$/i.exec(key);
  if (cn) return cn[1]!;
  const hk = /^hk(\d{1,5})$/i.exec(key);
  if (hk) return `${hk[1]!.padStart(5, "0")}.HK`;
  return key.replace(/^us/i, "").toUpperCase();
}

/**
 * since:上次运行的日期;seen:每只见过的公告;behind:公告**还没查成功**的那几只该从哪天查起。
 * 🔴 以前不管查没查成功,since 一律推到今天(审计第三轮 B6):13 日有公告、13 / 14 日公告接口都失败,
 *    15 日恢复后这条早于 since 被滤掉,又被记进 seen,以后再也不提醒。
 */
interface WatchState { since?: string; seen?: Record<string, string[]>; behind?: Record<string, string> }
/** 一次行情请求最多带几个代码:与 service.ts 的数组参数上限(MAX_ARG_ARR)一致,超了整批在取数前被拒 */
const QUOTE_BATCH = 50;
interface Announcement { symbol: string; key: string; title: string; date: string }

const ANN_SYMBOLS_MAX = 30;
const ANN_CONCURRENCY = 4;
const SEEN_KEEP = 60;

export function watchMessage(
  day: string,
  watch: { symbol: string; name: string }[],
  quotes: unknown,
  fresh: Announcement[],
  annFailed: string[],
  annSkipped: number,
): NotifyMessage {
  const names = new Map(watch.map((w) => [w.symbol, w.name]));
  const got = new Map<string, { name: string; c: number; period: string }>();
  for (const r of rowsOf(quotes)) {
    const c = numOf(r.f.change_pct?.value);
    const sym = symbolOfQuoteKey(r.key);
    if (c !== null && names.has(sym)) got.set(sym, { name: names.get(sym) || r.note.replace(/\(.*$/, "").trim() || sym, c, period: r.f.change_pct?.period ?? "" });
  }
  const label = (s: string) => `${names.get(s) || got.get(s)?.name || s} ${s}`;
  const lines: string[] = [];
  const moves = [...got.entries()].sort((a, b) => Math.abs(b[1].c) - Math.abs(a[1].c));
  if (moves.length) {
    lines.push("涨跌(按幅度排,括号里是不同于今天的行情日):");
    for (const [s, q] of moves.slice(0, 10)) lines.push(`${label(s)} ${pct(q.c)}${q.period && q.period !== day ? `(${q.period})` : ""}`);
    if (moves.length > 10) lines.push(`另有 ${moves.length - 10} 只,见自选页`);
  }
  const missing = watch.map((w) => w.symbol).filter((s) => !got.has(s));
  if (missing.length) lines.push(`没取到行情:${missing.slice(0, 8).map(label).join("、")}${missing.length > 8 ? ` 等 ${missing.length} 只` : ""}`);
  if (fresh.length) {
    lines.push(`新公告 ${fresh.length} 条:`);
    // 公告标题本身多以「公司名:」开头,前面已经写了名字,去掉重复的那段
    const bare = (a: Announcement) => { const n = names.get(a.symbol) || got.get(a.symbol)?.name; return n && a.title.startsWith(n) ? a.title.slice(n.length).replace(/^[:：]\s*/, "") || a.title : a.title; };
    for (const a of fresh.slice(0, 10)) lines.push(`${label(a.symbol)} ${a.date} ${bare(a)}`);
    if (fresh.length > 10) lines.push(`另有 ${fresh.length - 10} 条没列出(A股公告页可查)`);
  } else {
    // 「没有新公告」只说真查到了的那几只:公告全没取到时不能说没有(下面会列出没取到的)
    const cnTotal = watch.filter((w) => /^\d{6}$/.test(w.symbol)).length;
    const ok = cnTotal - annSkipped - annFailed.length;
    const other = cnTotal < watch.length ? "(港股、美股不查公告)" : "";
    if (!cnTotal) lines.push("自选里没有 A 股,没查公告");
    else if (ok > 0) lines.push(`已查的 ${ok} 只 A 股没有新公告${other}`);
  }
  if (annFailed.length) lines.push(`公告没取到:${annFailed.slice(0, 8).map(label).join("、")}${annFailed.length > 8 ? ` 等 ${annFailed.length} 只` : ""}`);
  if (annSkipped) lines.push(`公告只查前 ${ANN_SYMBOLS_MAX} 只 A 股,另有 ${annSkipped} 只没查`);
  return { title: `自选变化 ${day}`, lines, link: "/my-stocks?tab=watch", dedupeKey: `watch_changes:${day}` };
}

export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
  }));
  return out;
}

async function watchChanges(j: JobContext): Promise<JobResult> {
  const recs = ledgerList(j.ctx, "watch").watch ?? [];
  const watch = [...new Map(recs.flatMap((r) => (typeof r.symbol === "string" && r.symbol
    ? [[r.symbol, { symbol: r.symbol, name: typeof r.name === "string" ? r.name : "" }] as const] : []))).values()];
  if (!watch.length) return { messages: [], note: "自选为空,没有可看的" };

  const prev = (j.state && typeof j.state === "object" ? j.state : {}) as WatchState;
  const lastRun = prev.since ?? j.day;
  const sinceOf = (s: string) => prev.behind?.[s] ?? lastRun;
  // 行情每 50 只一批(审计第三轮 B5):一次传 51 只会被参数校验整批拒掉,所有自选都显示「没取到行情」。
  // 一批失败不影响别的批;失败的那几只照常列进「没取到行情」
  const batches: (typeof watch)[] = [];
  for (let i = 0; i < watch.length; i += QUOTE_BATCH) batches.push(watch.slice(i, i + QUOTE_BATCH));
  const quoteEnvs = await pool(batches, 2, (b) => fetchEndpoint(j.ctx, { endpoint: "tx_quotes_batch", args: { codes: b.map((w) => quoteCodeOf(w.symbol)) }, consistency: { mode: "fresh" }, signal: j.signal })
    .then((r) => r.envelope as Env).catch(() => undefined));
  const quoteOk = quoteEnvs.filter((e): e is Env => !!e && e.status !== "failed");
  const quotes = quoteOk.length ? { evidence: quoteOk.flatMap((e) => evs(e)) } : undefined;
  const quoteBatchFailed = quoteEnvs.length - quoteOk.length;

  const cn = watch.filter((w) => /^\d{6}$/.test(w.symbol));
  const checked = cn.slice(0, ANN_SYMBOLS_MAX);
  const seen: Record<string, string[]> = { ...(prev.seen ?? {}) };
  const fresh: Announcement[] = [];
  const failed: string[] = [];
  // 公告没查成功、或这次没查到(超过 ANN_SYMBOLS_MAX)的,检查起点不推进;查成功的才从 behind 里去掉
  const behind: Record<string, string> = {};
  for (const w of cn.slice(ANN_SYMBOLS_MAX)) behind[w.symbol] = sinceOf(w.symbol);
  await pool(checked, ANN_CONCURRENCY, async (w) => {
    const since = sinceOf(w.symbol);
    try {
      // legacy 脚本不接受参数,默认取最近 30 条
      const r = await fetchEndpoint(j.ctx, { endpoint: "fetch_announcements", symbol: w.symbol, consistency: { mode: "fresh" }, signal: j.signal });
      const env = r.envelope as Env;
      if (env.status === "failed") { failed.push(w.symbol); behind[w.symbol] = since; return; }
      const rows = evs(env).filter((e) => e.field === "announcement_title" && e.record_key && typeof e.value === "string" && e.period);
      const known = new Set(seen[w.symbol] ?? []);
      for (const e of rows) if (!known.has(e.record_key!) && e.period! >= since) fresh.push({ symbol: w.symbol, key: e.record_key!, title: String(e.value), date: e.period! });
      seen[w.symbol] = [...new Set([...rows.map((e) => e.record_key!), ...(seen[w.symbol] ?? [])])].slice(0, SEEN_KEEP);
    } catch {
      failed.push(w.symbol);
      behind[w.symbol] = since;
    }
  });
  if (!quotes && failed.length === checked.length && checked.length) throw new Error("行情和公告都没取到");
  fresh.sort((a, b) => b.date.localeCompare(a.date) || a.symbol.localeCompare(b.symbol));
  const msg = watchMessage(j.day, watch, quotes, fresh, failed, cn.length - checked.length);
  if (quoteBatchFailed && batches.length > 1) msg.lines.push(`行情分 ${batches.length} 批取(每批最多 ${QUOTE_BATCH} 只),其中 ${quoteBatchFailed} 批没取到`);
  // 离交易所异常波动标准较近的附在后面;算不出来只写一句,不让整条提醒失败。
  // 动态导入:abnormal.ts 反过来要用本文件的 pool / failedNote,静态互相导入容易在加载顺序上出事
  try {
    const { abnormalWatch, abnormalLines } = await import("./abnormal.ts");
    msg.lines.push(...abnormalLines(await abnormalWatch(j.ctx, { refresh: "1" }, j.signal)));
  } catch (e) {
    if (j.signal.aborted) throw e;
    msg.lines.push("异动接近度这次没算出来");
  }
  return {
    messages: [msg],
    state: { since: j.day, seen, behind } satisfies WatchState,
  };
}

export const FINANCE_SCHEDULE: ScheduleDef = {
  timeZone: SCHEDULE_TZ,
  gateNote: "按北京时间,只在 A 股交易日运行(周末、节假日不跑);交易日历取不到时当天不运行,并在收件箱说明。",
  gate: financeGate,
  jobs: [
    {
      id: "close_digest", label: "收盘摘要", at: "15:40", defaultEnabled: true,
      description: "A 股收盘后:主要指数涨跌、涨停 / 炸板 / 跌停家数、最高连板、主力资金净流入和净流出前三的行业、龙虎榜上榜数。只列事实。",
      run: closeDigest,
    },
    {
      id: "watch_changes", label: "自选变化", at: "16:15", defaultEnabled: true,
      description: "自选里每只的当日涨跌(港美股标出行情日)、A 股自选上次以来的新公告标题,以及离交易所异常波动标准较近的(按规则推算,以交易所公告为准)。只列事实。",
      run: watchChanges,
    },
    {
      id: "verdict_due", label: "判据到期", at: "16:30", defaultEnabled: true,
      description: "台账里的裁决点 / 证伪条件到了日子,列出写下以来的公司公告标题(A 股),提醒回来标记兑现与否。周末到期的下一个交易日提醒。",
      // 箭头包一层:verdicts.ts 反过来引用本文件,直接写函数名在加载顺序颠倒时会读到未初始化的绑定
      run: (j) => verdictDue(j),
    },
  ],
};
