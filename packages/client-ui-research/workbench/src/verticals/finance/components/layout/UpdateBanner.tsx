import { useEffect, useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { backend } from "@/lib/backend";
import { announceUpdate, onUpdateChanged, upgradeSteps, type UpdateInfo } from "@/lib/update";

/** 页面顶部的新版提示:只在后端说有新版时出现。查失败不打扰,原因在「接入 AI」页的「新版提示」里看 */
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    backend.update().then((u) => { if (alive) setInfo(u); }).catch(() => { /* 只是提示:查不到就不显示 */ });
    const off = onUpdateChanged((u) => { setInfo(u); setHidden(false); });
    return () => { alive = false; off(); };
  }, []);
  const latest = info?.latest;
  if (hidden || !info?.update_available || !latest) return null;
  const act = async (action: "skip" | "disable") => {
    setBusy(true);
    setErr("");
    try {
      setInfo(announceUpdate(await backend.updateAct(action, action === "skip" ? latest.version : undefined)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" aria-label="新版提示" className="flex shrink-0 flex-wrap items-start gap-x-4 gap-y-2 border-b border-primary/20 bg-primary/[0.06] px-4 py-2.5 text-xs md:px-8">
      <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      {/* 文字至少 14rem 宽:窄屏时按钮整组换到下一行,不把文字挤成一列 */}
      <div className="min-w-[14rem] flex-1">
        <p>
          <strong className="font-semibold">有新版本 v{latest.version}</strong>（你现在用的是 v{info.current}）。
          <a href={latest.url} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">看看更新了什么</a>
        </p>
        <p className="mt-1 text-muted-foreground">{upgradeSteps(info.install)}</p>
        {err && <p role="alert" className="mt-1 text-destructive">没能保存：{err}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={() => void act("skip")} className="rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50">这个版本不再提示</button>
        <button disabled={busy} onClick={() => void act("disable")} title="关掉后不再联网检查；可在「接入 AI」页的「新版提示」里重新打开"
          className="rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50">关掉新版提示</button>
        <button onClick={() => setHidden(true)} aria-label="这次先不提示" title="这次先不提示（下次打开还会提示）"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}
