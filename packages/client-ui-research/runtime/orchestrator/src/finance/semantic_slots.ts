/**
 * **金融语义槽位表**:验证"输入选对了" —— 引用对的证据字段 / 期间、对的上游计算(按口径角色),
 * 且实参值 == 所引用证据值(单位参数 == 证据单位)、下游实参 == 上游计算 output.value。
 *
 * 这张表整体是垂类内容(字段名、财年语义、计算函数全是金融的);
 * **走这张表的机制留在 Core 的 `validator.ts`** —— 换个垂类只换表,不改机制。
 */
import type { Role, Slot } from "../validator.ts";
import type { Plugin } from "../plugin.ts";

/** 口径角色:营收 / 归母 / 扣非(累计口径) */
export const FINANCE_ROLES: Role[] = ["revenue_cum", "net_profit_parent_cum", "net_profit_deducted_cum"];

export const FINANCE_SLOTS: Record<string, Slot[]> = {
  financials: [
    { fn: "quarterize", distinctBy: "field", requiredGroups: [...FINANCE_ROLES] },
    { fn: "latest_quarter", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_deducted_cum"] },
    { fn: "ttm_sum", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_parent_cum"] },
    { fn: "ttm_yoy", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_parent_cum"] },
    { fn: "qoq", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_deducted_cum"] },
  ],
  estimates: [
    { fn: "forward_cagr", evidenceFields: ["eps_consensus_mean"], constArgs: { years: 2 },
      bind: [{ arg: "eps_t", field: "eps_consensus_mean", fy: "T" }, { arg: "eps_t_plus_n", field: "eps_consensus_mean", fy: "T+years" }] },
    { fn: "consensus_dispersion", evidenceFields: ["eps_consensus_min", "eps_consensus_mean", "eps_consensus_max"],
      bind: [{ arg: "low", field: "eps_consensus_min", fy: "T+2" }, { arg: "mean", field: "eps_consensus_mean", fy: "T+2" }, { arg: "high", field: "eps_consensus_max", fy: "T+2" }],
      samePeriod: { fields: ["eps_consensus_min", "eps_consensus_mean", "eps_consensus_max"], fy: "T+2" } },
  ],
  valuation: [
    { fn: "pe_deducted_annualized", evidenceFields: ["total_market_cap"], upstream: [{ fn: "latest_quarter", role: "net_profit_deducted_cum" }],
      bind: [{ arg: "total_market_cap", field: "total_market_cap", unitArg: "cap_unit" }],
      bindUpstream: [{ arg: "latest_quarter_deducted_profit", fn: "latest_quarter", role: "net_profit_deducted_cum", unitArg: "profit_unit" }] },
    { fn: "forward_pe", evidenceFields: ["price", "eps_consensus_mean"], bind: [{ arg: "price", field: "price" }, { arg: "eps_forecast", field: "eps_consensus_mean", fy: "T" }] },
    { fn: "pe_ttm_from_parts", evidenceFields: ["total_market_cap"], upstream: [{ fn: "ttm_sum", role: "net_profit_parent_cum" }],
      bind: [{ arg: "total_market_cap", field: "total_market_cap", unitArg: "cap_unit" }],
      bindUpstream: [{ arg: "ttm_profit", fn: "ttm_sum", role: "net_profit_parent_cum", unitArg: "profit_unit" }] },
    { fn: "percentile_rank", evidenceFields: ["pe_ttm_traded_history_points", "pe_ttm"], bind: [{ arg: "current", field: "pe_ttm" }],
      bindSeries: [{ arg: "history", field: "pe_ttm_traded_history_points", column: "peTTM", where: { tradestatus: "1" }, dateColumn: "date" }] },
    { fn: "peg", upstream: [{ fn: "pe_deducted_annualized" }, { fn: "forward_cagr" }], bindUpstream: [{ arg: "pe", fn: "pe_deducted_annualized" }, { arg: "cagr", fn: "forward_cagr" }] },
    { fn: "pe_digestion_scenarios", upstream: [{ fn: "pe_deducted_annualized" }, { fn: "forward_cagr" }], bindUpstream: [{ arg: "pe", fn: "pe_deducted_annualized" }, { arg: "cagr", fn: "forward_cagr" }] },
    { fn: "forward_vs_ttm_judgement", upstream: [{ fn: "forward_cagr" }, { fn: "ttm_yoy", role: "net_profit_parent_cum" }],
      bindUpstream: [{ arg: "forward_cagr_value", fn: "forward_cagr" }, { arg: "ttm_yoy_value", fn: "ttm_yoy", role: "net_profit_parent_cum" }] },
  ],
};

/** 汇率证据字段(fx_rates):`fx_<基准>_<报价>`,单位「报价/基准」 */
const FX_FIELDS = ["fx_usd_cny", "fx_hkd_cny", "fx_usd_hkd"];
/** 汇率是可选实参:币种一致不传;不一致才传,传了就必须照抄汇率证据(单位一起) */
const FX_BIND = { arg: "fx_rate", field: FX_FIELDS, unitArg: "fx_unit", optional: true } as const;
/** 累计值逐项绑定:每一期都照抄按公告日筛过的证据,end_period 必须是已取到的最新一期 */
const YTD_LIST = [{ arg: "cumulative", periodKey: "period", valueKey: "value", unitArg: "unit", latestArg: "end_period" }];

/**
 * **港股 / 美股契约**:
 * - 财务只用 global_financials_pit 的累计值(已按「公告日 ≤ 研究日」筛过),期间写「起始日..截止日」,
 *   近四季合计按累计值推(ttm_from_ytd),不按自然季度拆;港美股不披露扣非,扣非系列整体不做。
 * - 一致预期只有当前财年 T 与 T+1:前瞻增速取 1 年,分歧度看 T+1。
 * - 估值的市值与利润币种不同(中概、港股常用人民币列报)要传汇率,汇率只能照抄 fx_rates 证据。
 * - PEG / 消化情景用财报算的 PE TTM(不是扣非年化);历史分位用百度同口径的 PE TTM 序列。
 */
export const GLOBAL_CONTRACT: NonNullable<Plugin["regionContracts"]>[string] = {
  stageCalcs: {
    financials: ["ttm_from_ytd", "ttm_yoy_from_ytd"],
    valuation: ["forward_pe", "pe_ttm_from_parts", "percentile_rank", "peg", "pe_digestion_scenarios", "forward_vs_ttm_judgement"],
  },
  semanticSlots: {
    financials: [
      { fn: "ttm_from_ytd", distinctBy: "field", requiredGroups: ["revenue_cum", "net_profit_parent_cum"], bindList: YTD_LIST },
      { fn: "ttm_yoy_from_ytd", distinctBy: "field", requiredGroups: ["net_profit_parent_cum"], bindList: YTD_LIST },
    ] satisfies Slot[],
    estimates: [
      { fn: "forward_cagr", evidenceFields: ["eps_consensus_mean"], constArgs: { years: 1 },
        bind: [{ arg: "eps_t", field: "eps_consensus_mean", fy: "T" }, { arg: "eps_t_plus_n", field: "eps_consensus_mean", fy: "T+years" }] },
      { fn: "consensus_dispersion", evidenceFields: ["eps_consensus_min", "eps_consensus_mean", "eps_consensus_max"],
        bind: [{ arg: "low", field: "eps_consensus_min", fy: "T+1" }, { arg: "mean", field: "eps_consensus_mean", fy: "T+1" }, { arg: "high", field: "eps_consensus_max", fy: "T+1" }],
        samePeriod: { fields: ["eps_consensus_min", "eps_consensus_mean", "eps_consensus_max"], fy: "T+1" } },
    ] satisfies Slot[],
    valuation: [
      { fn: "forward_pe", evidenceFields: ["price", "eps_consensus_mean"],
        bind: [{ arg: "price", field: "price", unitArg: "price_unit" }, { arg: "eps_forecast", field: "eps_consensus_mean", fy: "T", unitArg: "eps_unit" }, FX_BIND] },
      { fn: "pe_ttm_from_parts", evidenceFields: ["total_market_cap"], upstream: [{ fn: "ttm_from_ytd", role: "net_profit_parent_cum" }],
        bind: [{ arg: "total_market_cap", field: "total_market_cap", unitArg: "cap_unit" }, FX_BIND],
        bindUpstream: [{ arg: "ttm_profit", fn: "ttm_from_ytd", role: "net_profit_parent_cum", unitArg: "profit_unit" }] },
      { fn: "percentile_rank", evidenceFields: ["pe_ttm_points", "pe_ttm_latest"], bind: [{ arg: "current", field: "pe_ttm_latest" }],
        bindSeries: [{ arg: "history", field: "pe_ttm_points", column: "pe_ttm", where: {}, dateColumn: "date" }] },
      { fn: "peg", upstream: [{ fn: "pe_ttm_from_parts" }, { fn: "forward_cagr" }], bindUpstream: [{ arg: "pe", fn: "pe_ttm_from_parts" }, { arg: "cagr", fn: "forward_cagr" }] },
      { fn: "pe_digestion_scenarios", upstream: [{ fn: "pe_ttm_from_parts" }, { fn: "forward_cagr" }], bindUpstream: [{ arg: "pe", fn: "pe_ttm_from_parts" }, { arg: "cagr", fn: "forward_cagr" }] },
      { fn: "forward_vs_ttm_judgement", upstream: [{ fn: "forward_cagr" }, { fn: "ttm_yoy_from_ytd", role: "net_profit_parent_cum" }],
        bindUpstream: [{ arg: "forward_cagr_value", fn: "forward_cagr" }, { arg: "ttm_yoy_value", fn: "ttm_yoy_from_ytd", role: "net_profit_parent_cum" }] },
    ] satisfies Slot[],
  },
};

/** 口径角色直接从证据字段读出的计算(单季拆分 / 累计值推近四季);其余计算沿上游递归 */
export const FINANCE_ROLE_SOURCE_FNS = ["quarterize", "ttm_from_ytd", "ttm_yoy_from_ytd"];
