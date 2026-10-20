import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { backend, type PageBlock, type PageResult } from "@/lib/backend";
import { Link } from "react-router-dom";
import { Sparkles, Loader2, AlertCircle, RefreshCw, Gauge, TrendingUp, TrendingDown, Flame, BarChart3, Globe, Activity, Landmark, Coins } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { noRemoteImages } from "../../../core/ai/noRemoteImages";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import { api, ApiError, type GlobalIndex } from "@/lib/api";
import { hasLlm, chatStream } from "@/lib/llm";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { ReviewTiersCard } from "@/components/ReviewTiersCard";
import { TIER_PROMPT_RULES, tiersSummary, type ReviewTiersResult } from "@/lib/reviewTiers";
import { BREADTH_RULE, SPECULATION_RULE, aboveMa, blockOf, parseReview, reviewLines, staleNote, yiText, type ReviewBlockId } from "@/lib/marketReview";
import { cn } from "@/lib/utils";

// A股红涨绿跌。全球市场（美股/港股指数）**也沿用红涨**——与整个看板及东财等中国平台一致，
// 对中国用户最不易看错（Simon 2026-07-05 确认；非国际绿涨惯例，是有意选择，勿改）。
// 容 null:行情缺项时显示灰色的「—」,不套涨跌色
const pctColor = (p: number | null | undefined) =>
  p == null ? "text-muted-foreground/40" : p > 0 ? "text-danger" : p < 0 ? "text-success" : "text-muted-foreground";
const fmt = (v: number | null, digits = 2) => v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const pctText = (v: number | null | undefined, digits = 2) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
const shareText = (v: number | null | undefined) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
const signedYi = (v: number | null) => v == null ? "—" : `${v > 0 ? "+" : ""}${yiText(v)}`;
/** 涨跌分布横轴用短标签(23 档放得下、不用斜着排);全称在悬停提示里 */
const bucketShort = (key: number, label: string) =>
  key === 11 ? "涨停" : key === -11 ? "跌停" : key === 0 ? "平" : key === 10 ? ">9%" : key === -10 ? "<-9%"
    : label.replace(/^涨\s*/, "+").replace(/^跌\s*/, "-");

type ViewMode = "live" | "close";

/** 块没取到的原因:主源抛错 / 信封写的原因 / 备源也失败 */
function blockWhy(b: PageBlock | undefined): string {
  if (!b) return "这一块没有返回";
  const env = b.envelope as { reason?: unknown; missing?: { reason?: unknown }[] } | undefined;
  const why = b.error ?? (typeof env?.reason === "string" ? env.reason : "") ?? "";
  const miss = Array.isArray(env?.missing) ? String(env!.missing[0]?.reason ?? "") : "";
  return [why || miss || "上游没回数据", b.fallback_error ? `备用来源也没取到:${b.fallback_error}` : ""].filter(Boolean).join(";").slice(0, 200);
}

function Section({ icon: Icon, title, hint, children }: { icon: typeof Gauge; title: string; hint?: string; children: ReactNode }) {
  return <section className="mb-8">
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/60 pb-2">
      <h2 className="flex items-center gap-1.5 text-base font-semibold"><Icon className="h-4 w-4 text-primary" /> {title}</h2>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
    {children}
  </section>;
}

/** 一块数据的小标题行:标题 + 读法 + 数据日 / 此刻快照 / 备用来源 */
function BlockHead({ title, page, id, date, extra }: { title: string; page: PageResult | null; id: ReviewBlockId; date: string | null; extra?: ReactNode }) {
  const b = blockOf(page, id);
  const stale = staleNote(page, id, date);
  return <div className="mb-2">
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {date && !stale && <span className="text-[11px] text-muted-foreground">{date}</span>}
      {stale && <span className="rounded border border-warning/40 px-1.5 text-[11px] text-warning">{stale}</span>}
      {extra}
    </div>
    {b?.via_fallback && <p className="mt-0.5 text-[11px] text-warning">{b.via_fallback.note}</p>}
  </div>;
}

/** 块没取到 / 还在取 */
function Pending({ page, id, done }: { page: PageResult | null; id: ReviewBlockId; done: boolean }) {
  if (!done) return <p className="py-4 text-center text-sm text-muted-foreground/60">加载中…</p>;
  return <p role="status" className="py-4 text-center text-sm text-muted-foreground">这次没取到:{blockWhy(blockOf(page, id))}。不代表没有,可点右上角刷新重试。</p>;
}

function Stat({ k, v, sub, tone, title }: { k: string; v: ReactNode; sub?: ReactNode; tone?: string; title?: string }) {
  return <div className="rounded-lg border border-border/60 bg-muted/20 p-3" title={title}>
    <p className="text-[11px] text-muted-foreground">{k}</p>
    <p className={cn("mt-0.5 font-mono text-lg font-bold tabular-nums", tone)}>{v}</p>
    {sub && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{sub}</p>}
  </div>;
}

