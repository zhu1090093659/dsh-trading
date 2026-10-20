import { useState } from "react";
import { Link } from "react-router-dom";
import { CalendarRange, Loader2 } from "lucide-react";

import { ApiError, backend } from "@/lib/backend";
import { addNote } from "@/lib/notes";
import { WEEKLY_MAX, WEEK_DAYS, weeklyCompareMarkdown, weeklyGroups, type RunCompareResult } from "@/lib/runCompareView";
import { statusText } from "./RunCompareCard";

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
type State = { kind: "idle" } | { kind: "busy"; text: string } | { kind: "saved"; count: number } | { kind: "empty"; text: string } | { kind: "error"; text: string };

/**
 * 「本周对比周报」：把近 7 天被两家以上 Agent 研究过的股票，各自的研究过程对比汇成一份，存进本机的研究记录。
 * 🔴 只存本机，不发到任何地方。存成功了才说「已存」（写失败要看得见）。
 */
export function WeeklyCompareButton() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function make() {
    setState({ kind: "busy", text: "正在找本周的研究…" });
    try {
      const now = Date.now();
      const groups = weeklyGroups(await backend.runs(200), now);
      const picked = groups.slice(0, WEEKLY_MAX);
      const sections: { label: string; res: RunCompareResult }[] = [];
      const failed: string[] = [];
      for (const [i, g] of picked.entries()) {
        setState({ kind: "busy", text: `正在对比第 ${i + 1} / ${picked.length} 只：${g.label}` });
        try { sections.push({ label: g.label, res: await backend.runCompare(g.run_id) }); } catch (e) { failed.push(`${g.label}（${errText(e)}）`); }
      }
      const out = weeklyCompareMarkdown(sections, now, statusText, { skipped: groups.length - picked.length, failed });
      if (!out) {
        setState(failed.length
          ? { kind: "error", text: `没对比出来：${failed.join("；")}` }
          : { kind: "empty", text: `近 ${WEEK_DAYS} 天还没有哪只股票被两家以上 Agent 研究过（测试运行不算）。打开一份报告，在「各次研究过程对比」里可以请另一家 Agent 再研究一次。` });
        return;
      }
      await addNote("研究对比", out.title, out.markdown);
      setState({ kind: "saved", count: out.count });
    } catch (e) {
      setState({ kind: "error", text: `周报没生成：${errText(e)}` });
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={() => void make()} disabled={state.kind === "busy"}
        title={`把近 ${WEEK_DAYS} 天被两家以上 Agent 研究过的股票汇成一份对比，存进研究记录（只在本机）`}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
        {state.kind === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarRange className="h-3.5 w-3.5" />}本周对比周报
      </button>
      {state.kind === "busy" && <p role="status" className="text-[11px] text-muted-foreground">{state.text}</p>}
      {state.kind === "saved" && <p role="status" className="text-[11px] text-primary">已存进<Link to="/notes" className="underline">研究记录</Link>：{state.count} 只股票（只在本机）</p>}
      {state.kind === "empty" && <p role="status" className="max-w-sm text-right text-[11px] text-muted-foreground">{state.text}</p>}
      {state.kind === "error" && <p role="alert" className="max-w-sm text-right text-[11px] text-destructive">{state.text}</p>}
    </div>
  );
}
