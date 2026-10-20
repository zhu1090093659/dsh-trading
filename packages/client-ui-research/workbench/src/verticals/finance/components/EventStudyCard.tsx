import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarSearch, Loader2, Play, RefreshCw } from "lucide-react";

import { EChart } from "@/components/ui/EChart";
import { GlassCard } from "@/components/ui/GlassCard";
import { usePalette } from "@/components/ui/chartPalette";
import { ApiError, backend } from "@/lib/backend";
import { EVENT_BENCHMARK, eventDateLabel, eventFlags, eventKindsFor, eventOption, parseEvents, summaryRows, type EventKind, type EventResult, type EventView } from "@/lib/eventStudyView";
import { marketOfSymbol } from "@/lib/marketSymbol";
import { pctSigned } from "@/lib/perfView";
import { cn } from "@/lib/utils";

/** 要取公告和多年日线，只在点按钮时跑；同一只、同一类事件半小时内记住结果，换票再换回来不用重跑。 */
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; result: EventResult }>();
const keyOf = (symbol: string, kind: EventKind) => `${symbol}|${kind}`;
const cached = (k: string) => {
  const c = cache.get(k);
  return c && Date.now() - c.at < CACHE_MS ? c.result : null;
};
/** 逐次列表先显示这么多行，其余点「显示全部」 */
const FIRST_ROWS = 10;

export interface EventStudyData { symbol: string; result: EventResult }

// 红涨绿跌；没有数是灰色
const tone = (v: number | null) => (v == null ? "text-muted-foreground" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "");
const share = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

