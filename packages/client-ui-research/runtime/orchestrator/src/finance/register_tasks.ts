/**
 * 金融产品任务入口的额外注册项。
 *
 * 六阶段 CLI 只需要 `register.ts` 的 Plugin；Deep 任务解析器会依赖服务层与 Codex Deep 适配器，
 * 因而只在真正提供统一任务 API 的 composition root 加载。把两者混在同一个副作用入口里，
 * 会让实验 Direct CLI 即使完全不走 Deep，也在模块加载时拉入 Codex SDK。
 */
import "./register.ts";

import { registerDeepTargetResolver } from "../deep_target_registry.ts";
import { FinanceDeepTargetResolver } from "./deep_target.ts";
import { registerSchedule } from "../notify.ts";
import { FINANCE_SCHEDULE } from "./schedule.ts";
import { registerView } from "../views.ts";
import { eventCalendar } from "./events.ts";
import { verdictReview } from "./verdicts.ts";
import { candidatePool } from "./candidates.ts";
import { abnormalWatch } from "./abnormal.ts";
import { reviewTiers } from "./review_tiers.ts";
import { earningsBrief } from "./earnings_brief.ts";
import { shareCard } from "./share_card.ts";
import { holdingsAct, holdingsPerf, holdingsView } from "./holdings_view.ts";

registerDeepTargetResolver((dataRoot) => new FinanceDeepTargetResolver(dataRoot));
// 定时提醒同样只在提供 API 的入口注册;真正开始按点运行的是 api.ts 的 main()
registerSchedule(FINANCE_SCHEDULE);
registerView({ id: "calendar", label: "事件日历", run: eventCalendar });
registerView({ id: "verdicts", label: "判据回看", run: verdictReview });
registerView({ id: "candidates", label: "候选池", run: candidatePool });
registerView({ id: "abnormal", label: "异动接近度", run: abnormalWatch });
registerView({ id: "review_tiers", label: "涨停分档", run: reviewTiers });
registerView({ id: "earnings_brief", label: "财报前瞻与复盘", run: earningsBrief });
registerView({ id: "share_card", label: "研究分享卡", run: shareCard });
registerView({ id: "holdings", label: "持仓", run: holdingsView, act: holdingsAct });
registerView({ id: "holdings_perf", label: "持仓收益率", run: holdingsPerf });
