import { useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardCheck, History } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import { TYPE_LABEL, judgedRecord, reopenedRecord, verdictLabel, type Verdict, type VerdictItem, type VerdictResult } from "@/lib/verdicts";
import { shortTime } from "@/lib/chatSources";
import { cn } from "@/lib/utils";

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const BTN = "rounded-lg border border-border/60 px-2.5 py-1 text-xs hover:text-foreground disabled:opacity-50";

function who(symbol: string | null, name: string) {
  if (!symbol) return null;
  return <span className="mr-1.5 font-medium">{name || symbol}{name && <span className="ml-1 font-mono text-xs text-muted-foreground">{symbol}</span>}</span>;
}

/** 公告的取数时间(北京时间):不点「重新取数」时用的是两小时内的快照,要让人看得见是几点的 */
const fetchedText = (it: VerdictItem) => (it.facts_fetched_at ? `${shortTime(it.facts_fetched_at)} 取` : "");

function DueRow({ it, today, onSaved }: { it: VerdictItem; today: string; onSaved: () => void }) {
  const [choice, setChoice] = useState<Verdict | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const labels = TYPE_LABEL[it.type];

  const save = async () => {
    if (!choice) return;
    setBusy(true); setErr("");
    try {
      await backend.ledgerSave("criterion", judgedRecord(it.record, choice, note, today));
      onSaved();
    } catch (e) { setErr(`没存上:${errText(e)}`); } finally { setBusy(false); }
  };

  return <li className="rounded-xl border border-border/50 p-3">
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="rounded-md border border-primary/50 px-1.5 py-0.5 text-[11px] leading-4 text-primary">{labels.label}</span>
      {who(it.symbol, it.name)}
      <span className="text-xs text-muted-foreground">到期 {it.due}{it.overdue_days > 0 ? ` · 过了 ${it.overdue_days} 天` : " · 今天到期"}</span>
      {it.thesis && <span className="text-xs text-muted-foreground">· 论点:{it.thesis}</span>}
    </p>
    <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">{it.statement}</p>

    {/* 一条公告都没有时不做折叠:「0 条」和「没有来源 / 没取到」要直接看得见,别藏在点开之后 */}
    {it.facts.length === 0
      ? <p className="mt-2 text-xs text-muted-foreground">{it.facts_source ? `${it.since} 以来:` : ""}{it.facts_note}{it.facts_source && <span className="text-muted-foreground/70"> · {[it.facts_source, fetchedText(it)].filter(Boolean).join(" · ")}</span>}</p>
      : <details className="mt-2 text-xs" open={it.facts.length <= 5}>
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{it.since} 以来的公司公告 {it.facts_total} 条</summary>
        <ul className="mt-1.5 space-y-1 border-l border-border/60 pl-3">
          {it.facts.map((f, i) => <li key={`${f.date}-${i}`}><span className="mr-2 font-mono text-muted-foreground">{f.date}</span>{f.title}</li>)}
        </ul>
        <p className="mt-1.5 text-[11px] text-muted-foreground/80">{[it.facts_total > it.facts.length ? `只列最近 ${it.facts.length} 条` : "", it.facts_note, it.facts_source, fetchedText(it)].filter(Boolean).join(" · ")}</p>
      </details>}

    {!choice
      ? <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="标记这条判据">
        <button type="button" className={cn(BTN, "text-foreground")} onClick={() => setChoice("met")}>{labels.met}</button>
        <button type="button" className={cn(BTN, "text-foreground")} onClick={() => setChoice("broken")}>{labels.broken}</button>
        <button type="button" className={cn(BTN, "text-muted-foreground")} onClick={() => setChoice("dropped")}>不再跟踪</button>
      </div>
      : <div className="mt-3 space-y-2">
        <label className="block text-xs text-muted-foreground">
          标记为「{verdictLabel(it.type, choice)}」,写一句依据(可不填)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2}
            className="mt-1 w-full rounded-lg border border-border/60 bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/60" />
        </label>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void save()} className={cn(BTN, "border-primary/50 bg-primary/10 text-primary")}>{busy ? "保存中…" : "确认"}</button>
          <button type="button" disabled={busy} onClick={() => { setChoice(null); setErr(""); }} className={cn(BTN, "text-muted-foreground")}>取消</button>
        </div>
      </div>}
    {err && <p role="alert" className="mt-2 text-xs text-destructive">{err}</p>}
  </li>;
}