function Summary({ v }: { v: EventView }) {
  const { rows, sameAsAll } = summaryRows(v);
  if (!rows.length) return null;
  const th = "px-2 py-2 text-right font-medium";
  return (
    <div className="mb-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
              <th className="px-2 py-2 font-medium">累计超额收益</th>
              {v.horizons.map((h) => <th key={h.key} className={th}>{h.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.key} className="border-b border-border/30 align-top">
                <td className="px-2 py-2">{g.label}<span className="block text-[11px] text-muted-foreground">{g.events} 次</span></td>
                {v.horizons.map((h) => {
                  const s = g.horizons[h.key];
                  return s && s.mean !== null ? (
                    <td key={h.key} className="px-2 py-2 text-right">
                      <span className={cn("font-mono font-semibold", tone(s.mean))}>{pctSigned(s.mean)}</span>
                      <span className="block text-[11px] text-muted-foreground">中位 {pctSigned(s.median)} · 上涨 {share(s.positiveShare)} · {s.n} 次</span>
                    </td>
                  ) : (
                    <td key={h.key} className="px-2 py-2 text-right text-[11px] text-muted-foreground" title={`少于 ${v.minEvents} 次不给平均`}>
                      不给平均<span className="block">能算 {s?.n ?? 0} 次</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">每格是平均值；「上涨」是这一档超额收益大于 0 的次数占比。</p>
      {sameAsAll.map((g) => <p key={g.key} className="text-[11px] text-muted-foreground">这 {g.events} 次全部是{g.label}，所以没有单列这一组。</p>)}
      {rows.filter((g) => g.note).map((g) => <p key={g.key} className="text-[11px] text-muted-foreground">{g.label}：{g.note}</p>)}
    </div>
  );
}

function EventTable({ v }: { v: EventView }) {
  const [all, setAll] = useState(false);
  const rows = all ? v.events : v.events.slice(0, FIRST_ROWS);
  const th = "px-2 py-1.5 text-right font-medium";
  return (
    <div className="mb-3">
      <p className="mb-1 text-xs font-medium">逐次结果（新的在前）</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
              <th className="px-2 py-1.5 font-medium">{eventDateLabel(v.kind)}</th>
              <th className="px-2 py-1.5 font-medium">事件</th>
              {v.horizons.map((h) => <th key={h.key} className={th}>{h.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const flags = eventFlags(e, v.post);
              return (
                <tr key={e.day0} className="border-b border-border/30 align-top">
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono">
                    {e.date}
                    {e.day0 !== e.date && <span className="block font-sans text-[11px] text-muted-foreground">第 0 天 {e.day0}</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    {e.label}
                    <span className="block text-[11px] leading-4 text-muted-foreground">{e.detail}</span>
                    {flags.map((f) => <span key={f} className="block text-[11px] leading-4 text-warning">{f}</span>)}
                  </td>
                  {v.horizons.map((h) => {
                    const x = e.values[h.key] ?? null;
                    return <td key={h.key} className={cn("px-2 py-1.5 text-right font-mono", tone(x))}>{pctSigned(x)}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {v.events.length > FIRST_ROWS && (
        <button type="button" onClick={() => setAll((x) => !x)} className="mt-1 text-xs text-primary hover:underline">
          {all ? "收起" : `显示全部 ${v.events.length} 次`}
        </button>
      )}
    </div>
  );
}

/** 已经排期、还没到的（限售解禁）：放在最上面，只列日期和规模，不算涨跌 */
function Upcoming({ v }: { v: EventView }) {
  if (!v.upcoming.length) return null;
  return (
    <div className="mb-4 rounded-lg border border-border/60 px-3 py-2">
      <p className="mb-1 text-xs font-medium">已经排期、还没到的{v.kindLabel}</p>
      <ul className="space-y-0.5 text-xs">
        {v.upcoming.map((u) => (
          <li key={u.date}><span className="font-mono">{u.date}</span> <span className="text-muted-foreground">{u.detail}</span></li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted-foreground">还没发生，只列出来，不算涨跌；排期以公司公告为准，可能调整。</p>
    </div>
  );
}

function Result({ v }: { v: EventView }) {
  const palette = usePalette();
  const option = useMemo(() => eventOption(v.path, palette), [v.path, palette]);
  return (
    <div>
      <Upcoming v={v} />
      {v.events.length > 0 && <Summary v={v} />}
      {option && v.path && (
        <div className="mb-4">
          <EChart option={option} height={220} />
          <p className="text-[11px] text-muted-foreground">
            窗口完整、没有停牌的 {v.path.n} 次，从事件前第 {v.pre} 个交易日起累计的超额收益，每天取平均和中位数；横轴是相对第 0 天的交易日。
          </p>
        </div>
      )}
      {v.events.length > 0 && <EventTable key={`${v.symbol}|${v.kind}`} v={v} />}
      {v.gaps.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-medium">没有算进来</p>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            {v.gaps.map((g, i) => <li key={i}>{g.date ? <span className="font-mono">{g.date} </span> : null}{g.label}：{g.reason}</li>)}
          </ul>
        </div>
      )}
      <div className="space-y-0.5 text-[11px] leading-5 text-muted-foreground">
        {v.notes.map((n) => <p key={n}>{n}</p>)}
        {v.sources.length > 0 && <p>数据来源：{v.sources.join("、")}</p>}
      </div>
    </div>
  );
}

/**
 * 个股页：事件回看。选一类事件，列这只股票历史上每一次事件前后相对大盘对照的累计超额收益和各档平均。
 * A 股三类公告（对照沪深300）；港股、美股只有业绩公布（对照盈富基金 / SPY）。
 * 不自动跑；`onData` 把结果交给页面拼「问 Agent」的上下文。只描述过去，不预测，不给买卖提示。
 */
export function EventStudyCard({ symbol, onData }: { symbol: string; onData: (d: EventStudyData | null) => void }) {
  const market = marketOfSymbol(symbol);
  const kinds = eventKindsFor(market);
  const [picked, setKind] = useState<EventKind>("earnings_forecast");
  // 从 A 股换到港美股时，上次选的类型可能这个市场没有，就用这个市场的第一类
  const kind = kinds.some((x) => x.key === picked) ? picked : kinds[0]?.key ?? picked;
  const bench = market ? EVENT_BENCHMARK[market] : "大盘";
  const k = keyOf(symbol, kind);
  const [state, setState] = useState<{ key: string | null; result: EventResult | null }>({ key: null, result: null });
  const [loading, setLoading] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);

  // 换了票：正在跑的那次作废（慢请求回来时已经不是这只了）
  useEffect(() => () => { ctl.current?.abort(); setLoading(null); }, [symbol]);

  const run = useCallback(() => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    const key = keyOf(symbol, kind);
    setLoading(key);
    backend.runTool<unknown>("events", { symbol, kind, charts: true }, c.signal)
      .then((out) => {
        if (c.signal.aborted) return;
        const r = parseEvents(out);
        if (r.ok) cache.set(key, { at: Date.now(), result: r });
        setState({ key, result: r });
      })
      .catch((e) => { if (!c.signal.aborted) setState({ key, result: { ok: false, error: e instanceof ApiError ? e.message : String(e) } }); })
      .finally(() => { if (!c.signal.aborted) setLoading(null); });
  }, [symbol, kind]);

  // 每次渲染按当前这只、这类事件查一次：先看这次会话里刚跑出的，再看记住的
  const result = state.key === k ? state.result : cached(k);
  useEffect(() => { onData(result ? { symbol, result } : null); }, [symbol, result, onData]);

  const busy = loading === k;
  return (
    <GlassCard className="mb-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><CalendarSearch className="h-4 w-4 text-primary" /> 事件回看</h3>
        <span className="text-xs text-muted-foreground">这只股票过去每次{market === "CN" ? "事件" : "发业绩"}前后，相对{bench}多涨或少涨了多少</span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="事件类型" className="flex min-w-0 flex-wrap rounded-lg border border-border/60 p-0.5">
          {kinds.map((x) => (
            <button key={x.key} type="button" onClick={() => setKind(x.key)} aria-pressed={kind === x.key}
              className={cn("rounded-md px-2.5 py-1 text-xs", kind === x.key ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {x.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={run} disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : result ? <RefreshCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {result ? "重新回看" : "开始回看"}
        </button>
      </div>
      {busy && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {market === "US" ? "正在翻这只股票的 SEC 申报、再取多年日线，大约要半分钟到一分钟…" : "正在取这只股票的历次记录和多年日线，大约要十几秒到一分钟…"}
        </p>
      )}
      {!result && !busy && (
        <p className="text-sm text-muted-foreground">
          {market === "CN"
            ? "选一类事件（业绩预告、股东增减持、回购方案、机构调研、龙虎榜上榜、限售解禁），列出这只股票历史上每一次事件前 5 个交易日到后 20 个交易日、相对沪深300指数的累计超额收益（限售解禁还会列出已经排期的），"
            : market === "HK"
              ? "按港交所披露易的业绩公告（末期、中期、季度），列出这只股票每次发业绩前 5 个交易日到后 20 个交易日、相对盈富基金的累计超额收益（16:00 收市后发的从下一个交易日算），"
              : "按 SEC 8-K 里的业绩公布（Item 2.02），列出这只股票每次发业绩前 5 个交易日到后 20 个交易日、相对 SPY 的累计超额收益（外国公司用 6-K 报业绩，取不到），"}
          次数够 8 次再给平均。要取多年数据，不会自动运行，点「开始回看」开始。只描述过去，不代表下一次。
        </p>
      )}
      {result && !result.ok && <p role="alert" className="text-sm text-muted-foreground">这次回看没做成：{result.error}</p>}
      {result?.ok && <Result v={result.view} />}
    </GlassCard>
  );
}
