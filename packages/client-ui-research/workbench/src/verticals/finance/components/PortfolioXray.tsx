import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw, SlidersHorizontal } from "lucide-react";

import { EChart } from "@/components/ui/EChart";
import { GlassCard } from "@/components/ui/GlassCard";
import { usePalette } from "@/components/ui/chartPalette";
import { ApiError, backend } from "@/lib/backend";
import type { Holding } from "@/lib/api";
import { holdingsSig, holdingValues, valuesDrifted, type HoldingValues } from "@/lib/holdingsDrift";
import { storageGet, storageSet } from "@/lib/storage";
import { workspaceRoot } from "@/lib/workspace";
import {
  bucketMembers, correlationOption, DEFAULT_THRESHOLDS, findBreaches, NON_INDUSTRY_BUCKETS, parseThresholds, parseXray, pct, riskShareOption,
  THRESHOLDS_KEY, type XrayBreach, type XrayGroup, type XrayResult, type XrayThresholds,
} from "@/lib/xrayView";

/** 同一组持仓半小时内不重复体检：历史价格一天才变一次，没必要每次进页面都重取。持仓变没变看 holdingsDrift。 */
const CACHE_MS = 30 * 60 * 1000;
let cache: { sig: string; values: HoldingValues; at: number; result: XrayResult } | null = null;

const XRAY_ID = "portfolio-xray";
/** 滚到体检卡。卡片在「持仓体检」分页里，没切过去时不在页面上：调用方先切分页，等挂上再滚（审计第三轮 C6） */
export const scrollToXray = () => requestAnimationFrame(() => requestAnimationFrame(() =>
  workspaceRoot().querySelector<HTMLElement>(`#${XRAY_ID}`)?.scrollIntoView({ behavior: "smooth", block: "start" })));

export interface PortfolioXrayState {
  result: XrayResult | null;
  loading: boolean;
  run: (force?: boolean) => void;
  thresholds: XrayThresholds;
  setThresholds: (t: XrayThresholds) => void;
  breaches: XrayBreach[];
}

/** 持仓变了（代码、股数、名称，或市值变了 2% 以上）就自动体检一次；结果、提醒线、超线项给横幅和体检卡共用。 */
export function usePortfolioXray(holdings: Holding[]): PortfolioXrayState {
  const [result, setResult] = useState<XrayResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [thresholds, setTh] = useState<XrayThresholds>(() => parseThresholds(storageGet(THRESHOLDS_KEY)));
  const ctl = useRef<AbortController | null>(null);
  const [ran, setRan] = useState<HoldingValues | null>(null);
  const sig = holdingsSig(holdings);
  const latest = useRef(holdings);
  latest.current = holdings;

  const run = useCallback((force = false) => {
    const hs = latest.current;
    // 先作废还在跑的那次：下面命中缓存、持仓清空直接返回时，旧请求迟到的结果不能再盖上来（审计 C7）
    ctl.current?.abort();
    if (!hs.length) { setRan(null); setResult(null); setLoading(false); return; }
    const s = holdingsSig(hs);
    const values = holdingValues(hs);
    if (!force && cache && cache.sig === s && !valuesDrifted(cache.values, hs) && Date.now() - cache.at < CACHE_MS) {
      setRan(cache.values); setResult(cache.result); setLoading(false); return;
    }
    setRan(values);
    // 持仓变了要重算：旧结果是旧持仓的，先撤下，不在等新结果时当成现在的给横幅和 AI（审计第三轮 C3）
    setResult(null);
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    // 没取到现价的那只 value 传 null，工具会把它列进缺口，而不是当 0 算
    const positions = hs.map((h) => ({ symbol: h.code, name: h.name, value: h.market_value }));
    backend.runTool<unknown>("xray", { positions, charts: true }, c.signal)
      .then((out) => {
        if (c.signal.aborted) return;
        const r = parseXray(out);
        if (r.ok) cache = { sig: s, values, at: Date.now(), result: r };
        setResult(r);
      })
      .catch((e) => { if (!c.signal.aborted) setResult({ ok: false, error: e instanceof ApiError ? e.message : String(e) }); })
      .finally(() => { if (!c.signal.aborted) setLoading(false); });
  }, []);

  useEffect(() => { run(false); }, [sig, run]);
  // 股数没变、市值相对上次体检变了 2% 以上，也重算一次
  const drifted = ran !== null && valuesDrifted(ran, holdings);
  useEffect(() => { if (drifted) run(false); }, [drifted, run]);
  useEffect(() => () => ctl.current?.abort(), []);

  const setThresholds = useCallback((t: XrayThresholds) => { setTh(t); storageSet(THRESHOLDS_KEY, JSON.stringify(t)); }, []);
  const breaches = useMemo(() => (result?.ok ? findBreaches(result.view, thresholds) : []), [result, thresholds]);
  return { result, loading, run, thresholds, setThresholds, breaches };
}

