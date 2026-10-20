import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, History, Search, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { noRemoteImages } from "../../../../core/ai/noRemoteImages";

import { GlassCard } from "@/components/ui/GlassCard";
import { deleteNote, type Note } from "@/lib/notes";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";
import { maskPrivateText } from "@/lib/privacy";

export function ReportHistory({ kind, notes, onChange }: { kind: string; notes: Note[]; onChange: (notes: Note[]) => void }) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState("");
  // 隐私模式：标题和报告里自己的股数、金额只在屏幕上遮（审计第三轮 C2）
  const { on: hide } = usePrivacyMode();
  const shown = (t: string) => (hide ? maskPrivateText(t) : t);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter((n) => n.kind === kind && (!q || `${n.title}\n${n.content}`.toLowerCase().includes(q)));
  }, [kind, notes, query]);
  const stamp = (ts: number) => new Date(ts).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });

  return (
    <section className="space-y-3 pt-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-primary" /> {kind}记录</div>
          <p className="mt-1 text-xs text-muted-foreground">完整报告保存在本地，可搜索、展开和长期回看。</p>
        </div>
        <label className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索主题或报告内容"
            className="w-full rounded-xl border border-border/70 bg-background/55 py-2 pl-9 pr-3 text-xs outline-none focus:border-primary/60" />
        </label>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {rows.length === 0 ? (
        <GlassCard className="py-9 text-center text-sm text-muted-foreground">
          {query ? "没有匹配的记录。" : `完成一次${kind}后，报告会自动出现在这里。`}
        </GlassCard>
      ) : (
        <div className="space-y-2">
          {rows.map((n) => {
            const open = openId === n.id;
            return (
              <GlassCard key={n.id} className="!p-0 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3">
                  <button onClick={() => setOpenId(open ? null : n.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{shown(n.title)}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">{stamp(n.ts)}</span>
                  </button>
                  <button disabled={deleting === n.id} onClick={async () => {
                    setDeleting(n.id); setError("");
                    try { onChange(await deleteNote(n.id)); }
                    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
                    finally { setDeleting(null); }
                  }} className="text-muted-foreground/60 hover:text-destructive disabled:opacity-40" title="删除这份记录">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {open && <div className="border-t border-border/40 px-4 py-4">
                  <div className="prose prose-sm dark:prose-invert max-w-none text-foreground prose-table:text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={noRemoteImages}>{shown(n.content)}</ReactMarkdown>
                  </div>
                </div>}
              </GlassCard>
            );
          })}
        </div>
      )}
    </section>
  );
}
