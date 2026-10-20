/**
 * 持仓 = **交易流水按日期重放**的结果。台账只存用户写下的每一笔(期初持仓 / 买入 / 卖出 / 现金分红 / 送转拆股),
 * 持有多少、成本多少、已实现盈亏多少都在这里算出来,不另存一份 —— 存两份就会有两个真相。
 *
 * 🔴 两种成本法:先进先出(fifo)按买入批次逐批扣;移动加权平均(average)卖出不改均价。
 *    持有数量两者相同,成本与已实现盈亏不同 —— 界面要写明当前用的是哪一种。
 * 🔴 现金分红单独记为收入,不改持仓成本;费用计入买入成本、从卖出所得里扣。
 * 🔴 数据不对的流水(卖出超过持有、缺价格、比例不对……)逐条写原因、**不参与计算**,不猜也不补。
 *    跳过一笔卖出会让之后的持有数偏大 —— 所以问题清单必须摆在持仓明细旁边,不能藏。
 * 🔴 同一天:先送转(除权日的成交已按新股本计价),其余按录入顺序(created_at)。
 * 🔴 期初持仓的成本可以是负数:分红 / 送转摊薄之后真实存在(开源版 issue #3)。
 *
 * 纯函数:不读文件、不取行情。读台账、迁移旧持仓在 `holdings_view.ts`。
 */
import type { LedgerIssue, LedgerRecord } from "../ledger.ts";

export type CostMethod = "fifo" | "average";
export const COST_METHODS: Record<CostMethod, string> = { fifo: "先进先出", average: "移动加权平均" };
export const TRADE_TYPES = ["opening", "buy", "sell", "dividend", "split"] as const;
export type TradeType = (typeof TRADE_TYPES)[number];

export interface Trade {
  id: string; symbol: string; name: string; account: string; type: string; date: string;
  shares: number | null; price: number | null; fee: number | null; amount: number | null; ratio: number | null;
  note: string; migrated_from: string; created_at: string;
}
export interface TradeIssue { id: string; symbol: string; date: string; type: string; why: string }
/** 先进先出的一个买入批次;unit_cost 已含买入费用、已按送转换算 */
export interface Lot { trade_id: string; date: string; shares: number; unit_cost: number }
export interface HoldingRow {
  symbol: string; name: string; shares: number;
  /** 每股成本(按所选成本法);cost_total = unit_cost × shares */
  unit_cost: number; cost_total: number;
  /** 当前这段持有从哪天开始(清仓后再买从新的一天算) */
  opened_at: string;
  lots: Lot[];
  realized_pnl: number; dividends: number; fees: number; trade_count: number;
}
export interface RealizedRow { trade_id: string; symbol: string; date: string; shares: number; proceeds: number; cost: number; pnl: number }
export interface DividendRow { trade_id: string; symbol: string; date: string; amount: number }
/** 已经卖光、但有过已实现盈亏或分红的代码 */
export interface ClosedRow { symbol: string; name: string; realized_pnl: number; dividends: number; fees: number; last_date: string }
export interface ReplayResult {
  method: CostMethod;
  holdings: HoldingRow[];
  closed: ClosedRow[];
  realized: RealizedRow[];
  dividends: DividendRow[];
  issues: TradeIssue[];
}

/** 浮点余量:卖出 100 股、买入时是 33.333…×3 这类,差一点点不该报「卖超」 */
const EPS = 1e-8;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// 🔴 先判 NaN:`2025-13-01` 这种月份不存在的,new Date 得到 Invalid Date,toISOString 会直接抛错(导入预览 500)
const realDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function tradeOf(r: LedgerRecord): Trade {
  return {
    id: r.id, symbol: str(r.symbol), name: str(r.name), account: str(r.account), type: str(r.type), date: str(r.date),
    shares: num(r.shares), price: num(r.price), fee: num(r.fee), amount: num(r.amount), ratio: num(r.ratio),
    note: str(r.note), migrated_from: str(r.migrated_from), created_at: str(r.created_at),
  };
}

