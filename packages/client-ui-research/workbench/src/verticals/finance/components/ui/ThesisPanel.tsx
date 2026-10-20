import { useEffect, useRef, useState } from "react";
import { Target, CalendarClock, ShieldAlert, Plus } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError, type LedgerRecord } from "@/lib/backend";
import { THESIS_STATUS_LABEL, verdictLabel } from "@/lib/verdicts";

/**
 * 某只标的的**论点 → 判据 → 下一个数据日**。
 *
 * 🔴 为什么要有这一块：台账里 `thesis`（论点）与 `criterion`（裁决点 / 证伪条件）
 *    一直都有，研究档案也在存裁决点，但**界面从没把它们组成工作流** ——
 *    于是产品只帮用户"看资料"，没帮他"记住自己当时为什么买、什么情况下认错"。
 *    而这恰恰是让人明天还回来的那件事：**等下一个裁决日回来复核**。
 *
 * 🔴 两类判据分开显示：**裁决点**有到期日（到点必须判），
 *    **证伪条件**通常没有（它是随时可能触发的条件，不是日程）。
 *    糊成一类，"到期清单"就没法用了。
 */

const fmtDate = (s: unknown) => (typeof s === "string" && s ? s.slice(0, 10) : "");

/** 距今天还有几天。⚠️ 只按**日历日**算，不判交易日 —— 交易日要靠后端的日历，前端猜不得 */
function daysLeft(due: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  const d = new Date(`${due}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

export function ThesisPanel({ symbol, name }: { symbol: string; name?: string }) {
  /** `null` = 还没取回 / 取不到；`[]` = 这个主体确实没有记录。**两者不能混** */
  const [theses, setTheses] = useState<LedgerRecord[] | null>(null);
  const [criteria, setCriteria] = useState<LedgerRecord[] | null>(null);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const [adding, setAdding] = useState<"thesis" | "criterion" | null>(null);
  const [draft, setDraft] = useState({ title: "", statement: "", due: "", type: "decision_point" });
  /**
   * 陈旧响应的判据 = **单调请求序号**。每发一次请求就 +1;回来时序号不是最新的就丢掉。
   *
   * 🔴 不能拿"当前 symbol"当守卫:那个值是在 `load()` 里赋的,
   *    于是 ①保存完成后调用旧闭包里的 `load()` 会把它**改回上一个主体**;
   *    ②切换后、新的 effect 还没跑之前,旧请求回来时它仍等于旧主体 —— 两条都能绕过去。
   *    序号只增不减,谁都改不回去。
   */
  const seq = useRef(0);
  /** 同步的保存锁。`saving` 那个 state 在同一轮事件里读到的还是旧值,拦不住双击 */
  const savingRef = useRef(false);

  /**
   * 🔴 换主体时**先清空再取**，取回后还要核对是不是当前这个。
   *    两件事都必须做：
   *    ① 不清空 → 标题已是 B、正文还是 A 的论点，此时点保存会**把 A 的内容以 B 的身份写进台账**；
   *    ② 不核对 → A 的慢请求后回来，会盖掉已经取好的 B。
   *    取不到时也**不许留着上一个主体的记录** —— 那是把别人的判断挂在这个主体名下。
   */
  const load = (forSymbol: string): Promise<void> => {
    const my = ++seq.current;
    if (!forSymbol) { setTheses(null); setCriteria(null); return Promise.resolve(); }
    setTheses(null); setCriteria(null); setErr("");
    return backend
      .ledger()
      .then((d) => {
        if (my !== seq.current) return;   // 期间又发了新请求(换主体 / 保存后刷新)⇒ 这份已过期
        const mine = (rs: LedgerRecord[] | undefined) => (rs ?? []).filter((r) => String(r.symbol ?? "") === forSymbol);
        setTheses(mine(d.records.thesis));
        setCriteria(mine(d.records.criterion));
      })
      .catch((e) => {
        if (my !== seq.current) return;
        setTheses(null); setCriteria(null);   // 保留旧值 = 把上一个主体的记录挂到这个主体名下
        setErr(e instanceof ApiError ? e.message : String(e));
      });
  };
  // 换主体先让在途请求全部作废(序号 +1),再取新的
  useEffect(() => { seq.current += 1; void load(symbol); }, [symbol]);

  const save = async () => {
    // 🔴 用 ref 不用 state:同一轮事件里连点两次,`saving` 读到的都还是 false —— 拦不住
    if (savingRef.current) return;
    savingRef.current = true;
    // 这次保存写给谁 —— 保存过程中用户可能已经切走
    const forSymbol = symbol;
    setErr(""); setSavedNote(""); setSaving(true);
    try {
      if (adding === "thesis") {
        if (!draft.title.trim()) { setErr("论点得有个标题"); return; }
        await backend.ledgerSave("thesis", {
          symbol, title: draft.title.trim(), statement: draft.statement.trim(),
          ...(draft.due ? { review_by: draft.due } : {}), status: "active",
        });
      } else {
        if (!draft.statement.trim()) { setErr("判据得写清楚是什么"); return; }
        await backend.ledgerSave("criterion", {
          symbol, type: draft.type, statement: draft.statement.trim(),
          ...(draft.due ? { due: draft.due } : {}), status: "pending",
        });
      }
      // 🔴 期间用户切走了 → **不刷新**:刷新会把这个主体的记录读出来盖到新标题下面
      if (forSymbol !== symbol) { savingRef.current = false; setSaving(false); return; }
      setAdding(null);
      setDraft({ title: "", statement: "", due: "", type: "decision_point" });
      // 🔴 落库成功、但刷新失败,要**分开说** —— 只显示一个刷新错误,
      //    用户没法判断刚写的那条到底存住没有。
      await load(forSymbol);
      setSavedNote("已保存");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (!symbol) return null;

  const ready = theses !== null && criteria !== null;
  // 裁决点按到期日排；没写到期日的排最后（它们不是日程）
  const points = (criteria ?? [])
    .filter((c) => c.type === "decision_point")
    .sort((a, b) => String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));
  const falsifiers = (criteria ?? []).filter((c) => c.type === "falsifier");
  const next = points.find((c) => c.status === "pending" && fmtDate(c.due));
  const nextDays = next ? daysLeft(fmtDate(next.due)) : null;

  return (
    <GlassCard className="mb-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Target className="h-4 w-4 text-primary" />
        <h3 className="font-semibold">我的论点与判据</h3>
        <span className="text-xs text-muted-foreground">{name ? `${name}（${symbol}）` : symbol}</span>
        {/* 🔴 「下一个必须回来的日子」放在最显眼处 —— 这是整块的用途 */}
        {next && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-0.5 text-xs text-primary">
            <CalendarClock className="h-3.5 w-3.5" />
            下个裁决日 {fmtDate(next.due)}
            {nextDays !== null && (
              <span className="ml-1">（{nextDays < 0 ? `已过期 ${-nextDays} 天` : nextDays === 0 ? "就是今天" : `还有 ${nextDays} 天`}）</span>
            )}
          </span>
        )}
      </div>

      {!ready ? (
        // 🔴 「还没取回 / 取不到」不能画成「这个主体没有论点」——
        //    后者会让用户以为自己没写过，而其实是没读到。
        <p className="mb-3 text-sm text-muted-foreground">{err ? "这一块没取到（见下方原因）" : "读取中…"}</p>
      ) : theses.length === 0 && criteria.length === 0 ? (
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          还没为这只标的写下论点。<span className="text-foreground">写一条</span>，
          再配一个到期必判的裁决点 —— 以后每次打开就知道该回来核什么。
        </p>
      ) : (
        <div className="mb-3 space-y-3">
          {(theses ?? []).map((t) => (
            <div key={t.id} className="rounded-lg bg-muted/20 p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{String(t.title ?? "")}</span>
                <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">{THESIS_STATUS_LABEL[String(t.status ?? "")] ?? String(t.status ?? "")}</span>
                {fmtDate(t.review_by) && <span className="text-xs text-muted-foreground">复核 {fmtDate(t.review_by)}</span>}
              </div>
              {t.statement ? <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{String(t.statement)}</p> : null}
            </div>
          ))}

          {points.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">裁决点（到期必判）</p>
              {points.map((c) => (
                <div key={c.id} className="flex flex-wrap items-baseline gap-2 border-b border-border/30 py-1.5 text-sm last:border-0">
                  <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">{String(c.statement ?? "")}</span>
                  <span className="font-mono text-xs text-muted-foreground">{fmtDate(c.due) || "未定日期"}</span>
                  <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">{verdictLabel(c.type, c.status)}</span>
                </div>
              ))}
            </div>
          )}

          {falsifiers.length > 0 && (
            <div>
              {/* 证伪条件通常没有日期：它是随时可能触发的条件，不是日程 */}
              <p className="mb-1.5 text-xs text-muted-foreground">证伪条件（触发即认错）</p>
              {falsifiers.map((c) => (
                <div key={c.id} className="flex flex-wrap items-baseline gap-2 border-b border-border/30 py-1.5 text-sm last:border-0">
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
                  <span className="min-w-0 flex-1">{String(c.statement ?? "")}</span>
                  <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">{verdictLabel(c.type, c.status)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button onClick={() => { setAdding("thesis"); setErr(""); }}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted/40">
          <Plus className="h-3.5 w-3.5" /> 写论点
        </button>
        <button onClick={() => { setAdding("criterion"); setErr(""); }}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted/40">
          <Plus className="h-3.5 w-3.5" /> 加判据
        </button>
      </div>

      {adding && (
        <div className="mt-3 space-y-2 rounded-lg border border-border/60 p-3">
          {adding === "thesis" && (
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="论点标题，比如「产能护城河，绕不开」"
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm" />
          )}
          {adding === "criterion" && (
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}
              className="rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
              <option value="decision_point">裁决点（到期必判）</option>
              <option value="falsifier">证伪条件（触发即认错）</option>
            </select>
          )}
          <textarea value={draft.statement} onChange={(e) => setDraft({ ...draft, statement: e.target.value })}
            rows={3}
            placeholder={adding === "thesis" ? "为什么持有 / 为什么关注" : "写清楚什么情况下算成立、什么情况下算被推翻"}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm" />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-muted-foreground">
              {adding === "thesis" ? "复核日" : "到期日"}
              <input type="date" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })}
                className="ml-2 rounded-lg border border-border bg-background/60 px-2 py-1 text-sm" />
            </label>
            <button onClick={() => void save()} disabled={saving}
              className="rounded-lg bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary ring-1 ring-primary/30 hover:bg-primary/25 disabled:opacity-50">
              {saving ? "保存中…" : "保存"}
            </button>
            <button onClick={() => setAdding(null)} className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">取消</button>
          </div>
        </div>
      )}

      {savedNote && <p className="mt-2 text-xs text-primary">{savedNote}</p>}
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
    </GlassCard>
  );
}
