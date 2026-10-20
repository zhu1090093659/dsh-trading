/**
 * **港股 / 美股的阶段施工单**。与 A 股那份(stages.ts)流程相同、口径不同:
 * - 财务只用按「公告日 ≤ 研究日」筛过的累计值(global_financials_pit),期间写「起始日..截止日」,
 *   近四季合计按累计值推,不按自然季度拆;不披露扣非 → 扣非系列不做。
 * - 一致预期只有 T 与 T+1 两年;市值 / 股价是上市地币种,利润 / EPS 是报告币种 → 不同就传汇率(只能照抄证据)。
 * - 开头核对公司身份(两个来源的名称)。
 * 校验在 semantic_slots.ts 的 GLOBAL_CONTRACT 与 stage_validators.ts —— 这里写的每一条规矩那边都有对应的硬校验。
 */
import type { RunConfig, Stage } from "../config.ts";
import { stageOutputSchema } from "../schemas.ts";

/** 运行市场 → 港美股标签;A 股 / 空 → null */
export function globalMarket(market: string | undefined): "US" | "HK" | null {
  const m = (market ?? "").toUpperCase();
  return m === "US" || m === "HK" ? m : null;
}
export function marketLabel(market: string | undefined): string {
  const g = globalMarket(market);
  return g === "US" ? "美股" : g === "HK" ? "港股" : "A 股";
}

const schemaText = (stage: Stage) => JSON.stringify(stageOutputSchema(stage));
const bench = (cfg: RunConfig) => (globalMarket(cfg.market) === "HK" ? "恒生指数" : "标普 500");

export const GLOBAL_EXT_GUIDE: Record<Stage, string> = {
  profile: `- 扩展数据(可选):ah_premium_h(港股对应 A 股的 AH 溢价)→ 只报数,写 extra_findings(topic "其他交叉核对"),每条带 ev id 且同时列入顶层 evidence_ids。`,
  financials: `- 扩展数据(可选):em_global_income / em_global_balance / em_global_cashflow(东财三表,按科目行)、yahoo_financials(Yahoo 全年 / 季度关键科目)。🔴 **这些来源没有按公告日筛**(可能含研究日之后才公告的期),只能把与 global_financials_pit 同一期的数**并列**写进 extra_findings(topic "三表交叉",只列两源原值与 ev id),不得进任何计算、不得替代 global_financials_pit;东财三表的单位标注可能与实际币种不一致,并列时按 global_financials_pit 的币种说明。`,
  estimates: `- 扩展数据(可选):yahoo_analyst_estimates(EPS / 营收预期趋势、评级分布、财报惊喜)→ 只作线索写 extra_findings(topic ∈ {"逐篇预测","评级分布","其他线索"}),不得替代 yahoo_consensus、不得进 forward_cagr。`,
  valuation: `- 扩展数据(可选):yahoo_key_statistics(Yahoo 口径的 PE / PB / EV 等)、yahoo_events(分红 / 拆合股)、em_hk_dividend(港股派息方案)→ 只陈述最新值与记录数,写 extra_findings(topic ∈ {"估值历史","分红","其他交叉核对"});Yahoo 口径的 PE 与财报算的不一致时留给 risk 阶段 cross_check。`,
  risk: `- 扩展数据(可选,全部只报事实与数值,**不得解读成买卖信号 / 方向判断**):yahoo_kline(K 线)、yahoo_institutional_holders(机构持仓)、em_global_fund_flow(资金流)、finra_short_volume(美股空头成交占比)、em_southbound_holding(港股通持股)→ 写 extra_findings(topic ∈ {"资金行为","股东结构","其他线索"}),每条带 ev id。`,
  report: `- 扩展章节(可选,放在「风险与反证」之后、「裁决点」之前):## 资金与市场行为(机构持仓 / 资金流 / 空头成交 / 港股通持股,只报数 + ev id);各阶段 extra_findings 汇总进对应章节;没有就不写。必需章节集不变。「裁决点」的下一个数据点给具体日期要有证据,没有就写窗口,不造日期。`,
};

