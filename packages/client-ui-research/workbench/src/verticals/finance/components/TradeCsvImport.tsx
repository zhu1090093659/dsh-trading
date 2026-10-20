import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronUp, FileUp, Loader2, Table2 } from "lucide-react";

import { GlassCard } from "@/components/ui/GlassCard";
import { api, ApiError, SAVED_REFRESH_FAILED, type PortfolioData } from "@/lib/api";
import { backend } from "@/lib/backend";
import { TRADE_TYPE_LABELS, tradeDetail, type CostMethod, type ImportPreviewRow, type Trade, type TradeIssue, type TradeType } from "@/lib/holdings";
import { hideIf, maskPrivateText } from "@/lib/privacy";
import { CSV_MAX_ROWS, TRADE_CSV_TEMPLATE, decodeTableFile, parseTradeCsv, type CsvParse, type CsvRow } from "@/lib/tradeCsv";
import { cn } from "@/lib/utils";

/** 后端请求体上限 256KB,留点余量:超了提示分几份,不让请求半路被拒 */
const MAX_BODY_BYTES = 240 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TOO_BIG = "这份表格太大，一次传不过去：请分成几份导入";
const tooBig = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).length > MAX_BODY_BYTES;

export interface TradeImportDone { imported: number; backup: string }

const msg = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

/** 预览列表里的数字说明(与流水列表同一种写法) */
const detailOf = (r: Record<string, unknown>) => {
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  return tradeDetail({ type: String(r.type), shares: n(r.shares), price: n(r.price), fee: n(r.fee), amount: n(r.amount), ratio: n(r.ratio) } as Trade);
};

/**
 * 能导入的行:只认和**当前勾选**对得上的那份预览。勾选刚变、按新勾选重算的预览还没回来(或没算成)时一笔都不导,
 * 否则会按旧预览把「卖出超过持有」这种行写进去(第四轮审计 C5)。
 */
export function importableRows(valid: CsvRow[], preview: ImportPreviewRow[] | null, previewFor: string | null, selected: boolean[]): CsvRow[] {
  if (!preview || previewFor !== selected.join(",")) return [];
  return valid.filter((_, i) => selected[i] && preview[i]?.problem === null);
}

