import { workspaceStorage } from "@/lib/workspace";
import { useState, useEffect, useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Plus, ShieldCheck, RefreshCw, Loader2, Trash2, AlertCircle, Archive, ChevronDown } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageTabs } from "@/components/ui/PageTabs";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { api, ApiError, SAVED_REFRESH_FAILED, type Holding, type PortfolioData } from "@/lib/api";
import {
  COST_METHOD_KEY, FIELDS_OF, TRADE_TYPES, TRADE_TYPE_LABELS, emptyTradeForm, readCostMethod, tradeDetail,
  type CostMethod, type MigrationResult, type TradeForm, type TradeType,
} from "@/lib/holdings";
import { cn } from "@/lib/utils";
import { applyOrder, currencyRank, sortRows, visibleOrder, visibleSort, type SortDir, type SortValue } from "@/lib/tableSort";
import { useTableSort } from "@/hooks/useTableSort";
import { HOLDINGS_ORDER_KEY, useRowOrder } from "@/hooks/useRowOrder";
import { MoveButtons, PRIVATE_SORT_TITLE, ReorderToggle, SortTh } from "@/components/ui/SortTh";
import { PositionImport } from "@/components/PositionImport";
import { SymbolSearch } from "@/components/SymbolSearch";
import { PortfolioXrayCard, scrollToXray, usePortfolioXray, XrayBanner } from "@/components/PortfolioXray";
import { PortfolioPerfCard, usePortfolioPerf } from "@/components/PortfolioPerf";
import { ScenarioReplayCard, useScenarioReplay } from "@/components/ScenarioReplay";
import { TradeCsvImport, type TradeImportDone } from "@/components/TradeCsvImport";
import { perfContextText } from "@/lib/perfView";
import { replayContextText } from "@/lib/replayView";
import { xrayContextText } from "@/lib/xrayView";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";
import { hideIf, maskPrivateText } from "@/lib/privacy";
import { currencyLabel } from "@/lib/marketSymbol";

const REFRESH_MS = 30 * 60 * 1000; // 每半小时自动刷新
const TRADES_SHOWN = 30;
// 🔴 容 null:行情拉不到时这些是 null,显示「—」而不是 0 —— 0 会看着像"正好不赚不亏"
const pnlColor = (v: number | null) =>
  v == null ? "text-muted-foreground/40" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "text-muted-foreground";
const fmt = (v: number | null) => (v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: 2 }));
// 单价类（现价/成本/清仓价）最多 4 位小数：ETF/基金常见 3-4 位，截断成 2 位会与市值/盈亏对不上账
const fmtPx = (v: number | null) => (v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: 4 }));
const signed = (v: number) => `${v > 0 ? "+" : ""}${fmt(v)}`;

/**
 * 持仓明细的列：金额、价格类按币种分块再排（不同币种不比大小），数量和盈亏% 直接比。
 * masked = 隐私模式下这一列被遮住，不给排序（现价是公开行情、盈亏% 推不出本金，照常排）。
 */
const HOLD_COLS: { key: string; label: string; firstDir?: SortDir; right?: boolean; byCurrency?: boolean; masked?: boolean; value: (h: Holding) => SortValue }[] = [
  { key: "name", label: "名称", firstDir: "asc", value: (h) => h.name || h.code },
  { key: "price", label: "现价", right: true, byCurrency: true, value: (h) => h.price },
  { key: "shares", label: "数量", right: true, masked: true, value: (h) => h.shares },
  { key: "cost", label: "成本价", right: true, byCurrency: true, masked: true, value: (h) => h.cost },
  { key: "market_value", label: "市值", right: true, byCurrency: true, masked: true, value: (h) => h.market_value },
  { key: "pnl", label: "浮动盈亏", right: true, byCurrency: true, masked: true, value: (h) => h.pnl },
  { key: "pnl_pct", label: "盈亏%", right: true, value: (h) => h.pnl_pct },
  { key: "realized_pnl", label: "已实现", right: true, byCurrency: true, masked: true, value: (h) => h.realized_pnl },
  { key: "dividends", label: "分红", right: true, byCurrency: true, masked: true, value: (h) => h.dividends },
];
const HOLD_KEYS = HOLD_COLS.map((c) => c.key);
const holdValue = (h: Holding, k: string) => HOLD_COLS.find((c) => c.key === k)?.value(h);
const holdGroup = (h: Holding, k: string) => (HOLD_COLS.find((c) => c.key === k)?.byCurrency ? currencyRank(h.currency) : null);
const NUM = "whitespace-nowrap px-2 py-2.5 text-right font-mono tabular-nums";

/** 隐私模式下「记一笔」里自己的数（数量、成交价 / 成本、费用、到账金额）也显示成圆点；拆股比例不是金额（审计 C6） */
const PRIVATE_FIELDS = new Set(["shares", "price", "fee", "amount"]);
const SECRET_INPUT = { WebkitTextSecurity: "disc" } as CSSProperties;
/** 已经写进台账、只是重读失败：给这句（不让人以为没成功去重做），否则 null */
const savedButStale = (e: unknown) => (e instanceof ApiError && e.code === SAVED_REFRESH_FAILED ? e.message : null);
const saveMethod = (m: CostMethod) => { try { workspaceStorage.setItem(COST_METHOD_KEY, m); } catch { /* 记不住就每次用默认 */ } };

