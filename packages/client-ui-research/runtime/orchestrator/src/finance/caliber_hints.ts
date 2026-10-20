/**
 * 口径适用性提示:按本次证据和计算记录**确定性**核对几处常见的口径错位,结果放在报告开头(见 report_prelude.ts)。
 * 只提示、不拦截:查到问题不改状态、不要求重算;模型写正文用到相关计算时要如实说明限制。
 *
 * 1. 币种:同一项计算追溯到的证据混用了两种以上币种(没换算就放进一个公式)。
 * 2. TTM / 单季期末:计算取的期末早于它手里序列的最新一期;或几项 TTM / 单季计算的期末互不相同。
 * 3. 财报是否最新:按 A 股定期报告披露期限,取数日应已能取到更新的报告,财务序列却停在更早一期。
 * 4. 扣非×4 是否适用:最新单季比前三季平均高或低三成以上,年化会把 PE 压低或抬高。
 *
 * 🔴 提示行里只写日期、期数、币种和 calc id,不写任何算出来的数 —— 数字忠实度会把没有出处的数字判违规,
 *    比值本身也该由 calc 算、由模型照抄 display,不该由编排器另算一份。
 * ⚠️ 计算记录落盘前没有经过 schema 校验:这里任何字段都可能缺失或类型不对,一律跳过,不抛异常。
 */
import type { CalcRecord, EvidenceItem } from "../merge.ts";

const CALC_ID = /^calc-[a-f0-9]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 港美股累计值的期间写成「起..止」 */
const RANGE = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;
const A_SHARE_MARKETS = new Set(["SH", "SZ", "BJ"]);
/** 证据里表示"不涉及币种"的写法(百分比、计数、文本) */
const NO_CURRENCY = new Set(["", "N/A", "NOT_APPLICABLE", "NONE"]);
/** 年化偏离多少算明显(最新单季 ÷ 前三季平均 超出 1 ± 这个值) */
const ANNUALIZE_BAND = 0.3;

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const idOf = (c: unknown): string | null => (isObj(c) && typeof c.calculation_id === "string" && CALC_ID.test(c.calculation_id) ? c.calculation_id : null);
const isOk = (c: unknown): c is CalcRecord => idOf(c) !== null && typeof (c as Rec).function === "string" && isObj((c as Rec).output) && ((c as CalcRecord).output.status === "ok");
const refsOf = (c: CalcRecord): { ref_type: string; ref_id: string }[] =>
  (Array.isArray(c.inputs_refs) ? c.inputs_refs : []).filter((r): r is { ref_type: "evidence" | "calculation"; ref_id: string } => isObj(r) && typeof r.ref_id === "string");
const inputOf = (c: CalcRecord, key: string): unknown => (isObj(c.inputs) ? c.inputs[key] : undefined);

/** (period, value) 序列里有数值的期,按期排序 */
function filled(v: unknown): { period: string; value: number }[] {
  return (Array.isArray(v) ? v : [])
    .flatMap((x) => (isObj(x) && typeof x.period === "string" && DATE.test(x.period) && typeof x.value === "number" && Number.isFinite(x.value)
      ? [{ period: x.period, value: x.value }] : []))
    .sort((a, b) => a.period.localeCompare(b.period));
}

/** 上一个季末:03-31 → 上年 12-31;06-30 → 03-31;09-30 → 06-30;12-31 → 09-30 */
function prevQuarterEnd(p: string): string | null {
  const y = Number(p.slice(0, 4));
  switch (p.slice(5)) {
    case "03-31": return `${y - 1}-12-31`;
    case "06-30": return `${y}-03-31`;
    case "09-30": return `${y}-06-30`;
    case "12-31": return `${y}-09-30`;
    default: return null;
  }
}

/**
 * 某一天按 A 股定期报告最晚披露日**应已能取到**的最新报告期。
 * 年报:会计年度结束后 4 个月内;半年报:上半年结束后 2 个月内(《上市公司信息披露管理办法》第十三条);
 * 季报:前 3 个月、前 9 个月结束后 1 个月内(沪深北交易所股票上市规则)。
 * ⇒ 4-30 前后看上年三季报 / 当年一季报,8-31 后看半年报,10-31 后看三季报;截止日当天还可能有公司在发,只算过了截止日。
 */
export function latestDuePeriod(day: string): string {
  const y = Number(day.slice(0, 4));
  const md = day.slice(5);
  if (md > "10-31") return `${y}-09-30`;
  if (md > "08-31") return `${y}-06-30`;
  if (md > "04-30") return `${y}-03-31`;
  return `${y - 1}-09-30`;
}

/** 取数日(北京时间):本次证据里最晚的 fetched_at */
function fetchDay(evidence: EvidenceItem[]): string | null {
  let last = Number.NaN;
  for (const e of evidence) {
    const t = Date.parse(typeof e?.fetched_at === "string" ? e.fetched_at : "");
    if (Number.isFinite(t) && !(t <= last)) last = t;
  }
  return Number.isFinite(last) ? new Date(last + 8 * 3600_000).toISOString().slice(0, 10) : null;
}