/** 页面顶部的横幅：只说哪几项超过了用户自己设的线，不打分。 */
export function XrayBanner({ x, onOpen }: { x: PortfolioXrayState; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  if (x.loading && !x.result) {
    return <p className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在做持仓体检…</p>;
  }
  if (!x.result?.ok || !x.result.view.groups.some((g) => g.metrics)) return null;
  if (!x.breaches.length) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
        持仓体检：没有超过你设的提醒线。<button onClick={onOpen} className="ml-auto underline-offset-2 hover:underline">看体检明细</button>
      </div>
    );
  }
  const shown = open ? x.breaches : x.breaches.slice(0, 3);
  return (
    <div role="status" className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
        持仓体检：{x.breaches.length} 项超过你设的提醒线
        <button onClick={onOpen} className="ml-auto text-xs font-normal text-muted-foreground underline-offset-2 hover:underline">看体检明细 / 改提醒线</button>
      </div>
      <ul className="mt-1.5 space-y-0.5 pl-6 text-xs text-muted-foreground">
        {shown.map((b, i) => <li key={i}><span className="text-foreground/70">{b.group}</span> · {b.text}</li>)}
      </ul>
      {x.breaches.length > 3 && (
        <button onClick={() => setOpen(!open)} className="mt-1 pl-6 text-xs text-muted-foreground hover:text-foreground">
          {open ? "收起" : `还有 ${x.breaches.length - 3} 项`}
        </button>
      )}
    </div>
  );
}

const TH_FIELDS: { key: keyof XrayThresholds; label: string; unit: "%" | "r"; hint: string }[] = [
  { key: "single", label: "单只占比", unit: "%", hint: "任何一只超过这个比例就提醒（这一组只有一只时不比）" },
  { key: "top3", label: "前三只合计", unit: "%", hint: "持仓超过三只时才比较" },
  { key: "industry", label: "单一行业", unit: "%", hint: "A 股按申万一级，港美股按 GICS 一级" },
  { key: "corr", label: "两只的相关系数", unit: "r", hint: "−1 到 1，越接近 1 走势越像" },
];

function ThresholdEditor({ value, onChange }: { value: XrayThresholds; onChange: (t: XrayThresholds) => void }) {
  const show = (k: keyof XrayThresholds, unit: "%" | "r") => {
    const v = value[k];
    return v === null ? "" : unit === "%" ? String(Math.round(v * 1000) / 10) : String(v);
  };
  const [draft, setDraft] = useState(() => Object.fromEntries(TH_FIELDS.map((f) => [f.key, show(f.key, f.unit)])) as Record<keyof XrayThresholds, string>);
  const [err, setErr] = useState("");
  const commit = (k: keyof XrayThresholds, unit: "%" | "r", text: string) => {
    const t = text.trim();
    if (!t) { setErr(""); onChange({ ...value, [k]: null }); return; }
    const n = Number(t);
    const v = unit === "%" ? n / 100 : n;
    if (!Number.isFinite(n) || v <= 0 || v > 1) {
      setErr(unit === "%" ? "占比要填 0 到 100 之间的数" : "相关系数要填 0 到 1 之间的数");
      return;
    }
    setErr("");
    onChange({ ...value, [k]: v });
  };
  return (
    <div className="mb-4 rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex flex-wrap items-end gap-3">
        {TH_FIELDS.map((f) => (
          <label key={f.key} className="space-y-1" title={f.hint}>
            <span className="block text-[11px] text-muted-foreground">{f.label}{f.unit === "%" ? "（%）" : ""}</span>
            <input
              value={draft[f.key]} inputMode="decimal" placeholder="不提醒" aria-label={`${f.label}提醒线`}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              onBlur={(e) => commit(f.key, f.unit, e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commit(f.key, f.unit, (e.target as HTMLInputElement).value); }}
              className="w-24 rounded-md border border-border bg-background/60 px-2 py-1 font-mono text-sm"
            />
          </label>
        ))}
        <button
          onClick={() => { onChange({ ...DEFAULT_THRESHOLDS }); setDraft(Object.fromEntries(TH_FIELDS.map((f) => [f.key, f.unit === "%" ? String((DEFAULT_THRESHOLDS[f.key] ?? 0) * 100) : String(DEFAULT_THRESHOLDS[f.key])])) as Record<keyof XrayThresholds, string>); setErr(""); }}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        >恢复起点值</button>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        提醒线由你自己定，留空就不提醒这一项。起点值只是方便第一次用，不是我们的建议；超线只说明数字超过了你设的线，不代表好坏。
      </p>
      {err && <p role="alert" className="mt-1 text-xs text-destructive">{err}</p>}
    </div>
  );
}

