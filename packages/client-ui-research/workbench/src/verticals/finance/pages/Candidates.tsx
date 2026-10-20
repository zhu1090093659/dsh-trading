import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Filter, Minus, RefreshCw, SearchX, X } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import {
  METRICS, PAGE_SIZE, STATE_META, UNIVERSES, VERDICT_TABS, candidateQuery, formError, parseStoredForm, rowsOfTab,
  type CandidateCheck, type CandidateForm, type CandidateResult, type CheckState, type MetricId, type UniverseId,
} from "@/lib/candidates";
import { shortTime } from "@/lib/chatSources";
import { storageGet, storageSet } from "@/lib/storage";
import { useAiPage } from "../../../core/ai/pageContext";
import { cn } from "@/lib/utils";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";
const INPUT = "w-full min-w-0 rounded-lg border border-border bg-background/60 px-2.5 py-1.5 text-sm tabular-nums";
const FORM_KEY = "vr-candidates-form";
const LEDGER_LINK: Record<string, { to: string; label: string }> = { watch: { to: "/my-stocks?tab=watch", label: "自选股" }, position: { to: "/my-stocks?tab=hold", label: "我的持仓" } };

function StateIcon({ state }: { state: CheckState }) {
  const Icon = state === "met" ? Check : state === "unmet" ? X : Minus;
  return <Icon aria-hidden className="h-3 w-3 shrink-0" />;
}

function CheckCell({ c }: { c: CandidateCheck | undefined }) {
  if (!c) return <td className="px-3 py-2 text-xs text-muted-foreground">—</td>;
  const meta = STATE_META[c.state];
  return <td className="px-3 py-2 align-top">
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] leading-4", meta.tone)}>
      <StateIcon state={c.state} />{meta.label}
    </span>
    <span className="mt-0.5 block whitespace-nowrap text-xs tabular-nums text-muted-foreground">{c.shown}</span>
  </td>;
}

