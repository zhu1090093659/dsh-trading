import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend } from "@/lib/backend";
import { announceUpdate, onUpdateChanged, updateStatusText, upgradeSteps, type UpdateActionName, type UpdateInfo } from "@/lib/update";

const when = (iso: string) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString("zh-CN", { hour12: false });
};

/** 设置页「新版提示」:开关、现在检查、上次检查的结果(含失败原因) */
export function UpdateSettingsCard() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    backend.update().then(setInfo).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
    return onUpdateChanged(setInfo);
  }, []);
  const act = async (action: UpdateActionName) => {
    setBusy(true);
    setErr("");
    try {
      setInfo(announceUpdate(await backend.updateAct(action)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <GlassCard>
      <h3 className="mb-1 font-semibold">新版提示</h3>
      <p className="mb-3 text-xs text-muted-foreground">每天去 GitHub 查一次有没有新版本（没查成隔一小时再试），只发送当前版本号；有新版时在页面顶部提示一行。</p>
      {err && <p role="alert" className="mb-2 text-xs text-destructive">{err}</p>}
      {info && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={info.enabled && !info.env_disabled} disabled={busy || info.env_disabled}
              onChange={(e) => void act(e.target.checked ? "enable" : "disable")} />
            有新版时提示我
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            当前 v{info.current}。{updateStatusText(info)}{info.checked_at && ` 上次检查：${when(info.checked_at)}`}
          </p>
          {info.update_available && info.latest && (
            <p className="mt-1 text-xs">
              {upgradeSteps(info.install)}{" "}
              <a href={info.latest.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">看看更新了什么</a>
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <button disabled={busy || !info.enabled || info.env_disabled} onClick={() => void act("check")}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50">
              {busy && <LoaderCircle className="h-3 w-3 animate-spin" />}现在检查
            </button>
            {info.skip_version && info.enabled && !info.env_disabled && (
              <button disabled={busy} onClick={() => void act("enable")} className="rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50">
                恢复提示 v{info.skip_version}
              </button>
            )}
          </div>
        </>
      )}
    </GlassCard>
  );
}
