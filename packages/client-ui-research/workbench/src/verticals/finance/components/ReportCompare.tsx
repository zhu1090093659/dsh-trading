import { useEffect, useRef, useState } from "react";
import { GitCompare } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError, type AlertDiff, type RunListItem } from "@/lib/backend";
import { comparableRuns, defaultPeer, diffReports, fieldLabel, ordered, showValue, type SectionDiff } from "@/lib/reportDiff";
import { STATUS as RUN_STATUS } from "./ResearchRunItem";
import { cn } from "@/lib/utils";

type ReportResult = Awaited<ReturnType<typeof backend.report>>;

/** 三种变化分开说:糊成「有变化」会让「这条事实不见了」被读成噪音 */
const KIND_CN: Record<AlertDiff["kind"], string> = { changed: "变了", added: "新增", removed: "消失" };
const SEC_CN: Record<SectionDiff["status"], string> = { changed: "改了", added: "新增", removed: "删掉", same: "没变" };
const OPS_MAX = 60;
/** 找同一家公司以前的研究时取的归档条数(后端上限)。页面上的归档列表只有最近 30 条,不够用来判断「只有这一次」 */
const ALL_MAX = 500;
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const when = (r: RunListItem) => (r.finished_at ?? r.started_at ?? "").slice(0, 16).replace("T", " ");
/** 公告是一条条标题,和数字放一起会把数字变化淹掉:单独折叠 */
const isNotice = (d: AlertDiff) => d.field === "announcement_title";

interface Result { diffs: AlertDiff[] | null; diffsErr: string; sections: SectionDiff[] | null; reportNote: string }

function DataRow({ d }: { d: AlertDiff }) {
  return <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/30 py-1.5 text-sm last:border-0">
    {/* 红涨绿跌:这里的颜色只分种类,不用红绿 */}
    <span className={d.kind === "removed" ? "rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning"
      : d.kind === "added" ? "rounded bg-primary/15 px-1.5 py-0.5 text-[11px] text-primary" : "rounded bg-muted/60 px-1.5 py-0.5 text-[11px]"}>{KIND_CN[d.kind]}</span>
    <span className="font-medium" title={d.field}>{fieldLabel(d.field)}</span>
    <span className="text-xs text-muted-foreground">{d.base && d.next && d.base.period !== d.next.period ? `${d.base.period} → ${d.next.period}` : d.period}</span>
    {/* 两侧各挂自己的证据 id:一条变化要能追回两边分别出自哪条证据 */}
    <span className="ml-auto font-mono text-xs">
      <span title={d.base?.id ? `证据 ${d.base.id} · ${d.base.source}${d.base.as_of ? ` · ${d.base.as_of}` : ""}` : "这一侧没有(新增项)"}
        className={d.base?.id ? "cursor-help underline decoration-dotted underline-offset-2" : undefined}>{d.base ? showValue(d.base.value, d.unit) : "—"}</span>
      <span className="mx-1 text-muted-foreground">→</span>
      <span title={d.next?.id ? `证据 ${d.next.id} · ${d.next.source}${d.next.as_of ? ` · ${d.next.as_of}` : ""}` : "这一侧没有(这次消失)"}
        className={d.next?.id ? "cursor-help underline decoration-dotted underline-offset-2" : undefined}>{d.next ? showValue(d.next.value, d.unit) : "—"}</span>
    </span>
  </div>;
}

function SectionRow({ s }: { s: SectionDiff }) {
  const head = <>
    <span className={cn("rounded px-1.5 py-0.5 text-[11px]", s.status === "same" ? "bg-muted/40 text-muted-foreground"
      : s.status === "removed" ? "bg-warning/15 text-warning" : s.status === "added" ? "bg-primary/15 text-primary" : "bg-muted/60")}>{SEC_CN[s.status]}</span>
    <span className={cn("font-medium", s.status === "same" && "text-muted-foreground")}>{s.title}</span>
    {s.status !== "same" && <span className="text-xs text-muted-foreground">{s.added ? `+${s.added} 行` : ""}{s.added && s.removed ? " " : ""}{s.removed ? `−${s.removed} 行` : ""}</span>}
  </>;
  if (s.status === "same" || !s.ops.length) return <li className="flex flex-wrap items-baseline gap-2 py-1 text-sm">{head}</li>;
  return <li className="py-1 text-sm">
    <details>
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-2">{head}</summary>
      <ul className="mt-1.5 space-y-1 border-l border-border/60 pl-3 text-xs leading-relaxed">
        {s.ops.slice(0, OPS_MAX).map((o, i) => <li key={i} className={o.op === "add" ? "text-foreground" : "text-muted-foreground"}>
          <span className={cn("mr-1.5 inline-block w-3 font-mono", o.op === "add" ? "text-primary" : "text-muted-foreground")} aria-label={o.op === "add" ? "新版" : "旧版"}>{o.op === "add" ? "+" : "−"}</span>{o.text}
        </li>)}
        {s.ops.length > OPS_MAX && <li className="text-muted-foreground">还有 {s.ops.length - OPS_MAX} 行没列出</li>}
      </ul>
    </details>
  </li>;
}

