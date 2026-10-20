/**
 * **金融的"报价是否陈旧"判定**(SOP §2),不信任 agent 自填。
 *
 * 判据全是证券特有的:交易日历、参考交易日、盘前时段、成交额为 0 且现价 == 昨收(停牌 / 废码)。
 * 换个垂类"数据陈旧"的含义完全不同 ⇒ 规则进包,Core 只在该判的时候来问(`Plugin.quoteDecision`)。
 */
import type { QuoteDecision, RunView } from "../validator.ts";

export function financeQuoteDecision(run: RunView): { decision: QuoteDecision; reason: string } {
  // 港美股没有可查的假期日历:global_quote_ref 同时给个股报价日与基准指数报价日(参考交易日)、交易时段
  const global = run.region !== undefined && run.region !== "CN";
  const qid = global ? "global_quote_ref" : "fetch_quote";
  const q = run.fetch[qid];
  const cal = global ? q : run.fetch["fetch_trade_calendar"];
  if (!q || q.status === "failed") return { decision: "missing", reason: `${qid} 缺失或失败` };
  if (!cal || cal.status === "failed") return { decision: "unknown_unverified", reason: "缺少交易日历,无法判定报价时效" };
  const qx = (q.extra ?? {}) as Record<string, unknown>;
  const cx = (cal.extra ?? {}) as Record<string, unknown>;
  const quoteDate = String(qx.quote_date ?? "");
  const ref = String(cx.reference_quote_day ?? "");
  const last = String(cx.last_trading_day ?? "");
  const phase = String(cx.session_phase ?? "");
  const stale = qx.is_stale;
  const preOpenOk = phase === "pre_open" && (quoteDate === ref || quoteDate === last);
  if (!quoteDate || !ref) return { decision: "unknown_unverified", reason: "缺 quote_date / reference_quote_day" };
  if (quoteDate < ref) return { decision: "stale", reason: `quote_date ${quoteDate} < reference_quote_day ${ref}:个股停牌或数据陈旧` };
  if (quoteDate > ref && !preOpenOk) return { decision: "stale", reason: `quote_date ${quoteDate} 晚于参考日 ${ref} 且非盘前集合竞价:数据异常` };
  if (stale === true) {
    if (preOpenOk) return { decision: "pre_open", reason: `盘前(session_phase=pre_open)且 quote_date ${quoteDate} 吻合,按昨收继续` };
    return { decision: "stale", reason: "成交额 0 且现价 == 昨收,且非盘前:停牌 / 废码" };
  }
  if (stale !== false) {
    const k = run.fetch["fetch_kline"];
    const kx = (k?.extra ?? {}) as Record<string, unknown>;
    const traded = k?.evidence.some(e => e.field === "volume_latest" && e.period === ref &&
      typeof e.value === "number" && Number.isFinite(e.value) && e.value > 0);
    if (k && k.status !== "failed" && String(kx.end ?? "") === ref && traded) return { decision: "normal", reason: "报价时效未知,K 线最新日期 == 参考日且成交量为正,二次验证通过" };
    return { decision: "unknown_unverified", reason: "报价时效未知,K 线日期或正成交量证据不足,无法二次验证" };
  }
  return { decision: "normal", reason: `quote_date ${quoteDate} == reference_quote_day ${ref},is_stale=false` };
}
