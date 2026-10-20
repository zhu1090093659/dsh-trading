import { useState } from "react";
import { Check, ClipboardCopy, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

import { GlassCard } from "@/components/ui/GlassCard";
import { ApiError, backend, type LedgerRecord, type RunListItem } from "@/lib/backend";
import { HEAD_CAVEAT, auditHeadline, filesText, fmtAt, issueSubject, type AuditIssue, type AuditIssueKind, type AuditNames, type AuditReport, type HeadCheck } from "@/lib/auditView";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";
import { maskPrivateText } from "@/lib/privacy";
import { cn } from "@/lib/utils";

const GROUPS: { kind: AuditIssueKind; title: string }[] = [
  { kind: "changed", title: "和登记时不一样" },
  { kind: "missing", title: "登记过，现在不见了" },
  { kind: "unregistered", title: "还没登记" },
];
/** 每组先列这么多条 */
const FIRST = 8;

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/** 名字只用来显示：取不到就退回编号，不影响核对本身 */
function namesFrom(runs: RunListItem[], kinds: Record<string, { label: string }>, records: Record<string, LedgerRecord[]>): AuditNames {
  const runById = new Map(runs.map((r) => [r.run_id, r]));
  return {
    run: (id) => { const r = runById.get(id); return r ? { name: r.name, symbol: r.symbol } : null; },
    kindLabel: (k) => kinds[k]?.label ?? null,
    record: (k, id) => records[k]?.find((r) => r.id === id) ?? null,
  };
}

function IssueGroup({ title, items, names, shown }: { title: string; items: AuditIssue[]; names: AuditNames; shown: (s: string) => string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const list = all ? items : items.slice(0, FIRST);
  return (
    <div className="mb-3">
      <p className="mb-1 text-xs font-medium text-foreground">{title}（{items.length}）</p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {list.map((i) => (
          <li key={`${i.subject}:${i.ref}`} className="break-words">
            <span className="text-foreground">{shown(issueSubject(i, names))}</span>
            {i.files ? `：${filesText(i.files)}` : ""}
            {i.last ? <span className="text-muted-foreground/70">（最后登记 {fmtAt(i.last.at)}）</span> : null}
          </li>
        ))}
      </ul>
      {items.length > FIRST && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">
          {all ? "收起" : `显示全部 ${items.length} 条`}
        </button>
      )}
    </div>
  );
}

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";

/** 核对结论 + 逐条问题 + 处理按钮（单独拆出来方便测试） */
export function AuditFindings({ report, names, shown, busy, onRegister }: {
  report: AuditReport; names: AuditNames; shown: (s: string) => string; busy: boolean;
  onRegister: (opts: { changed?: boolean; missing?: boolean }) => void;
}) {
  const headline = auditHeadline(report);
  const count = (k: AuditIssueKind) => report.issues.filter((i) => i.kind === k).length;
  return (
    <>
      <p className={cn("mb-3 flex items-start gap-1.5 text-sm", headline.tone === "ok" ? "text-foreground" : headline.tone === "warn" ? "text-warning" : "text-destructive")}>
        {headline.tone === "ok" ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> : <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />}
        <span>{headline.text}</span>
      </p>
      {report.problems.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-medium text-foreground">登记簿本身（{report.problems.length}）</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {report.problems.map((p) => <li key={`${p.line}:${p.why}`}>第 {p.line} 行：{p.why}</li>)}
          </ul>
        </div>
      )}
      {GROUPS.map((g) => <IssueGroup key={g.kind} title={g.title} items={report.issues.filter((i) => i.kind === g.kind)} names={names} shown={shown} />)}
      {(count("unregistered") > 0 || count("changed") > 0 || count("missing") > 0) && (
        <div className="mb-3 flex flex-wrap gap-2">
          {count("unregistered") > 0 && <button type="button" onClick={() => onRegister({})} disabled={busy} className={BTN}>补登这 {count("unregistered")} 条</button>}
          {count("changed") > 0 && <button type="button" onClick={() => onRegister({ changed: true })} disabled={busy} className={BTN}>按现在的内容重新登记</button>}
          {count("missing") > 0 && <button type="button" onClick={() => onRegister({ missing: true })} disabled={busy} className={BTN}>确认这些已经不在了</button>}
        </div>
      )}
    </>
  );
}