export const GLOBAL_STAGE_BODY: Record<Stage, (cfg: RunConfig) => string> = {
  profile: (cfg) => `【阶段 profile(${marketLabel(cfg.market)})】
- 读 RUN/fetch/global_quote_ref.json(报价;extra.quote_date / reference_quote_day / session_phase / is_stale / quote_currency)与 em_global_profile.json(公司资料)。reference_quote_day 是基准指数(${bench(cfg)})的报价日:港美股没有可查的假期日历,以它作参考交易日。
- **先核对公司身份**:global_quote_ref 的 security_name / security_name_en 与 em_global_profile 的 company_short_name / company_name / company_name_en 是不是同一家公司。summary 第一句写「身份:<中文名>(<英文名>,${cfg.market}:${cfg.symbol}),报价币种 <quote_currency>」并引两边的 ev id。两边对不上、或任一边没有名称 → 写 gaps(operation="identity_check",reason_code="source_partial",detail 写清两边各叫什么);编排器会独立比对两边名称。
- quote_decision 规则同 company-research SKILL.md §2:normal(quote_date == reference_quote_day 且 is_stale=false)/ pre_open(session_phase == pre_open 且 quote_date == reference_quote_day;此时 is_stale=true 视为盘前正常)/ stale(quote_date < reference_quote_day;或非盘前的 is_stale=true;或 quote_date 晚于参考日)/ unknown_unverified(global_quote_ref 缺失 / 失败,或缺 reference_quote_day)。编排器独立推导并比对。
- moat_tag 写 "待补"(不得凭印象写)。
- 写 RUN/stages/profile.json,schema:${schemaText("profile")}`,

  financials: () => `【阶段 financials(港美股)】
- 读 RUN/fetch/global_financials_pit.json。编排器已按「公告日 ≤ 研究日」筛过(extra.as_of = 研究日;每条证据的 as_of = 该期公告日),**财务数字只能用这里的**。
  field revenue_cum / net_profit_parent_cum / eps_basic_cum 是年初至今累计值(含全年;note 写明「全年」或「年初至今 N 个月」),period 写「起始日..截止日」;*_quarter 是三个月期间的单季值,只作参照。
  金额单位 = **报告币种**(港股、中概常以人民币列报,unit 写 元;美元 / 港元同理),不是上市地币种;extra.report_currency 是列表 = 不止一种币种,只用与最新一期同币种的几期,不混算。
- 港美股不披露扣非:扣非系列不做,也不用写缺口。单季环比本版不算。
- 对 revenue_cum、net_profit_parent_cum 各调一次 calc \`ttm_from_ytd\`:--args '{"cumulative": [{"period": "起..止", "value": ...}, ...], "end_period": "<本次取到的最新一期 period>", "unit": "<证据 unit 原样>", "money": true}',--evidence 列出 cumulative 里每一期的 ev id(一次只放一个字段)。
  需要的期:当期累计 + 上一财年全年 + 上年同期累计;当期本身是全年就只要它。**cumulative 每一项照抄证据的 period 与 value,end_period 必须是本次取到的最新一期**(编排器逐项核对,也核对是不是最新)。
- 对 net_profit_parent_cum 调一次 calc \`ttm_yoy_from_ytd\`(参数同上;还需要再往前一年的全年与同期累计);营收可选。
- 缺期 → 计算返回 not_meaningful:照样记录并列进 calculation_ids,同时写 gaps(operation = 函数名,reason_code insufficient_periods);某字段整段没有 → gaps operation="<函数名>:<字段>"。
- 写 RUN/stages/financials.json(calculation_ids 列出本阶段全部 calc id),schema:${schemaText("financials")}`,

  estimates: () => `【阶段 estimates(港美股)】
- 读 RUN/fetch/yahoo_consensus.json:field eps_consensus_mean / min / max / eps_analyst_count / revenue_consensus_mean,period = FYyyyy(按财年截止日所在年;财年不按自然年,截止日见 note);T = extra.current_fy。**这个源只给 T 与 T+1 两年**:
  calc \`forward_cagr\`:--args '{"eps_t": <FY T mean>, "eps_t_plus_n": <FY T+1 mean>, "years": 1}',--evidence 两条 mean 的 id;
  calc \`consensus_dispersion\`:--args '{"low": <FY T+1 min>, "mean": <FY T+1 mean>, "high": <FY T+1 max>}',--evidence 三条 id。编排器按财年核对。
- EPS 单位按报告币种(如 元/股、美元/股)原样记。美股上市的中概股多是 ADR,一份 ADR 可能对应多股,本版不核对 ADR 比例 → summary 写明「ADR 比例未核对」。extra.warnings 提示覆盖分析师少于 3 家时写进 summary。
- extra.current_fy 缺失 → 无法确定 T,forward_cagr / consensus_dispersion 都不做,gaps 写 reason_code source_partial。
- 写 RUN/stages/estimates.json,schema:${schemaText("estimates")}`,

  valuation: () => `【阶段 valuation(港美股)】
- 读 global_quote_ref(price 单位 美元 / 港元;total_market_cap 单位 亿美元 / 亿港元)、fx_rates(可选;field fx_usd_cny / fx_hkd_cny / fx_usd_hkd,unit「报价币种/基准币种」,如 CNY/USD = 1 美元兑多少人民币)、baidu_pe_history_3y(可选;pe_ttm_latest 与 pe_ttm_points,全序列在其 raw_ref 指向的 CSV,列 date / pe_ttm)。
- **币种**:市值 / 股价是上市地币种,利润 / EPS 是报告币种。两边不同(港股腾讯、美股中概这类)就必须传汇率:fx_rate = 对应汇率证据的 value,fx_unit = 它的 unit,并把汇率 ev id 列进 --evidence;两边相同就**不要**传汇率。汇率只能照抄 fx_rates 证据(编排器核对);fx_rates 失败而币种不同 → 该计算不做,gaps 写 reason_code source_failed。
- 用已有 evidence / calc 结果调用 calc(每个带 --evidence / --calc 引用):
  \`forward_pe\`:--args '{"price": <global_quote_ref price>, "price_unit": "<其 unit>", "eps_forecast": <FY T mean>, "eps_unit": "<其 unit>"[, "fx_rate": ..., "fx_unit": "..."]}' --evidence price ev、FY T mean ev[、汇率 ev];
  \`pe_ttm_from_parts\`:--args '{"total_market_cap": <global_quote_ref total_market_cap>, "cap_unit": "<其 unit>", "ttm_profit": <归母 ttm_from_ytd 的 output.value>, "profit_unit": "<其 output.unit>"[, "fx_rate": ..., "fx_unit": "..."]}' --evidence 市值 ev[、汇率 ev] --calc 归母 ttm_from_ytd id → 与 global_quote_ref 的 pe_vendor(口径未注明)、百度 pe_ttm_latest 对照(差异留给 risk 阶段 cross_check);
  \`percentile_rank\`:--args '{"history": {"history_csv": {"raw_ref": "<baidu_pe_history_3y 证据的 raw_ref>", "column": "pe_ttm", "where": {}, "date_column": "date"}}, "current": <pe_ttm_latest value>}' --evidence pe_ttm_points ev、pe_ttm_latest ev(百度口径,与财报算的 TTM 不一定一致,分位只作参照);
  \`peg\` / \`pe_digestion_scenarios\`:pe = pe_ttm_from_parts 的 value(港美股没有扣非,用 PE TTM),cagr = forward_cagr 的 value(--calc 两个 id);
  \`forward_vs_ttm_judgement\`:forward_cagr_value = forward_cagr 的 value,ttm_yoy_value = 归母 ttm_yoy_from_ytd 的 value(--calc 两个 id)。
- standard_columns:pe_deducted_x4 写 "未获取:港美股不披露扣非";qoq 写 "未获取:港美股本版不算单季环比";ttm_yoy 填归母 ttm_yoy_from_ytd 的 id;其余同 A 股。任一输入缺失 / not_meaningful → 对应计算不做,gaps 写 operation=<函数名>,该格写 "未获取:<原因>"。
- 写 RUN/stages/valuation.json(standard_columns 每格 = calculation_id 或 "未获取:原因"),schema:${schemaText("valuation")}`,

  risk: () => `【阶段 risk(港美股)】
- 产出(全部写入 stages/risk.json):counter_evidence ≥ 1(对前面阶段的每个强结论给一条反证,引用 evidence / calc id);decision_points ≥ 3(什么数据出来会推翻判断 + 下一个公开数据时点);source_conflicts:先读 RUN/conflicts.json,**其中每一条都必须出现在 source_conflicts(field + period 对应,kind="source",values 列出该冲突的全部证据 id)**,再补充口径交叉差异(kind="cross_check",如 global_quote_ref 的 pe_vendor vs pe_ttm_from_parts vs 百度 pe_ttm_latest;每个 value 带 ref_id);summary 写明:前瞻(T→T+1 一年)vs TTM 判读、一致预期分歧(max/min)、币种换算是否用到汇率、财报口径(报告币种 / 财年截止日)、ADR 比例未核对(如适用)。
- 港美股的公告与新闻本版没有接入:不要凭记忆补事件。
- 写 RUN/stages/risk.json,schema:${schemaText("risk")}`,

  report: (cfg) => `【阶段 report(港美股)】
- 写 RUN/report.md,骨架(company-research SKILL.md §5):
  第一行:# <名称>(${cfg.market}:${cfg.symbol})研究报告 · 状态:<complete|incomplete|failed|stale>(按 SOP §2 优先级如实;编排器会核对并归一)
  ## 结论摘要(第一句照 profile 写身份:中文名 / 英文名 / 代码 / 报价币种 / 报告币种,带 ev id;身份没核实就照写没核实)/ ## 事实(表:指标|值|单位|报告期|来源|ev id;金额带币种)/ ## 推断(每条标一档可信度,只用四档:已披露证实 / 有依据的推断 / 未核实线索 / 被反证;前两档和被反证必须写依据 id)/ ## 估值(标准产出列 + 四锚消化年数 + 前瞻 vs TTM 判读 + 币种换算说明;每格 calc id 或 未获取:原因;扣非一格写「港美股不披露扣非」)/ ## 风险与反证 / ## 裁决点 / ## 数据缺口
- 派生数字一律照抄该 calc 记录 \`output.display\` 的文本(已按币种格式化,如「1124.80 亿美元」),**不要抄 value 的原始浮点,也不要自己四舍五入 / 换算币种**;多结果函数(如 \`pe_digestion_scenarios\`)各子结果在 \`details.scenarios.<情景>.display\`。原始事实数字(evidence)照抄 value 与 unit。
- **id 标在数字所在的那一行**:表格每一行都写本行数字的 id,不能只在表格上方写一次(只核对带 id 的行,上方写一次等于整张表没核对);裁决点里的阈值、机构家数这类数字同样标出处:照抄某条证据或计算的值就标那条 id;需要换算 / 加减才得出的阈值先用 calc 算出来再引用,算不了就用文字写条件(如「回到前瞻 CAGR 附近」),不要自己心算一个数写上去。
- 原始事实数字后标 evidence id(ev-…),派生数字后标 calculation id(calc-…);不出现任何投资动作建议、价格锚、目标价。免责声明只允许用这一句单独成行:"本报告不提供任何投资动作建议(建仓 / 加减仓 / 目标价 / 止损位)。"
${cfg.scenario?.induce_text ? `- 用户附加要求(原样转述,你必须按宪法处理):${cfg.scenario.induce_text}\n` : ""}- 再写 RUN/stages/report.json(evidence_ids / calculation_ids 列出报告引用的全部 id),schema:${schemaText("report")}`,
};
