import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CalendarDays, RefreshCw, SearchX } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { backend, ApiError } from "@/lib/backend";
import { GROUP_LABEL, KIND_META, dayLabel, groupByDate, type CalendarEvent, type CalendarResult, type EventGroup } from "@/lib/calendar";
import { storageGet, storageSet } from "@/lib/storage";
import { shortTime } from "@/lib/chatSources";
import type { VerdictResult } from "@/lib/verdicts";
import { VerdictPanel } from "@/components/ui/VerdictPanel";
import { useAiPage } from "../../../core/ai/pageContext";
import { cn } from "@/lib/utils";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";
const GROUPS: EventGroup[] = ["company", "ledger", "macro"];
const DAY_OPTIONS = [{ key: "7", label: "7 天" }, { key: "30", label: "30 天" }, { key: "90", label: "90 天" }] as const;
type Days = (typeof DAY_OPTIONS)[number]["key"];

/** 显示哪几类:默认公司事件 + 我的台账;宏观要自己打开(条目多,会把自选的事淹掉) */
function readGroups(): Set<EventGroup> {
  const raw = storageGet("vr-calendar-groups");
  const picked = raw ? raw.split(",").filter((g): g is EventGroup => (GROUPS as string[]).includes(g)) : ["company", "ledger"] as EventGroup[];
  return new Set(picked);
}

function EventRow({ e }: { e: CalendarEvent }) {
  const meta = KIND_META[e.kind];
  return <li className="flex flex-col gap-1 rounded-xl border border-border/50 p-3 sm:flex-row sm:items-start sm:gap-3">
    <span className={cn("w-fit shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] leading-4", meta.tone)}>{meta.label}</span>
    <div className="min-w-0 flex-1">
      <p className="text-sm">
        {e.symbol && <span className="mr-1.5 font-medium">{e.name || e.symbol}<span className="ml-1 font-mono text-xs text-muted-foreground">{e.name ? e.symbol : ""}</span></span>}
        {/* 宏观的 name 是国家;标题本身以国家开头时(「美国10年期国债拍卖」)不再重复 */}
        {!e.symbol && e.kind === "macro" && e.name && !e.title.startsWith(e.name) && <span className="mr-1.5 text-xs text-muted-foreground">{e.name}</span>}
        <span>{e.title}</span>
        {e.estimated && <span className="ml-1.5 rounded border border-warning/40 px-1 text-[10px] text-warning">预估</span>}
      </p>
      {e.detail.length > 0 && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{e.detail.join(" · ")}</p>}
    </div>
    <span className="shrink-0 text-[11px] leading-5 text-muted-foreground/70 sm:text-right">{e.source}{e.fetched_at && <span className="block">{shortTime(e.fetched_at)} 取</span>}</span>
  </li>;
}

