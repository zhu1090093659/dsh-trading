import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Globe, RefreshCw, Star, Wallet } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { MoveButtons, PRIVATE_SORT_TITLE, ReorderToggle, SortTh } from "@/components/ui/SortTh";
import { api } from "@/lib/api";
import { backend } from "@/lib/backend";
import { loadWatch } from "@/lib/watchlist";
import { readCostMethod, type HoldingsView } from "@/lib/holdings";
import { homeHoldings, homeTotals, type HomeHolding } from "@/lib/homeDashboard";
import { isMarketTrading } from "@/lib/marketSymbol";
import { useLiveQuotes } from "@/hooks/useLiveQuotes";
import { useTableSort } from "@/hooks/useTableSort";
import { HOLDINGS_ORDER_KEY, useRowOrder } from "@/hooks/useRowOrder";
import { applyOrder, currencyRank, sortRows, visibleOrder, visibleSort, type SortValue } from "@/lib/tableSort";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";
import { hideIf } from "@/lib/privacy";
import { cn } from "@/lib/utils";

/**
 * 首页上半部分：先看市场和自己的股票，再往下才是对话（Simon 2026-10-09：「大家不会想上来就问问题，而是看自己的股票到底怎么样」）。
 *
 * - 指数条：A 股四大指数 + 美股、港股四个指数，一次请求取齐。三地任一开盘且页面在前台时每 15 秒刷新，其余时间不刷。
 * - 自选、持仓：现价走同一路实时行情（交易时段、页面在前台时每次取完隔 3 秒再取；休市只取一次）。
 * - 持仓的数量和成本来自交易流水重放，盈亏在这里按现价算；金额在隐私模式下遮住，百分比照常显示。
 * 只读：不开始研究、不调模型、不改台账。
 */

const STRIP_MS = 15_000;
const STRIP_IDLE_MS = 60_000;
const WATCH_SHOWN = 10;
const MARKETS = ["CN", "HK", "US"] as const;