const FIELD_LABEL: Record<TradeType, Partial<Record<"shares" | "price" | "fee" | "amount" | "ratio", [string, string]>>> = {
  buy: { shares: ["数量（股）", "如 100"], price: ["成交价", "如 12.5"], fee: ["费用（选填）", "佣金、税费合计"] },
  sell: { shares: ["数量（股）", "如 100"], price: ["成交价", "如 13.2"], fee: ["费用（选填）", "佣金、税费合计"] },
  dividend: { amount: ["到账金额（税后）", "如 320"] },
  split: { ratio: ["每 1 股变成几股", "10 转 5 填 1.5"] },
  opening: { shares: ["数量（股）", "如 100"], price: ["每股成本（可负）", "如 12.5"] },
};
const TYPE_HINT: Record<TradeType, string> = {
  buy: "费用（佣金、印花税、过户费等）计入买入成本。",
  sell: "卖出所得扣掉费用后算已实现盈亏，成本按下方选的成本法算。",
  dividend: "记账户实际到账的金额（税后）。分红单独算收入，不改持仓成本。",
  split: "送股、转增、拆股、合股都记这里：10 送 3 转 2 填 1.5，1 拆 4 填 4，10 合 1 填 0.1。数量按比例变，总成本不变。",
  opening: "开始记流水之前就有的持仓：写当时的数量和每股成本，日期写建仓日（不记得就写开始记账那天，收益率从这天算起）。",
};

type Sub = "perf" | "trades" | "xray" | "replay";

/** `tabs`：放在页头下面的「自选 / 持仓」切换（这一页挂在「自选与持仓」里）。 */
/** 给 AI 的一行持仓：没取到现价就直说，不写成「现价null 浮盈null」（第四轮审计 C4） */
export function holdingContextLine(h: Holding): string {
  const live = h.price == null
    ? "现价没取到（市值、浮盈没算）"
    : `现价${h.price} 浮盈${h.pnl ?? "算不出"}(${h.pnl_pct == null ? "比例算不出" : `${h.pnl_pct}%`})`;
  return `${h.name}(${h.code},${h.currency}) ${h.shares}股 每股成本${h.cost} ${live} 已实现${h.realized_pnl} 分红${h.dividends}`;
}