/**
 * 研究记录页底部的「防篡改核对」：研究运行和台账每次保存都在本地登记簿里记一个指纹，
 * 这里点「核对」逐条复算。只在点按钮时读盘（研究多时要把每个原始文件都算一遍）。
 */
export function AuditCard() {
  const { on: hide } = usePrivacyMode();
  const shown = (s: string) => (hide ? maskPrivateText(s) : s);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [names, setNames] = useState<AuditNames | null>(null);
  const [busy, setBusy] = useState<"verify" | "register" | "head" | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState("");
  const [headResult, setHeadResult] = useState<HeadCheck | null>(null);

  async function verify() {
    setBusy("verify"); setErr(""); setCopied(false);
    try {
      const [r, runs, ledger] = await Promise.all([
        backend.auditVerify(),
        backend.runs(500).catch(() => [] as RunListItem[]),
        backend.ledger().catch(() => null),
      ]);
      setReport(r);
      setNames(namesFrom(runs, ledger?.kinds ?? {}, ledger?.records ?? {}));
    } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  }

  async function register(opts: { changed?: boolean; missing?: boolean }) {
    if (opts.changed && !confirm("按现在的内容重新登记这些改动？以后核对不再报它们；登记簿里原来的登记和这次重新登记都会留着，可以查到。")) return;
    if (opts.missing && !confirm("确认这些已经不在了？以后核对不再报它们；登记簿里会记下这次确认。")) return;
    setBusy("register"); setErr("");
    try { setReport((await backend.auditRegister(opts)).report); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  }

  async function copyHead() {
    if (!report?.head_text) return;
    try { await navigator.clipboard.writeText(report.head_text); setCopied(true); } catch (e) { setErr(`复制没成功：${errText(e)}，可以手动选中下面的链头复制`); }
  }

  async function checkSaved() {
    setBusy("head"); setErr(""); setHeadResult(null);
    try { setHeadResult(await backend.auditCheckHead(saved)); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  }

  return (
    <GlassCard className="mt-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" /> 防篡改核对</h3>
        <span className="text-xs text-muted-foreground">研究结束、记录保存时都会在本地登记簿里记一个指纹</span>
        <button type="button" onClick={verify} disabled={busy !== null} className={cn(BTN, "ml-auto")}>
          {busy === "verify" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          {report ? "重新核对" : "核对"}
        </button>
      </div>
      {!report && !busy && (
        <p className="text-sm text-muted-foreground">
          点「核对」检查研究报告、证据、原始数据和研究记录、持仓流水等有没有被人绕开软件改过或删掉。只读，不会改任何东西。
        </p>
      )}
      {busy === "verify" && <p role="status" className="text-sm text-muted-foreground">正在逐个文件重算指纹…</p>}
      {err && <p role="alert" className="mt-2 text-sm text-destructive">{err}</p>}

      {report && names && (
        <div className="mt-2">
          <AuditFindings report={report} names={names} shown={shown} busy={busy !== null} onRegister={register} />

          <div className="rounded-lg border border-border/60 p-3">
            <p className="mb-2 text-xs text-muted-foreground">{HEAD_CAVEAT}</p>
            {report.head_text ? (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 select-all break-all rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground">{report.head_text}</code>
                <button type="button" onClick={copyHead} className={BTN}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}{copied ? "已复制" : "复制链头"}
                </button>
              </div>
            ) : <p className="mb-3 text-xs text-muted-foreground">登记簿还是空的，没有链头。</p>}
            <div className="flex flex-wrap items-center gap-2">
              <input value={saved} onChange={(e) => { setSaved(e.target.value); setHeadResult(null); }} placeholder="粘贴以前保存的链头"
                aria-label="以前保存的链头" className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2 py-1.5 font-mono text-[11px]" />
              <button type="button" onClick={checkSaved} disabled={busy !== null || !saved.trim()} className={BTN}>
                {busy === "head" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}核对链头
              </button>
            </div>
            {headResult && <p role="status" className={cn("mt-2 text-xs", headResult.ok ? "text-foreground" : "text-destructive")}>{headResult.why}</p>}
          </div>
        </div>
      )}
    </GlassCard>
  );
}