const tone = (v: number | null | undefined) =>
  v == null || v === 0 ? "text-muted-foreground" : v > 0 ? "text-danger" : "text-success";
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const money = (v: number | null) => (v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: 2 }));
const signedMoney = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${money(v)}`);
const clock = (ms: number) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
const NUM = "whitespace-nowrap text-right font-mono tabular-nums";

/**
 * 首页持仓表每列按什么排。两行的格子按下面那行的百分比排：百分比能跨币种比，金额不能；
 * 只有金额的列（市值、当日盈亏）先按币种分块，块内再比。
 */
const HOLD_SORT_KEYS = ["name", "change_pct", "market_value", "pnl_pct", "day_pnl"] as const;
const holdValue = (r: HomeHolding, k: string): SortValue =>
  k === "name" ? r.name : k === "change_pct" ? r.change_pct : k === "market_value" ? r.market_value
    : k === "pnl_pct" ? r.pnl_pct : k === "day_pnl" ? r.day_pnl : null;
const holdGroup = (r: HomeHolding, k: string) => (k === "market_value" || k === "day_pnl" ? currencyRank(r.currency) : null);
/** 隐私模式下被遮住的列（市值、当日盈亏金额）：不按它们排，记着的排序也先不用 */
const HOLD_MASKED: readonly string[] = ["market_value", "day_pnl"];

/** 指数条：开盘时 15 秒一刷；休市、页面切走时只留一个心跳，切回来立刻补一次 */
function useMarketStrip() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.marketStrip>> | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const kick = useRef<(manual: boolean) => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;
    const clear = () => { if (timer !== null) { window.clearTimeout(timer); timer = null; } };
    const tick = async (first: boolean, manual = false) => {
      if (cancelled || inFlight) return;
      clear();
      const on = MARKETS.some((m) => isMarketTrading(m)) && !document.hidden;
      setLive(on);
      if (first || on || manual) {
        inFlight = true;
        setLoading(true);
        try {
          const d = await api.marketStrip(on || manual);
          if (!cancelled) { setData(d); setErr(false); setAt(Date.now()); }
        } catch {
          if (!cancelled) setErr(true);
        } finally {
          inFlight = false;
          if (!cancelled) setLoading(false);
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(false), on ? STRIP_MS : STRIP_IDLE_MS);
    };
    kick.current = (manual) => void tick(false, manual);
    void tick(true);
    const onVisible = () => { if (!document.hidden) void tick(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clear(); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  const refresh = useCallback(() => kick.current(true), []);
  return { data, err, loading, live, at, refresh };
}

function IndexTile({ name, tag, price, change, title }: { name: string; tag: string; price: number | null; change: number | null; title?: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2" title={title}>
      <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
        <span className="truncate">{name}</span><span className="shrink-0 text-muted-foreground/50">{tag}</span>
      </p>
      <p className={cn("mt-0.5 font-mono text-[15px] font-semibold leading-6 tabular-nums", tone(change))}>{price == null ? "—" : price.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</p>
      <p className={cn("font-mono text-[11px]", tone(change))}>{pct(change)}</p>
    </div>
  );
}

function MarketStrip({ strip }: { strip: ReturnType<typeof useMarketStrip> }) {
  const { data, err, loading, live, at, refresh } = strip;
  return (
    <section aria-labelledby="home-market" className="glass mb-2.5 overflow-hidden">
      <div className="workspace-panel-head flex-wrap">
        <h2 id="home-market" className="flex items-center gap-1.5"><Globe className="h-3.5 w-3.5 text-primary" /> 大盘与全球指数</h2>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {err && <span className="text-warning">{data ? "这次没刷新成功，显示的是上一次的" : "指数没取到，请稍后刷新；不代表市场没有变化"}</span>}
          {!err && <span>{live ? "交易时段 · 每 15 秒刷新" : "休市或页面在后台 · 不自动刷新"}</span>}
          {at && <span className="font-mono">{clock(at)}</span>}
          <button onClick={refresh} disabled={loading} title="立即刷新" aria-label="刷新指数" className="hover:text-primary disabled:opacity-50">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4 xl:grid-cols-8">
        {data
          ? <>
            {data.cn.map((i) => <IndexTile key={i.name} name={i.name} tag="A 股" price={i.price} change={i.change_pct} title={i.note} />)}
            {data.global.map((g) => <IndexTile key={g.key} name={g.name} tag={g.region} price={g.price} change={g.change_pct}
              title={g.note || (g.fetched_at ? `取数：${new Date(g.fetched_at).toLocaleString("zh-CN", { hour12: false })}` : undefined)} />)}
          </>
          : Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="bg-card px-3 py-2 text-[11px] text-muted-foreground">{err ? "未取到" : "加载中…"}<p className="mt-0.5 font-mono text-[15px] leading-6 text-muted-foreground/40">—</p></div>
          ))}
      </div>
      <p className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">腾讯行情快照，不是逐笔实时；指数只看涨跌，不代表个股。</p>
    </section>
  );
}

function LiveNote({ polling, updatedAt, error }: { polling: boolean; updatedAt: number | null; error: string | null }) {
  return (
    <span className="text-[11px] text-muted-foreground">
      {error ? <span className="text-warning">{error}</span> : polling ? "交易时段 · 实时刷新" : "休市或页面在后台 · 不自动刷新"}
      {updatedAt && <span className="ml-1.5 font-mono" title="所显示价格中最早的取数时刻；不是成交时间，上游可能延迟">{clock(updatedAt)}</span>}
    </span>
  );
}

function WatchCard({ codes, quotes, live }: { codes: string[]; quotes: ReturnType<typeof useLiveQuotes>["quotes"]; live: ReturnType<typeof useLiveQuotes> }) {
  const [all, setAll] = useState(false);
  const shown = all ? codes : codes.slice(0, WATCH_SHOWN);
  return (
    <GlassCard className="min-w-0 overflow-hidden p-0 lg:col-span-2">
      <div className="workspace-panel-head flex-wrap">
        <h2 className="flex items-center gap-1.5"><Star className="h-3.5 w-3.5 text-primary" /> 我的自选<span className="text-xs font-normal text-muted-foreground">（{codes.length}）</span></h2>
        <Link to="/my-stocks?tab=watch" className="inline-flex items-center gap-1 text-xs text-primary">管理自选<ArrowRight className="h-3.5 w-3.5" /></Link>
      </div>
      {codes.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-muted-foreground">还没有自选股。<Link to="/my-stocks?tab=watch" className="text-primary">去添加</Link>，代码、名称、拼音都行。</p>
      ) : <>
        <div className="flex justify-end border-b border-border px-3 py-1"><LiveNote polling={live.polling} updatedAt={live.updatedAt} error={live.error} /></div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr>
              <th>名称</th><th className="text-right">现价</th><th className="text-right">涨跌</th>
            </tr></thead>
            <tbody>
              {shown.map((c) => {
                const q = quotes[c];
                return (
                  <tr key={c}>
                    <td className="min-w-[6.5rem] max-w-[10rem]">
                      <Link to={`/research?symbol=${encodeURIComponent(c)}`} title="在个股深挖看走势、财报和事件回看" className="block truncate font-medium hover:text-primary">{q?.name || c}</Link>
                      <span className="font-mono text-[10px] text-muted-foreground">{c}</span>
                    </td>
                    <td className={cn("whitespace-nowrap text-right font-mono tabular-nums", tone(q?.change_pct))}>{q?.price ?? "—"}</td>
                    <td className={cn("whitespace-nowrap text-right font-mono tabular-nums", tone(q?.change_pct))}>{q ? pct(q.change_pct) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {codes.length > WATCH_SHOWN && (
          <button onClick={() => setAll((v) => !v)} className="w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-primary">
            {all ? "收起" : `展开全部 ${codes.length} 只`}
          </button>
        )}
      </>}
    </GlassCard>
  );
}

export function HoldingsCard({ view, err, rows, live, pending }: {
  view: HoldingsView | null; err: string | null; rows: HomeHolding[]; live: ReturnType<typeof useLiveQuotes>; pending: (code: string) => boolean;
}) {
  const { on: hide } = usePrivacyMode();
  const p = (text: string) => hideIf(hide, text);
  const totals = useMemo(() => homeTotals(rows), [rows]);
  // 有持仓的行情还在取（首次进入，或持仓读出来后名单变了）：这时「没取到现价」是还在取，不是取不到
  const quoting = rows.some((r) => pending(r.code));
  const { sort: savedSort, onSort, setSort } = useTableSort("vr-sort-home-holdings", HOLD_SORT_KEYS);
  const sort = visibleSort(savedSort, hide, (k) => HOLD_MASKED.includes(k));
  const saved = useRowOrder(HOLDINGS_ORDER_KEY);
  const { order, masked: orderMasked } = visibleOrder(saved.order, saved.masked, hide);
  const [reorder, setReorder] = useState(false);
  const shown = useMemo(() => sortRows(applyOrder(rows, order, (r) => r.code), sort, holdValue, holdGroup), [rows, order, sort]);
  const shownCodes = shown.map((r) => r.code);
  const toggleReorder = () => {
    // 正按某列排着时点「调整顺序」：从眼前这个先后开始挪。
    // 隐私模式下暂时没用的那份排序也清掉，不然挪到一半关掉隐私模式，表又按它排、挪了看不出来
    if (!reorder && savedSort) { if (sort) saved.setOrder(shownCodes, HOLD_MASKED.includes(sort.key) || orderMasked); setSort(null); }
    setReorder((v) => !v);
  };
  const th = { sort, onSort, disabled: reorder };
  return (
    <GlassCard className="min-w-0 overflow-hidden p-0 lg:col-span-3">
      <div className="workspace-panel-head flex-wrap">
        <h2 className="flex items-center gap-1.5"><Wallet className="h-3.5 w-3.5 text-primary" /> 我的持仓<span className="text-xs font-normal text-muted-foreground">（{rows.length}）</span></h2>
        <Link to="/my-stocks?tab=hold" className="inline-flex items-center gap-1 text-xs text-primary">记一笔、看收益<ArrowRight className="h-3.5 w-3.5" /></Link>
      </div>
      {err ? <p role="status" className="px-3 py-8 text-center text-sm text-destructive">持仓没读出来（{err}），请稍后再试；这不表示没有持仓。</p>
        : view === null ? <p role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">正在读持仓…</p>
        : rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            还没有持仓记录。<Link to="/my-stocks?tab=hold" className="text-primary">去记一笔</Link>（买入、卖出、分红都记，或导入券商导出的表格）。
          </p>
        ) : <>
          {/* 合计：一种币一行，各列上下对齐；金额不换算、不跨币种相加 */}
          <div className="overflow-x-auto border-b border-border bg-muted/30">
            <table className="data-table" aria-label="持仓合计（按币种分开）">
              <thead><tr>
                <th>币种</th><th className="text-right">市值</th><th className="text-right">持仓盈亏</th><th className="text-right">收益率</th>
                <th className="text-right" title="按最近一个交易日：（现价 − 昨收）× 股数">当日盈亏</th><th className="text-right">当日涨跌</th>
              </tr></thead>
              <tbody>
                {totals.map((t) => {
                  // 当日有买卖的那只照样不算进当日合计，但合计这里不提示：小概率，提示反而让人困惑；原因写在那一行的「—」下面
                  const note = quoting ? "正在取现价…" : t.unquoted ? `${t.unquoted} 只没取到现价，没算进合计` : "";
                  const cell = (extra?: string) => cn(NUM, note && "border-b-0", extra);
                  return (
                    <Fragment key={t.currency}>
                      <tr>
                        <td className={cn("whitespace-nowrap font-medium", note && "border-b-0")}>{t.label}</td>
                        <td className={cell()}>{p(money(t.market_value))}</td>
                        <td className={cell(tone(t.pnl))}>{p(signedMoney(t.pnl))}</td>
                        <td className={cell(tone(t.pnl_pct))}>{pct(t.pnl_pct)}</td>
                        <td className={cell(tone(t.day_pnl))}>{p(signedMoney(t.day_pnl))}</td>
                        <td className={cell(tone(t.day_pnl_pct))}>{pct(t.day_pnl_pct)}</td>
                      </tr>
                      {note && <tr><td colSpan={6} className={cn("pt-0 text-[11px]", quoting ? "text-muted-foreground" : "text-warning")}>{note}</td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1">
            {/* 调整中卖到只剩一只也留着「完成」，不然表头一直锁着 */}
            {reorder || rows.length > 1 ? <ReorderToggle on={reorder} onToggle={toggleReorder} /> : <span />}
            <LiveNote polling={live.polling} updatedAt={live.updatedAt} error={live.error} />
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr>
                <SortTh label="名称" k="name" firstDir="asc" {...th} />
                <SortTh label="现价" k="change_pct" right title="按今天的涨跌幅排序" {...th} />
                {/* 手机宽度先藏市值列（合计里有），让两种盈亏不用横着拖就能看到 */}
                <SortTh label="市值" k="market_value" right title="按市值排序，不同币种分开排" className="hidden sm:table-cell" {...th}
                  disabled={reorder || hide} disabledTitle={hide ? PRIVATE_SORT_TITLE : undefined} />
                <SortTh label="持仓盈亏" k="pnl_pct" right title="按持仓收益率排序" {...th} />
                <SortTh label="当日盈亏" k="day_pnl" right title="按当日盈亏金额排序，不同币种分开排" {...th}
                  disabled={reorder || hide} disabledTitle={hide ? PRIVATE_SORT_TITLE : undefined} />
              </tr></thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={r.code}>
                    <td className="min-w-[5.5rem] max-w-[9rem] sm:min-w-[6.5rem] sm:max-w-[12rem]">
                      <div className="flex items-center gap-1.5">
                        {reorder && <MoveButtons name={r.name} first={i === 0} last={i === shown.length - 1} onMove={(d) => saved.move(shownCodes, r.code, d, orderMasked)} />}
                        <div className="min-w-0">
                          <Link to={`/research?symbol=${encodeURIComponent(r.code)}`} title={r.name} className="block truncate font-medium hover:text-primary">{r.name}</Link>
                          <span className="font-mono text-[10px] text-muted-foreground">{r.code} · {p(`${r.shares.toLocaleString("zh-CN")} 股`)}</span>
                        </div>
                      </div>
                    </td>
                    <td className={cn("whitespace-nowrap text-right font-mono tabular-nums", tone(r.change_pct))}>
                      {r.price ?? "—"}<span className="block text-[10px]">{pct(r.change_pct)}</span>
                    </td>
                    <td className="hidden whitespace-nowrap text-right font-mono tabular-nums sm:table-cell">{p(money(r.market_value))}</td>
                    <td className={cn("whitespace-nowrap text-right font-mono tabular-nums", tone(r.pnl))}>
                      {p(signedMoney(r.pnl))}<span className="block text-[10px]">{pct(r.pnl_pct)}</span>
                    </td>
                    <td className={cn("text-right font-mono tabular-nums", tone(r.day_pnl))} title={r.day_note ?? "（现价 − 昨收）× 股数"}>
                      <span className="whitespace-nowrap">{p(signedMoney(r.day_pnl))}</span>
                      {/* 显示「—」时把原因直接写在下面，不只藏在鼠标悬停里（手机上没有悬停） */}
                      {r.day_pnl === null && (
                        <span className="ml-auto block max-w-[6.5rem] font-sans text-[10px] leading-3 text-muted-foreground">{pending(r.code) ? "正在取现价" : r.day_note}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-border px-3 py-1.5 text-[10px] leading-4 text-muted-foreground">
            成本按持仓页选的成本法，合计按币种分开、不换算。当日盈亏按最近一个交易日（现价 − 昨收）× 股数，这只当天有买卖或送转时显示「—」；不含分红。
            点表头排序；「调整顺序」排的先后和持仓页共用，只记在这台电脑的浏览器里。
          </p>
        </>}
      {view && view.issues.length > 0 && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-warning">
          有 {view.issues.length} 笔流水数据不对，没参与计算。跳过的卖出会让之后的持有数偏大，<Link to="/my-stocks?tab=hold" className="text-primary">去持仓页</Link>改好（删掉重记）。
        </p>
      )}
      {view && view.migration_pending > 0 && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-warning">有 {view.migration_pending} 条旧版持仓记录还没转成交易流水，没算在这里。<Link to="/my-stocks?tab=hold" className="text-primary">打开持仓页</Link>会自动处理。</p>
      )}
    </GlassCard>
  );
}

export function HomeDashboard() {
  const strip = useMarketStrip();
  const [watch] = useState<string[]>(loadWatch);
  const [view, setView] = useState<HoldingsView | null>(null);
  const [holdErr, setHoldErr] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    backend.holdings(readCostMethod()).then(
      (v) => { if (!off) setView(v); },
      (e: unknown) => { if (!off) setHoldErr(e instanceof Error ? e.message : String(e)); },
    );
    return () => { off = true; };
  }, []);
  const heldCodes = useMemo(() => homeHoldings(view ?? { holdings: [], trades: [] }, {}).map((h) => h.code), [view]);
  const key = [...new Set([...watch, ...heldCodes])].join(",");
  // 🔴 按内容记：每次渲染都是新数组的话，实时行情那边会当成名单变了、立刻重取
  const codes = useMemo(() => (key ? key.split(",") : []), [key]);
  const live = useLiveQuotes(codes, true);
  const rows = useMemo(() => homeHoldings(view ?? { holdings: [], trades: [] }, live.quotes), [view, live.quotes]);
  // 这份名单还没完整取过一次：没拿到价的算「正在取」，不算「没取到」
  const pending = useCallback((code: string) => live.settled !== key && !(code in live.quotes), [live.settled, live.quotes, key]);

  return (
    <div className="mb-2.5">
      <MarketStrip strip={strip} />
      <div className="grid items-start gap-2.5 lg:grid-cols-5">
        <WatchCard codes={watch} quotes={live.quotes} live={live} />
        <HoldingsCard view={view} err={holdErr} rows={rows} live={live} pending={pending} />
      </div>
    </div>
  );
}
