import { useMemo, useState, type ReactNode } from "react";
import { LineChart as LineIcon } from "lucide-react";

import { EChart } from "@/components/ui/EChart";
import { GlassCard } from "@/components/ui/GlassCard";
import { usePalette } from "@/components/ui/chartPalette";
import { SegmentedToggle as Toggle } from "@/components/ui/SegmentedToggle";
import {
  bootstrapBase, COST_ROWS, costSummary, equityOption, fixed, monthlyOption, paramLabel, pct, sensitivityOption, SENSITIVITY_METRICS, sharePct, underwaterOption, yearlyOption,
  type BacktestView, type SensitivityMetric,
} from "@/lib/backtestView";

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

const tone = (v: number | null) => (v === null ? "" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "");

export function BacktestCharts({ view }: { view: BacktestView }) {
  const palette = usePalette();
  const [monthWhich, setMonthWhich] = useState<"ret" | "bench">("ret");
  const [metric, setMetric] = useState<SensitivityMetric>("total_return");

  const equity = useMemo(() => equityOption(view, palette), [view, palette]);
  const underwater = useMemo(() => underwaterOption(view, palette), [view, palette]);
  const monthly = useMemo(() => monthlyOption(view, palette, monthWhich), [view, palette, monthWhich]);
  const yearly = useMemo(() => yearlyOption(view, palette), [view, palette]);
  const s = view.sensitivity;
  const sens = useMemo(() => (s ? sensitivityOption(s, metric, palette) : null), [s, metric, palette]);
  const rb = view.robustness;
  const c = view.costs;
  const years = view.monthly?.years.length ?? 0;

  return (
    <GlassCard className="space-y-6">
      <div className="flex items-center gap-2">
        <LineIcon className="h-4 w-4 text-primary" />
        <h2 className="text-base font-semibold">回测图表</h2>
        <span className="text-xs text-muted-foreground">图里的数直接取自回测工具，与上面的报告同源</span>
      </div>

      {equity && <Section title={`累计收益：策略对${view.benchmarkLabel}`}
        note={view.benchmarkIsSelf ? "没有取到指数，对照是标的等权买入持有" : "对照是价格序列，不含分红再投资"}>
        <EChart option={equity} height={300} />
      </Section>}

      {underwater && <Section title="水下回撤" note="离上一个高点跌了多少；高点从初始资金起算">
        <EChart option={underwater} height={170} />
      </Section>}

      {(monthly || yearly) && <div className="grid gap-6 xl:grid-cols-2">
        {monthly && <Section title="月度收益">
          {view.monthly?.bench && <Toggle value={monthWhich} onChange={setMonthWhich}
            options={[{ key: "ret", label: "策略" }, { key: "bench", label: view.benchmarkLabel }]} />}
          <EChart option={monthly} height={Math.max(180, years * 24 + 72)} />
        </Section>}
        {yearly && <Section title="年度收益" note={view.yearly.some((r) => r.partial) ? "* 该年不完整（回测区间只覆盖了一部分）" : undefined}>
          <EChart option={yearly} height={Math.max(180, Math.min(years * 24 + 72, 420))} />
        </Section>}
      </div>}

      {c && <Section title="扣费前后对照" note="同一套信号把费用和滑点设为零再跑一遍，只用来量成本；现实里做不到零成本">
        {"error" in c ? <p className="text-xs text-muted-foreground">{c.error}</p> : <div className="space-y-2">
          <div className="max-w-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground"><tr className="border-b border-border/60 text-left">
                <th className="py-1.5 font-medium">指标</th><th className="text-right font-medium">实际（扣费和滑点）</th>
                <th className="text-right font-medium">不计成本</th>
              </tr></thead>
              <tbody>{COST_ROWS.map((r) => {
                const signed = r.key === "total_return" || r.key === "annual_return";
                return (
                  <tr key={r.key} className="border-b border-border/30">
                    <td className="py-1.5">{r.label}</td>
                    <td className={`text-right font-mono ${signed ? tone(c.actual[r.key]) : ""}`}>{r.fmt(c.actual[r.key])}</td>
                    <td className={`text-right font-mono ${signed ? tone(c.free[r.key]) : ""}`}>{r.fmt(c.free[r.key])}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <p className="text-xs leading-5">{costSummary(c)}</p>
          {c.note && <p className="text-[11px] leading-4 text-muted-foreground">{c.note}</p>}
        </div>}
      </Section>}

      {(view.drawdowns.length > 0 || rb) && <div className="grid gap-6 xl:grid-cols-2">
        {view.drawdowns.length > 0 && <Section title="最深的几段回撤">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground"><tr className="border-b border-border/60 text-left">
                <th className="py-1.5 font-medium">开始</th><th className="font-medium">谷底</th><th className="font-medium">恢复</th>
                <th className="text-right font-medium">深度</th><th className="text-right font-medium">持续（交易日）</th>
              </tr></thead>
              <tbody>{view.drawdowns.map((d) => (
                <tr key={d.start} className="border-b border-border/30">
                  <td className="py-1.5 font-mono">{d.start}</td><td className="font-mono">{d.trough}</td>
                  <td className="font-mono">{d.end ?? <span className="text-warning">未恢复</span>}</td>
                  <td className={`text-right font-mono ${tone(d.depth)}`}>{pct(d.depth, 2)}</td>
                  <td className="text-right font-mono">{d.bars}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Section>}
        {rb && <Section title="稳健性检验" note="同一段历史上的检验，不代表未来表现">
          <div className="space-y-3 text-xs leading-5">
            {rb.bootstrap && ("error" in rb.bootstrap
              ? <p className="text-muted-foreground">夏普区间没有算出来：{rb.bootstrap.error}</p>
              : <p>夏普比率 {pct(rb.bootstrap.confidence, 0)} 区间：<b className="font-mono">{fixed(rb.bootstrap.ci_lower)} ~ {fixed(rb.bootstrap.ci_upper)}</b>，
                {bootstrapBase(rb.bootstrap)}里为正的比例 <b className="font-mono">{sharePct(rb.bootstrap.prob_positive)}</b>。</p>)}
            {rb.segments && ("error" in rb.segments
              ? <p className="text-muted-foreground">分段检验没有做：{rb.segments.error}</p>
              : <>
                <p>把净值切成 {rb.segments.n_windows ?? "—"} 段，其中 <b className="font-mono">{rb.segments.profitable_windows ?? "—"}</b> 段赚钱。</p>
                <div className="overflow-x-auto"><table className="w-full">
                  <thead className="text-muted-foreground"><tr className="border-b border-border/60 text-left">
                    <th className="py-1.5 font-medium">区间</th><th className="text-right font-medium">收益</th>
                    <th className="text-right font-medium">夏普</th><th className="text-right font-medium">最大回撤</th>
                  </tr></thead>
                  <tbody>{rb.segments.windows.map((w) => (
                    <tr key={w.window} className="border-b border-border/30">
                      <td className="py-1.5 font-mono">{w.start} ~ {w.end}</td>
                      <td className={`text-right font-mono ${tone(w.return)}`}>{pct(w.return, 1)}</td>
                      <td className="text-right font-mono">{fixed(w.sharpe)}</td>
                      <td className="text-right font-mono">{pct(w.max_dd, 1)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </>)}
          </div>
        </Section>}
      </div>}

      {s && sens && <Section title="参数敏感度"
        note="参数在你给的值附近各换几档重跑，看结论稳不稳。不代表最优参数，也不代表未来表现。">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Toggle value={metric} onChange={setMetric} options={SENSITIVITY_METRICS} />
          <p className="text-xs text-muted-foreground">
            {s.positiveShare !== null && <>跑出结果的 {s.runs} 格里，{sharePct(s.positiveShare)} 收益为正，区间 {pct(s.returnMin)} ~ {pct(s.returnMax)}。</>}
            {Object.keys(s.fixed).length > 0 && <> 固定不动：{Object.entries(s.fixed).map(([k, v]) => `${paramLabel(k)} ${v}`).join("、")}。</>}
            {!s.complete && <span className="text-warning"> 超过时间上限，网格没有跑完。</span>}
          </p>
        </div>
        <EChart option={sens} height={Math.max(300, s.y.values.length * 40 + 110)} />
      </Section>}
    </GlassCard>
  );
}
