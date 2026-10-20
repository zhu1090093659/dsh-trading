import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, TrendingUp } from "lucide-react";

import { EChart } from "@/components/ui/EChart";
import { GlassCard } from "@/components/ui/GlassCard";
import { usePalette } from "@/components/ui/chartPalette";
import { ApiError, backend } from "@/lib/backend";
import type { Trade } from "@/lib/holdings";
import { parsePerf, pctSigned, perfOption, type PerfGroup, type PerfResult } from "@/lib/perfView";
import { hideIf } from "@/lib/privacy";

/** 同一份流水半小时内不重算：历史价格一天才变一次，没必要每次进页面都重取几年的日线。 */
const CACHE_MS = 30 * 60 * 1000;
let cache: { sig: string; at: number; result: PerfResult } | null = null;

// 流水的任何一个数改了都要重算；备注、名称改了不影响收益率
const signature = (ts: readonly Trade[]) =>
  ts.map((t) => [t.id, t.symbol, t.type, t.date, t.shares, t.price, t.fee, t.amount, t.ratio].join(":")).sort().join("|");

export interface PortfolioPerfState { result: PerfResult | null; loading: boolean; run: (force?: boolean) => void }

/**
 * 结果绑在算它时的那份流水上：流水一改，旧结果马上不显示、不进 AI 上下文，
 * 新结果回来前是「正在算」，不拿旧的收益率配新的持仓（第四轮审计 C3）。
 */
export const perfFor = (held: { sig: string; result: PerfResult } | null, sig: string): PerfResult | null =>
  held && held.sig === sig ? held.result : null;

/** 流水变了就自动重算一次。服务端自己读台账，这里只决定什么时候算。 */
export function usePortfolioPerf(trades: readonly Trade[]): PortfolioPerfState {
  const [held, setHeld] = useState<{ sig: string; result: PerfResult } | null>(null);
  const [loading, setLoading] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const sig = signature(trades);
  const latest = useRef(sig);
  latest.current = sig;

  const run = useCallback((force = false) => {
    const s = latest.current;
    // 先作废还在跑的那次：命中缓存、流水清空直接返回时，旧请求迟到的结果不能再盖上来（审计 C7）
    ctl.current?.abort();
    if (!s) { setHeld(null); setLoading(false); return; }
    if (!force && cache && cache.sig === s && Date.now() - cache.at < CACHE_MS) { setHeld({ sig: s, result: cache.result }); setLoading(false); return; }
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    backend.holdingsPerf(c.signal)
      .then((out) => {
        if (c.signal.aborted) return;
        const r = parsePerf(out);
        if (r.ok) cache = { sig: s, at: Date.now(), result: r };
        setHeld({ sig: s, result: r });
      })
      .catch((e) => { if (!c.signal.aborted) setHeld({ sig: s, result: { ok: false, error: e instanceof ApiError ? e.message : String(e) } }); })
      .finally(() => { if (!c.signal.aborted) setLoading(false); });
  }, []);

  useEffect(() => { run(false); }, [sig, run]);
  useEffect(() => () => ctl.current?.abort(), []);
  const result = perfFor(held, sig);
  // 流水刚改、新请求还没发出去的那一下也算「正在算」，不闪成「还没有交易流水」
  return { result, loading: loading || (!!sig && result === null), run };
}

