import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import {
  DIR_LABEL, TRIGGER_LABEL, levelText, levelTone, limitText, reachedWhen, ruleLine, showPair, splitRows,
  type AbnormalResult, type AbnormalRow, type Crit,
} from "@/lib/abnormal";
import { shortTime } from "@/lib/chatSources";
import { cn } from "@/lib/utils";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";

function CritCell({ c, when }: { c: Crit; when: string }) {
  return <td className="px-2 py-2 align-top">
    <span className={cn("block whitespace-nowrap font-mono text-xs tabular-nums", c.reached ? "text-warning" : "text-foreground/90")}>{showPair(c)}</span>
    <span className="block whitespace-nowrap text-[11px] text-muted-foreground">{c.reached ? `${when === "今天" ? when : `${when.slice(5)} `}已达到` : `标准 ${limitText(c)}`}</span>
  </td>;
}

function Row({ r, res }: { r: AbnormalRow; res: AbnormalResult }) {
  const p = r.result!;
  const when = reachedWhen(p, res);
  return <tr className="border-b border-border/30 last:border-0">
    <td className="px-2 py-2 align-top">
      <span className="block whitespace-nowrap font-medium">{r.name || "—"}</span>
      <span className="block whitespace-nowrap font-mono text-[11px] text-muted-foreground">{r.symbol} · {r.board_label}</span>
      {p.notes.map((n) => <span key={n} className="block text-[11px] text-muted-foreground/80">{n}</span>)}
    </td>
    <CritCell c={p.abnormal} when={when} />
    <CritCell c={p.severe10} when={when} />
    <CritCell c={p.severe30} when={when} />
    <td className="whitespace-nowrap px-2 py-2 align-top text-xs text-muted-foreground">
      向上 {p.same_dir.up} · 向下 {p.same_dir.down}
      <span className="block text-[11px]">第 {p.same_dir.need} 次构成严重</span>
    </td>
    <td className="px-2 py-2 align-top">
      <span className={cn("inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] tabular-nums", levelTone(p.level))}>{levelText(p.level)}</span>
    </td>
  </tr>;
}

/**
 * 自选页:异动接近度。后端自己读台账里的自选,这里只在自选里的 A 股变了时重新取(防抖,等台账写完)。
 * `onData` 把结果交给页面拼「问 Agent」的上下文。
 */
export function AbnormalCard({ codes, onData }: { codes: string[]; onData: (r: AbnormalResult | null) => void }) {
  const [data, setData] = useState<AbnormalResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);
  const cnKey = codes.filter((c) => /^\d{6}$/.test(c)).join(",");

  const load = useCallback(async (refresh: boolean) => {
    const my = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const r = await backend.abnormal({ refresh });
      if (my !== seq.current) return;
      setData(r);
      onData(r);
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [onData]);

  useEffect(() => {
    if (!cnKey) { seq.current++; setData(null); setError(""); setLoading(false); onData(null); return; }
    const t = setTimeout(() => void load(false), 800);
    return () => clearTimeout(t);
  }, [cnKey, load, onData]);

  if (!cnKey) return null;
  const parts = data ? splitRows(data.rows) : null;
  const recent = data ? data.rows.flatMap((r) => (r.result?.recent ?? []).map((t) => ({ r, t }))).sort((a, b) => b.t.date.localeCompare(a.t.date)) : [];

  return <GlassCard className="mt-4">
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 font-semibold"><Gauge className="h-4 w-4 text-primary" /> 异动接近度</h3>
      <button type="button" onClick={() => void load(true)} disabled={loading} className={BTN} title="不用缓存,重新取日 K">
        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> 重新取
      </button>
    </div>
    <p className="mb-3 text-xs leading-5 text-muted-foreground">
      自选里的 A 股离交易所「异常波动 / 严重异常波动」标准还有多远:累计涨跌幅减去基准指数的同期涨跌幅,和标准比。
      按公开规则推算,<span className="text-foreground/80">以交易所公告为准</span>;只看离标准多远,不判断方向、不预测。
    </p>

    {error && <p role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
    {loading && !data && <p role="status" className="py-4 text-sm text-muted-foreground">正在取日 K 推算…每只一次,自选多的话要十几秒。</p>}

    {data && parts && <>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {data.as_of ? <>截至 {data.as_of}{data.intraday ? " · 盘中按最新价估算,收盘后才是正式口径" : " 收盘"}</> : "这次没有算出来的"}
        {data.fetched_at && <> · 日 K 取于 {shortTime(data.fetched_at)}(北京时间){data.cached ? ",用的是缓存" : ""}</>}
      </p>

      {parts.shown.length + parts.folded.length > 0 && <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
              {["名称", "3 日累计偏离", "10 日", "30 日", "10 日内同向异常波动", "离标准"].map((h) => <th key={h} scope="col" className="whitespace-nowrap px-2 py-2 font-normal">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {parts.shown.map((r) => <Row key={r.symbol} r={r} res={data} />)}
            {open && parts.folded.map((r) => <Row key={r.symbol} r={r} res={data} />)}
          </tbody>
        </table>
      </div>}
      {parts.shown.length === 0 && parts.folded.length > 0 && !open && <p className="py-2 text-xs text-muted-foreground">算出来的 {parts.folded.length} 只离标准都不到一半。</p>}
      {parts.folded.length > 0 && <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn(BTN, "mt-2")}>
        {open ? "收起不到一半的" : `展开其余 ${parts.folded.length} 只(离标准都不到一半)`}
      </button>}

      {recent.length > 0 && <div className="mt-4">
        <h4 className="mb-1 text-xs font-semibold">最近 30 个交易日按规则推算达到过的</h4>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {recent.map(({ r, t }) => <li key={`${r.symbol}-${t.date}-${t.kind}`}>
            <span className="text-foreground/90">{r.name ? `${r.name} ` : ""}{r.symbol}</span> · {t.date} {TRIGGER_LABEL[t.kind]}({DIR_LABEL[t.dir]}):{t.why}
          </li>)}
        </ul>
      </div>}

      {parts.skipped.length > 0 && <div className="mt-4">
        <h4 className="mb-1 text-xs font-semibold">没算出来的({parts.skipped.length})</h4>
        <ul className="space-y-1 text-xs text-muted-foreground">{parts.skipped.map((r) => <li key={r.symbol}>{r.name ? `${r.name} ` : ""}{r.symbol}:{r.skipped}</li>)}</ul>
      </div>}

      {data.gaps.length > 0 && <div className="mt-4">
        <h4 className="mb-1 text-xs font-semibold">没算的</h4>
        <ul className="space-y-1 text-xs text-muted-foreground">{data.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
      </div>}

      {data.rules.length > 0 && <details className="mt-4 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">标准和来源</summary>
        <ul className="mt-2 space-y-1">{data.rules.map((r) => <li key={r.board}>{ruleLine(r)}</li>)}</ul>
        <p className="mt-2">「N 个交易日内」指截至当天、长度 1 到 N 天的任一区间;达到后交易所公告,从次一交易日起重新计算,停牌的从复牌日起算;新股上市初期没有涨跌幅限制的几天不算。日 K 用前复权价。</p>
        <p className="mt-1">来源:{data.source}</p>
      </details>}
    </>}
  </GlassCard>;
}
