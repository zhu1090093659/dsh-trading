import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, type SecContactStatus } from "@/lib/backend";

const INPUT = "w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm";
const BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50";

/**
 * 设置页「美股官方数据(选填)」:SEC 要求访问者留英文姓名和邮箱。
 * 填了:美股业绩日期改用 SEC 官方全文检索,AI 查美股也能用 SEC 的申报和财务数据;没填照旧用东财。
 * 页面只看得到打码后的样子(录屏、截图不露全名和邮箱);环境变量指定的只读。
 */
export function SecContactCard() {
  const [st, setSt] = useState<SecContactStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    backend.secContact().then(setSt).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  const save = async (contact: string | null) => {
    setBusy(true);
    setErr("");
    try {
      setSt(await backend.setSecContact(contact));
      setDraft("");
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const showInput = st && st.source !== "env" && (st.source === "none" || editing);
  return (
    <GlassCard>
      <h3 className="mb-1 font-semibold">美股官方数据（选填）</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        美国证监会（SEC）要求访问者留下英文姓名和邮箱。填了以后，美股事件回看的业绩日期改用 SEC 官方数据（大银行这类也能取全），
        AI 查美股时也能用上 SEC 的申报和财务数据；不填照旧用东财转载的申报。只存在这台电脑上，只发给 SEC。
      </p>
      {err && <p role="alert" className="mb-2 text-xs text-destructive">{err}</p>}
      {st?.source === "env" && (
        <p className="text-xs">
          已由环境变量 VRA_SEC_CONTACT 指定：<span className="font-mono">{st.masked}</span>
          {!st.valid && <span className="text-destructive">（格式不对，应为「英文姓名 邮箱」，SEC 会拒绝）</span>}
        </p>
      )}
      {st?.source === "saved" && !editing && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>已填：<span className="font-mono">{st.masked}</span></span>
          <button disabled={busy} onClick={() => { setEditing(true); setErr(""); }} className={BUTTON}>修改</button>
          <button disabled={busy} onClick={() => void save(null)} className={BUTTON}>
            {busy && <LoaderCircle className="h-3 w-3 animate-spin" />}清除
          </button>
        </div>
      )}
      {showInput && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void save(draft); }}>
          <input className={`${INPUT} min-w-[16rem] flex-1`} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy}
            placeholder="英文姓名 邮箱，例如 Zhang San zhangsan@example.com" aria-label="SEC 联系方式（英文姓名和邮箱）"
            autoComplete="off" spellCheck={false} maxLength={200} />
          <button type="submit" disabled={busy || !draft.trim()} className={BUTTON}>
            {busy && <LoaderCircle className="h-3 w-3 animate-spin" />}保存
          </button>
          {editing && <button type="button" disabled={busy} onClick={() => { setEditing(false); setDraft(""); setErr(""); }} className={BUTTON}>取消</button>}
        </form>
      )}
    </GlassCard>
  );
}
