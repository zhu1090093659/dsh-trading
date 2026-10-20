import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Loader2, Play, RefreshCw } from "lucide-react";

import { EChart } from "@/components/ui/EChart";
import { GlassCard } from "@/components/ui/GlassCard";
import { usePalette } from "@/components/ui/chartPalette";
import { ApiError, backend } from "@/lib/backend";
import type { Holding } from "@/lib/api";
import { amountAtNow, holdingsSig, holdingValues, valuesDrifted, type HoldingValues } from "@/lib/holdingsDrift";
import { pctSigned } from "@/lib/perfView";
import { hideIf } from "@/lib/privacy";
import { parseReplay, replayOption, type ReplayGroup, type ReplayResult, type ReplayScenario } from "@/lib/replayView";
import { cn } from "@/lib/utils";

/** 回放要逐只取十几年的日线，只在点按钮时跑；同一组持仓半小时内记住结果，离开页面再回来不用重跑。 */
const CACHE_MS = 30 * 60 * 1000;
let cache: { sig: string; values: HoldingValues; at: number; result: ReplayResult } | null = null;

// 比例和「按现在的市值约」都按市值算：代码、股数、名称变了，现价有无变了，或市值变了 2% 以上，都算持仓变了
const cached = (sig: string, hs: Holding[]) =>
  (cache && cache.sig === sig && !valuesDrifted(cache.values, hs) && Date.now() - cache.at < CACHE_MS ? cache.result : null);

export interface ScenarioReplayState {
  result: ReplayResult | null;
  loading: boolean;
  /** 结果是按之前的持仓算的（之后持仓变了） */
  stale: boolean;
  /** 现在每只的市值：「按现在的市值约」现算用 */
  now: HoldingValues;
  run: () => void;
}

/** 不自动跑：点「开始回放」才取数。结果给卡片和页面上下文（给 AI）共用。 */
export function useScenarioReplay(holdings: Holding[]): ScenarioReplayState {
  const sig = holdingsSig(holdings);
  const [state, setState] = useState<{ sig: string | null; values: HoldingValues; result: ReplayResult | null }>({ sig: null, values: {}, result: null });
  const [loading, setLoading] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const latest = useRef(holdings);
  latest.current = holdings;

  const run = useCallback(() => {
    const hs = latest.current;
    ctl.current?.abort();
    if (!hs.length) { setLoading(false); return; }
    const s = holdingsSig(hs);
    const values = holdingValues(hs);
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    // 没取到现价的那只 value 传 null，工具会把它列进缺口，而不是当 0 算
    const positions = hs.map((h) => ({ symbol: h.code, name: h.name, value: h.market_value }));
    backend.runTool<unknown>("replay", { positions, charts: true }, c.signal)
      .then((out) => {
        if (c.signal.aborted) return;
        const r = parseReplay(out);
        if (r.ok) cache = { sig: s, values, at: Date.now(), result: r };
        setState({ sig: s, values, result: r });
      })
      .catch((e) => { if (!c.signal.aborted) setState({ sig: s, values, result: { ok: false, error: e instanceof ApiError ? e.message : String(e) } }); })
      .finally(() => { if (!c.signal.aborted) setLoading(false); });
  }, []);

  useEffect(() => () => ctl.current?.abort(), []);
  // 持仓是异步取的（刚进页面是空的），所以每次渲染按当前持仓查一次记住的结果，而不是只在第一次渲染时查
  const current = state.result !== null && state.sig === sig && !valuesDrifted(state.values, holdings);
  const remembered = current ? null : cached(sig, holdings);
  // 结果不是按现在的持仓算的：标过期，页面也不再把它交给 AI
  return { result: remembered ?? state.result, loading, stale: !remembered && state.result !== null && !current, now: holdingValues(holdings), run };
}

