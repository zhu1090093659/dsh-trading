import { useState } from "react";
import { Link } from "react-router-dom";
import { Columns3, Loader2, UserPlus } from "lucide-react";

import { GlassCard } from "@/components/ui/GlassCard";
import { ApiError, backend, type LocalAgentStatus, type RunListItem } from "@/lib/backend";
import {
  COMPARE_BASIS, ROWS, SCOPE, agentChoices, compareMarkdown, compareNotes, engineDetail, engineName, scopeOf, when,
  type AgentChoice, type RunCompareResult,
} from "@/lib/runCompareView";
import { STATUS as RUN_STATUS } from "./ResearchRunItem";
import { SaveNoteButton } from "./ui/SaveNoteButton";
import { cn } from "@/lib/utils";

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
export const statusText = (s: string | null) => (s && RUN_STATUS[s]) || s || "状态未知";

/** 并排表格（单独拆出来方便测试）。不标最好、不按好坏上色 */
export function RunCompareTable({ res }: { res: RunCompareResult }) {
  const notes = compareNotes(res);
  return (
    <>
      {notes.length > 0 && (
        <ul className="mb-3 space-y-1 text-xs text-muted-foreground">
          {notes.map((n) => <li key={n}>· {n}</li>)}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border/60 align-bottom">
              <th scope="col" className="sticky left-0 min-w-[9rem] max-w-[12rem] bg-card py-2 pr-3 text-left font-normal text-muted-foreground">研究过程</th>
              {res.runs.map((r) => (
                <th key={r.run_id} scope="col" title={`运行标识：${r.run_id}`} className={cn("whitespace-nowrap px-3 py-2 text-left font-normal", r.run_id === res.run_id && "bg-primary/5")}>
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    {engineName(r.engine)}
                    {r.run_id === res.run_id && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">这次</span>}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">{when(r.started_at)}</span>
                  <span className="block text-[11px] text-muted-foreground">{statusText(r.status)}</span>
                  <span className="block max-w-[10rem] truncate text-[10px] text-muted-foreground/70" title={engineDetail(r.engine)}>{engineDetail(r.engine)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label} className="border-b border-border/30 last:border-0">
                <th scope="row" className="sticky left-0 min-w-[9rem] max-w-[12rem] bg-card py-1.5 pr-3 text-left font-normal">
                  <span className="text-foreground">{row.label}</span>
                  {row.hint && <span className="block text-[10px] text-muted-foreground">{row.hint}</span>}
                </th>
                {res.runs.map((r) => (
                  <td key={r.run_id} className={cn("whitespace-nowrap px-3 py-1.5 font-mono tabular-nums", r.run_id === res.run_id && "bg-primary/5")}>{row.value(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * 「各次研究过程对比」：同一家公司的几次研究（换一家 Agent 再跑就有了）并排看取数、引用、数字核对、缺口。
 * 只在点按钮时读（要把每次的报告数字重新对一遍）。
 *
 * `onRunWith` 给了，对比出来后列出本机已登录的订阅 Agent，一键请它用同样的取数范围再研究这只
 * （只这一次用它，不改「接入 AI」里的设置）；`researchBusy` = 页面上已有一次研究在跑，跑完才能再开。
 */
export function RunCompareCard({ current, onRunWith, researchBusy = false }: {
  current: RunListItem;
  onRunWith?: (provider: string, endpoints: "core" | "full") => Promise<void>;
  researchBusy?: boolean;
}) {
  const [res, setRes] = useState<RunCompareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [agents, setAgents] = useState<LocalAgentStatus[] | null>(null);
  const [agentsErr, setAgentsErr] = useState("");
  const [launch, setLaunch] = useState<{ state: "starting" | "started" | "failed"; text: string } | null>(null);

  async function load() {
    setBusy(true); setErr("");
    try { setRes(await backend.runCompare(current.run_id)); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    if (onRunWith) backend.localAgents().then((a) => { setAgents(a); setAgentsErr(""); }, (e) => setAgentsErr(errText(e)));
  }

  const label = current.name ? `${current.name}（${current.symbol ?? current.run_id}）` : current.symbol ?? current.run_id;
  async function runWith(c: AgentChoice, scope: "core" | "full") {
    if (!onRunWith) return;
    if (!window.confirm(`用 ${c.name} 再研究一次 ${label}？\n\n取数范围沿用这次的「${SCOPE[scope]}」。会用掉它的订阅额度，可能要几十分钟；不改你在「接入 AI」里的设置。`)) return;
    setLaunch({ state: "starting", text: `正在请 ${c.name} 开始…` });
    try {
      await onRunWith(c.provider, scope);
      setLaunch({ state: "started", text: `已经开始：${c.name} 在研究 ${label}，进度在页面上方。跑完回到这里点「重新对比」。` });
    } catch (e) {
      setLaunch({ state: "failed", text: `没有开始：${errText(e)}` });
    }
  }

  return (
    <GlassCard className="mb-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 font-semibold"><Columns3 className="h-4 w-4 text-primary" /> 各次研究过程对比</h3>
        <button type="button" onClick={() => void load()} disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{res ? "重新对比" : "对比"}
        </button>
        {res && <SaveNoteButton key={res.runs.map((r) => r.run_id).join(",")} kind="研究对比" title={`${label} 各次研究过程对比`} content={compareMarkdown(res, statusText)} />}
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        把这家公司的几次研究并排：取了多少资料、实际引用多少、报告数字对不对得上、写出了哪些缺口。{COMPARE_BASIS}
      </p>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      {res && <RunCompareTable res={res} />}
      {res && onRunWith && (
        <AskAnother res={res} agents={agents} agentsErr={agentsErr} launch={launch} researchBusy={researchBusy}
          onPick={(c) => void runWith(c, scopeOf(res))} />
      )}
    </GlassCard>
  );
}

/** 「请另一家 Agent 也研究这只」：只列本机已登录可用的订阅 Agent；没有就说去哪登录（单独拆出来方便测试） */
export function AskAnother({ res, agents, agentsErr, launch, researchBusy, onPick }: {
  res: RunCompareResult; agents: LocalAgentStatus[] | null; agentsErr: string;
  launch: { state: "starting" | "started" | "failed"; text: string } | null; researchBusy: boolean;
  onPick: (c: AgentChoice) => void;
}) {
  const choices = agents ? agentChoices(agents, res) : [];
  const scope = scopeOf(res);
  return (
    <div className="mt-4 border-t border-border/40 pt-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground"><UserPlus className="h-3.5 w-3.5 text-primary" /> 请另一家 Agent 也研究这只</p>
      {agentsErr ? <p className="text-xs text-destructive">没查到本机有哪些 Agent：{agentsErr}</p>
        : agents === null ? <p className="text-xs text-muted-foreground">正在查本机已登录的 Agent…</p>
        : choices.length === 0 ? (
          <p className="text-xs leading-5 text-muted-foreground">
            本机没有已登录的订阅 Agent（Codex / Claude Code / WorkBuddy）。到<Link to="/settings" className="text-primary hover:underline">「接入 AI」</Link>登录一家，这里就能一键请它再研究；
            用 API 的话，在「接入 AI」换一个模型，再点页面上方的「开始」。
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {choices.map((c) => (
              <button key={c.provider} type="button" onClick={() => onPick(c)} disabled={researchBusy || launch?.state === "starting"}
                className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20 disabled:opacity-50">
                用 {c.name} 研究{c.count > 0 && <span className="ml-1 text-muted-foreground">（表里已有 {c.count} 次）</span>}
              </button>
            ))}
          </div>
        )}
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        取数范围沿用这次的「{SCOPE[scope]}」；用那家订阅的额度，只这一次，不改「接入 AI」里的设置。
        {researchBusy && <span className="text-warning"> 页面上方还有一次研究在跑，跑完才能再开。</span>}
      </p>
      {launch && <p role="status" className={cn("mt-1.5 text-xs", launch.state === "failed" ? "text-destructive" : "text-primary")}>{launch.text}</p>}
    </div>
  );
}