/** 重放顺序:日期 → 同日先送转 → 录入顺序 → id(保证同输入同输出) */
export function replayOrder(a: Trade, b: Trade): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const sa = a.type === "split" ? 0 : 1, sb = b.type === "split" ? 0 : 1;
  if (sa !== sb) return sa - sb;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 单笔流水自身的字段是否够算(不看前后文)。返回原因;够算返回 null */
/**
 * B 股(沪 900、深 200 开头)按美元、港元计价,而六位代码在这里一律按 A 股、人民币算 ——
 * 记进来会把美元、港元金额直接加进人民币合计(第四轮审计 C1)。支持之前先明确拒收。
 */
export const B_SHARE = /^(?:900|200)\d{3}$/;
export const B_SHARE_UNSUPPORTED = "B 股(900、200 开头)暂不支持:按美元、港元计价,并进人民币合计会算错";

export function tradeProblem(t: Trade): string | null {
  if (!t.symbol) return "没有代码";
  if (B_SHARE.test(t.symbol)) return B_SHARE_UNSUPPORTED;
  if (!(TRADE_TYPES as readonly string[]).includes(t.type)) return `类型「${t.type || "空"}」不认识`;
  if (!realDay(t.date)) return `日期「${t.date || "空"}」不是有效日期`;
  const pos = (v: number | null) => v !== null && v > 0;
  const feeOk = t.fee === null || t.fee >= 0;
  switch (t.type as TradeType) {
    case "opening":
      if (!pos(t.shares)) return "期初持仓要写大于 0 的数量";
      if (t.price === null) return "期初持仓要写每股成本";
      return null;
    case "buy":
    case "sell":
      if (!pos(t.shares)) return `${t.type === "buy" ? "买入" : "卖出"}要写大于 0 的数量`;
      if (!pos(t.price)) return `${t.type === "buy" ? "买入" : "卖出"}要写大于 0 的成交价`;
      if (!feeOk) return "费用不能是负数";
      return null;
    case "dividend":
      if (!pos(t.amount)) return "现金分红要写大于 0 的到账金额";
      return null;
    case "split":
      if (!pos(t.ratio)) return "送转拆股要写大于 0 的比例(每 1 股变成几股,如 10 转 5 写 1.5)";
      return null;
  }
}

interface Book {
  symbol: string; name: string;
  lots: Lot[]; // fifo
  shares: number; cost: number; // average:总股数、总成本
  opened_at: string;
  realized: number; dividends: number; fees: number; trades: number; last: string;
}

const heldShares = (b: Book, method: CostMethod) => (method === "fifo" ? b.lots.reduce((s, l) => s + l.shares, 0) : b.shares);