function Tile({ k, v, sub, title }: { k: string; v: string; sub?: string; title?: string }) {
  return (
    <div className="rounded-lg bg-muted/30 p-3" title={title}>
      <p className="text-[11px] text-muted-foreground">{k}</p>
      <p className="mt-0.5 font-mono text-base font-bold">{v}</p>
      {sub && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{sub}</p>}
    </div>
  );
}

function GroupView({ g, palette }: { g: XrayGroup; palette: ReturnType<typeof usePalette> }) {
  const m = g.metrics;
  const risk = useMemo(() => riskShareOption(g, palette), [g, palette]);
  const corr = useMemo(() => correlationOption(g, palette), [g, palette]);
  const nameOf = (s: string) => g.positions.find((p) => p.symbol === s)?.name || s;
  return (
    <div className="border-t border-border/40 pt-4 first:border-t-0 first:pt-0">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="font-semibold">{g.label}</h4>
        <span className="text-xs text-muted-foreground">纳入 {g.included} / {g.input} 只</span>
        {m?.window && <span className="text-xs text-muted-foreground">回看 {m.window.first} 至 {m.window.last}（{m.window.days} 个交易日）</span>}
      </div>
      {m && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile k="最大一只" v={pct(m.top1?.weight ?? null)} sub={m.top1 ? (m.top1.name || m.top1.symbol) : undefined} />
            <Tile k="前三只合计" v={pct(m.top3Weight)} sub={g.positions.length <= 3 ? `只有 ${g.positions.length} 只，必然是 100%` : undefined} />
            <Tile k="等效持股数" v={m.effectiveN === null ? "—" : m.effectiveN.toFixed(1)} sub="按集中度折算，相当于平均持有几只"
              title="1 ÷ 各只占比平方和。持 10 只但有一只占一半，等效只有两三只" />
            <Tile k="年化波动" v={pct(m.annualizedVol)} sub={m.downsideVol === null ? undefined : `只算下跌的波动 ${pct(m.downsideVol)}`} />
            <Tile k="最大回撤" v={pct(m.maxDrawdown)} sub={m.maxDrawdownStart && m.maxDrawdownTrough ? `${m.maxDrawdownStart} → ${m.maxDrawdownTrough}` : undefined} />
            <Tile k="单日 95% VaR" v={pct(m.var95, 2)} sub={m.es95 === null ? undefined : `最差那 5% 的日子平均跌 ${pct(m.es95, 2)}`}
              title="过去一年里，有 5% 的交易日，按现在的比例算组合单日跌幅超过这个数" />
            <Tile k="平均相关性" v={m.avgAbsCorr === null ? "—" : m.avgAbsCorr.toFixed(2)} sub="两两相关系数取绝对值后的平均" />
            <Tile k="走势最像的一对" v={m.maxCorrPair?.corr == null ? "—" : m.maxCorrPair.corr.toFixed(2)}
              sub={m.maxCorrPair ? `${nameOf(m.maxCorrPair.symbols[0])} × ${nameOf(m.maxCorrPair.symbols[1])}` : "只有一只，没有可比的"} />
          </div>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            {risk && (
              <div>
                <p className="mb-1 text-xs font-medium">资金占比 vs 风险贡献</p>
                <EChart option={risk} height={Math.max(160, 48 + g.positions.length * 34)} />
                <p className="text-[11px] text-muted-foreground">风险贡献明显高于资金占比的，是组合波动的主要来源；加起来是 100%。</p>
              </div>
            )}
            {corr && (
              <div>
                <p className="mb-1 text-xs font-medium">两两相关系数</p>
                <EChart option={corr} height={Math.max(220, 90 + g.positions.length * 30)} />
              </div>
            )}
          </div>
          {g.industry && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium">行业暴露 <span className="font-normal text-muted-foreground">· {g.industry.classification}</span></p>
              <div className="space-y-1.5">
                {g.industry.buckets.map((b) => (
                  <div key={b.name}>
                    <div className="flex items-center gap-2 text-xs">
                      <span title={b.name} className={`w-32 shrink-0 truncate sm:w-52 ${NON_INDUSTRY_BUCKETS.includes(b.name) ? "text-muted-foreground" : ""}`}>{b.name}</span>
                      <div className="h-2 flex-1 rounded bg-muted/40"><div className="h-2 rounded bg-primary/70" style={{ width: `${Math.min(100, (b.weight ?? 0) * 100)}%` }} /></div>
                      <span className="w-14 text-right font-mono">{pct(b.weight)}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground sm:pl-[13.5rem]">{bucketMembers(g, b.symbols)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {g.gaps.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-medium">缺口</p>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            {g.gaps.map((x, i) => <li key={i}><span className="font-mono">{x.name ? `${x.name} ${x.symbol}` : x.symbol}</span>：{x.reason}</li>)}
          </ul>
        </div>
      )}
      <div className="space-y-0.5 text-[11px] leading-5 text-muted-foreground">
        {g.notes.map((n) => <p key={n}>{n}</p>)}
        {g.sources.length > 0 && <p>价格来源：{g.sources.join("、")}</p>}
      </div>
    </div>
  );
}

/** 体检明细卡：各币种分组的指标、风险贡献、相关性、行业暴露、缺口，以及提醒线设置。 */
export function PortfolioXrayCard({ x }: { x: PortfolioXrayState }) {
  const palette = usePalette();
  const [editing, setEditing] = useState(false);
  const r = x.result;
  return (
    <section id={XRAY_ID} className="mb-4 mt-6 scroll-mt-4">
    <GlassCard>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <h3 className="font-semibold">持仓体检</h3>
        <span className="text-xs text-muted-foreground">按币种分开算；只给数字，不打分</span>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setEditing(!editing)} aria-expanded={editing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            <SlidersHorizontal className="h-3.5 w-3.5" />提醒线
          </button>
          <button onClick={() => x.run(true)} disabled={x.loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
            {x.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}重新体检
          </button>
        </div>
      </div>
      {editing && <ThresholdEditor value={x.thresholds} onChange={x.setThresholds} />}
      {!r && x.loading && <p className="text-sm text-muted-foreground">正在取每只的历史价格并计算，持仓多时要十几秒…</p>}
      {!r && !x.loading && <p className="text-sm text-muted-foreground">还没有持仓，添加之后会自动体检。</p>}
      {r && !r.ok && <p role="alert" className="text-sm text-muted-foreground">这次体检没做成：{r.error}</p>}
      {r?.ok && (
        <div className="space-y-4">
          {r.view.groups.map((g) => <GroupView key={g.currency} g={g} palette={palette} />)}
          {r.view.gaps.length > 0 && (
            <div className="border-t border-border/40 pt-3">
              <p className="mb-1 text-xs font-medium">没有纳入体检</p>
              <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                {r.view.gaps.map((g, i) => <li key={i}><span className="font-mono">{g.name ? `${g.name} ${g.symbol}` : g.symbol}</span>：{g.reason}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </GlassCard>
    </section>
  );
}
