/** 金融 Plugin 的 Deep 对象解析：只在 composition root 注入通用任务层。 */
import { createHash } from "node:crypto";

import { DeepExecutionError, type DeepResearchTarget, type DeepTargetResolver } from "../engines/deep_engine.ts";
import { reportText } from "../report_library.ts";
import type { RouteDecision } from "../task_router.ts";

// 号段 → 交易所，逐段写全。🔴 不能只看首位：9 开头只有 92 是北交所，900 是沪 B 股、93 开头是中证指数。
// B 股（沪 900、深 200）和 ETF 不在 Deep 研究范围内，落到下面「认不出」。
const A_SHARE_BOARDS: ReadonlyArray<readonly [RegExp, "SH" | "SZ" | "BJ"]> = [
  [/^6\d{5}$/, "SH"],
  [/^[03]\d{5}$/, "SZ"],
  [/^(?:[48]\d|92)\d{4}$/, "BJ"],
];
const HK_RE = /^(\d{1,5})(?:\.HK)?$/i;
const US_RE = /^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$/;
const revisionOf = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * 代码 → 研究用的 (代码, 市场)。A 股 6 位按号段判沪深北;港股 1-5 位数字(可带 .HK)补成 5 位;美股大写代码。
 * 资料库入库时港股已规范成 5 位(00700)、美股是大写代码(见 finance/report_symbols.ts)。认不出 → null。
 */
export function deepTargetOf(raw: string): { symbol: string; market: string } | null {
  const s = raw.trim();
  const board = A_SHARE_BOARDS.find(([re]) => re.test(s));
  if (board) return { symbol: s, market: board[1] };
  if (/^\d{6,}$/.test(s)) return null;
  const hk = HK_RE.exec(s);
  if (hk) return { symbol: hk[1]!.padStart(5, "0"), market: "HK" };
  const us = s.toUpperCase();
  return US_RE.test(us) ? { symbol: us, market: "US" } : null;
}

export class FinanceDeepTargetResolver implements DeepTargetResolver {
  readonly #dataRoot: string;
  constructor(dataRoot: string) { this.#dataRoot = dataRoot; }

  resolveDeepTarget(route: RouteDecision): DeepResearchTarget {
    const explicit = route.materials.inputs
      .filter((item) => item.kind === "entity" && item.status === "ready")
      .map((item) => item.id);
    const reportIds: string[] = [];
    const reportRevisions: Record<string, string> = {};
    const reportSymbols = new Set<string>();
    for (const item of route.materials.inputs) {
      if (item.kind !== "report" && item.kind !== "document") continue;
      // 圈选范围里只要有一份缺失/不可读就整次拒绝。跳过它再继续会把空 reportIds
      // 解释成“未限定资料”，进而回退到同标的整库召回，越过用户明确圈选的边界。
      if (item.status !== "ready") {
        throw new DeepExecutionError("deep_start_failed", "所选资料已缺失或尚未解析完成，请刷新资料列表后重新发起任务");
      }
      const found = reportText(this.#dataRoot, item.id);
      if (!found || revisionOf(found.text) !== item.revision) {
        throw new DeepExecutionError("deep_start_failed", "资料在路由后发生变化，请重新发起任务");
      }
      reportIds.push(item.id);
      reportRevisions[item.id] = item.revision!;
      for (const symbol of found.record.symbols) reportSymbols.add(symbol);
    }
    if ([...reportSymbols].some((symbol) => !deepTargetOf(symbol))) {
      throw new DeepExecutionError("deep_unsupported_entity", "所选材料里有认不出市场的代码，六阶段 Deep 研究只支持 A 股、港股、美股");
    }
    const candidates = new Map<string, { symbol: string; market: string }>();
    for (const raw of [...explicit, ...reportSymbols]) {
      const t = deepTargetOf(raw);
      if (t) candidates.set(`${t.market}:${t.symbol}`, t);
    }
    if (candidates.size === 0) {
      throw new DeepExecutionError("deep_entity_required", "Deep 六阶段研究需要一个可确认的代码（A 股、港股或美股）；请只选择同一标的资料");
    }
    if (candidates.size !== 1) {
      throw new DeepExecutionError("deep_multiple_entities", "所选材料包含多个代码，Deep 不会猜选哪一个；请一次只选一个标的");
    }
    const { symbol, market } = [...candidates.values()][0]!;
    return Object.freeze({ symbol, market, reportIds: Object.freeze(reportIds),
      reportRevisions: Object.freeze(reportRevisions) });
  }
}