/** 到期的判据 + 校准表。数据由页面取,标记后调 onChanged 让页面重取 */
export function VerdictPanel({ data, error, onChanged }: { data: VerdictResult | null; error: string; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState("");

  if (error) return <GlassCard><p role="alert" className="text-xs text-destructive">判据回看没取到:{error}</p></GlassCard>;
  if (!data) return null;

  const reopen = async (id: string, record: VerdictResult["judged"][number]["record"]) => {
    setBusyId(id); setErr("");
    try { await backend.ledgerSave("criterion", reopenedRecord(record)); onChanged(); }
    catch (e) { setErr(`没改成:${errText(e)}`); } finally { setBusyId(null); }
  };

  const total = data.calibration.reduce((n, r) => n + r.met + r.broken + r.dropped + r.due_unjudged + r.upcoming + r.no_due, 0);
  return <>
    {data.due.length > 0 && <GlassCard className="border-primary/30">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><ClipboardCheck className="h-4 w-4 text-primary" />到期的判据({data.due.length})</h2>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">到了你写的日子。下面列出写下以来的公司公告,对照后自己标记;只记兑现与否,不算涨跌。</p>
      <ul className="space-y-3">{data.due.map((it) => <DueRow key={it.id} it={it} today={data.today} onSaved={onChanged} />)}</ul>
      {data.gaps.length > 0 && <p className="mt-3 text-[11px] text-muted-foreground">{data.gaps.join(";")}</p>}
    </GlassCard>}

    <GlassCard>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-muted-foreground" />判据回看</h2>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">只数你写的判据有没有兑现,不算涨跌、不算胜率。</p>
      {total === 0
        ? <p className="text-sm text-muted-foreground">还没有判据。在 <Link to="/research" className="text-primary hover:underline">个股研究</Link> 页选一只股票,「概览」最下面的「我的论点与判据」里写一条带到期日的裁决点,到期时这里和「提醒」会告诉你。</p>
        : <div className="grid gap-3 sm:grid-cols-2">{data.calibration.map((r) => {
          const cells: [string, number][] = [[r.met_label, r.met], [r.broken_label, r.broken], ["不再跟踪", r.dropped], ["到期没判", r.due_unjudged], ["还没到期", r.upcoming], ["没写到期日", r.no_due]];
          return <div key={r.type} className="rounded-xl border border-border/50 p-3">
            <p className="mb-2 text-xs font-medium">{r.label}</p>
            <dl className="grid grid-cols-3 gap-2 text-center">{cells.map(([k, v]) => <div key={k} className="flex flex-col-reverse rounded-lg bg-muted/30 px-1 py-1.5">
              <dt className="text-[11px] text-muted-foreground">{k}</dt><dd className="text-base font-semibold tabular-nums">{v}</dd>
            </div>)}</dl>
          </div>;
        })}</div>}

      {data.judged.length > 0 && <div className="mt-4">
        <p className="mb-2 text-xs text-muted-foreground">最近判过的</p>
        <ul className="space-y-2">{data.judged.map((j) => <li key={j.id} className="flex flex-col gap-1 border-b border-border/30 pb-2 text-sm last:border-0 sm:flex-row sm:items-baseline sm:gap-3">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{j.judged_at || "日期没记"}</span>
          <span className="min-w-0 flex-1">
            <span className="mr-1.5 rounded border border-border px-1 text-[11px] text-muted-foreground">{TYPE_LABEL[j.type].label}·{verdictLabel(j.type, j.status)}</span>
            {who(j.symbol, j.name)}<span>{j.statement}</span>
            {j.verdict_note && <span className="mt-0.5 block text-xs text-muted-foreground">依据:{j.verdict_note}</span>}
          </span>
          <button type="button" disabled={busyId === j.id} onClick={() => void reopen(j.id, j.record)} className={cn(BTN, "shrink-0 self-start text-muted-foreground")}>改回待判</button>
        </li>)}</ul>
      </div>}
      {err && <p role="alert" className="mt-2 text-xs text-destructive">{err}</p>}
    </GlassCard>
  </>;
}