export function Portfolio({ tabs }: { tabs?: ReactNode } = {}) {
  // 隐私模式：自己的金额、股数、成交价显示成 ••••；现价是公开行情、百分比推不出本金，照常显示
  const { on: hide } = usePrivacyMode();
  const p = (text: string) => hideIf(hide, text);
  // 说明文字里夹着的股数、金额(「卖出 100 股,超过…」)按措辞遮
  const show = (text: string) => (hide ? maskPrivateText(text) : text);
  const [method, setMethod] = useState<CostMethod>(readCostMethod);
  const [data, setData] = useState<PortfolioData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState<TradeForm>(() => emptyTradeForm());
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [confirmLegacy, setConfirmLegacy] = useState<{ id: string; action: "adopt" | "discard" } | null>(null);
  const [allTrades, setAllTrades] = useState(false);
  /** 「记一笔 / 导入」面板：没点过就跟着数据走 —— 一笔流水都没有时展开，有了就收起，省得每次打开先翻过一大块表单 */
  const [entryOpen, setEntryOpen] = useState<boolean | null>(null);
  const [subPick, setSub] = useState<Sub>("perf");
  const set = (patch: Partial<TradeForm>) => setForm((f) => ({ ...f, ...patch }));
  const [notice, setNotice] = useState<MigrationResult | null>(null);
  const [imported, setImported] = useState<TradeImportDone | null>(null);
  const seq = useRef(0);
  /** 后发出的请求说了算:先发的晚回来不覆盖。迁移 / 备份提示只被下一次真有内容的结果替换 ——
   *  两次加载撞在一起时,后一次看到的旧记录已经迁完,结果是空的,不能把前一次的提示冲掉 */
  const accept = async (job: Promise<PortfolioData>) => {
    const mine = ++seq.current;
    const d = await job;
    const m = d.migration;
    if (m && (m.backup || m.migrated.length || m.removed_stale.length || m.failed.length)) setNotice(m);
    if (mine === seq.current) setData(d);
  };

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      await accept(manual ? api.refreshPortfolio(method) : api.portfolio(method));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [method]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), REFRESH_MS); // 每半小时自动刷新
    return () => clearInterval(t);
  }, [load]);

  const pickMethod = (m: CostMethod) => { saveMethod(m); setMethod(m); };

  const addTrade = async () => {
    setSaving(true); setErr(null);
    try {
      await accept(api.addTrade(form, method));
      setForm(emptyTradeForm(form.type));
    } catch (e) {
      // 已经写进台账、只是重读失败：照样清表单，别让人再点一次记成两笔
      if (e instanceof ApiError && e.code === SAVED_REFRESH_FAILED) setForm(emptyTradeForm(form.type));
      setErr(e instanceof ApiError ? e.message : "记录失败");
    } finally {
      setSaving(false);
    }
  };

  const removeTrade = async (id: string) => {
    if (confirmDel !== id) { setConfirmDel(id); return; }
    setConfirmDel(null);
    try { await accept(api.removeTrade(id, method)); setErr(null); } catch (e) { setErr(savedButStale(e) ?? "删除流水失败，请重试"); }
  };

  const resolveLegacy = async (id: string, action: "adopt" | "discard") => {
    if (confirmLegacy?.id !== id || confirmLegacy.action !== action) { setConfirmLegacy({ id, action }); return; }
    setConfirmLegacy(null);
    try { await accept(api.resolveLegacy(action, id, method)); setErr(null); } catch (e) { setErr(e instanceof ApiError ? e.message : "处理旧记录失败，请重试"); }
  };

  // 删清仓记录同删流水：先按一次变成「再按一次删除」，免得误点就没了（第四轮审计 C5）
  const removeClosed = async (id: string) => {
    if (confirmDel !== `closed:${id}`) { setConfirmDel(`closed:${id}`); return; }
    setConfirmDel(null);
    try { await accept(api.removeClosed(id, method)); setErr(null); } catch (e) { setErr(savedButStale(e) ?? "删除清仓记录失败，请重试"); }
  };

  const holdings = data?.holdings || [];
  const totals = data?.totals ?? [];
  const trades = data?.trades ?? [];
  const issues = data?.issues ?? [];
  const closed = data?.closed ?? [];
  // 待迁移(pending)和已迁完待删(stale)的打开页面时自动处理,只有冲突和转不了的要用户拿主意
  const legacy = (data?.legacy ?? []).filter((l) => l.state === "conflict" || l.state === "skipped");
  const legacyClosed = data?.legacy_closed ?? [];
  const migration = notice;
  const unquotedOf = (c: string) => data?.unquoted.find((u) => u.currency === c)?.count ?? 0;
  const unquotedAll = (data?.unquoted ?? []).reduce((a, u) => a + u.count, 0);
  const extraTotals = (data?.realized_totals ?? []).filter((r) => !totals.some((t) => t.currency === r.currency)
    && (r.pnl !== 0 || r.dividends !== 0 || unquotedOf(r.currency) > 0));
  const xray = usePortfolioXray(holdings);
  const perf = usePortfolioPerf(trades);
  const replay = useScenarioReplay(holdings);
  // 持仓明细：点表头排序；「调整顺序」自己排先后（和首页共用，只记在本机浏览器）
  const { sort: savedHoldSort, onSort: onHoldSort, setSort: setHoldSort } = useTableSort("vr-sort-holdings", HOLD_KEYS);
  // 隐私模式下记着的排序正好是被遮的列：先不用（关掉隐私模式又回来）
  const holdSort = visibleSort(savedHoldSort, hide, (k) => !!HOLD_COLS.find((c) => c.key === k)?.masked);
  const savedHoldOrder = useRowOrder(HOLDINGS_ORDER_KEY);
  const { order: holdOrder, masked: holdOrderMasked } = visibleOrder(savedHoldOrder.order, savedHoldOrder.masked, hide);
  const [reorder, setReorder] = useState(false);
  const shownHoldings = sortRows(applyOrder(holdings, holdOrder, (h) => h.code), holdSort, holdValue, holdGroup);
  const shownHoldCodes = shownHoldings.map((h) => h.code);
  const toggleReorder = () => {
    if (!reorder && savedHoldSort) { if (holdSort) savedHoldOrder.setOrder(shownHoldCodes, !!HOLD_COLS.find((c) => c.key === holdSort.key)?.masked || holdOrderMasked); setHoldSort(null); }
    setReorder((v) => !v);
  };
  const nameOf = (code: string) => holdings.find((h) => h.code === code)?.name || closed.find((c) => c.code === code)?.name || trades.find((t) => t.symbol === code && t.name)?.name || "";
  const shownTrades = [...trades].reverse().slice(0, allTrades ? undefined : TRADES_SHOWN);
  const entryShown = entryOpen ?? (data !== null && trades.length === 0 && legacy.length === 0);
  // 自动展开与否只在第一次拿到数据时定：记下第一笔、导入完成后不能自己收起来（截图转写和 CSV 导入还要接着用）
  useEffect(() => {
    if (entryOpen === null && data !== null) setEntryOpen(trades.length === 0 && legacy.length === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  // 持仓明细下面的四块分页显示；没有的那块（没流水就没收益表现，没持仓就没体检和回放）不给分页
  const subs = ([
    trades.length > 0 && { key: "perf", label: "收益表现" },
    { key: "trades", label: `交易流水（${trades.length}）` },
    holdings.length > 0 && { key: "xray", label: "持仓体检" },
    holdings.length > 0 && { key: "replay", label: "历史回放" },
  ] as const).filter((x): x is { key: Sub; label: string } => !!x);
  const sub: Sub = subs.some((x) => x.key === subPick) ? subPick : subs[0]!.key;

  const holdingsText = holdings.length
    ? `我的持仓（本地数据，由交易流水按${data?.method_label ?? ""}算出）：\n` + holdings.map(holdingContextLine).join("\n") +
      `\n分币种汇总：\n${totals.map((t) => `${t.label} ${t.currency}：市值${t.market_value} 浮盈${t.pnl}(${t.pnl_pct == null ? "比例算不出：成本和 ≤ 0" : `${t.pnl_pct}%`})${unquotedOf(t.currency) ? `，另有 ${unquotedOf(t.currency)} 只没取到现价、不在这两个数里` : ""}`).join("\n")}` +
      (issues.length ? `\n有 ${issues.length} 笔流水数据不对、没参与计算。` : "") +
      (xray.result?.ok ? `\n${xrayContextText(xray.result.view, xray.breaches)}` : "")
    : "我的持仓：暂无记录。";
  const perfText = perfContextText(perf.result);
  // 持仓变了以后，旧的回放结果不再给 AI（它对应的是之前的持仓）
  const replayText = replay.stale ? "" : replayContextText(replay.result);
  const aiContext = [holdingsText, perfText, replayText].filter(Boolean).join("\n");

  useAiPage({
    key: "portfolio",
    title: "我的持仓",
    context: aiContext,
    suggestions: ["我的持仓集中在哪些方向", "结构上有什么风险", "帮我梳理一下"],
  });

  const fields = FIELDS_OF[form.type];
  const input = "rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50";

  return (
    <div>
      <PageHeader
        title="我的持仓"
        subtitle="记下每一笔买卖，持仓、成本和盈亏按流水算出来"
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => setEntryOpen(!entryShown)} aria-expanded={entryShown} aria-controls="portfolio-entry"
              className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium",
                entryShown ? "border border-border text-muted-foreground hover:text-foreground" : "bg-primary/15 text-primary shadow-glow hover:bg-primary/25")}>
              <Plus className="h-4 w-4" /> 记一笔 / 导入
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", entryShown && "rotate-180")} />
            </button>
            <button onClick={() => load(true)} disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              刷新
            </button>
          </div>
        }
      />
      {tabs}

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <span>交易流水<b className="text-foreground">保存在本地</b>，不进仓库。使用截图／表格转写时，所选文件内容会发送给已连接的 AI；行情和汇率查询会发送标的代码。行情每半小时自动刷新，也可手动刷新。本产品不提供标的、不给建议，只帮你把自己的账理清楚。</span>
      </div>

      {migration && (
        <div role="status" className="mb-4 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
          <Archive className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            {migration.migrated.length > 0 && <p>已把 {migration.migrated.length} 条旧持有记录转成「期初持仓」流水，数量和成本照旧；没写建立日期的按今天记，可以删掉重记。</p>}
            {migration.removed_stale.length > 0 && <p>删掉了 {migration.removed_stale.length} 条旧持有记录（已转成流水的，或你确认不要的）。</p>}
            {migration.backup && <p className="mt-1">改动前的原文件备份在数据目录的 <span className="font-mono">{migration.backup}</span>，里面有恢复说明。</p>}
            {migration.failed.map((f) => <p key={f.position_id} className="mt-1 text-destructive">{f.symbol}：{show(f.why)}</p>)}
          </div>
        </div>
      )}

      {data?.migration_error && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          旧持有记录这次没能自动转成流水：{show(data.migration_error)}。下次打开会再试；在那之前这些记录仍算持有，但不进下面的持仓明细。
        </p>
      )}

      {imported && (
        <div role="status" className="mb-4 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
          <Archive className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p>已从表格导入 {imported.imported} 笔流水，持仓和收益率按新的流水重新算了。</p>
            <p className="mt-1">导入前的原文件备份在数据目录的 <span className="font-mono">{imported.backup}</span>，里面有恢复说明；导错了可以照着恢复，或在下面的流水列表里逐笔删。</p>
          </div>
        </div>
      )}

      {legacy.length > 0 && (
        <GlassCard className="mb-4">
          <h3 className="text-sm font-semibold">要你确认的旧持有记录</h3>
          <p className="mt-1 text-xs text-muted-foreground">这些是旧版「一只一条」的持有记录，没能自动转成流水。处理前会先备份。处理之前，数量大于 0 的仍算持有（事件日历、候选池会用到），但不进下面的持仓明细。</p>
          <div className="mt-3 space-y-2">
            {legacy.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2.5 text-sm">
                <div>
                  {l.name && <span className="mr-1.5 font-medium">{l.name}</span>}
                  <span className="font-mono text-xs text-muted-foreground">{l.symbol}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{p(fmt(l.shares))} 股 · 成本 {p(fmtPx(l.cost))}</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">{show(l.why)}</p>
                </div>
                <div className="flex gap-2">
                  {l.state === "conflict" && (
                    <button onClick={() => resolveLegacy(l.id, "adopt")} className="rounded border border-border px-2.5 py-1 text-xs hover:border-primary/50">
                      {confirmLegacy?.id === l.id && confirmLegacy.action === "adopt" ? "再按一次确认（会先备份）" : l.migrated_trade ? "按它现在的数替换那笔期初持仓" : "按它补一笔期初持仓"}
                    </button>
                  )}
                  {(l.state === "conflict" || l.state === "skipped") && (
                    <button onClick={() => resolveLegacy(l.id, "discard")} className="rounded border border-border px-2.5 py-1 text-xs hover:border-destructive/50 hover:text-destructive">
                      {confirmLegacy?.id === l.id && confirmLegacy.action === "discard" ? "再按一次确认删除（会先备份）" : "删掉这条旧记录"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      {holdings.length > 0 && <XrayBanner x={xray} onOpen={() => { setSub("xray"); scrollToXray(); }} />}

      {/* 汇总 */}
      {(totals.length > 0 || extraTotals.length > 0) && (
        <div className="mb-4 grid gap-3 xl:grid-cols-3">
          {totals.map((total) => {
            const rz = data?.realized_totals.find((r) => r.currency === total.currency);
            const uq = unquotedOf(total.currency);
            return (
              <GlassCard key={total.currency} className="p-3">
                <div className="mb-3 flex items-center justify-between">
                  <p className="font-semibold">{total.label}账户</p>
                  <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{total.currency}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-2">
                  {[
                    { k: "市值", v: p(fmt(total.market_value)), c: "text-foreground" },
                    { k: "成本", v: p(fmt(total.cost)), c: "text-foreground" },
                    { k: "浮动盈亏", v: p(signed(total.pnl)), c: pnlColor(total.pnl) },
                    {
                      k: "盈亏比例",
                      v: total.pnl_pct == null ? "—" : (total.pnl_pct > 0 ? "+" : "") + total.pnl_pct + "%",
                      c: pnlColor(total.pnl),
                    },
                  ].map((m) => (
                    <div key={m.k}>
                      <p className="text-[11px] text-muted-foreground">{m.k}</p>
                      <p className={cn("mt-0.5 font-mono text-base font-bold", m.c)}>{m.v}</p>
                    </div>
                  ))}
                </div>
                {uq > 0 && <p className="mt-2 text-[11px] text-warning">另有 {uq} 只没取到行情，没算进上面的市值和成本</p>}
                {rz && <p className="mt-3 text-xs text-muted-foreground">已实现 <b className={cn("font-mono", pnlColor(rz.pnl))}>{p(signed(rz.pnl))}</b> · 分红 <b className="font-mono text-foreground">{p(fmt(rz.dividends))}</b></p>}
              </GlassCard>
            );
          })}
          {/* 已卖光的币种、或持有的都没取到行情:没有市值合计,已实现和分红照样列 */}
          {extraTotals.map((rz) => {
            const uq = unquotedOf(rz.currency);
            return (
              <GlassCard key={rz.currency} className="p-3">
                <div className="mb-3 flex items-center justify-between">
                  <p className="font-semibold">{currencyLabel(rz.currency)}账户</p>
                  <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{rz.currency}</span>
                </div>
                <p className={cn("text-xs", uq > 0 ? "text-warning" : "text-muted-foreground")}>{uq > 0 ? `${uq} 只持有中，没取到行情，市值和浮动盈亏暂缺` : "目前没有持仓"}</p>
                <p className="mt-3 text-xs text-muted-foreground">已实现 <b className={cn("font-mono", pnlColor(rz.pnl))}>{p(signed(rz.pnl))}</b> · 分红 <b className="font-mono text-foreground">{p(fmt(rz.dividends))}</b></p>
              </GlassCard>
            );
          })}
          {data?.cny && "missing" in data.cny && (
            <GlassCard className="p-3 text-xs text-muted-foreground">缺 {data.cny.missing.join("、")} 兑人民币汇率，没算人民币合计。</GlassCard>
          )}
          {data?.cny && !("missing" in data.cny) && (
            <GlassCard className="p-3">
              <div className="mb-3 flex items-center justify-between">
                <p className="font-semibold">折合人民币</p>
                <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">CNY</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-2">
                {[
                  { k: "市值", v: p(fmt(data.cny.market_value)), c: "text-foreground" },
                  { k: "成本", v: p(fmt(data.cny.cost)), c: "text-foreground" },
                  { k: "浮动盈亏", v: p(signed(data.cny.pnl)), c: pnlColor(data.cny.pnl) },
                  { k: "盈亏比例", v: data.cny.pnl_pct == null ? "—" : (data.cny.pnl_pct > 0 ? "+" : "") + data.cny.pnl_pct + "%", c: pnlColor(data.cny.pnl) },
                ].map((m) => (
                  <div key={m.k}>
                    <p className="text-[11px] text-muted-foreground">{m.k}</p>
                    <p className={cn("mt-0.5 font-mono text-base font-bold", m.c)}>{m.v}</p>
                  </div>
                ))}
              </div>
              {unquotedAll > 0 && <p className="mt-2 text-[11px] text-warning">另有 {unquotedAll} 只没取到行情，没算进来</p>}
              <p className="mt-3 text-[11px] text-muted-foreground/70">
                按腾讯外汇 {data.cny.fx.date ?? "（日期未知）"}{data.cny.fx.USD !== null && ` · 1 美元 = ${data.cny.fx.USD} 人民币`}{data.cny.fx.HKD !== null && ` · 1 港元 = ${data.cny.fx.HKD} 人民币`}；只是用当前汇率换算的参考，成本也按当前汇率折算。
              </p>
            </GlassCard>
          )}
        </div>
      )}

      {/* 录入：收起时用 hidden 藏着而不是卸载 —— 填了一半的表单、选好的导入文件都还在 */}
      <div id="portfolio-entry" hidden={!entryShown}>
      <PositionImport existingCodes={holdings.map(h => h.code)} onFill={values => {
        setForm({ ...emptyTradeForm("opening"), symbol: values.symbol, shares: values.shares, price: values.cost });
      }} />
      <GlassCard className="mb-4">
        <h3 className="mb-3 text-sm font-semibold">记一笔</h3>
        <div className="mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="流水类型">
          {TRADE_TYPES.map((t) => (
            <button key={t} role="radio" aria-checked={form.type === t} onClick={() => set({ type: t })}
              className={cn("rounded-lg border px-3 py-1.5 text-sm", form.type === t ? "border-primary/50 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
              {TRADE_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">代码 / 名称 / 拼音</label>
            <SymbolSearch value={form.symbol} onChange={(v) => set({ symbol: v })} onPick={(m) => { if (!form.name.trim()) set({ name: m.name }); }}
              placeholder="600519 / 腾讯 / AAPL" ariaLabel="股票代码" className="w-56" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">日期</label>
            <div className="flex gap-1">
              <input aria-label="流水日期" value={form.date} onChange={e => set({ date: e.target.value })} placeholder="YYYY-MM-DD" maxLength={10} className={cn(input, "w-36")} />
              <input type="date" aria-label="用日历选择日期" title="用日历选择日期"
                value={/^\d{4}-\d{2}-\d{2}$/.test(form.date) ? form.date : ""} onChange={e => set({ date: e.target.value })}
                className="w-10 rounded-lg border border-border bg-black/20 p-2 text-transparent outline-none focus:border-primary/50" />
            </div>
          </div>
          {fields.map((k) => {
            const [label, ph] = FIELD_LABEL[form.type][k]!;
            return (
              <div key={k}>
                <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
                <input aria-label={label} value={form[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<TradeForm>)} placeholder={ph} className={cn(input, "w-32")}
                  style={hide && PRIVATE_FIELDS.has(k) ? SECRET_INPUT : undefined} autoComplete="off" />
              </div>
            );
          })}
          <label className="block text-xs text-muted-foreground">名称（选填）
            <input aria-label="公司名称" value={form.name} onChange={e => set({ name: e.target.value })} maxLength={40} placeholder="便于查找" className={cn(input, "mt-1 block w-32")} />
          </label>
          <button onClick={addTrade} disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} 记录
          </button>
        </div>
        <label className="mt-3 block text-xs text-muted-foreground">备注（选填）
          <input aria-label="流水备注" value={form.note} onChange={e => set({ note: e.target.value })} maxLength={1000}
            placeholder="当时的判断、要留意什么…" className={cn(input, "mt-1 block w-full")} />
        </label>
        <p className="mt-2 text-[11px] text-muted-foreground/60">{TYPE_HINT[form.type]} 支持 A 股、港股和美股。只记已经发生的交易，不下单。</p>
      </GlassCard>
      <TradeCsvImport method={method} hide={hide} onDone={(d, r) => { setErr(null); setImported(r); void accept(Promise.resolve(d)); }} />
      </div>

      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}

      {/* 持仓表 */}
      <GlassCard glow>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">持仓明细</h3>
            {/* 调整中卖到只剩一只也留着「完成」，不然表头一直锁着 */}
            {(reorder || holdings.length > 1) && <ReorderToggle on={reorder} onToggle={toggleReorder} />}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">成本法</span>
            <div className="flex overflow-hidden rounded-lg border border-border" role="radiogroup" aria-label="成本法">
              {(data?.methods ?? [{ id: "fifo" as const, label: "先进先出" }, { id: "average" as const, label: "移动加权平均" }]).map((m) => (
                <button key={m.id} role="radio" aria-checked={method === m.id} onClick={() => pickMethod(m.id)}
                  className={cn("px-2.5 py-1 text-xs", method === m.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
                  {m.label}
                </button>
              ))}
            </div>
            {data?.updated && <span className="text-xs text-muted-foreground/60">更新于 {new Date(data.updated).toLocaleString("zh-CN", { hour12: false })}</span>}
          </div>
        </div>
        {issues.length > 0 && (
          <div role="alert" className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
            <p className="font-medium text-primary">有 {issues.length} 笔流水数据不对，没参与计算。跳过的卖出会让之后的持有数偏大，请先改好（删掉重记）。</p>
            <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
              {issues.map((i) => <li key={i.id}><span className="font-mono">{i.date || "无日期"}</span> · {TRADE_TYPE_LABELS[i.type as TradeType] ?? i.type} · {nameOf(i.symbol) || i.symbol}：{show(i.why)}</li>)}
            </ul>
          </div>
        )}
        {holdings.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground/60">还没有持仓。开始记账前就有的仓位，用上面的「期初持仓」记一笔。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {HOLD_COLS.map((c) => (
                    <SortTh key={c.key} label={c.label} k={c.key} firstDir={c.firstDir} right={c.right} sort={holdSort} onSort={onHoldSort}
                      disabled={reorder || (hide && !!c.masked)} disabledTitle={hide && c.masked ? PRIVATE_SORT_TITLE : undefined}
                      title={c.byCurrency ? `按${c.label}排序，不同币种分开排` : undefined} className="px-2 py-2 font-medium" />
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownHoldings.map((h, i) => (
                  <tr key={h.code} className="border-b border-border/30">
                    <td className="px-2 py-2.5">
                      {reorder && <span className="mr-1.5 align-middle"><MoveButtons name={h.name || h.code} first={i === 0} last={i === shownHoldings.length - 1} onMove={(d) => savedHoldOrder.move(shownHoldCodes, h.code, d, holdOrderMasked)} /></span>}
                      <Link to={`/research?symbol=${encodeURIComponent(h.code)}`} title="在个股页看走势、财报和事件回看" className="font-medium hover:text-primary hover:underline">{h.name || h.code}</Link>
                      <span className="ml-1.5 font-mono text-xs text-muted-foreground/60">{h.code}</span>
                      <span className="ml-1.5 rounded border border-border px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{h.currency}</span>
                      {h.opened_at && <p className="mt-0.5 whitespace-nowrap text-[11px] text-muted-foreground/60">自 {h.opened_at} 持有</p>}
                    </td>
                    <td className={NUM}>{fmtPx(h.price)}</td>
                    <td className={cn(NUM, "text-muted-foreground")}>{p(fmt(h.shares))}</td>
                    <td className={cn(NUM, "text-muted-foreground")}>{p(fmtPx(h.cost))}</td>
                    <td className={NUM}>{p(fmt(h.market_value))}</td>
                    <td className={cn(NUM, pnlColor(h.pnl))}>{p(`${h.pnl != null && h.pnl > 0 ? "+" : ""}${fmt(h.pnl)}`)}</td>
                    <td className={cn(NUM, pnlColor(h.pnl))}>{h.pnl_pct == null ? "—" : `${h.pnl_pct > 0 ? "+" : ""}${h.pnl_pct}%`}</td>
                    <td className={cn(NUM, pnlColor(h.realized_pnl))}>{p(signed(h.realized_pnl))}</td>
                    <td className={cn(NUM, "text-muted-foreground")}>{p(fmt(h.dividends))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground/60">
          {data?.method === "fifo" ? "先进先出：卖出时先扣最早买入的那批，剩下的成本是还没卖掉那几批的成本。" : "移动加权平均：每次买入后重算平均成本，卖出不改平均成本。"}
          两种方法持有数量一样，成本价和已实现盈亏不同。费用计入买入成本、从卖出所得里扣；分红单独算。
          点表头排序（金额、价格类不同币种分开排）；「调整顺序」排的先后和首页共用，只记在这台电脑的浏览器里。
        </p>
      </GlassCard>

      <PageTabs label="持仓的更多内容" className="mt-6" value={sub} onChange={setSub} options={subs} />

      {sub === "perf" && <PortfolioPerfCard x={perf} hide={hide} legacyPending={legacy.length} />}

      {sub === "xray" && <PortfolioXrayCard x={xray} />}

      {sub === "replay" && <ScenarioReplayCard x={replay} hide={hide} />}

      {/* 流水、已卖光、旧清仓记录 */}
      {sub === "trades" && <>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">交易流水（{trades.length} 笔）</h3>
        {trades.length > TRADES_SHOWN && (
          <button onClick={() => setAllTrades((v) => !v)} className="text-xs text-primary">{allTrades ? `只看最近 ${TRADES_SHOWN} 笔` : `显示全部 ${trades.length} 笔`}</button>
        )}
      </div>
      <GlassCard className="mb-4">
        {trades.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground/60">还没有流水。买入、卖出、分红、送转都在上面记一笔。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["日期", "类型", "名称", "明细", "备注", ""].map((h, i) => <th key={i} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {shownTrades.map((t) => (
                  <tr key={t.id} className={cn("border-b border-border/30", issues.some((i) => i.id === t.id) && "bg-primary/5")}>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{t.date}</td>
                    <td className="whitespace-nowrap px-2 py-2">{TRADE_TYPE_LABELS[t.type as TradeType] ?? t.type}</td>
                    <td className="px-2 py-2">
                      <span className="font-medium">{t.name || nameOf(t.symbol)}</span>
                      <span className="ml-1.5 font-mono text-xs text-muted-foreground/60">{t.symbol}</span>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground">{p(tradeDetail(t))}</td>
                    <td className="max-w-xs whitespace-pre-wrap break-words px-2 py-2 text-xs text-muted-foreground">{show(t.note)}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <button onClick={() => removeTrade(t.id)} className={cn("text-xs", confirmDel === t.id ? "text-destructive" : "text-muted-foreground/50 hover:text-destructive")} title="删除这笔">
                        {confirmDel === t.id ? "再按一次删除" : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* 已卖光(流水算出) */}
      {closed.length > 0 && (
        <>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">已卖光</h3>
          <GlassCard className="mb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                    {["名称", "最后一笔", "已实现盈亏", "分红", "费用"].map((h) => <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {closed.map((x) => (
                    <tr key={x.code} className="border-b border-border/30">
                      <td className="px-2 py-2.5"><span className="font-medium">{x.name}</span><span className="ml-1.5 font-mono text-xs text-muted-foreground/60">{x.code}</span></td>
                      <td className="px-2 py-2.5 font-mono text-muted-foreground">{x.last_date}</td>
                      <td className={cn("px-2 py-2.5 font-mono", pnlColor(x.realized_pnl))}>{x.currency} {p(signed(x.realized_pnl))}</td>
                      <td className="px-2 py-2.5 font-mono text-muted-foreground">{p(fmt(x.dividends))}</td>
                      <td className="px-2 py-2.5 font-mono text-muted-foreground">{p(fmt(x.fees))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassCard>
        </>
      )}

      {/* 旧版清仓记录(流水之前手记的):只读 + 可删,不和流水的已实现盈亏相加 */}
      {(legacyClosed.length > 0 || !!data?.legacy_closed_invalid) && (
        <>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-muted-foreground">旧清仓记录</h3>
            {legacyClosed.length > 0 && data && (
              <span className="text-sm">
                已实现盈亏 {data.legacy_realized_totals.map(t => <b key={t.currency} className={cn("ml-2 font-mono", pnlColor(t.pnl))}>{t.currency} {p(`${t.pnl > 0 ? "+" : ""}${fmt(t.pnl)}`)}</b>)}
              </span>
            )}
          </div>
          <GlassCard>
            <p className="mb-3 text-xs text-muted-foreground">改成流水之前手记的清仓。不并入上面的已实现盈亏（如果同一笔卖出也记了流水，相加会算两遍）。盈亏未扣手续费。</p>
            {!!data?.legacy_closed_invalid && <p role="alert" className="mb-3 text-sm text-primary">有 {data.legacy_closed_invalid} 条清仓记录格式异常，未计入列表和已实现盈亏；原始记录仍保留，请核对台账。</p>}
            {legacyClosed.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                      {["名称", "清仓日期", "清仓价", "股数", "成本", "已实现盈亏", "盈亏%", ""].map((h) => (
                        <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {legacyClosed.map((c) => (
                      <tr key={c.id} className="border-b border-border/30">
                        <td className="px-2 py-2.5">
                          <span className="font-medium">{c.name}</span>
                          <span className="ml-1.5 font-mono text-xs text-muted-foreground/60">{c.code}</span>
                          {c.note && <p className="mt-1 max-w-sm whitespace-pre-wrap break-words text-xs text-muted-foreground">{show(c.note)}</p>}
                        </td>
                        <td className="px-2 py-2.5 font-mono text-muted-foreground">{c.date}</td>
                        <td className="px-2 py-2.5 font-mono">{p(fmtPx(c.price))}</td>
                        <td className="px-2 py-2.5 font-mono text-muted-foreground">{p(fmt(c.shares))}</td>
                        <td className="px-2 py-2.5 font-mono text-muted-foreground">{p(fmtPx(c.cost))}</td>
                        <td className={cn("px-2 py-2.5 font-mono", pnlColor(c.pnl))}>{c.currency} {p(`${c.pnl > 0 ? "+" : ""}${fmt(c.pnl)}`)}</td>
                        <td className={cn("px-2 py-2.5 font-mono", pnlColor(c.pnl))}>{c.pnl_pct === null ? "—" : `${c.pnl_pct > 0 ? "+" : ""}${c.pnl_pct}%`}</td>
                        <td className="px-2 py-2.5">
                          <button onClick={() => removeClosed(c.id)} className={cn("text-xs", confirmDel === `closed:${c.id}` ? "text-destructive" : "text-muted-foreground/50 hover:text-destructive")} title="删除">
                            {confirmDel === `closed:${c.id}` ? "再按一次删除" : <Trash2 className="h-3.5 w-3.5" />}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </GlassCard>
        </>
      )}
      </>}

      <Disclaimer />
    </div>
  );
}
