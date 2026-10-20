import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, RefreshCw } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import {
  MOVE_RULE, PAST_ONLY, amountText, consensusRange, daysText, forecastText, moveText, publishedText, reactionLine, surpriseText,
  type EarningsBriefResult,
} from "@/lib/earningsBrief";
import { shortTime } from "@/lib/chatSources";
import { cn } from "@/lib/utils";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";
const BOX = "rounded-lg border border-border/50 px-3 py-2.5";

/**
 * 个股页:财报前瞻与复盘。查到的主体变了就重新取(竞态守卫:慢请求回来时已经换了票就丢掉)。
 * `onData` 把结果交给页面拼「问 Agent」的上下文。数字照抄 calc 的 display,不用红绿(这里不是行情涨跌的颜色位)。
 */
export function EarningsBriefCard({ symbol, onData }: { symbol: string; onData: (r: EarningsBriefResult | null) => void }) {
  const [data, setData] = useState<EarningsBriefResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const my = ++seq.current;
    setLoading(true);
    setError("");
    if (!refresh) { setData(null); onData(null); }
    try {
      const r = await backend.earningsBrief({ symbol, refresh });
      if (my !== seq.current) return;
      setData(r);
      onData(r);
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [symbol, onData]);

  useEffect(() => {
    void load(false);
    return () => { seq.current++; };
  }, [load]);

  const up = data?.upcoming;
  const c = data?.consensus;
  return <GlassCard className="mb-4">
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-primary" /> 财报前瞻与复盘</h3>
      <button type="button" onClick={() => void load(true)} disabled={loading} className={BTN} title="不用缓存,全部重新取">
        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> 重新取
      </button>
    </div>
    <p className="mb-3 text-xs leading-5 text-muted-foreground">
      下一份财报什么时候出、市场预期多少;过去几次财报出来后第一个交易日涨跌多少、实际和预期差多少。{PAST_ONLY}。
    </p>

    {error && <p role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
    {loading && !data && <p role="status" className="py-3 text-sm text-muted-foreground">正在取财报日、预期和日 K…</p>}

    {data && <>
      {(up || c || data.forecast) && <div className="mb-4 grid gap-3 md:grid-cols-3">
        {up && <div className={BOX}>
          <p className="text-[11px] text-muted-foreground">下一份财报</p>
          <p className="mt-0.5 text-sm font-medium leading-5">{up.label}</p>
          <p className="font-mono text-base font-bold tabular-nums">{up.date}</p>
          {up.days !== null && <p className="text-xs text-muted-foreground">{daysText(up.days)}</p>}
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{up.note}</p>
        </div>}
        {c && <div className={BOX}>
          <p className="text-[11px] text-muted-foreground">{c.label}</p>
          <p className="mt-0.5 font-mono text-base font-bold tabular-nums">{c.mean}{c.unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{c.unit}</span>}</p>
          <p className="text-xs tabular-nums text-muted-foreground">区间 {consensusRange(c)}</p>
          {c.dispersion?.status === "ok" && c.dispersion.display && <p className="text-xs text-muted-foreground">最高 ÷ 最低 {c.dispersion.display}(越大分歧越大)</p>}
          {c.revenue_mean !== null && <p className="text-xs text-muted-foreground">营收预期均值 {amountText(c.revenue_mean, c.unit)}</p>}
        </div>}
        {data.forecast && <div className={BOX}>
          <p className="text-[11px] text-muted-foreground">业绩预告(下一期)</p>
          <p className="mt-0.5 text-sm leading-5">{forecastText(data.forecast)}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">公司自己公布的预告,以公告为准</p>
        </div>}
      </div>}

      {data.history.length > 0 && <>
        <h4 className="mb-1 text-xs font-semibold">过去几次财报</h4>
        <div className="-mx-2 overflow-x-auto">
          {/* 最后一列(实际和预期)可以折行;窄屏整表横向滚动 */}
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                {["报告期", "发布", "反应日", "当天涨跌", "实际和预期"].map((h) => <th key={h} scope="col" className="whitespace-nowrap px-2 py-2 font-normal">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.history.map((h) => <tr key={h.id} className="border-b border-border/30 last:border-0">
                <td className="whitespace-nowrap px-2 py-2 align-top font-medium">{h.id}</td>
                <td className="whitespace-nowrap px-2 py-2 align-top text-xs text-muted-foreground">{publishedText(h, data.market)}</td>
                <td className="whitespace-nowrap px-2 py-2 align-top font-mono text-xs tabular-nums">
                  {h.reaction_day ?? "—"}
                  {h.merged.length > 0 && <span className="block font-sans text-[11px] text-muted-foreground">和 {h.merged.join("、")} 同一天</span>}
                </td>
                <td className="whitespace-nowrap px-2 py-2 align-top font-mono tabular-nums" title={h.move?.reason || undefined}>{moveText(h)}</td>
                <td className="px-2 py-2 align-top text-xs leading-5 text-foreground/85">{h.surprise ? surpriseText(h.surprise) : <span className="text-muted-foreground">—</span>}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {data.reaction && <p className="mt-2 text-xs leading-5 text-foreground/85">{reactionLine(data.reaction)}</p>}
        {data.intraday && <p className="mt-1 text-[11px] text-warning">最近一次的反应日就是今天、还没收盘:涨跌按最新价,收盘后会变。</p>}
      </>}

      {data.gaps.length > 0 && <div className="mt-4">
        <h4 className="mb-1 text-xs font-semibold">没取到的</h4>
        <ul className="space-y-1 text-xs text-muted-foreground">{data.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
      </div>}
      <p className="mt-3 text-[11px] leading-4 text-muted-foreground/80">
        来源:{data.sources.join("、")}{data.fetched_at && <> · 取于 {shortTime(data.fetched_at)}(北京时间){data.cached ? ",用的是缓存" : ""}</>}。
        {MOVE_RULE};财报日以公司公告为准。
      </p>
    </>}
  </GlassCard>;
}