export function DailyReview() {
  const fetchingRef = useRef(false);
  const [mode, setMode] = useState<ViewMode>("live");
  const [review, setReview] = useState("");
  /** 这份复盘是按哪个业务日的数据写的：刷新后业务日可能变，保存和显示都按写的那天（审计第三轮 C4） */
  const [reviewDay, setReviewDay] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [globalIdx, setGlobalIdx] = useState<GlobalIndex[]>([]);
  const [globalErr, setGlobalErr] = useState<string | null>(null);
  const [globalDone, setGlobalDone] = useState(false);

  /**
   * 🔴 业务日与各块状态**由 Core 一次算好**（`/page/review`），不再让每块自己判。
   *    页面各自拼旧端点时实测出现过：标题与"市场情绪"是 08-27，"短线情绪"却是 08-26 ——
   *    同一屏跨了两天，而**页面上看不出任何异常**。
   * 🔴 这一屏要的全部数据(指数中长线、涨跌分布、短线、资金、两融、估值)都在这一次请求里;
   *    页面不再另拉实时行情补价格 —— 看上一个交易日时那是今天的价,和那一天对不上。
   */
  const [pageMeta, setPageMeta] = useState<PageResult | null>(null);
  const [pageErr, setPageErr] = useState<string | null>(null);
  const [ovDone, setOvDone] = useState(false);

  const loadPage = async (refresh = false, view: ViewMode = mode) => {
    if (fetchingRef.current || reviewLoading) return;
    fetchingRef.current = true;
    setOvDone(false); setPageMeta(null); setPageErr(null);
    setGlobalDone(false); setGlobalErr(null); setGlobalIdx([]);
    const globalTask = api.globalIndices(refresh).then(setGlobalIdx)
      .catch((e) => setGlobalErr(e instanceof Error ? e.message : "全球指数获取失败"))
      .finally(() => setGlobalDone(true));
    // 默认要「今天·盘中」:盘中打开就是此刻的市场;盘前 / 收盘后 / 休市日后端不理会 live,照常给完整的一天
    const pageTask = backend.page("review", { ...(refresh ? { refresh: true } : {}), ...(view === "live" ? { mode: "live" as const } : {}) })
      .then(setPageMeta)
      // 🔴 不吞:取不到这一屏 = 业务日与缺口保护都没了,必须让用户看见
      .catch((e) => { setPageMeta(null); setPageErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => setOvDone(true));
    await Promise.allSettled([globalTask, pageTask]);
    fetchingRef.current = false;
  };

  useEffect(() => { void loadPage(); }, []);

  const switchMode = (m: ViewMode) => {
    if (m === mode || fetchingRef.current || reviewLoading) return;
    setMode(m);
    setReview("");
    void loadPage(false, m);
  };

  /** 这一屏在看哪一天 —— **只认 Core 给的业务日**（拿不到就是 null，不拿本地日期顶上） */
  const bizDay = pageMeta ? pageMeta.context.review_date ?? pageMeta.context.last_trading_day : null;
  const ctx = pageMeta?.context;
  const R = useMemo(() => parseReview(pageMeta), [pageMeta]);
  const palette = usePalette();

  /**
   * 涨停分档:要等业务日,按业务日取。`tiersFor` 记「哪一天的已经取完(成功或失败)」——
   * 复盘按钮只在业务日那天的分档取完后才可用,不会拿上一轮、别的日子的分档去复盘。
   */
  const [tiers, setTiers] = useState<ReviewTiersResult | null>(null);
  const [tiersErr, setTiersErr] = useState("");
  const [tiersLoading, setTiersLoading] = useState(false);
  const [tiersFor, setTiersFor] = useState<string | null>(null);
  const tiersSeq = useRef(0);
  const loadTiers = async (day: string, refresh: boolean) => {
    const my = ++tiersSeq.current;
    setTiersLoading(true);
    setTiersErr("");
    setTiersFor(null);
    try {
      const r = await backend.reviewTiers({ date: day, refresh });
      if (my === tiersSeq.current) setTiers(r);
    } catch (e) {
      if (my === tiersSeq.current) { setTiers(null); setTiersErr(e instanceof Error ? e.message : String(e)); }
    } finally {
      if (my === tiersSeq.current) { setTiersLoading(false); setTiersFor(day); }
    }
  };
  useEffect(() => {
    if (bizDay) void loadTiers(bizDay, false);
    else { tiersSeq.current++; setTiersLoading(false); }
  }, [bizDay]);
  // 业务日没拿到(这一屏失败)就没有分档可等;页面那块结束即可
  const tiersReady = bizDay ? tiersFor === bizDay : ovDone;
  const dataReady = globalDone && ovDone && tiersReady;

  const runReview = async () => {
    // Ref also covers a refresh click before React commits the pending flags.
    if (!dataReady || fetchingRef.current || reviewLoading) return;
    setReviewErr(null);
    setNeedConfig(false);
    if (!hasLlm()) { setNeedConfig(true); return; }
    setReviewLoading(true);
    setReview("");
    setReviewDay(bizDay);
    const prompt =
      "请根据这一屏的客观数据（含业务日与各块读法护栏）做一次市场复盘。\n" +
      "按这个顺序写：① 市场处在什么状态（涨跌面、成交量与均值比、指数在中长期均线的什么位置）；② 短线情绪（涨停 / 跌停 / 炸板、昨日涨停今日表现、晋级）；" +
      "③ 中长线（各指数 20 / 60 / 250 日涨跌、离一年高点、两融变化、估值和国债收益率的差）；④ 资金去了哪（行业资金、成交额居前、龙虎榜）。\n" +
      "🔴 硬要求：① 标了【缺口】的块**不要就它下任何结论**，如实说这块没取到；" +
      "② 引用数字时带上它的读法护栏（【读法·xx】那几行），不要把口径丢掉；标了「此刻快照」的块和业务日不是同一天，要说明；" +
      "③ 只做客观陈述与多视角分析，不预测涨跌、不推荐任何标的、不构成投资建议；" +
      TIER_PROMPT_RULES;
    try {
      await chatStream([{ role: "user", content: prompt }], `大盘数据：${dataSummary}`, {
        onDelta: (t) => setReview((r) => r + t),
      });
    } catch (e) {
      setReviewErr(e instanceof ApiError ? e.message : "复盘失败");
    } finally {
      setReviewLoading(false);
    }
  };

  /**
   * 喂给 AI 的那份数据:整屏结构化事实 + 每块的读法护栏与状态 + 数据日。
   * 🔴 只给数字不给读法，等于让模型替上游打包票;块没取到写【缺口】,空着会被读成"今天没有"。
   */
  const dataSummary = (() => {
    const lines: string[] = [];
    if (!dataReady) lines.push("【加载中】本轮数据尚未全部返回。不要据此作整屏复盘，等待加载结束。");
    if (ovDone && (pageErr || !pageMeta)) lines.push(`【缺口】这一屏没取到${pageErr ? `（${pageErr}）` : ""}，业务日和各块数据都不可用，不要下结论。`);
    if (ctx?.review_date) lines.push(`【业务日】${ctx.review_date}（${ctx.review_reason ?? ctx.session_phase}）`);
    if (pageMeta?.mixed_ages) {
      // 🔴 只说"跨了业务日"是**不可操作**的 —— 把各块的取数时刻一并给出，模型才能限定"这条是几点的"。
      const stamps = pageMeta.blocks
        .filter((b) => b.fetched_at)
        .map((b) => `${b.title} ${b.fetched_at!.slice(0, 16).replace("T", " ")}`)
        .join("；");
      lines.push(`⚠️ 这一屏的数据来自不同业务日，跨日比较要当心。各块取数时刻：${stamps || "未记录"}`);
    }
    if (pageMeta) lines.push(...reviewLines(pageMeta, R));
    // 拿不到价的那条**不写进去** —— 让模型看到 null 比不给还糟
    const gi = globalIdx.filter((i) => i.price !== null && i.change_pct !== null);
    lines.push(gi.length
      ? `【海外指数·腾讯快照，非逐笔实时】${gi.map((i) => `${i.name} ${i.price}（${i.change_pct! > 0 ? "+" : ""}${i.change_pct}%）；取数时间 ${i.fetched_at ?? "未知"}；价格证据 ${i.evidence_id ?? "未提供"}${i.note ? `；读法 ${i.note}` : ""}`).join("；")}`
      : `【海外指数】${globalErr ?? (globalDone ? "未取得可用数据" : "仍在加载")}；没有可引用的数据，不就此下结论。`);
    const missingGlobal = globalIdx.filter((i) => i.price === null || i.change_pct === null);
    if (missingGlobal.length) lines.push(`【海外指数缺口】${missingGlobal.map((i) => i.name).join("、")}报价不完整，不据此下结论。`);
    // 分档只认业务日那天的;没取到写缺口,别让模型以为「今天没有集中的行业」
    if (bizDay && tiersErr) lines.push(`【缺口·涨停分档】没取到(${tiersErr}),不分档、不据此下结论`);
    lines.push(...tiersSummary(bizDay && tiers?.date === bizDay ? tiers : null));
    // 取数层写的读法护栏 + 哪些块没取到 / 换了备源 —— 都要让模型知道
    for (const b of pageMeta?.blocks ?? []) {
      if (b.note) lines.push(`【读法·${b.title}】${b.note}`);
      if (b.via_fallback) lines.push(`【备用来源·${b.title}】${b.via_fallback.note}`);
      if (b.status === "failed" || b.status === "missing") lines.push(`【缺口】${b.title} 这次没取到，不要就它下结论`);
      else if (b.status === "partial") lines.push(`【不完整】${b.title} 只取到一部分`);
    }
    return lines.join("\n");
  })();

  // 右上角那个 AI 按钮聊的就是这一页（登记处见 core/ai/pageContext）
  useAiPage({
    key: "daily-review",
    title: "每日复盘",
    context: `大盘数据：${dataSummary}`,
    suggestions: ["市场现在处在什么状态", "短线情绪怎么样", "各指数离均线和一年高点多远"],
  });

  const { breadth: B, short: S, trend: T, margin: M, valuation: V, flow: F, turnover: TV, dragon: D } = R;
  const idx = T?.indices ?? [];
  const aboveCount = (key: "ma20" | "ma60" | "ma250") => {
    const known = idx.map((i) => aboveMa(i.close, i[key])).filter((x): x is boolean => x !== null);
    return known.length ? `${known.filter(Boolean).length}/${known.length}` : "—";
  };

  const distOption = useMemo(() => B && B.buckets.length ? {
    grid: { left: 36, right: 8, top: 18, bottom: 24 },
    tooltip: { trigger: "axis", backgroundColor: palette.tooltipBg, textStyle: { color: palette.tooltipText },
      formatter: (ps: { dataIndex: number; value: number }[]) => `${B.buckets[ps[0]!.dataIndex]!.label}:${ps[0]!.value} 只` },
    xAxis: { type: "category", data: B.buckets.map((b) => bucketShort(b.key, b.label)), axisLabel: { color: palette.text, fontSize: 10, interval: 0, hideOverlap: false }, axisLine: { lineStyle: { color: palette.axis } } },
    yAxis: { type: "value", axisLabel: { color: palette.text, fontSize: 10 }, splitLine: { lineStyle: { color: palette.grid } } },
    series: [{ type: "bar", data: B.buckets.map((b) => ({ value: b.count, itemStyle: { color: b.key > 0 ? palette.rise : b.key < 0 ? palette.fall : palette.benchmark } })), label: { show: true, position: "top", fontSize: 9, color: palette.text } }],
  } : null, [B, palette]);

  const amountOption = useMemo(() => T && T.amounts.length ? {
    grid: { left: 52, right: 64, top: 16, bottom: 28 },
    tooltip: { trigger: "axis", backgroundColor: palette.tooltipBg, textStyle: { color: palette.tooltipText }, valueFormatter: (v: unknown) => `${fmt(Number(v), 0)} 亿` },
    xAxis: { type: "category", data: T.amounts.map((a) => a.date.slice(5)), axisLabel: { color: palette.text, fontSize: 10 }, axisLine: { lineStyle: { color: palette.axis } } },
    yAxis: { type: "value", axisLabel: { color: palette.text, fontSize: 10, formatter: (v: number) => `${fmt(v, 0)}` }, splitLine: { lineStyle: { color: palette.grid } } },
    series: [{
      // 盘中没收完的那根用灰色,和收完的日子区分开
      type: "bar", name: "两市成交额", itemStyle: { color: palette.primary },
      data: T.amounts.map((a, i) => (T.partial && i === T.amounts.length - 1 ? { value: Math.round(a.total / 1e8), itemStyle: { color: palette.benchmark } } : Math.round(a.total / 1e8))),
      markLine: {
        symbol: "none", lineStyle: { type: "dashed" },
        data: [
          ...(T.ma20 ? [{ yAxis: Math.round(T.ma20 / 1e8), name: "20 日均", lineStyle: { color: palette.strong }, label: { formatter: "20 日均", color: palette.text, fontSize: 10 } }] : []),
          ...(T.ma60 ? [{ yAxis: Math.round(T.ma60 / 1e8), name: "60 日均", lineStyle: { color: palette.benchmark }, label: { formatter: "60 日均", color: palette.text, fontSize: 10 } }] : []),
        ],
      },
    }],
  } : null, [T, palette]);

  const marginOption = useMemo(() => M && M.series.length ? {
    grid: { left: 56, right: 12, top: 16, bottom: 28 },
    tooltip: { trigger: "axis", backgroundColor: palette.tooltipBg, textStyle: { color: palette.tooltipText }, valueFormatter: (v: unknown) => `${fmt(Number(v), 0)} 亿` },
    xAxis: { type: "category", data: M.series.map((x) => x.date.slice(5)), axisLabel: { color: palette.text, fontSize: 10 }, axisLine: { lineStyle: { color: palette.axis } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: palette.text, fontSize: 10, formatter: (v: number) => `${fmt(v, 0)}` }, splitLine: { lineStyle: { color: palette.grid } } },
    series: [{ type: "line", name: "两融余额", showSymbol: false, data: M.series.map((x) => (x.balance === null ? null : Math.round(x.balance / 1e8))), lineStyle: { color: palette.primary, width: 2 }, itemStyle: { color: palette.primary } }],
  } : null, [M, palette]);

  const flowIn = F ? F.rows.filter((x) => x.net !== null && x.net > 0).slice(0, 8) : [];
  // 🔴 判据是**净额的正负**，不是"在列表的哪一头"(旧写法把末尾当流出,实测流出榜第一名是 +8.04 亿)
  const flowOut = F ? F.rows.filter((x) => x.net !== null && x.net < 0).sort((a, b) => a.net! - b.net!).slice(0, 8) : [];
  const lianban = S ? S.stocks.filter((x) => (x.boards ?? 0) >= 2) : [];
  const hasIndustry = !!TV?.rows.some((r) => r.industry);
  const hasMcap = !!TV?.rows.some((r) => r.mcap !== null);

  return (
    <div>
      {/* 🔴 标题里的日期用 **Core 算出的业务日**,不用浏览器本地"今天"。业务日还没拿到就先不写日期,别先写一个再改。 */}
      <PageHeader
        title="每日复盘"
        subtitle={`${bizDay ? `${bizDay}${ctx?.live ? "（盘中）" : ""} · ` : ""}市场处在什么状态：涨跌面与短线情绪、中长线趋势与量能、资金去了哪`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {ctx?.live_available && (
          <SegmentedToggle<ViewMode> label="看哪一天" value={ctx.live ? "live" : "close"} disabled={!dataReady || reviewLoading}
            onChange={switchMode} options={[{ key: "live", label: "今天 · 盘中" }, { key: "close", label: "上一个交易日 · 完整" }]} />
        )}
        <button onClick={() => loadPage(true)} disabled={reviewLoading || !dataReady}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50" title="不用缓存,重新取这一屏">
          <RefreshCw className={cn("h-3.5 w-3.5", !dataReady && "animate-spin")} /> 刷新
        </button>
        {!dataReady && <span role="status" className="text-xs text-muted-foreground">数据分批返回中…</span>}
      </div>

      {pageErr && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          这一屏没取到：{pageErr}
          <span className="ml-1 text-destructive/80">—— 业务日与缺口提示都不可用。</span>
        </div>
      )}

      {/*
        🔴 **这一屏在看哪一天，要写在屏上**;缺了哪块也要说：没取到就说没取到，别让空白被读成"今天没有"。
           换了备用来源的块写出口径 —— 新浪的板块分类和净额算法都和东财不一样。
      */}
      {pageMeta && (
        <div className="mb-5 space-y-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-muted-foreground">
              业务日 <span className="font-medium text-foreground">{bizDay}</span>
              {ctx?.review_reason && <span className="ml-1 text-muted-foreground/70">（{ctx.review_reason}）</span>}
            </span>
            {pageMeta.mixed_ages && <span className="text-warning">⚠️ 这一屏的数据来自不同业务日，跨日比较要当心</span>}
            {ctx?.realtime_matches_review_day === false && <span className="text-warning">涨跌分布、板块资金、成交额榜三个源只给当天：现在显示的是今天此刻的快照，和业务日不是同一天</span>}
          </div>
          {pageMeta.blocks.some((b) => b.status !== "ok" || b.via_fallback) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              {pageMeta.blocks.filter((b) => b.status === "failed" || b.status === "missing").map((b) => (
                <span key={b.id}><span className="text-warning">缺</span> {b.title}（{blockWhy(b).slice(0, 40)}）</span>
              ))}
              {pageMeta.blocks.filter((b) => b.status === "partial").map((b) => <span key={b.id}>{b.title} 只取到一部分</span>)}
              {pageMeta.blocks.filter((b) => b.via_fallback).map((b) => <span key={b.id}>{b.title} 换了备用来源</span>)}
            </div>
          )}
        </div>
      )}

      {/* 0. 市场状态一眼看:全是事实与按固定规则算的数,不下判断 */}
      <Section icon={Gauge} title="市场状态" hint="一眼看全:涨跌面 · 量能 · 短线 · 中长线位置 · 杠杆 · 股债收益率">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat k="涨跌面" title={BREADTH_RULE} v={B ? <><span className="text-danger">{B.up ?? "—"}</span> / <span className="text-success">{B.down ?? "—"}</span></> : "—"}
            sub={B ? <>上涨占比 {shareText(B.upShare)}{B.label && <> · <span className="text-primary">{B.label}</span></>}{staleNote(pageMeta, "breadth", B.date) && " · 此刻快照"}</> : ovDone ? "没取到" : "加载中"} />
          <Stat k={`两市成交额${T?.amountDate ? ` · ${T.amountDate.slice(5)}` : ""}${T?.partial ? " · 盘中累计" : ""}`} v={T?.lastAmount != null ? yiText(T.lastAmount) : "—"}
            title={T?.partial ? "今天还没收盘:这是截至取数时刻的累计,不和整天的均值比" : undefined}
            sub={T?.lastAmount == null ? (ovDone ? "没取到" : "加载中")
              : T.partial ? <>还没收完 · 上一个交易日 {yiText(T.prevAmount)} · 20 日均 {yiText(T.ma20)}</>
              : <>比 20 日均 <span className={pctColor(T.vsMa20)}>{pctText(T.vsMa20, 1)}</span> · 60 日均 <span className={pctColor(T.vsMa60)}>{pctText(T.vsMa60, 1)}</span></>} />
          <Stat k="涨停 / 跌停" v={S ? <><span className="text-danger">{S.zt ?? "—"}</span> / <span className="text-success">{S.dt ?? "—"}</span></> : "—"}
            sub={S ? <>炸板 {S.zb ?? "—"} · 封板率 {shareText(S.sealRate)}</> : ovDone ? "没取到" : "加载中"} />
          <Stat k="连板高度" title={SPECULATION_RULE} v={S?.maxBoards != null ? `${S.maxBoards} 板` : "—"}
            sub={S ? <>2 板及以上 {S.lianban ?? "—"} 只{S.label && <> · 题材热度 <span className="text-primary">{S.label}</span></>}</> : ovDone ? "没取到" : "加载中"} />
          <Stat k="昨日涨停今日" v={<span className={pctColor(S?.yesterday?.avg)}>{pctText(S?.yesterday?.avg)}</span>}
            sub={S?.yesterday ? <>平均涨跌 · 上涨占比 {shareText(S.yesterday.upShare)} · 晋级 {shareText(S.promotionAll?.rate)}</> : ovDone ? "没取到" : "加载中"} />
          <Stat k="站上 20 日线的指数" title="收盘价 ≥ 均线的指数个数 / 取到的指数个数;只是位置关系" v={aboveCount("ma20")}
            sub={<>站上 60 日线 {aboveCount("ma60")} · 250 日线 {aboveCount("ma250")}</>} />
          <Stat k={`两融余额${M?.date ? ` · ${M.date.slice(5)}` : ""}`} v={M?.balance != null ? yiText(M.balance) : "—"}
            sub={M ? <>比 5 个交易日前 <span className={pctColor(M.chg5)}>{signedYi(M.chg5)}</span></> : ovDone ? "没取到" : "加载中"} />
          <Stat k={`沪深300${V?.date ? ` · ${V.date.slice(5)}` : ""}`} title="市盈率、股息率来自中证官网(总股本口径);10 年国债来自中债。只是收益率的差,不是估值判断"
            v={V?.pe != null ? `${V.pe} 倍` : "—"}
            sub={V ? <>股息率 {V.dy ?? "—"}% · 10 年国债 {V.y10 ?? "—"}%</> : ovDone ? "没取到" : "加载中"} />
        </div>
      </Section>

      {/* 1. 指数 */}
      <Section icon={TrendingUp} title="主要指数" hint={T?.date ? `截至 ${T.date}${ctx?.live ? "(盘中,收盘前还会变)" : ""} · 按收盘价` : undefined}>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {idx.length === 0
            ? [1, 2, 3, 4].map((i) => (
                <GlassCard key={i} className="p-3">
                  <p className="text-xs text-muted-foreground">{ovDone ? "指数没取到" : "加载中…"}</p>
                  <p className="mt-1 font-mono text-lg font-bold text-muted-foreground/40">—</p>
                </GlassCard>
              ))
            : idx.map((i) => (
                <GlassCard key={i.code} className="p-3">
                  <p className="truncate text-xs text-muted-foreground">{i.name}</p>
                  <p className={cn("mt-1 font-mono text-lg font-bold", pctColor(i.chg))}>{fmt(i.close)}</p>
                  <p className={cn("text-xs", pctColor(i.chg))}>{pctText(i.chg)}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">20 日 <span className={pctColor(i.r20)}>{pctText(i.r20, 1)}</span> · 60 日 <span className={pctColor(i.r60)}>{pctText(i.r60, 1)}</span></p>
                </GlassCard>
              ))}
        </div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Globe className="h-4 w-4 text-muted-foreground" /> 全球市场</h3>
          <span className="text-[11px] text-muted-foreground/70">腾讯行情快照 · 非逐笔实时行情</span>
        </div>
        {globalIdx.length === 0 && <p role="status" className="mb-2 text-sm text-muted-foreground">
          {globalErr ?? (globalDone ? "全球指数未取得可用数据，不代表市场没有变化。" : "全球指数加载中…")}
        </p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {globalIdx.map((g) => (
            <GlassCard key={g.key} className="p-3">
              <p className="truncate text-xs text-muted-foreground">{g.name} <span className="text-muted-foreground/40">{g.region}</span></p>
              <p title={`取数时间：${g.fetched_at ?? "未知"}；价格证据：${g.evidence_id ?? "未取得"}`} className={cn("mt-1 font-mono text-lg font-bold", g.change_pct == null ? "text-foreground" : pctColor(g.change_pct))}>{g.price ?? "—"}</p>
              <p className={cn("text-xs", g.change_pct == null ? "text-muted-foreground" : pctColor(g.change_pct))}>
                {g.change_pct == null ? "—" : `${g.change_pct > 0 ? "+" : ""}${g.change_pct}%`}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">{g.fetched_at ? `取数：${new Date(g.fetched_at).toLocaleString()}` : "取数时间未知"}</p>
              {g.note && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{g.note}</p>}
            </GlassCard>
          ))}
        </div>
      </Section>

      {/* 2. Agent 复盘 */}
      <GlassCard glow className="mb-8">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 font-semibold"><Sparkles className="h-4 w-4 text-primary" /> Agent 复盘</h3>
          <button onClick={runReview} disabled={reviewLoading || !dataReady}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/25 disabled:opacity-50">
            {reviewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {!dataReady ? "等待本轮数据…" : review ? "重新复盘" : `让 Agent 复盘${bizDay ? ` ${bizDay}` : ""}`}
          </button>
        </div>
        {needConfig && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
            Agent 还没有可用模型。<Link to="/settings" className="text-primary">先为 Agent 选择模型</Link>，之后一键出复盘。
          </div>
        )}
        {reviewErr && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" /> {reviewErr}
          </div>
        )}
        {review ? (
          <>
            <div className="prose prose-sm dark:prose-invert mt-4 max-w-none text-foreground"><ReactMarkdown remarkPlugins={[remarkGfm]} components={noRemoteImages}>{review}</ReactMarkdown></div>
            {!reviewLoading && reviewDay !== bizDay && (
              <p className="mt-3 text-xs text-warning">这份复盘是按 {reviewDay ?? "业务日未知"} 的数据写的，这一屏已经换成 {bizDay ?? "业务日未知"}；要按现在的数据请点「重新复盘」。</p>
            )}
            {!reviewLoading && <div className="mt-3"><SaveNoteButton kind="复盘" title={`每日复盘 ${reviewDay ?? "（业务日未知）"}`} content={review} /></div>}
          </>
        ) : !needConfig && !reviewErr && !reviewLoading ? (
          <p className="mt-3 text-sm text-muted-foreground">
            快速复盘会把这一屏已经取到的客观数据、缺口与读法护栏交给所选模型整理；它不会启动完整研究工具链。
            需要完整的多阶段流程，请进入<Link to="/research" className="text-primary hover:underline">个股研究</Link>。
          </p>
        ) : null}
      </GlassCard>

      {/* 3. 短线 */}
      <Section icon={Flame} title="短线情绪" hint="涨跌分布 · 赚钱效应 / 亏钱效应 · 晋级 · 连板股 · 涨停分档;客观公开榜单,非推荐">
        <GlassCard className="mb-4">
          <BlockHead title="涨跌分布" page={pageMeta} id="breadth" date={B?.date ?? null}
            extra={B && <span className="text-[11px] text-muted-foreground">上涨 {B.up ?? "—"} · 平盘 {B.flat ?? "—"} · 下跌 {B.down ?? "—"} · 涨 5% 以上 {B.up5 ?? "—"} · 跌 5% 以上 {B.down5 ?? "—"}</span>} />
          {!distOption ? <Pending page={pageMeta} id="breadth" done={ovDone} /> : <>
            <EChart option={distOption} height={220} />
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border/50 text-left text-muted-foreground">{["", "上涨", "下跌", "平盘", "成交额"].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {B!.exchanges.map((x) => (
                    <tr key={x.market} className="border-b border-border/30">
                      <td className="px-2 py-1.5">{x.name}</td>
                      <td className="px-2 py-1.5 font-mono text-danger">{x.up ?? "—"}</td>
                      <td className="px-2 py-1.5 font-mono text-success">{x.down ?? "—"}</td>
                      <td className="px-2 py-1.5 font-mono">{x.flat ?? "—"}</td>
                      <td className="px-2 py-1.5 font-mono">{yiText(x.amount)}</td>
                    </tr>
                  ))}
                  <tr><td className="px-2 py-1.5 text-muted-foreground">合计</td><td colSpan={3} className="px-2 py-1.5 text-[11px] text-muted-foreground">三所家数口径与上面的分布不同,不互相凑</td><td className="px-2 py-1.5 font-mono">{yiText(B!.amount)}</td></tr>
                </tbody>
              </table>
            </div>
          </>}
        </GlassCard>

        {!S ? <GlassCard className="mb-4"><Pending page={pageMeta} id="sentiment" done={ovDone} /></GlassCard> : <>
          <div className="mb-4 grid gap-3 md:grid-cols-2">
            <GlassCard className="min-w-0">
              <BlockHead title="赚钱效应" page={pageMeta} id="yzt" date={S.dates.yzt} />
              <div className="grid grid-cols-3 gap-2">
                <Stat k="昨日涨停今日平均" v={<span className={pctColor(S.yesterday?.avg)}>{pctText(S.yesterday?.avg)}</span>} sub={`中位数 ${pctText(S.yesterday?.median)}`} />
                <Stat k="其中上涨的" v={shareText(S.yesterday?.upShare)} sub={S.yesterday ? `${S.yesterday.up} 涨 / ${S.yesterday.down} 跌` : "没取到"} />
                <Stat k="晋级(又涨停)" v={shareText(S.promotionAll?.rate)} sub={S.promotionAll ? `${S.promotionAll.promoted} / ${S.promotionAll.base} 只` : S.promotionGap || "—"} />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">昨天涨停的那批今天逐只算:接力买入的人今天平均赚没赚钱。封板率 {shareText(S.sealRate)}(涨停 ÷(涨停 + 炸板))。</p>
            </GlassCard>
            <GlassCard className="min-w-0">
              <BlockHead title="亏钱效应" page={pageMeta} id="sentiment" date={S.dates.sentiment} />
              <div className="grid grid-cols-3 gap-2">
                <Stat k="跌停" v={<span className="text-success">{S.dt ?? "—"}</span>} />
                <Stat k="炸板" v={S.zb ?? "—"} sub={`炸板率 ${shareText(S.sealRate === null ? null : 1 - S.sealRate)}`} />
                <Stat k="昨日涨停今大跌" v={S.yesterday ? `${S.yesterday.loss5} 只` : "—"} sub={S.yesterday ? `跌 5% 以上;其中跌 9% 以上 ${S.yesterday.loss9}` : "没取到"} />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">炸板 = 盘中摸到涨停又打开;昨日涨停今天大跌 = 接力被套。</p>
            </GlassCard>
          </div>

          <GlassCard className="mb-4">
            <BlockHead title="晋级与连板" page={pageMeta} id="zt_pool" date={S.dates.zt}
              extra={<span className="text-[11px] text-muted-foreground">今天分层:{S.ladder.map((x) => `${x.boards === 1 ? "首板" : `${x.boards} 板${x.plus ? "及以上" : ""}`} ${x.count}`).join(" · ") || "—"}</span>} />
            {S.promotion ? (
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {S.promotion.map((t) => (
                  <Stat key={t.from} k={t.label} v={shareText(t.rate)} sub={`昨天 ${t.base} 只,今天又涨停 ${t.promoted}`} />
                ))}
              </div>
            ) : <p className="mb-3 text-xs text-muted-foreground">{S.promotionGap}</p>}
            <p className="mb-1.5 text-[11px] text-muted-foreground">连板股(2 板以上连续涨停)· 价格与成交额是业务日那天的 · 题材是同花顺的市场叙事,不是核验过的因果 · 非推荐 / 非预测</p>
            {lianban.length === 0 ? <p className="text-xs text-muted-foreground/70">{S.stocks.length ? "这一天没有 2 板以上的个股" : "涨停池没取到"}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                      {["名称", "连板", "首封", "价格", "成交额", "流通市值", "行业", "同花顺题材"].map((h) => <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {lianban.slice(0, 40).map((s) => (
                      <tr key={s.code} className="border-b border-border/30">
                        <td className="whitespace-nowrap px-2 py-2"><span className="font-medium">{s.name || s.code}</span> <span className="text-xs text-muted-foreground/60">{s.code}</span></td>
                        <td className="whitespace-nowrap px-2 py-2 font-mono font-bold text-primary">{s.boards} 板</td>
                        <td className="px-2 py-2 font-mono text-xs">{s.firstSeal ?? "—"}</td>
                        <td className="px-2 py-2 font-mono">{fmt(s.price)}</td>
                        <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yiText(s.amount)}</td>
                        <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yiText(s.floatCap)}</td>
                        <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{s.industry}</td>
                        <td className="min-w-[10rem] px-2 py-2 text-xs text-muted-foreground">{s.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </GlassCard>
        </>}

        {/* 涨停分档(按行业、和前两个交易日比;每组的最高板与梯队) */}
        <ReviewTiersCard data={bizDay && tiers?.date === bizDay ? tiers : null} loading={tiersLoading || (!bizDay && !ovDone)} error={tiersErr}
          bizDay={bizDay} onRefresh={() => { if (bizDay) void loadTiers(bizDay, true); }} />
      </Section>

      {/* 4. 中长线 */}
      <Section icon={Activity} title="中长线" hint="趋势 · 量能 · 杠杆 · 股债收益率;都是按固定公式算的事实,不是趋势判断">
        <GlassCard className="mb-4">
          <BlockHead title="主要指数的中长期位置" page={pageMeta} id="trend" date={T?.date ?? null} />
          {!T || idx.length === 0 ? <Pending page={pageMeta} id="trend" done={ovDone} /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                    {["指数", "收盘", "当日", "5 日", "20 日", "60 日", "250 日", "年初至今", "离一年高点", "20 / 60 / 250 日线"].map((h) => <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {idx.map((i) => (
                    <tr key={i.code} className="border-b border-border/30">
                      <td className="whitespace-nowrap px-2 py-2 font-medium">{i.name}</td>
                      <td className="px-2 py-2 font-mono">{fmt(i.close)}</td>
                      {[i.chg, i.r5, i.r20, i.r60, i.r250, i.ytd].map((v, k) => <td key={k} className={cn("whitespace-nowrap px-2 py-2 font-mono", pctColor(v))}>{pctText(v)}</td>)}
                      <td className={cn("whitespace-nowrap px-2 py-2 font-mono", pctColor(i.offHigh))} title={i.high250Date ? `一年最高收盘 ${fmt(i.high250)}(${i.high250Date})` : undefined}>{pctText(i.offHigh)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-xs">
                        {([["20", i.ma20], ["60", i.ma60], ["250", i.ma250]] as const).map(([n, ma]) => {
                          const a = aboveMa(i.close, ma);
                          return <span key={n} title={ma == null ? `${n} 日均线没算出来(日线不够)` : `${n} 日均线 ${fmt(ma)}`} className={cn("mr-1.5", a === null ? "text-muted-foreground/50" : a ? "text-danger" : "text-success")}>{a === null ? "—" : a ? "上" : "下"}</span>;
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-muted-foreground">N 日涨跌 = 最新收盘 ÷ N 个交易日前收盘 − 1;离一年高点 = 最新收盘 ÷ 250 日最高收盘 − 1;「上 / 下」= 收盘在均线上方 / 下方。{T.missing.length > 0 && <span className="text-warning"> 缺:{T.missing.join(";")}</span>}</p>
            </div>
          )}
        </GlassCard>

        <div className="mb-4 grid gap-3 lg:grid-cols-2">
          <GlassCard className="min-w-0">
            <BlockHead title="两市成交额(亿元)" page={pageMeta} id="trend" date={T?.amountDate ?? null}
              extra={T?.lastAmount != null && <span className="text-[11px] text-muted-foreground">{T.partial ? `今天盘中累计 ${yiText(T.lastAmount)}(灰色那根,还没收完)` : `最新 ${yiText(T.lastAmount)}`} · 20 日均 {yiText(T.ma20)} · 60 日均 {yiText(T.ma60)}</span>} />
            {!amountOption ? <Pending page={pageMeta} id="trend" done={ovDone} /> : <EChart option={amountOption} height={220} />}
            <p className="mt-1 text-[11px] text-muted-foreground">沪深两市成交额 = 上证指数成交额 + 深证综指成交额;虚线是{T?.partial ? "截至上一个交易日(不含今天没收完的)" : "截至最新一天"}的 20 / 60 日均值。</p>
          </GlassCard>
          <GlassCard className="min-w-0">
            <BlockHead title="两融余额(亿元)" page={pageMeta} id="margin" date={M?.date ?? null}
              extra={<span className="text-[11px] text-muted-foreground">T 日数据 T+1 发布</span>} />
            {!marginOption || !M ? <Pending page={pageMeta} id="margin" done={ovDone} /> : <>
              <EChart option={marginOption} height={160} />
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Stat k="比 5 个交易日前" v={<span className={pctColor(M.chg5)}>{signedYi(M.chg5)}</span>} />
                <Stat k="比 20 个交易日前" v={<span className={pctColor(M.chg20)}>{signedYi(M.chg20)}</span>} />
                <Stat k="近 5 日融资净买入" v={<span className={pctColor(M.netBuy5)}>{signedYi(M.netBuy5)}</span>} sub={`融资余额占流通市值 ${M.floatPct == null ? "—" : `${M.floatPct.toFixed(2)}%`}`} />
              </div>
            </>}
          </GlassCard>
        </div>

        <GlassCard>
          <BlockHead title="沪深300 估值与国债收益率" page={pageMeta} id="valuation" date={V?.date ?? null} />
          {!V ? <Pending page={pageMeta} id="valuation" done={ovDone} /> : <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat k="市盈率" v={V.pe != null ? `${V.pe} 倍` : "—"} sub={`计算用股本口径 ${V.peCalc ?? "—"} 倍`} />
              <Stat k="股息率" v={V.dy != null ? `${V.dy}%` : "—"} sub={`计算用股本口径 ${V.dyCalc ?? "—"}%`} />
              <Stat k="10 年国债收益率" v={V.y10 != null ? `${V.y10}%` : "—"} sub={V.y10Date ?? undefined} />
              <Stat k="差值(百分点)" v={V.dySpread != null ? `${V.dySpread > 0 ? "+" : ""}${V.dySpread}` : "—"} sub={`股息率 − 国债;盈利收益率 − 国债 ${V.eySpread == null ? "—" : `${V.eySpread > 0 ? "+" : ""}${V.eySpread}`}`} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">盈利收益率 = 1 ÷ 市盈率 = {V.ey ?? "—"}%。市盈率、股息率是中证官网指标文件(总股本口径,不含市净率),国债是中债国债收益率曲线。只是两组收益率的差,不是估值高低的判断。</p>
          </>}
        </GlassCard>
      </Section>

      {/* 5. 资金 */}
      <Section icon={Coins} title="资金去了哪" hint="行业资金 · 成交额居前 · 龙虎榜;客观公开榜单,非推荐 / 非预测">
        <GlassCard className="mb-4">
          <BlockHead title={`行业资金${F ? `(${F.source}口径)` : ""}`} page={pageMeta} id="board_flow" date={F?.date ?? null} />
          {!F || F.rows.length === 0 ? <Pending page={pageMeta} id="board_flow" done={ovDone} /> : (
            <div className="grid gap-4 md:grid-cols-2">
              {[
                { title: "净流入居前", icon: TrendingUp, color: "text-danger", rows: flowIn },
                { title: "净流出居前", icon: TrendingDown, color: "text-success", rows: flowOut },
              ].map((col) => (
                <div key={col.title}>
                  <h4 className={cn("mb-2 flex items-center gap-1.5 text-xs font-semibold", col.color)}><col.icon className="h-3.5 w-3.5" /> {col.title}</h4>
                  {col.rows.length === 0 ? <p className="text-xs text-muted-foreground">没有{col.title.slice(0, 3)}的行业</p> : (
                    <div className="space-y-1.5">
                      {col.rows.map((s, i) => (
                        <div key={s.name} className="flex items-center gap-3 border-b border-border/30 pb-1.5 text-sm last:border-0">
                          <span className="w-5 text-xs text-muted-foreground/50">{i + 1}</span>
                          <span className="flex-1 truncate" title={s.leader ? `领涨 ${s.leader}` : undefined}>{s.name}</span>
                          <span className={cn("font-mono text-xs", pctColor(s.pct))}>{pctText(s.pct)}</span>
                          <span className={cn("w-24 text-right font-mono text-xs", pctColor(s.net))}>{signedYi(s.net)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {F && <p className="mt-2 text-[11px] text-muted-foreground">{F.source === "新浪" ? "新浪口径:净额 = 流入 − 流出,行业是新浪自己的分类,和东财「主力净额」不是一个算法。" : "东财口径:主力净额(超大单 + 大单),全市场行业板块。"}按净额正负分流入 / 流出。</p>}
        </GlassCard>

        <GlassCard className="mb-4">
          <BlockHead title="全市场成交额居前 20" page={pageMeta} id="turnover" date={TV?.date ?? null} />
          {!TV || TV.rows.length === 0 ? <Pending page={pageMeta} id="turnover" done={ovDone} /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                    {["#", "名称", "价格", "涨跌", "成交额", ...(hasMcap ? ["总市值"] : []), ...(hasIndustry ? ["行业"] : [])].map((h) => <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {TV.rows.map((s, i) => (
                    <tr key={s.code} className="border-b border-border/30">
                      <td className="px-2 py-2 font-mono text-xs text-muted-foreground/50">{i + 1}</td>
                      <td className="whitespace-nowrap px-2 py-2"><span className="font-medium">{s.name || s.code}</span> <span className="text-xs text-muted-foreground/60">{s.code}</span></td>
                      <td className="px-2 py-2 font-mono">{fmt(s.price)}</td>
                      <td className={cn("px-2 py-2 font-mono", pctColor(s.pct))}>{pctText(s.pct)}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono">{yiText(s.amount)}</td>
                      {hasMcap && <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yiText(s.mcap)}</td>}
                      {hasIndustry && <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{s.industry}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>

        <GlassCard>
          <BlockHead title="龙虎榜" page={pageMeta} id="dragon" date={D?.date ?? null}
            extra={D && <span className="text-[11px] text-muted-foreground">{D.stocks} 只上榜</span>} />
          {!D ? <Pending page={pageMeta} id="dragon" done={ovDone} /> : (D.buy.length + D.sell.length === 0) ? <p className="py-3 text-sm text-muted-foreground">这一天的榜单还没出(龙虎榜收盘后才发布)或为空。</p> : (
            <div className="grid gap-4 md:grid-cols-2">
              {[
                { title: "净买入居前", rows: D.buy, color: "text-danger" },
                { title: "净卖出居前", rows: D.sell, color: "text-success" },
              ].map((col) => (
                <div key={col.title}>
                  <h4 className={cn("mb-2 text-xs font-semibold", col.color)}>{col.title}</h4>
                  <div className="space-y-1.5">
                    {col.rows.map((x) => (
                      <div key={x.code} className="border-b border-border/30 pb-1.5 text-sm last:border-0">
                        <div className="flex items-center gap-2">
                          <span className="flex-1 truncate"><span className="font-medium">{x.name || x.code}</span> <span className="text-xs text-muted-foreground/60">{x.code}</span></span>
                          <span className={cn("font-mono text-xs", pctColor(x.pct))}>{pctText(x.pct)}</span>
                          <span className={cn("w-24 text-right font-mono text-xs", pctColor(x.net))}>{signedYi(x.net)}</span>
                        </div>
                        <p className="truncate text-[11px] text-muted-foreground" title={x.reason}>{x.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">同一只可能因几条上榜理由各出现一次(统计区间不同),净额不相加,每只只列一条。</p>
        </GlassCard>
      </Section>

      <p className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Landmark className="h-3.5 w-3.5" /> <BarChart3 className="h-3.5 w-3.5" /> 数据来自东财、腾讯、新浪、同花顺、中证指数、中债等公开来源,各块标了自己的数据日与口径。</p>
      <Disclaimer />
    </div>
  );
}