export function Candidates() {
  const [form, setForm] = useState<CandidateForm>(() => parseStoredForm(storageGet(FORM_KEY)));
  const [data, setData] = useState<CandidateResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<CheckState>("met");
  const [shownCount, setShownCount] = useState(PAGE_SIZE);
  const seq = useRef(0);

  const update = (next: CandidateForm) => { setForm(next); storageSet(FORM_KEY, JSON.stringify(next)); };
  const setRange = (id: MetricId, side: "min" | "max", v: string) => update({ ...form, ranges: { ...form.ranges, [id]: { ...form.ranges[id], [side]: v } } });

  const run = useCallback(async (refresh: boolean) => {
    const bad = formError(form);
    if (bad) { setError(bad); return; }
    const my = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const r = await backend.candidates(candidateQuery(form, refresh));
      if (my !== seq.current) return;
      setData(r);
      setShownCount(PAGE_SIZE);
      // 默认停在「全部满足」;那组是空的就停在第一个有内容的组
      setTab(VERDICT_TABS.find((t) => r.counts[t.key] > 0)?.key ?? "met");
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [form]);

  const rows = useMemo(() => (data ? rowsOfTab(data.rows, tab) : []), [data, tab]);
  const shown = rows.slice(0, shownCount);

  useAiPage({
    key: "candidates",
    title: "候选池",
    context: data
      ? `候选池(只排除、不排名;按代码排列):范围 ${data.universe.label} 共 ${data.universe.size} 只`
        + `${data.universe.as_of ? `,成分文件日期 ${data.universe.as_of}` : ""}(${data.universe.source});行情来自${data.quotes.source}${data.quotes.fetched_at ? `,取于 ${data.quotes.fetched_at}` : ""}。\n`
        + `条件:${data.conditions.map((c) => c.label).join(";")}\n`
        + `全部满足 ${data.counts.met} 只,有缺数据 ${data.counts.missing} 只,有不满足 ${data.counts.unmet} 只。\n`
        + (["met", "missing"] as const).map((k) => {
          const list = rowsOfTab(data.rows, k).slice(0, 80);
          return list.length ? `${k === "met" ? "全部满足" : "有缺数据"}${list.length < data.counts[k] ? `(前 ${list.length} 只)` : ""}:\n`
            + list.map((r) => `${r.symbol} ${r.name}:${r.checks.map((c) => `${c.id}=${c.shown}(${STATE_META[c.state].label})`).join(",")}`).join("\n") : "";
        }).filter(Boolean).join("\n")
        + (data.gaps.length ? `\n没取到:${data.gaps.join(";")}` : "")
      : "候选池:还没有核对结果。",
    suggestions: ["哪一条条件排除的最多", "缺数据的几只分别缺什么"],
  });

  return <div>
    <PageHeader title="候选池"
      subtitle="在自选、持仓或某个指数的成分股里,按你设的条件逐只核对:每一条都写明满足、不满足还是缺数据。只排除、不排名,不打分、不给买卖建议。"
      actions={data ? <button type="button" onClick={() => void run(true)} disabled={loading} className={BTN}><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />{loading ? "取数中…" : "重新取行情"}</button> : undefined} />

    <GlassCard className="mb-5">
      <form onSubmit={(e) => { e.preventDefault(); if (!loading) void run(false); }} className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1.5">
            <span className="block text-xs text-muted-foreground">范围</span>
            <select value={form.universe} onChange={(e) => update({ ...form, universe: e.target.value as UniverseId })}
              className="rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
              {UNIVERSES.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
          <p className="pb-2 text-[11px] text-muted-foreground">指数成分取自中证 / 国证指数官网的成分文件;自选和持仓只核对 A 股。</p>
        </div>

        <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
          {METRICS.map((m) => <fieldset key={m.id} className="min-w-0">
            <legend className="mb-1.5 text-xs text-muted-foreground">{m.label}<span className="ml-1 text-muted-foreground/70">({m.unit})</span>{m.hint && <span className="ml-1.5 text-[11px] text-muted-foreground/70">{m.hint}</span>}</legend>
            <div className="flex items-center gap-2">
              <input type="text" inputMode="decimal" aria-label={`${m.label}下限`} placeholder="不限" value={form.ranges[m.id].min}
                onChange={(e) => setRange(m.id, "min", e.target.value)} className={INPUT} />
              <span className="shrink-0 text-xs text-muted-foreground">到</span>
              <input type="text" inputMode="decimal" aria-label={`${m.label}上限`} placeholder="不限" value={form.ranges[m.id].max}
                onChange={(e) => setRange(m.id, "max", e.target.value)} className={INPUT} />
            </div>
          </fieldset>)}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.excludeSt} onChange={(e) => update({ ...form, excludeSt: e.target.checked })} />排除 ST / *ST / 退市整理</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.excludeHalted} onChange={(e) => update({ ...form, excludeHalted: e.target.checked })} />排除当天没有成交的(停牌)</label>
          <button type="submit" disabled={loading}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary ring-1 ring-primary/30 hover:bg-primary/25 disabled:opacity-50">
            <Filter className="h-4 w-4" />{loading ? "核对中…" : "开始核对"}
          </button>
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">两头都可以只填一头;区间包含边界。没取到的值单独算「缺数据」,既不算满足也不算不满足。</p>
      </form>
    </GlassCard>

    {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
    {loading && !data && <p role="status" className="mb-4 text-sm text-muted-foreground">正在取数…指数成分股要分批取行情,第一次可能要十几秒到半分钟。</p>}

    {data && <div className="space-y-5">
      <GlassCard>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {VERDICT_TABS.map((t) => <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => { setTab(t.key); setShownCount(PAGE_SIZE); }}
            className={cn("rounded-full border px-3 py-1 text-xs", tab === t.key ? "border-primary/50 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground")}>
            {t.label} {data.counts[t.key]}
          </button>)}
        </div>
        <p className="mb-1 text-xs text-muted-foreground">
          {data.universe.label} 共 {data.universe.size} 只{data.universe.as_of ? `(成分文件日期 ${data.universe.as_of},${data.universe.source})` : `(${data.universe.source})`}
          {data.universe.size > 0 && <>{" · "}行情:{data.quotes.source}{data.quotes.fetched_at ? `,取于 ${shortTime(data.quotes.fetched_at)}(北京时间)${data.quotes.cached ? ",用的是缓存" : ""}` : ",这次没取到"}</>}
        </p>
        <p className="mb-4 text-xs text-muted-foreground">按代码排列,不排名。「全部满足」只说明过了你设的这几条,不是选股结论。</p>

        {rows.length === 0
          ? <p className="py-6 text-center text-sm text-muted-foreground">
            {data.universe.size > 0 ? "这一组没有。" : `${data.universe.label}里没有可以核对的 A 股。`}
            {data.universe.size === 0 && LEDGER_LINK[data.universe.id] && <>可以先去 <Link to={LEDGER_LINK[data.universe.id]!.to} className="text-primary hover:underline">{LEDGER_LINK[data.universe.id]!.label}</Link> 加几只。</>}
            {data.gaps.length ? "下面有没取到的,请一并看。" : ""}
          </p>
          : <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-normal">代码</th>
                  <th scope="col" className="px-3 py-2 font-normal">简称</th>
                  {data.conditions.map((c) => <th key={c.id} scope="col" className="px-3 py-2 font-normal">{c.label}</th>)}
                  <th scope="col" className="px-3 py-2 font-normal"><span className="sr-only">去研究</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => <tr key={r.symbol} className="border-b border-border/30 last:border-0">
                  <td className="px-3 py-2 align-top font-mono text-xs">{r.symbol}</td>
                  <td className="whitespace-nowrap px-3 py-2 align-top">{r.name || "—"}</td>
                  {data.conditions.map((c) => <CheckCell key={c.id} c={r.checks.find((x) => x.id === c.id)} />)}
                  <td className="px-3 py-2 align-top"><Link to={`/research?symbol=${encodeURIComponent(r.symbol)}`} className="whitespace-nowrap text-xs text-primary hover:underline">去研究</Link></td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        {rows.length > shown.length && <div className="mt-3 text-center">
          <button type="button" onClick={() => setShownCount((n) => n + PAGE_SIZE)} className={BTN}>再显示 {Math.min(PAGE_SIZE, rows.length - shown.length)} 只(这一组共 {rows.length} 只)</button>
        </div>}
      </GlassCard>

      <GlassCard>
        <h2 className="mb-2 text-sm font-semibold">条件和来源</h2>
        <ul className="space-y-1 text-xs text-muted-foreground">{data.conditions.map((c) => <li key={c.id}>{c.label}:{c.source}</li>)}</ul>
      </GlassCard>

      {data.gaps.length > 0 && <GlassCard>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><SearchX className="h-4 w-4 text-muted-foreground" />没取到的({data.gaps.length})</h2>
        <p className="mb-2 text-[11px] text-muted-foreground">没取到的不算「不满足」,也不代表真的不符合。</p>
        <ul className="space-y-1 text-xs text-muted-foreground">{data.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
      </GlassCard>}
    </div>}
  </div>;
}