/** 从表格导入多笔流水:本机解析 → 后端预览(不写)→ 勾选 → 一次写进去(先备份) */
export function TradeCsvImport({ method, hide, onDone }: { method: CostMethod; hide: boolean; onDone: (data: PortfolioData, r: TradeImportDone) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<CsvParse | null>(null);
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null);
  // 这份预览是按哪种勾选算的(勾选用逗号连起来);和当前勾选对不上就不能导入
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<boolean[]>([]);
  // 已记的流水里,按现在的勾选写进去以后会变成算不了的
  const [existingIssues, setExistingIssues] = useState<TradeIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ctl = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { ctl.current?.abort(); if (timer.current) clearTimeout(timer.current); }, []);

  const p = (t: string) => hideIf(hide, t);
  const show = (t: string) => (hide ? maskPrivateText(t) : t);
  // 能交给后端的行(本机检查通过的);预览、勾选都和它一一对应
  const valid: CsvRow[] = parsed?.ok ? parsed.rows.filter((r) => r.record !== null) : [];
  const records = valid.map((r) => r.record!);

  const reset = () => {
    ctl.current?.abort(); if (timer.current) clearTimeout(timer.current);
    setParsed(null); setPreview(null); setPreviewFor(null); setSelected([]); setExistingIssues([]); setError("");
  };

  /** quiet:失败时不改提示(导入失败后的重新预览,不能把导入失败的原因冲掉) */
  const ask = async (sel: boolean[] | undefined, recs: Record<string, unknown>[], quiet = false) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    try {
      const r = await backend.holdingsImportPreview(recs, sel, c.signal);
      if (c.signal.aborted) return null;
      setPreview(r.preview);
      // 没给勾选时后端按默认勾(数据对、且不和已记的重复),和 check() 设的默认勾选一致
      setPreviewFor((sel ?? r.preview.map((x) => x.problem === null && x.duplicate !== "existing")).join(","));
      setExistingIssues(r.existing_issues ?? []);
      return r.preview;
    } catch (e) {
      if (!c.signal.aborted && !quiet) setError(msg(e, "预览失败，请重试"));
      return null;
    }
  };

  const check = async () => {
    reset();
    const r = parseTradeCsv(text);
    setParsed(r);
    if (!r.ok) return;
    const recs = r.rows.flatMap((x) => (x.record ? [x.record] : []));
    if (!recs.length) return;
    // 预览也走同一个请求体上限:超了先说分几份,不让请求半路被拒
    if (tooBig({ action: "import_preview", rows: recs, selected: recs.map(() => true) })) { setError(TOO_BIG); return; }
    setBusy(true);
    const pv = await ask(undefined, recs);
    setBusy(false);
    // 默认勾选:数据对、且不和已记的重复(和表格里前一行一样的照样勾:同一天同价成交两笔是常事)
    if (pv) setSelected(pv.map((x) => x.problem === null && x.duplicate !== "existing"));
  };

  const toggle = (i: number) => {
    const next = selected.map((v, k) => (k === i ? !v : v));
    setSelected(next);
    // 勾选变了,「卖出超过持有」要按新的勾选重算;连点几下只问最后一次
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void ask(next, records); }, 250);
  };

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) { setError("文件超过 2MB：请分成几份导入"); return; }
    const r = decodeTableFile(await f.arrayBuffer());
    if ("error" in r) { setError(r.error); return; }
    reset();
    setText(r.text);
  };

  const chosen = importableRows(valid, preview, previewFor, selected);
  const rechecking = preview !== null && previewFor !== selected.join(",");
  const skipped = preview && !rechecking ? preview.filter((x, i) => selected[i] && x.problem === null && x.skip_reason).length : 0;

  const importNow = async () => {
    const rows = chosen.map((r) => r.record!);
    if (!rows.length) return;
    if (tooBig({ action: "import", rows, method })) { setError(TOO_BIG); return; }
    setBusy(true); setError("");
    try {
      const r = await api.importTrades(rows, method);
      onDone(r.data, r.imported);
      setText(""); reset(); setOpen(false);
    } catch (e) {
      // 明确已经写进去、只是重读持仓失败：清掉这份表格，只提示刷新（重新预览分不出「本来就重复、用户主动勾的」那几行）
      if (e instanceof ApiError && e.code === SAVED_REFRESH_FAILED) { setText(""); reset(); setError(e.message); return; }
      setError(msg(e, "导入失败，请重试"));
      // 可能已经写进去、只是回包没收到(超时、断网):重新预览,已经在台账里的标成「和已记的一样」并取消勾选,免得再导一次记重
      const was = preview;
      const pv = await ask(selected, records, true);
      if (pv) {
        const next = selected.map((v, i) => v && !(pv[i]?.duplicate === "existing" && was?.[i]?.duplicate !== "existing"));
        if (next.some((v, i) => v !== selected[i])) { setSelected(next); await ask(next, records, true); }
      }
    } finally {
      setBusy(false);
    }
  };

  const status = (r: CsvRow, i: number): { text: string; tone: "bad" | "warn" | "ok" } => {
    if (r.error) return { text: r.error, tone: "bad" };
    const v = preview?.[i];
    if (!v) return { text: "", tone: "ok" };
    if (v.problem) return { text: v.problem, tone: "bad" };
    if (v.duplicate === "existing") return { text: "和已记的一笔完全一样，默认不导入（确实是另一笔就勾上）", tone: "warn" };
    if (selected[i] && v.skip_reason) return { text: `写进去后这笔不参与计算：${v.skip_reason}`, tone: "warn" };
    if (v.duplicate === "table") return { text: `和第 ${valid[v.duplicate_of ?? 0]?.line ?? "?"} 行一样（是两笔就都勾上）`, tone: "warn" };
    return { text: selected[i] ? "可以导入" : "不导入", tone: "ok" };
  };

  // 隐私模式下输入框里的原文(股数、价格)也遮掉
  const secret: CSSProperties | undefined = hide ? ({ WebkitTextSecurity: "disc" } as CSSProperties) : undefined;
  const allRows = parsed?.ok ? parsed.rows : [];
  const indexOf = new Map(valid.map((r, i) => [r, i]));
  const bad = allRows.filter((r) => r.error).length + (preview ?? []).filter((x) => x.problem).length;
  const dupExisting = (preview ?? []).filter((x) => x.duplicate === "existing").length;

  return (
    <GlassCard className="mb-4">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 text-left">
        <Table2 className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">批量导入流水（CSV / 复制粘贴）</h3>
        <span className="text-xs text-muted-foreground">在本机解析，不发给 AI；写进去之前先备份</span>
        {open ? <ChevronUp className="ml-auto h-4 w-4 text-muted-foreground" /> : <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-5 text-muted-foreground">
            第一行写列名：<b className="text-foreground">日期、类型、代码</b>必填，数量、价格、费用、金额、比例、名称、备注按类型填（和上面「记一笔」一样）。
            类型写 买入 / 卖出 / 现金分红 / 送转 / 期初持仓；A 股代码写满 6 位，港股写成 00700.HK，美股写代码。
            可以在表格软件里选中整张表复制、粘贴到下面，也可以选 CSV 文件（Excel 工作簿请先另存为 CSV）。一次最多 {CSV_MAX_ROWS} 行。
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              <FileUp className="h-3.5 w-3.5" />选择 CSV 文件
            </button>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="hidden" aria-label="选择 CSV 文件"
              onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
            <button onClick={() => { reset(); setText(TRADE_CSV_TEMPLATE); }} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              填入格式示例
            </button>
          </div>
          <textarea aria-label="表格内容" value={text} onChange={(e) => { setText(e.target.value); if (parsed) reset(); }} rows={6} spellCheck={false} style={secret}
            placeholder={"日期,类型,代码,名称,数量,价格,费用\n2025-01-02,买入,600519,贵州茅台,100,1500,5"}
            className="w-full rounded-lg border border-border bg-black/20 px-3 py-2 font-mono text-xs outline-none focus:border-primary/50" />
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => void check()} disabled={busy || !text.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-1.5 text-sm font-medium text-primary hover:bg-primary/25 disabled:opacity-50">
              {busy && !preview ? <Loader2 className="h-4 w-4 animate-spin" /> : null}检查
            </button>
            {hide && <span className="text-[11px] text-muted-foreground">隐私模式下输入框里的内容显示成圆点</span>}
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {parsed && !parsed.ok && <p role="alert" className="text-xs text-destructive">{parsed.error}</p>}
          {parsed?.ok && (
            <>
              <p className="text-xs text-muted-foreground">
                共 {allRows.length} 行：勾选了 {chosen.length} 行{bad > 0 && `，${bad} 行数据不对`}{dupExisting > 0 && `，${dupExisting} 行和已记的一样`}。
                {parsed.unused.length > 0 && <>这些列没用上：{parsed.unused.join("、")}。</>}
              </p>
              <div className="max-h-80 overflow-auto rounded-lg border border-border/50">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-background/95 text-muted-foreground">
                    <tr className="text-left">
                      <th className="w-8 px-2 py-1.5"><span className="sr-only">导入</span></th>
                      <th className="px-2 py-1.5 font-normal">行</th>
                      <th className="px-2 py-1.5 font-normal">日期</th>
                      <th className="px-2 py-1.5 font-normal">类型</th>
                      <th className="px-2 py-1.5 font-normal">代码</th>
                      <th className="px-2 py-1.5 font-normal">数字</th>
                      <th className="px-2 py-1.5 font-normal">检查结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allRows.map((r) => {
                      const i = indexOf.get(r) ?? -1;
                      const s = status(r, i);
                      const can = i >= 0 && preview?.[i]?.problem === null;
                      return (
                        <tr key={r.line} className="border-t border-border/30 align-top">
                          <td className="px-2 py-1.5">
                            {can && <input type="checkbox" checked={!!selected[i]} onChange={() => toggle(i)} aria-label={`导入第 ${r.line} 行`} />}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-muted-foreground">{r.line}</td>
                          <td className="whitespace-nowrap px-2 py-1.5 font-mono">{(r.record?.date as string | undefined) ?? r.cells.date}</td>
                          <td className="whitespace-nowrap px-2 py-1.5">{r.record ? TRADE_TYPE_LABELS[r.record.type as TradeType] : r.cells.type}</td>
                          <td className="whitespace-nowrap px-2 py-1.5"><span className="font-mono">{(r.record?.symbol as string | undefined) ?? r.cells.symbol}</span>{r.cells.name && <span className="ml-1 text-muted-foreground">{r.cells.name}</span>}</td>
                          <td className="whitespace-nowrap px-2 py-1.5 font-mono">{r.record ? p(detailOf(r.record)) : ""}</td>
                          <td className={cn("px-2 py-1.5", s.tone === "bad" ? "text-destructive" : s.tone === "warn" ? "text-warning" : "text-muted-foreground")}>{show(s.text)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {existingIssues.length > 0 && (
                <div role="alert" className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs text-warning">
                  <p>按现在的勾选写进去以后，已记的 {existingIssues.length} 笔会不参与计算（现在是能算的）：</p>
                  <ul className="mt-1 list-disc pl-5">
                    {existingIssues.slice(0, 10).map((x) => (
                      <li key={x.id}><span className="font-mono">{x.date}</span> {TRADE_TYPE_LABELS[x.type as TradeType] ?? x.type} <span className="font-mono">{x.symbol}</span>：{show(x.why)}</li>
                    ))}
                  </ul>
                  {existingIssues.length > 10 && <p>另有 {existingIssues.length - 10} 笔。</p>}
                  <p className="mt-1">多半是表格里有和已记的重复、或日期对不上的流水，核对后再导入。</p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button onClick={() => void importNow()} disabled={busy || chosen.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
                  {busy && preview ? <Loader2 className="h-4 w-4 animate-spin" /> : null}导入选中的 {chosen.length} 笔
                </button>
                <span className="text-[11px] text-muted-foreground">
                  {rechecking ? "正在按新的勾选重新核对，核对完才能导入。" : "写进去之前先把原文件备份到数据目录；要么全部写进去，要么一笔都不写。"}{skipped > 0 && `有 ${skipped} 笔写进去后不参与计算（原因见上），确认无误再导入。`}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </GlassCard>
  );
}