export function replayTrades(trades: readonly Trade[], method: CostMethod): ReplayResult {
  const books = new Map<string, Book>();
  const realized: RealizedRow[] = [];
  const dividends: DividendRow[] = [];
  const issues: TradeIssue[] = [];
  const issue = (t: Trade, why: string) => issues.push({ id: t.id, symbol: t.symbol, date: t.date, type: t.type, why });

  for (const t of [...trades].sort(replayOrder)) {
    const bad = tradeProblem(t);
    if (bad) { issue(t, bad); continue; }
    const b = books.get(t.symbol) ?? { symbol: t.symbol, name: "", lots: [], shares: 0, cost: 0, opened_at: "", realized: 0, dividends: 0, fees: 0, trades: 0, last: "" };
    books.set(t.symbol, b);
    const held = heldShares(b, method);
    if (t.type === "opening" || t.type === "buy") {
      const n = t.shares!, fee = t.type === "buy" ? (t.fee ?? 0) : 0;
      const total = n * t.price! + fee;
      if (held <= EPS) { b.opened_at = t.date; b.lots = []; b.shares = 0; b.cost = 0; }
      b.lots.push({ trade_id: t.id, date: t.date, shares: n, unit_cost: total / n });
      b.shares += n; b.cost += total; b.fees += fee;
    } else if (t.type === "sell") {
      const n = t.shares!, fee = t.fee ?? 0;
      if (n > held + EPS) { issue(t, `卖出 ${n} 股,超过当时持有的 ${round(held)} 股(之前的买入或送转可能没录)`); continue; }
      let cost = 0;
      if (method === "fifo") {
        let left = n;
        while (left > EPS && b.lots.length) {
          const lot = b.lots[0]!;
          const take = Math.min(lot.shares, left);
          cost += take * lot.unit_cost; lot.shares -= take; left -= take;
          if (lot.shares <= EPS) b.lots.shift();
        }
      } else {
        cost = b.shares > EPS ? (b.cost / b.shares) * n : 0;
      }
      // 两种成本法都维护总股数(fifo 也要,送转 / 清仓判断用同一个数)
      b.cost -= method === "average" ? cost : 0;
      b.shares -= n;
      const proceeds = n * t.price! - fee;
      realized.push({ trade_id: t.id, symbol: t.symbol, date: t.date, shares: n, proceeds, cost, pnl: proceeds - cost });
      b.realized += proceeds - cost; b.fees += fee;
      if (heldShares(b, method) <= EPS || b.shares <= EPS) { b.lots = []; b.shares = 0; b.cost = 0; }
    } else if (t.type === "dividend") {
      dividends.push({ trade_id: t.id, symbol: t.symbol, date: t.date, amount: t.amount! });
      b.dividends += t.amount!;
    } else if (t.type === "split") {
      // 空仓时也照收、不改股数:港美股算收益率时要靠它把拆股前的价格还原(卖光后拆股、之后又买回)
      const r = t.ratio!;
      for (const lot of b.lots) { lot.shares *= r; lot.unit_cost /= r; }
      if (held > EPS) b.shares *= r; // 平均法总成本不变
    }
    if (t.name) b.name = t.name;
    b.trades += 1; b.last = t.date;
  }

  const holdings: HoldingRow[] = [];
  const closed: ClosedRow[] = [];
  for (const b of [...books.values()].sort((x, y) => (x.symbol < y.symbol ? -1 : 1))) {
    const shares = heldShares(b, method);
    if (shares > EPS) {
      const costTotal = method === "fifo" ? b.lots.reduce((s, l) => s + l.shares * l.unit_cost, 0) : b.cost;
      holdings.push({ symbol: b.symbol, name: b.name, shares, unit_cost: costTotal / shares, cost_total: costTotal, opened_at: b.opened_at,
        lots: method === "fifo" ? b.lots.map((l) => ({ ...l })) : [], realized_pnl: b.realized, dividends: b.dividends, fees: b.fees, trade_count: b.trades });
    } else if (b.realized !== 0 || b.dividends !== 0) {
      closed.push({ symbol: b.symbol, name: b.name, realized_pnl: b.realized, dividends: b.dividends, fees: b.fees, last_date: b.last });
    }
  }
  return { method, holdings, closed, realized, dividends, issues };
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * 现在持有哪些代码(候选池「我的持仓」、事件日历、判据回看用):流水重放后数量 > 0 的,
 * 加上还没迁移成流水的旧持有记录(迁移冲突留着没处理的那些,用户眼里仍是持有)。
 * 🔴 字段不合台账规则的流水不算(与持仓页同口径):issues 传台账快照里的问题清单。
 */
export function heldFromLedger(recs: Readonly<Record<string, readonly LedgerRecord[]>>, issues: Readonly<Record<string, readonly LedgerIssue[]>> = {}): { symbol: string; name: string }[] {
  const trades = (recs.trade ?? []).map(tradeOf);
  const bad = new Set((issues.trade ?? []).map((i) => i.id));
  const out = new Map<string, string>();
  for (const h of replayTrades(trades.filter((t) => !bad.has(t.id)), "average").holdings) out.set(h.symbol, h.name);
  const migrated = new Set(trades.map((t) => t.migrated_from).filter(Boolean));
  for (const r of recs.position ?? []) {
    const s = str(r.symbol);
    if (!s || migrated.has(r.id) || !((num(r.shares) ?? 0) > 0)) continue;
    if (!out.has(s) || !out.get(s)) out.set(s, str(r.name) || out.get(s) || "");
  }
  return [...out].map(([symbol, name]) => ({ symbol, name })).sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
}
