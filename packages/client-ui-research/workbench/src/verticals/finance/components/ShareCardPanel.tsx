import { useEffect, useRef, useState } from "react";
import { Copy, Download } from "lucide-react";
import { backend, ApiError } from "@/lib/backend";
import { saveBlob } from "@/lib/download";
import { CARD_SIZE, STATEMENT, drawShareCard, shareSummary, type CardLayout, type ShareCardResult } from "@/lib/shareCard";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";
const LAYOUTS: { key: CardLayout; label: string }[] = [{ key: "portrait", label: "竖版(手机)" }, { key: "landscape", label: "横版" }];

/**
 * 报告卡里的「分享卡」:取这次研究的事实、数量、缺口,画成 PNG 下载,或复制成文字。
 * 换了一次研究就重新取(竞态守卫:慢请求回来时已经换了就丢掉)。只在报告通过最终校验后出现(页面判断,后端也会拒)。
 */
export function ShareCardPanel({ runId }: { runId: string }) {
  const [data, setData] = useState<ShareCardResult | null>(null);
  const [error, setError] = useState("");
  const [layout, setLayout] = useState<CardLayout>("portrait");
  const [note, setNote] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    setData(null);
    setError("");
    setNote("");
    backend.shareCard(runId).then(
      (r) => { if (my === seq.current) setData(r); },
      (e) => { if (my === seq.current) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)); },
    );
    return () => { seq.current++; };
  }, [runId]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !data) return;
    el.width = CARD_SIZE[layout].w;
    el.height = CARD_SIZE[layout].h;
    drawShareCard(ctx, data, layout);
  }, [data, layout]);

  const download = () => {
    const el = canvas.current;
    if (!el || !data) return;
    el.toBlob((blob) => {
      if (!blob) { setNote("图片没生成出来,可以换横版 / 竖版再试"); return; }
      saveBlob(blob, `研究分享卡-${data.symbol}-${layout === "portrait" ? "竖版" : "横版"}.png`);
    }, "image/png");
  };

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(shareSummary(data).join("\n"));
      setNote("文字版已复制");
    } catch {
      // 局域网 http 打开时浏览器不给写剪贴板:下面的文字版可以手动选中复制
      setNote("浏览器没让写剪贴板,可以在下面「文字版」里手动选中复制");
    }
  };

  return <div className="mb-4 rounded-lg border border-border/50 px-3 py-3">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <SegmentedToggle label="分享卡版式" value={layout} options={LAYOUTS} onChange={setLayout} disabled={!data} />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={download} disabled={!data} className={BTN}><Download className="h-3.5 w-3.5" /> 下载图片</button>
        <button type="button" onClick={() => void copy()} disabled={!data} className={BTN}><Copy className="h-3.5 w-3.5" /> 复制文字</button>
      </div>
    </div>
    <p className="mb-2 text-xs leading-5 text-muted-foreground">卡片只放这次研究取到的原始数据、数量和缺口,不放报告里的判断。{STATEMENT}</p>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">分享卡没生成:{error}</p>}
    {!data && !error && <p role="status" className="py-3 text-sm text-muted-foreground">正在整理这次研究的数据…</p>}
    {note && <p role="status" className="mb-2 text-xs text-primary">{note}</p>}
    {data && <>
      <div className="flex justify-center overflow-hidden rounded-md border border-border/40 bg-muted/20 p-2">
        <canvas ref={canvas} aria-label={`研究分享卡预览(${layout === "portrait" ? "竖版" : "横版"})`}
          className={layout === "portrait" ? "h-auto w-full max-w-[360px]" : "h-auto w-full max-w-[720px]"} />
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">文字版</summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-2 font-sans leading-5">{shareSummary(data).join("\n")}</pre>
      </details>
    </>}
  </div>;
}