// 红涨绿跌；没有数是灰色
const tone = (v: number | null) => (v == null ? "text-muted-foreground" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "");
const money = (v: number | null) => (v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: 2 }));
const moneySigned = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${money(v)}`);

function Tile({ k, v, sub, cls, title }: { k: string; v: string; sub?: string; cls?: string; title?: string }) {
  return (
    <div className="rounded-lg bg-muted/30 p-3" title={title}>
      <p className="text-[11px] text-muted-foreground">{k}</p>
      <p className={`mt-0.5 font-mono text-base font-bold ${cls ?? ""}`}>{v}</p>
      {sub && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{sub}</p>}
    </div>
  );
}

function GroupView({ g, hide, palette }: { g: PerfGroup; hide: boolean; palette: ReturnType<typeof usePalette> }) {
  const chart = useMemo(() => perfOption(g, palette), [g, palette]);
  const p = (text: string) => hideIf(hide, text);
  return (
    <div className="border-t border-border/40 pt-4 first:border-t-0 first:pt-0">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="font-semibold">{g.label}</h4>
        {g.ok && <span className="text-xs text-muted-foreground">{g.start} 至 {g.end}（{g.spanDays} 天）· {g.symbols.length} 只</span>}
      </div>
      {!g.ok && <p className="mb-3 text-sm text-muted-foreground">这一组没算成：{g.reason}</p>}
      {g.ok && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile k="时间加权收益" v={pctSigned(g.twr)} cls={tone(g.twr)}
              sub={g.twrAnnualized === null ? "不满一年，不给年化" : `年化 ${pctSigned(g.twrAnnualized)}`}
              title="把每天的涨跌连乘：存取钱的多少和时机不影响它，看选的这些票本身走得怎么样" />
            <Tile k="资金加权收益" v={pctSigned(g.mwrPeriod)} cls={tone(g.mwrPeriod)}
              sub={g.xirr === null ? "不满一年，不给年化" : `年化（XIRR）${pctSigned(g.xirr)}`}
              title="把每笔投入、取出和期末市值当现金流算内部收益率：加仓、减仓的时机会影响它，看这些钱实际赚了多少" />
            <Tile k="区间盈亏" v={p(moneySigned(g.gain))} cls={tone(g.gain)} sub="期末市值 + 卖出所得 + 分红 − 投入" />
            <Tile k="期末市值" v={p(money(g.endValue))} sub={`投入 ${p(money(g.invested))}`} />
            <Tile k="卖出所得" v={p(money(g.proceeds))} sub="已扣卖出费用" />
            <Tile k="现金分红" v={p(money(g.dividends))} />
            <Tile k="费用合计" v={p(money(g.fees))} sub="买入费用算进投入，卖出费用从所得里扣" />
          </div>
          {chart && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium">时间加权累计收益</p>
              <EChart option={chart} height={200} />
            </div>
          )}
        </>
      )}
      {g.warnings.length > 0 && (
        <ul role="status" className="mb-3 space-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          {g.warnings.map((w) => <li key={w} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />{w}</li>)}
        </ul>
      )}
      {g.excluded.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-medium">没算进来</p>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            {g.excluded.map((x, i) => <li key={i}><span className="font-mono">{x.name ? `${x.name} ${x.symbol}` : x.symbol}</span>：{x.reason}</li>)}
          </ul>
        </div>
      )}
      <div className="space-y-0.5 text-[11px] leading-5 text-muted-foreground">
        {g.notes.map((n) => <p key={n}>{n}</p>)}
      </div>
    </div>
  );
}

/** 收益率卡：各币种分组的时间加权 / 资金加权收益、金额、走势，以及没算进来的部分。 */
export function PortfolioPerfCard({ x, hide, legacyPending }: { x: PortfolioPerfState; hide: boolean; legacyPending: number }) {
  const palette = usePalette();
  const r = x.result;
  return (
    <section className="mb-4 mt-6">
      <GlassCard>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">收益率</h3>
          <span className="text-xs text-muted-foreground">按交易流水逐日估值；按币种分开算，只给数字</span>
          <button onClick={() => x.run(true)} disabled={x.loading}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
            {x.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}重新计算
          </button>
        </div>
        {legacyPending > 0 && (
          <p className="mb-3 text-xs text-muted-foreground">还有 {legacyPending} 条旧持有记录等你确认，确认成流水之前不算进收益率。</p>
        )}
        {!r && x.loading && <p className="text-sm text-muted-foreground">正在取每只的历史价格并逐日计算，持仓多时要十几秒…</p>}
        {!r && !x.loading && <p className="text-sm text-muted-foreground">还没有交易流水，记一笔之后会自动计算。</p>}
        {r && !r.ok && <p role="alert" className="text-sm text-muted-foreground">这次没算成：{r.error}</p>}
        {r?.ok && (
          <div className="space-y-4">
            {r.view.groups.length === 0 && <p className="text-sm text-muted-foreground">没有能算的流水。</p>}
            {r.view.groups.map((g) => <GroupView key={g.currency} g={g} hide={hide} palette={palette} />)}
            {(r.view.skipped.length > 0 || r.view.gaps.length > 0) && (
              <div className="border-t border-border/40 pt-3 text-[11px] text-muted-foreground">
                {r.view.skipped.length > 0 && <p>{r.view.skipped.length} 笔数据不对的流水没算（原因见上面「持仓明细」）。</p>}
                {r.view.gaps.map((g, i) => <p key={i}><span className="font-mono">{g.symbol}</span>：{g.reason}</p>)}
              </div>
            )}
            <div className="space-y-0.5 border-t border-border/40 pt-3 text-[11px] leading-5 text-muted-foreground">
              {r.view.notes.map((n) => <p key={n}>{n}</p>)}
              {r.view.sources.length > 0 && <p>价格来源：{r.view.sources.join("、")}；算到 {r.view.asOf}</p>}
            </div>
          </div>
        )}
      </GlassCard>
    </section>
  );
}
