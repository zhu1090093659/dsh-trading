import { useState } from "react";
import { Layers, RefreshCw } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { TIERS, ladderText, prevText, stockText, topOf, topText, type ReviewTiersResult, type TierId } from "@/lib/reviewTiers";
import { shortTime } from "@/lib/chatSources";
import { cn } from "@/lib/utils";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";
/** 集中的两档用主色标出层次;不用红绿(红绿在这个看板里是涨跌) */
const TIER_TONE: Record<TierId, string> = {
  mainline: "border-primary/50 text-primary",
  today: "border-primary/30 text-primary/80",
  scattered: "border-border text-muted-foreground",
  single: "border-border text-muted-foreground",
};

/** 每日复盘:涨停分档。数据由页面取(提示词也要用),这里只负责显示 */
export function ReviewTiersCard({ data, loading, error, bizDay, onRefresh }: {
  data: ReviewTiersResult | null; loading: boolean; error: string; bizDay: string | null; onRefresh: () => void;
}) {
  const [showSingle, setShowSingle] = useState(false);
  const singles = data?.groups.filter((g) => g.tier === "single") ?? [];

  return <GlassCard className="mb-6">
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 font-semibold"><Layers className="h-4 w-4 text-primary" /> 涨停分档</h3>
      <button type="button" onClick={onRefresh} disabled={loading || !bizDay} className={BTN} title="今天的涨停池不用缓存,重新取">
        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> 重新取
      </button>
    </div>
    <p className="mb-3 text-xs leading-5 text-muted-foreground">
      复盘那天的涨停股按东财行业归类,和前两个交易日比,按只数分四档:先看集中的,再看零散的。每组的「最高板」= 连板数最多、同板数里首封最早的那只;「梯队」= 各连板高度各有几只。档位是固定规则,不代表能不能持续,也不是推荐。
    </p>

    {!bizDay && <p className="py-3 text-sm text-muted-foreground">{loading ? "等业务日…" : "业务日没拿到,分档没算(见页面上方的缺口)。"}</p>}
    {error && <p role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
    {loading && !data && bizDay && <p role="status" className="py-3 text-sm text-muted-foreground">正在取 {bizDay} 和前两个交易日的涨停池…</p>}

    {data && <>
      <p className="mb-3 text-[11px] text-muted-foreground">
        {data.date} · 涨停 {data.total ?? "—"} 只 · 对比 {data.prev_dates.map((d) => d ?? "没找到").join("、")}
        {data.fetched_at && <> · 取于 {shortTime(data.fetched_at)}(北京时间){data.cached ? ",用的是缓存" : ""}</>}
      </p>

      {data.groups.length > 0 && <div className="mb-3 flex flex-wrap gap-2">
        {data.tiers.map((t) => <span key={t.id} title={t.rule} className={cn("rounded-full border px-2.5 py-0.5 text-xs", t.industries ? TIER_TONE[t.id] : "border-border/50 text-muted-foreground/70")}>
          {t.label} {t.industries} 个行业 · {t.stocks} 只
        </span>)}
      </div>}

      <div className="space-y-4">
        {TIERS.filter((t) => t.id !== "single").map((t) => {
          const groups = data.groups.filter((g) => g.tier === t.id);
          if (!groups.length) return null;
          return <section key={t.id}>
            <h4 className="mb-1.5 text-xs font-semibold">{t.label}<span className="ml-2 font-normal text-muted-foreground">{t.rule}</span></h4>
            <ul className="space-y-1.5">
              {groups.map((g) => <li key={g.industry} className={cn("rounded-lg border px-3 py-2", t.id === "mainline" ? "border-primary/30 bg-primary/[0.04]" : "border-border/50")}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="font-medium">{g.industry}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">今天 {g.today} 只 · 前两个交易日 {prevText(g)}</span>
                </div>
                {topOf(g) && <p className="mt-0.5 text-[11px] text-muted-foreground">最高板 <span className="text-foreground/90">{topText(topOf(g)!)}</span> · 梯队 {ladderText(g)}</p>}
                <p className="mt-0.5 text-xs leading-5 text-foreground/85">{g.stocks.map(stockText).join("、")}</p>
                {g.tags.length > 0 && <p className="text-[11px] text-muted-foreground">同花顺题材标签:{g.tags.map((x) => `${x.tag}×${x.count}`).join("、")}</p>}
                {g.note && <p className="text-[11px] text-warning">{g.note}</p>}
              </li>)}
            </ul>
          </section>;
        })}
        {singles.length > 0 && <section>
          <h4 className="mb-1.5 text-xs font-semibold">单只<span className="ml-2 font-normal text-muted-foreground">今天这个行业只有 1 只涨停 · {singles.length} 个行业</span></h4>
          <p className="text-xs leading-5 text-muted-foreground">{singles.map((g) => g.industry).join("、")}</p>
          <button type="button" aria-expanded={showSingle} onClick={() => setShowSingle((v) => !v)} className={cn(BTN, "mt-1.5")}>{showSingle ? "收起" : "看每只"}</button>
          {showSingle && <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
            {singles.map((g) => <li key={g.industry}>{g.industry}:{g.stocks.map(stockText).join("、")}{g.stocks[0]?.tags.length ? `(${g.stocks[0].tags.join("、")})` : ""}</li>)}
          </ul>}
        </section>}
      </div>

      {data.gaps.length > 0 && <div className="mt-4">
        <h4 className="mb-1 text-xs font-semibold">没取到的</h4>
        <ul className="space-y-1 text-xs text-muted-foreground">{data.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
      </div>}
      <p className="mt-3 text-[11px] text-muted-foreground/80">来源:{data.source}。行业用东财涨停池自带的行业名(东财截成最长 4 个字,原样显示);题材标签是同花顺的市场叙事,不是核验过的因果。</p>
    </>}
  </GlassCard>;
}