function currencyHints(evById: Map<string, EvidenceItem>, calcById: Map<string, CalcRecord>, oks: CalcRecord[]): string[] {
  const memo = new Map<string, Set<string>>();
  const currencies = (c: CalcRecord, seen: Set<string>): Set<string> => {
    const id = idOf(c)!;
    const hit = memo.get(id);
    if (hit) return hit;
    const out = new Set<string>();
    seen.add(id);
    // 计算里已带汇率换算(forward_pe / pe_ttm_from_parts 的 fx_rate),结果是倍数,不再算混用
    if (typeof inputOf(c, "fx_rate") === "number") { memo.set(id, out); return out; }
    for (const r of refsOf(c)) {
      const e = evById.get(r.ref_id);
      if (e) { const cur = String(e.currency ?? "").trim().toUpperCase(); if (!NO_CURRENCY.has(cur)) out.add(cur); continue; }
      const up = calcById.get(r.ref_id);
      if (up && !seen.has(r.ref_id)) for (const cur of currencies(up, seen)) out.add(cur);
    }
    memo.set(id, out);
    return out;
  };
  const mixed = (c: CalcRecord) => currencies(c, new Set()).size > 1;
  const lines: string[] = [];
  for (const c of oks) {
    if (!mixed(c)) continue;
    // 只报源头:上游计算已经混了币种的,下游(PEG、消化年数…)不再重复
    if (refsOf(c).some((r) => { const up = calcById.get(r.ref_id); return !!up && mixed(up); })) continue;
    lines.push(`> 口径提示：计算 ${c.function} 的输入混用了 ${[...currencies(c, new Set())].sort().join(" / ")}，结果没有换算成同一币种，不能直接当一个币种的数来读。[${idOf(c)}]`);
  }
  return lines;
}

const PERIOD_FNS = new Set(["ttm_sum", "ttm_yoy", "qoq", "latest_quarter", "ttm_from_ytd", "ttm_yoy_from_ytd"]);

function periodHints(oks: CalcRecord[]): string[] {
  const lines: string[] = [];
  const byEnd = new Map<string, string[]>();
  for (const c of oks) {
    if (!PERIOD_FNS.has(c.function)) continue;
    const end = c.function === "latest_quarter" ? (isObj(c.output.details) ? c.output.details.period : undefined) : inputOf(c, "end_period");
    if (typeof end !== "string" || !(DATE.test(end) || RANGE.test(end))) continue;
    byEnd.set(end, [...(byEnd.get(end) ?? []), idOf(c)!]);
    const latest = filled(inputOf(c, "single_quarters")).at(-1)?.period;
    if (latest && end < latest) {
      lines.push(`> 口径提示：计算 ${c.function} 的期末取 ${end}，但它所用的单季序列已有 ${latest}，没有用最新一期。[${idOf(c)}]`);
    }
  }
  if (byEnd.size > 1) {
    const groups = [...byEnd].sort(([a], [b]) => a.localeCompare(b)).map(([end, ids]) => `${end}：${[...ids].sort().join("、")}`);
    lines.push(`> 口径提示：TTM 与单季类计算的期末不一致（${groups.join("；")}），对比时注意它们不是同一期。`);
  }
  return lines;
}

function disclosureHint(evidence: EvidenceItem[], oks: CalcRecord[]): string[] {
  // 披露期限是 A 股的规定;别的市场接入研究时要换成各自的期限
  if (!evidence.some((e) => A_SHARE_MARKETS.has(String(e?.market)))) return [];
  const day = fetchDay(evidence);
  const periods = oks.filter((c) => c.function === "quarterize").flatMap((c) => filled(inputOf(c, "cumulative")).map((x) => x.period));
  if (!day || !periods.length) return [];
  const latest = periods.sort().at(-1)!;
  const due = latestDuePeriod(day);
  if (latest >= due) return [];
  return [`> 口径提示：按 A 股定期报告披露期限，取数日 ${day} 应已能取到 ${due} 的报告，本次财务数据最新只到 ${latest}；增速、TTM 和 PE 都基于这一期。`];
}

function annualizeHints(calcById: Map<string, CalcRecord>, oks: CalcRecord[]): string[] {
  const lines: string[] = [];
  for (const c of oks) {
    if (c.function !== "pe_deducted_annualized") continue;
    const lq = refsOf(c).map((r) => calcById.get(r.ref_id)).find((x): x is CalcRecord => isOk(x) && x.function === "latest_quarter");
    const end = lq && isObj(lq.output.details) ? lq.output.details.period : undefined;
    if (!lq || typeof end !== "string") continue;
    const s = filled(inputOf(lq, "single_quarters"));
    const k = s.findIndex((x) => x.period === end);
    if (k < 3) continue;
    const win = s.slice(k - 3, k + 1);
    // 四季必须首尾相接、都是正数:断档或亏损季拿来比"高低"没有意义
    if (win.some((x, i) => i > 0 && prevQuarterEnd(x.period) !== win[i - 1]!.period) || win.some((x) => x.value <= 0)) continue;
    const avg = (win[0]!.value + win[1]!.value + win[2]!.value) / 3;
    const r = win[3]!.value / avg;
    const side = r > 1 + ANNUALIZE_BAND ? ["高", "偏低"] : r < 1 - ANNUALIZE_BAND ? ["低", "偏高"] : null;
    if (!side) continue;
    lines.push(`> 口径提示：扣非×4 PE 的分母是 ${end} 单季扣非乘 4，这一季比前三季平均${side[0]}三成以上，年化后 PE ${side[1]}；季节性强的公司要对照 TTM PE 看。[${idOf(c)}]`);
  }
  return lines;
}

/** 报告开头的口径提示行(顺序固定,同一行只出一次) */
export function caliberHintLines(evidence: Iterable<EvidenceItem>, calcs: Iterable<CalcRecord>): string[] {
  const ev = [...evidence].filter((e) => isObj(e) && typeof e.id === "string");
  const all = [...calcs].filter((c) => idOf(c) !== null);
  const evById = new Map(ev.map((e) => [e.id, e]));
  const calcById = new Map(all.map((c) => [idOf(c)!, c]));
  const oks = all.filter(isOk).sort((a, b) => idOf(a)!.localeCompare(idOf(b)!));
  return [...new Set([
    ...currencyHints(evById, calcById, oks),
    ...periodHints(oks),
    ...disclosureHint(ev, oks),
    ...annualizeHints(calcById, oks),
  ])];
}