/**
 * 同一家公司两次研究的对比:关键数据逐条对齐(沿用变化提醒的同源同口径对齐),报告按章节逐行比。
 * 🔴 只有一次研究时要说「还没有可比较的第二次」,不能显示成「没有变化」。
 */
export function ReportCompare({ current, runs, report }: { current: RunListItem; runs: RunListItem[]; report: ReportResult }) {
  // 自己取一份更长的归档列表;到之前先用页面那 30 条。页面列表刷新(删了 / 新跑了)时跟着重取
  const [all, setAll] = useState<RunListItem[] | null>(null);
  const [allErr, setAllErr] = useState("");
  useEffect(() => {
    let alive = true;
    backend.runs(ALL_MAX).then((r) => { if (alive) { setAll(r); setAllErr(""); } }, (e) => { if (alive) setAllErr(errText(e)); });
    return () => { alive = false; };
  }, [current.run_id, runs]);
  const peers = comparableRuns(current, all ?? runs);
  const [peerId, setPeerId] = useState<string | null>(() => defaultPeer(current, peers));
  const [result, setResult] = useState<Result | null>(null);
  const seq = useRef(0);
  // 归档列表晚到或刷新后,选中的那次不在了就退回默认那次
  const peer = peers.find((p) => p.run_id === peerId) ?? peers.find((p) => p.run_id === defaultPeer(current, peers)) ?? null;
  const peerKey = peer?.run_id ?? "";

  useEffect(() => {
    if (!peer || !current.symbol) return;
    const my = ++seq.current;
    setResult(null);
    const [older, newer] = ordered(current, peer);
    void Promise.allSettled([backend.alerts(current.symbol, current.market ?? undefined, older.run_id, newer.run_id), backend.report(peer.run_id)]).then(([a, p]) => {
      if (my !== seq.current) return;
      const text = (r: ReportResult | null) => (r?.availability === "ready" && r.report ? r.report : null);
      const byId = new Map<string, string | null>([[current.run_id, text(report)], [peer.run_id, p.status === "fulfilled" ? text(p.value) : null]]);
      const missing = [older, newer].filter((r) => !byId.get(r.run_id)).map((r) => `${when(r)} 那次`);
      // 取报告失败 ≠ 那次没有通过校验的报告:分开说
      const peerErr = p.status === "rejected" ? errText(p.reason) : "";
      setResult({
        diffs: a.status === "fulfilled" ? a.value.diffs : null,
        diffsErr: a.status === "rejected" ? `关键数据没比成:${errText(a.reason)}` : "",
        sections: peerErr || missing.length ? null : diffReports(byId.get(older.run_id)!, byId.get(newer.run_id)!),
        reportNote: peerErr ? `${when(peer)} 那次的报告这次没取到(${peerErr}),报告部分没比;关键数据照常比较。`
          : missing.length ? `${missing.join("、")}没有通过校验的报告,报告部分没法比;关键数据照常比较。` : "",
      });
    });
    // report 换了(重新打开同一次)也要重比
  }, [current.run_id, peerKey, report.report]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!peers.length) {
    return <GlassCard className="mb-4">
      <div className="mb-1 flex items-center gap-2"><GitCompare className="h-4 w-4 text-primary" /><h3 className="font-semibold">和另一次研究比较</h3></div>
      <p className="text-sm text-muted-foreground">{allErr ? `以前的研究列表没取到(${allErr}),没法确定有没有可以比较的那一次。`
        : !all ? "正在找这家公司以前的研究…"
        : all.length >= ALL_MAX ? `最近 ${ALL_MAX} 次研究里,这家公司只有这一次 —— 再跑一次才能比较「变了什么」。`
        : "这家公司还只有这一次研究 —— 再跑一次才能比较「变了什么」。"}</p>
    </GlassCard>;
  }
  const [older, newer] = peer ? ordered(current, peer) : [current, current];
  const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  return <GlassCard className="mb-4">
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex items-center gap-2"><GitCompare className="h-4 w-4 text-primary" /><h3 className="font-semibold">和另一次研究比较</h3></span>
      <label className="flex min-w-0 max-w-full items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0">对比</span>
        <select value={peer?.run_id ?? ""} onChange={(e) => setPeerId(e.target.value)} className="min-w-0 max-w-full truncate rounded-lg border border-border bg-background/60 px-2 py-1 text-xs text-foreground">
          {peers.map((p) => <option key={p.run_id} value={p.run_id}>{when(p)}{p.status === "complete" ? "" : `(${(p.status && RUN_STATUS[p.status]) || p.status || "状态未知"})`} · {p.run_id}</option>)}
        </select>
      </label>
    </div>
    <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
      旧 {when(older)}({older.run_id})→ 新 {when(newer)}({newer.run_id})。只并列两次写了什么,不解读涨跌;证据和计算编号每次都会重新生成,比较时已经忽略。
    </p>
    {!result ? <p className="text-sm text-muted-foreground">正在比较…</p> : <div className="space-y-4">
      <section>
        <h4 className="mb-1.5 flex flex-wrap items-baseline gap-2 text-sm font-medium">关键数据
          {result.diffs && <span className="text-xs font-normal text-muted-foreground">变了 {count(result.diffs, (d) => !isNotice(d) && d.kind === "changed")} · 新增 {count(result.diffs, (d) => !isNotice(d) && d.kind === "added")} · 消失 {count(result.diffs, (d) => !isNotice(d) && d.kind === "removed")}</span>}
        </h4>
        {result.diffsErr && <p className="text-xs text-destructive">{result.diffsErr}</p>}
        {result.diffs && (() => {
          const nums = result.diffs.filter((d) => !isNotice(d));
          const notices = result.diffs.filter(isNotice);
          return <>
            {nums.length === 0
              ? <p className="text-sm text-muted-foreground">股价、估值、财务、一致预期等数字两次之间没有变化。</p>
              : <div>{nums.slice(0, 40).map((d, i) => <DataRow key={`${d.key}-${i}`} d={d} />)}
                {nums.length > 40 && <p className="pt-1 text-xs text-muted-foreground">还有 {nums.length - 40} 条没列出</p>}</div>}
            {notices.length > 0 && <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">公告:新增 {count(notices, (d) => d.kind === "added")} 条、消失 {count(notices, (d) => d.kind === "removed")} 条(两次取到的公告范围不同也会出现在这里)</summary>
              <ul className="mt-1.5 space-y-1 border-l border-border/60 pl-3 text-xs">
                {notices.slice(0, OPS_MAX).map((d, i) => <li key={`${d.key}-${i}`} className={d.kind === "removed" ? "text-muted-foreground" : undefined}>
                  <span className="mr-2 font-mono text-muted-foreground">{(d.next ?? d.base)?.period}</span>{d.kind === "removed" ? "(这次没有)" : ""}{String((d.next ?? d.base)?.value ?? "")}
                </li>)}
                {notices.length > OPS_MAX && <li className="text-muted-foreground">还有 {notices.length - OPS_MAX} 条没列出</li>}
              </ul>
            </details>}
          </>;
        })()}
      </section>
      <section>
        <h4 className="mb-1.5 flex flex-wrap items-baseline gap-2 text-sm font-medium">报告各章节
          {result.sections && <span className="text-xs font-normal text-muted-foreground">改了 {count(result.sections, (s) => s.status === "changed")} · 新增 {count(result.sections, (s) => s.status === "added")} · 删掉 {count(result.sections, (s) => s.status === "removed")} · 没变 {count(result.sections, (s) => s.status === "same")}</span>}
        </h4>
        {result.reportNote && <p className="text-xs text-muted-foreground">{result.reportNote}</p>}
        {result.sections && <>
          <p className="mb-1 text-[11px] text-muted-foreground">报告由模型撰写,措辞每次会有出入;点开一节看具体哪几行不一样(− 旧版,+ 新版)。</p>
          <ul className="divide-y divide-border/30">{result.sections.map((s, i) => <SectionRow key={`${s.title}-${i}`} s={s} />)}</ul>
        </>}
      </section>
    </div>}
  </GlassCard>;
}