// 红涨绿跌；没有数是灰色
const tone = (v: number | null) => (v == null ? "text-muted-foreground" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "");
const moneySigned = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`);
const share = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function Tile({ k, v, sub, cls, title }: { k: string; v: string; sub?: string; cls?: string; title?: string }) {
  return (
    <div className="rounded-lg bg-muted/30 p-3" title={title}>
      <p className="text-[11px] text-muted-foreground">{k}</p>
      <p className={cn("mt-0.5 font-mono text-base font-bold", cls)}>{v}</p>
      {sub && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{sub}</p>}
    </div>
  );
}

function GapList({ title, gaps }: { title: string; gaps: { symbol: string; name: string; reason: string }[] }) {
  if (!gaps.length) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-medium">{title}</p>
      <ul className="space-y-0.5 text-[11px] text-muted-foreground">
        {gaps.map((x, i) => <li key={i}><span className="font-mono">{x.name ? `${x.name} ${x.symbol}` : x.symbol}</span>：{x.reason}</li>)}
      </ul>
    </div>
  );
}

function ScenarioDetail({ s, g, hide, now, palette }: { s: ReplayScenario; g: ReplayGroup; hide: boolean; now: HoldingValues; palette: ReturnType<typeof usePalette> }) {
  const option = useMemo(() => replayOption(s, g.benchmarkLabel, palette), [s, g.benchmarkLabel, palette]);
  const p = s.portfolio;
  // 金额按现在的市值现算；有一只现在没有市值就用回放那一刻的金额，并写明（审计第二轮 C2）
  const live = p ? amountAtNow(p.ret, s.holdings.filter((h) => h.weight !== null).map((h) => h.symbol), now) : null;
  const b = s.benchmark;
  return (
    <div className="mb-4 rounded-lg border border-border/60 bg-muted/10 p-3">
      <p className="mb-3 text-sm font-medium">{s.label} <span className="ml-1 text-xs font-normal text-muted-foreground">{s.start} 至 {s.end}</span></p>
      {p ? (
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile k="组合涨跌" v={pctSigned(p.ret)} cls={tone(p.ret)}
            sub={live !== null ? `按现在的市值约 ${hideIf(hide, moneySigned(live))} ${g.currency}` : `按回放时的市值约 ${hideIf(hide, moneySigned(p.valueChange))} ${g.currency}`}
            title="有价格的那部分持仓的市值 × 这段时期的组合涨跌；各只的比例按回放那一刻的市值" />
          <Tile k="期间最大回撤" v={pctSigned(p.maxDrawdown)} cls={tone(p.maxDrawdown)} sub={p.mddPeak && p.mddTrough ? `${p.mddPeak} → ${p.mddTrough}` : undefined} />
          <Tile k="最差单日" v={pctSigned(p.worstDay)} cls={tone(p.worstDay)} sub={p.worstDayDate ?? undefined} />
          <Tile k={`对照：${g.benchmarkLabel}`} v={pctSigned(b?.ret ?? null)} cls={tone(b?.ret ?? null)}
            sub={b ? `期间最大回撤 ${pctSigned(b.maxDrawdown)}` : (s.benchmarkError ?? "没取到")} />
        </div>
      ) : (
        <p className="mb-3 text-xs text-muted-foreground">组合数字没给：{s.portfolioNote ?? "这段时期没有可用的价格"}</p>
      )}
      {p && s.portfolioNote && <p className="mb-2 text-[11px] text-muted-foreground">{s.portfolioNote}</p>}
      {option && (
        <div className="mb-3">
          <EChart option={option} height={240} />
          <p className="text-[11px] text-muted-foreground">两条线都从这段时期第一天的 0% 起步；停牌的日子按停牌前的收盘价算。</p>
        </div>
      )}
      {s.holdings.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">持仓</th>
                {p && <th className="px-2 py-1.5 text-right font-medium" title="在这段时期有价格的几只之间按现在的市值分配">占比</th>}
                <th className="px-2 py-1.5 text-right font-medium">这段涨跌</th>
                {p && <th className="px-2 py-1.5 text-right font-medium" title="占比 × 这段涨跌，加起来等于组合涨跌">对组合的贡献</th>}
                <th className="px-2 py-1.5 font-medium">用到的价格</th>
              </tr>
            </thead>
            <tbody>
              {s.holdings.map((h) => (
                <tr key={h.symbol} className="border-b border-border/30">
                  <td className="px-2 py-1.5">{h.name || h.symbol} <span className="font-mono text-muted-foreground">{h.name ? h.symbol : ""}</span></td>
                  {p && <td className="px-2 py-1.5 text-right font-mono">{share(h.weight)}</td>}
                  <td className={cn("px-2 py-1.5 text-right font-mono", tone(h.ret))}>{pctSigned(h.ret)}</td>
                  {p && <td className={cn("px-2 py-1.5 text-right font-mono", tone(h.contribution))}>{pctSigned(h.contribution)}</td>}
                  <td className="px-2 py-1.5 text-muted-foreground">{h.firstDate} → {h.lastDate}{h.haltedDays > 0 ? `，其间 ${h.haltedDays} 个交易日没有价格（多半停牌）` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <GapList title="这段时期没算进来" gaps={s.gaps} />
    </div>
  );
}

function GroupReplay({ g, hide, now, palette }: { g: ReplayGroup; hide: boolean; now: HoldingValues; palette: ReturnType<typeof usePalette> }) {
  const replayed = g.scenarios.filter((s) => !s.unavailable);
  const [sel, setSel] = useState<string | null>(null);
  const current = replayed.find((s) => s.id === sel) ?? replayed[0] ?? null;
  const th = "px-2 py-2 text-right font-medium";
  return (
    <div className="border-t border-border/40 pt-4 first:border-t-0 first:pt-0">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="font-semibold">{g.label}</h4>
        <span className="text-xs text-muted-foreground">{g.input} 只持仓 · 对照{g.benchmarkLabel} · 点一行看那段时期的走势和各只的贡献</span>
      </div>
      <div className="mb-4 overflow-x-auto">
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
              <th className="px-2 py-2 font-medium">时期</th>
              <th className={th}>组合涨跌</th>
              <th className={th}>期间最大回撤</th>
              <th className={th}>最差单日</th>
              <th className={th}>{g.benchmarkLabel}</th>
              <th className={th} title="这段时期有价格的持仓占这一组现在市值的比例">有价格的持仓</th>
            </tr>
          </thead>
          <tbody>
            {g.scenarios.map((s) => s.unavailable ? (
              <tr key={s.id} className="border-b border-border/30 text-muted-foreground">
                <td className="px-2 py-2">{s.label}<span className="block text-[11px]">{s.start} 至 {s.end}</span></td>
                <td colSpan={5} className="px-2 py-2 text-xs">{s.unavailable}</td>
              </tr>
            ) : (
              <tr key={s.id} onClick={() => setSel(s.id)}
                className={cn("cursor-pointer border-b border-border/30 hover:bg-muted/20", current?.id === s.id && "bg-primary/10")}>
                <td className="px-2 py-2">
                  <button type="button" onClick={() => setSel(s.id)} aria-pressed={current?.id === s.id} className="text-left">
                    {s.label}<span className="block text-[11px] text-muted-foreground">{s.start} 至 {s.end}</span>
                  </button>
                </td>
                <td className={cn("px-2 py-2 text-right font-mono", tone(s.portfolio?.ret ?? null))} title={s.portfolio ? undefined : (s.portfolioNote ?? undefined)}>
                  {pctSigned(s.portfolio?.ret ?? null)}
                </td>
                <td className={cn("px-2 py-2 text-right font-mono", tone(s.portfolio?.maxDrawdown ?? null))}>{pctSigned(s.portfolio?.maxDrawdown ?? null)}</td>
                <td className={cn("px-2 py-2 text-right font-mono", tone(s.portfolio?.worstDay ?? null))}>{pctSigned(s.portfolio?.worstDay ?? null)}</td>
                <td className={cn("px-2 py-2 text-right font-mono", tone(s.benchmark?.ret ?? null))} title={s.benchmark ? undefined : (s.benchmarkError ?? undefined)}>
                  {pctSigned(s.benchmark?.ret ?? null)}
                </td>
                <td className="px-2 py-2 text-right font-mono text-muted-foreground">
                  {s.coverage === null ? "—" : `${Math.round(s.coverage * 100)}%`}
                  <span className="ml-1 font-sans text-[11px]">（{s.included}/{g.input} 只）</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {current && <ScenarioDetail key={current.id} s={current} g={g} hide={hide} now={now} palette={palette} />}
      <div className="space-y-0.5 text-[11px] leading-5 text-muted-foreground">
        {g.notes.map((n) => <p key={n}>{n}</p>)}
        {g.sources.length > 0 && <p>价格来源：{g.sources.join("、")}</p>}
      </div>
    </div>
  );
}

/** 历史情景回放卡：按币种分组，每组一张时期表 + 选中时期的走势、各只贡献、缺口。只说那段时期发生了什么，不预测。 */
export function ScenarioReplayCard({ x, hide }: { x: ScenarioReplayState; hide: boolean }) {
  const palette = usePalette();
  const r = x.result;
  return (
    <section id="scenario-replay" className="mb-4 mt-6 scroll-mt-4">
    <GlassCard>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <History className="h-4 w-4 text-primary" />
        <h3 className="font-semibold">历史情景回放</h3>
        <span className="text-xs text-muted-foreground">按现在的持仓比例回看几段历史大跌期；不预测，也不给买卖提示</span>
        <button onClick={x.run} disabled={x.loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
          {x.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : r ? <RefreshCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {r ? "重新回放" : "开始回放"}
        </button>
      </div>
      {x.loading && (
        <p className="mb-3 text-sm text-muted-foreground">
          正在取每只持仓十几年的日线并回放。A 股要一只一只取（同时取会被数据源挤掉登录），持仓多时要一两分钟…
        </p>
      )}
      {!r && !x.loading && (
        <p className="text-sm text-muted-foreground">
          把现在的持仓按市值比例放回过去几段大跌期（A 股如 2015 年 6–8 月，港股、美股如 2020 年初），看组合那段时间会涨跌多少、最深回撤多少、和大盘比怎样。
          要取多年的历史价格，不会自动运行，点「开始回放」开始。
        </p>
      )}
      {r && x.stale && !x.loading && <p role="status" className="mb-3 text-xs text-warning">持仓变了，下面还是按之前的持仓回放的结果，点「重新回放」更新。</p>}
      {r && !r.ok && <p role="alert" className="text-sm text-muted-foreground">这次回放没做成：{r.error}</p>}
      {r?.ok && (
        <div className="space-y-5">
          {r.view.groups.map((g) => <GroupReplay key={g.currency} g={g} hide={hide} now={x.now} palette={palette} />)}
          {r.view.gaps.length > 0 && (
            <div className="border-t border-border/40 pt-3">
              <GapList title="没有纳入回放" gaps={r.view.gaps} />
            </div>
          )}
        </div>
      )}
    </GlassCard>
    </section>
  );
}