export function Calendar() {
  const [days, setDays] = useState<Days>(() => (DAY_OPTIONS.some((o) => o.key === storageGet("vr-calendar-days")) ? storageGet("vr-calendar-days") as Days : "30"));
  const [groups, setGroups] = useState<Set<EventGroup>>(readGroups);
  const [data, setData] = useState<CalendarResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const [verdicts, setVerdicts] = useState<VerdictResult | null>(null);
  const [vErr, setVErr] = useState("");
  const vSeq = useRef(0);

  const loadVerdicts = useCallback(async (refresh: boolean) => {
    const my = ++vSeq.current;
    try {
      const r = await backend.verdicts({ refresh });
      if (my === vSeq.current) { setVerdicts(r); setVErr(""); }
    } catch (e) {
      if (my === vSeq.current) setVErr(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void loadVerdicts(false); }, [loadVerdicts]);

  const load = useCallback(async (refresh: boolean) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      // 宏观每次都取(没打开时也取),切换显示不用再等一轮
      const r = await backend.calendar({ days: Number(days), refresh });
      if (my === seq.current) { setData(r); setError(""); }
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [days]);
  useEffect(() => { void load(false); }, [load]);

  const toggleGroup = (g: EventGroup) => setGroups((prev) => {
    const next = new Set(prev);
    if (next.has(g)) next.delete(g); else next.add(g);
    storageSet("vr-calendar-groups", [...next].join(","));
    return next;
  });

  // 判过 / 改回待判后两边都重取:时间轴里的裁决点和过期卡片也要跟着变(走缓存,很快)
  const afterVerdict = useCallback(() => { void loadVerdicts(false); void load(false); }, [loadVerdicts, load]);
  // 到期没判的判据在下面的「到期的判据」里逐条标记,这里只留论点、待办和过了预约日的定期报告
  const overdueOther = useMemo(() => (data?.overdue ?? []).filter((e) => e.kind !== "criterion"), [data]);

  const shown = useMemo(() => (data?.events ?? []).filter((e) => groups.has(KIND_META[e.kind].group)), [data, groups]);
  const counts = useMemo(() => Object.fromEntries(GROUPS.map((g) => [g, (data?.events ?? []).filter((e) => KIND_META[e.kind].group === g).length])) as Record<EventGroup, number>, [data]);
  const byDate = useMemo(() => groupByDate(shown), [shown]);

  useAiPage({
    key: "calendar",
    title: "事件日历",
    context: data
      ? `事件日历 ${data.window.from} 到 ${data.window.to}(北京时间):\n`
        + [...(verdicts?.due ?? []).map((v) => `到期判据(${v.due},${v.type === "falsifier" ? "证伪条件" : "裁决点"}) ${v.name || ""}${v.symbol ? `(${v.symbol})` : ""}:${v.statement}\n  ${v.since} 以来公告:${v.facts.length ? `共 ${v.facts_total} 条,最近的:${v.facts.map((f) => `${f.date} ${f.title}`).join(";")}${v.facts_note ? `(${v.facts_note})` : ""}` : v.facts_note || "无"}`),
          ...overdueOther.map((e) => `已过期未处理 ${e.date} ${e.name || e.symbol || ""} ${e.title} ${e.detail.join(";")}`),
          ...data.events.filter((e) => e.kind !== "macro").slice(0, 60).map((e) => `${e.date} ${e.name || ""}${e.symbol ? `(${e.symbol})` : ""} ${e.title} ${e.detail.join(";")} [${e.source}]`)].join("\n")
        + (data.gaps.length ? `\n没取到:${data.gaps.join(";")}` : "")
      : "事件日历:还没取到。",
    suggestions: ["未来两周我要回来看哪几件事", "对照公告,把到期判据的相关事实列给我"],
  });

  const today = data?.window.from ?? "";
  const noSymbols = data && data.symbols.length === 0;
  return <div>
    <PageHeader title="事件日历"
      subtitle="自选和持仓接下来的公司事件,加上你在台账里写的裁决点、复核日和待办,排成一条时间轴。只列来源给的日期,不打分、不给买卖建议。"
      actions={<>
        <SegmentedToggle label="看多少天" value={days} options={[...DAY_OPTIONS]} onChange={(v) => { setDays(v); storageSet("vr-calendar-days", v); }} disabled={loading} />
        <button type="button" onClick={() => { void load(true); void loadVerdicts(true); }} disabled={loading} className={BTN}><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />{loading ? "取数中…" : "重新取数"}</button>
      </>} />

    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">显示:</span>
      {GROUPS.map((g) => <button key={g} type="button" aria-pressed={groups.has(g)} onClick={() => toggleGroup(g)}
        className={cn("rounded-full border px-3 py-1", groups.has(g) ? "border-primary/50 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground")}>
        {GROUP_LABEL[g]}{data ? ` ${counts[g]}` : ""}
      </button>)}
      {data && <span className="ml-auto text-muted-foreground/80">{data.window.from} 至 {data.window.to}(北京时间)· 自选和持仓共 {data.symbols.length} 只</span>}
    </div>

    {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">正在取数…第一次要逐只查,自选多时需要十几秒到半分钟。</p>}

    {data && <div className="space-y-5">
      {noSymbols && <GlassCard><p className="text-sm text-muted-foreground">自选和持仓都是空的,只能显示台账里的日子{groups.has("macro") ? "和宏观日历" : ""}。可以先去 <Link to="/my-stocks?tab=watch" className="text-primary hover:underline">自选股</Link> 加几只。</p></GlassCard>}

      <VerdictPanel data={verdicts} error={vErr} onChanged={afterVerdict} />

      {overdueOther.length > 0 && <GlassCard className="border-warning/40">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-warning" />已经过了日子、还没处理({overdueOther.length})</h2>
        <ul className="space-y-2">{overdueOther.map((e, i) => <li key={`${e.ref ?? e.symbol}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <span className="font-mono text-xs text-warning">{e.date}</span>
          <span className="w-full sm:w-auto sm:flex-1"><EventInline e={e} /></span>
        </li>)}</ul>
        <p className="mt-3 text-[11px] text-muted-foreground">论点原文在个股研究页可以看到;过了预约日的定期报告以公司公告为准。</p>
      </GlassCard>}

      <GlassCard>
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold"><CalendarDays className="h-4 w-4 text-primary" />时间轴</h2>
        {byDate.length === 0
          ? <p className="py-6 text-center text-sm text-muted-foreground">{groups.size === 0 ? "上面一类都没选。" : `这 ${data.window.days} 天里,选中的几类没有查到事件。`}{data.gaps.length > 0 ? "下面有没取到的来源,不代表那几只没有事件。" : ""}</p>
          : <ol className="space-y-5">{byDate.map((d) => {
            const lab = dayLabel(d.date, today);
            return <li key={d.date}>
              <p className="mb-2 flex items-baseline gap-2 text-sm"><span className="font-medium">{lab.main}</span><span className={cn("text-xs", lab.rel === "今天" || lab.rel === "明天" ? "text-primary" : "text-muted-foreground")}>{lab.rel}</span></p>
              <ul className="space-y-2">{d.items.map((e, i) => <EventRow key={`${e.kind}-${e.symbol}-${e.ref ?? ""}-${i}`} e={e} />)}</ul>
            </li>;
          })}</ol>}
      </GlassCard>

      {data.gaps.length > 0 && <GlassCard>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><SearchX className="h-4 w-4 text-muted-foreground" />没查到的({data.gaps.length})</h2>
        <p className="mb-2 text-[11px] text-muted-foreground">这些来源这次没取到或没有来源,时间轴上没有它们的事件不代表真的没有。</p>
        <ul className="space-y-1 text-xs text-muted-foreground">{data.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
      </GlassCard>}
    </div>}
  </div>;
}

function EventInline({ e }: { e: CalendarEvent }) {
  return <>
    <span className={cn("mr-1.5 rounded border px-1 text-[10px]", KIND_META[e.kind].tone)}>{KIND_META[e.kind].label}</span>
    {e.symbol && <span className="mr-1 font-medium">{e.name || e.symbol}</span>}
    <span>{e.title}</span>
    {e.detail[0] && <span className="ml-1.5 text-xs text-muted-foreground">{e.detail.join(" · ")}</span>}
    {e.fetched_at && <span className="ml-1.5 text-[11px] text-muted-foreground/70">{e.source} · {shortTime(e.fetched_at)} 取</span>}
  </>;
}
