import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CandlestickChart, Loader2 } from "lucide-react";

import { EChart } from "@/components/ui/EChart";
import { GlassCard } from "@/components/ui/GlassCard";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { usePalette } from "@/components/ui/chartPalette";
import { ApiError, backend } from "@/lib/backend";
import { fmtChange, fmtPrice, fmtVolume, klineOption, parseKline, type KlineResult } from "@/lib/klineView";

type Period = "day" | "week" | "month";
type Adjust = "qfq" | "hfq" | "none";

const PERIODS: { key: Period; label: string }[] = [{ key: "day", label: "日线" }, { key: "week", label: "周线" }, { key: "month", label: "月线" }];
const ADJUSTS: { key: Adjust; label: string }[] = [{ key: "qfq", label: "前复权" }, { key: "hfq", label: "后复权" }, { key: "none", label: "不复权" }];

/** 复权只对 A 股有意义。写法与 K 线工具认的一致：600519 / 600519.SH / SH.600519。 */
const looksLikeAShare = (s: string) => /^(\d{6}(\.(SH|SZ|BJ))?|(SH|SZ|BJ)\.\d{6})$/i.test(s.trim());

/**
 * 个股走势：K 线 + 均线 + 成交量。数据来自 K 线工具（不需要接 AI）。
 * 🔴 只画行情，不画买卖点；红涨绿跌。
 */
export function KlineCard({ symbol, title, action }: { symbol: string; title?: string; action?: ReactNode }) {
  const palette = usePalette();
  const [period, setPeriod] = useState<Period>("day");
  const [adjust, setAdjust] = useState<Adjust>("qfq");
  // 结果连同它是哪只一起记：换了股票、新的还没回来时不显示上一只的图（放在 effect 里清空会先闪一帧旧图）
  const [got, setGot] = useState<{ symbol: string; res: KlineResult } | null>(null);
  const res = got?.symbol === symbol ? got.res : null;
  const [loading, setLoading] = useState(false);

  const aShareCode = looksLikeAShare(symbol);
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    // 港美股不传复权：页面上不显示这个选项，传了上一只 A 股留下的选择只会换来一句看不懂的提示
    const body = aShareCode ? { symbol, period, adjust, charts: true } : { symbol, period, charts: true };
    backend.runTool<unknown>("kline", body, ctl.signal)
      .then((out) => { if (!ctl.signal.aborted) setGot({ symbol, res: parseKline(out) }); })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        setGot({ symbol, res: { ok: false, error: e instanceof ApiError ? e.message : String(e) } });
      })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    // 切代码 / 周期 / 复权时丢掉上一次还没回来的请求，免得慢的那次后到把新图盖掉
    return () => ctl.abort();
  }, [symbol, period, adjust, aShareCode]);

  const view = res?.ok ? res.view : null;
  const option = useMemo(() => (view ? klineOption(view, palette) : null), [view, palette]);
  const aShare = view ? view.market === "a_share" : aShareCode;
  const s = view?.series;
  const last = s ? s.dates.length - 1 : -1;
  const tone = (x: number | null | undefined) => (x == null || x === 0 ? "" : x > 0 ? "text-danger" : "text-success");

  return (
    <GlassCard className="mb-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <CandlestickChart className="h-4 w-4 text-primary" />
        <h3 className="font-semibold">走势</h3>
        {title && <span className="text-sm font-medium">{title}</span>}
        <span className="font-mono text-sm">{view?.symbol || symbol}</span>
        {view && <span className="text-xs text-muted-foreground">{view.marketLabel} · {view.adjustLabel}</span>}
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="正在取 K 线" />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SegmentedToggle label="周期" value={period} onChange={setPeriod} options={PERIODS} disabled={loading} />
          {aShare && <SegmentedToggle label="复权" value={adjust} onChange={setAdjust} options={ADJUSTS} disabled={loading} />}
          {action}
        </div>
      </div>

      {res && !res.ok && <p role="alert" className="text-sm text-muted-foreground">K 线没有画出来：{res.error}</p>}
      {!res && loading && <p className="text-sm text-muted-foreground">正在取 K 线…</p>}

      {view && s && option && (
        <>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">{s.dates[last]}</span>
            <span>收盘 <b className={`font-mono text-sm ${tone(s.change[last])}`}>{fmtPrice(s.close[last] ?? null)}</b></span>
            <span className={`font-mono ${tone(s.change[last])}`}>{fmtChange(s.change[last] ?? null)}</span>
            <span className="text-muted-foreground">开 <span className="font-mono text-foreground">{fmtPrice(s.open[last] ?? null)}</span></span>
            <span className="text-muted-foreground">高 <span className="font-mono text-foreground">{fmtPrice(s.high[last] ?? null)}</span></span>
            <span className="text-muted-foreground">低 <span className="font-mono text-foreground">{fmtPrice(s.low[last] ?? null)}</span></span>
            {view.volumeUnit && <span className="text-muted-foreground">量 <span className="font-mono text-foreground">{fmtVolume(s.volume[last] ?? null)}</span> {view.volumeUnit}</span>}
          </div>
          <EChart option={option} height={420} />
          <div className="mt-2 space-y-0.5 text-[11px] leading-5 text-muted-foreground">
            {view.notes.map((n) => <p key={n}>{n}</p>)}
            <p>
              来源：{view.source}{view.fetchedAt ? ` · 取数 ${view.fetchedAt.slice(0, 16).replace("T", " ")}` : ""} ·
              {" "}{view.periodLabel} {view.bars} 根（{view.first} 至 {view.last}），默认显示最近一段，拖动下方滑条或图表看更早，按住 Ctrl 滚轮（或双指捏合）缩放。
              均线是收盘价的简单移动平均。
            </p>
          </div>
        </>
      )}
    </GlassCard>
  );
}
