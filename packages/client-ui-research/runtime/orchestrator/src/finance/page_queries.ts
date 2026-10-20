/**
 * **界面查询声明**(金融垂类):每一屏要哪些数据、在回答什么问题。
 *
 * 🔴 这是"页面不再认识物理端点名"的那一层。前端只说 `page("today")`,
 *    端点 id、参数、分页上限全在这里 —— 端点改名或换源,前端一行不用改,
 *    界面上也就不会再印出 `em_limit_up_sentiment` 这种东西。
 *
 * 🔴 **今日总览与每日复盘的分工是产品定义,不是排版偏好**:
 *    · 今日总览 = **盘中**。今天在发生什么:指数、情绪、涨停、人气、资金、成交额榜。
 *    · 每日复盘 = **过去**。看的是**已经收完盘的那一天** —— 盘中打开显示上一个交易日,
 *      盘后打开显示今天。半天的盘中数据不是复盘,而且"不完整"这件事从数字上看不出来。
 *    判定不在前端做(用户机器的时区与时钟都不可信),由 `session.ts` 解析后注入。
 */
import type { PageContextDef, PageQueryDef } from "../plugin.ts";
import { calendarFromEnvelope, liveSession, realtimeMatchesReviewDay, resolveSession } from "./session.ts";

/** 主要指数 + 宽基 ETF(端点自带默认代码表,这里不重复写死) */
const INDEX_BLOCK = { id: "indices", title: "大盘", note: "A股四大指数 + 美股道指纳指 + 港股恒生与恒生科技;红涨绿跌", endpoint: "tx_quotes_batch", required: true } as const;

/** 板块资金流:**取全 496 个**。默认 50 只够看流入侧,"净流出最多"那一栏会全是净流入的板块 */
const BOARD_FLOW_ARGS = { board_type: "industry", period: "today", top_n: 500 } as const;

/**
 * 东财列表接口(clist)2026-09-22 起成片取不到,板块资金流与成交额榜整块空白 —— 复盘页最下面那几块就是这么坏的。
 * 备源换新浪,**口径不同要说出来**(界面照抄 note)。
 */
const BOARD_FLOW_FALLBACK = {
  endpoint: "sina_board_flow", args: { board_type: "industry" },
  note: "东财这次没取到,改用新浪板块资金流:新浪自己的行业分类(约 48 个),净额 = 流入 − 流出,和东财「主力净额」不是一个口径,两边的数不要互相比",
} as const;
const TURNOVER_FALLBACK = {
  endpoint: "sina_turnover_rank", args: { top_n: 20 },
  note: "东财这次没取到,改用新浪「沪深京 A 股」成交额榜(新浪不给行业)",
} as const;

export const FINANCE_PAGE_CONTEXT: PageContextDef = {
  endpoint: "fetch_trade_calendar",
  // 日历端点要一个主体,但只用来定位市场;给一个稳定的大盘股即可
  symbol: "300308",
  unavailable: "拿不到交易日历,无法确定该看哪一天 —— 下面的数据可能不是你以为的那一天",
  // live = 盘中看今天(进行中、收盘前还会变);不选 = 看已经收完盘的那一天
  modes: ["live"],
  resolve: (envelope, mode) => {
    const facts = calendarFromEnvelope(envelope as never);
    if (!facts) return null;
    const base = resolveSession(facts);
    const s = mode === "live" ? liveSession(base) : { ...base, live: false };
    /**
     * 同一个"看哪一天",**产出两种写法**,由各块用 `injectAs` 显式挑:
     *   `date`         → `YYYY-MM-DD`(全市场龙虎榜要这个)
     *   `date_compact` → `YYYYMMDD` (涨停情绪 / 涨停梯队要这个)
     *
     * 🔴 写法挑错**不会报错**:上游返回空集,端点如实报「四池皆空」「池为空」
     *    「无龙虎榜数据(非交易日或盘后未更新)」—— 三句都读起来像真实行情,
     *    不像格式不对。实测涨停 77 家因此被显示成 **0 家**,而页面上看不出异常。
     * ⚠️ 哪个端点要哪种,只能真跑一次比证据条数;签名核不出取值写法。
     * ⚠️ 声明了 `injectAs` 就**只注入列出的键** —— 否则多出来的那个会被参数白名单拒掉。
     */
    const compact = s.review_date ? s.review_date.replace(/-/g, "") : s.review_date;
    return {
      values: {
        ...s,
        // 此刻能不能切到"看今天"(只有交易时段能)
        live_available: base.intraday,
        realtime_matches_review_day: realtimeMatchesReviewDay(s),
      },
      inject: { date: s.review_date, date_compact: compact },
    };
  },
};

export const FINANCE_PAGE_QUERIES: Record<string, PageQueryDef> = {
  today: {
    title: "今日总览",
    intent: "今天在发生什么 —— 盘中的市场温度",
    blocks: [
      INDEX_BLOCK,
      { id: "sentiment", title: "今日情绪", note: "涨停 / 炸板 / 跌停三个计数", endpoint: "em_limit_up_sentiment" },
      { id: "turnover", title: "成交额榜", note: "全市场成交最活跃的标的;客观榜单,不含推荐", endpoint: "em_turnover_rank", args: { top_n: 20 }, fallback: TURNOVER_FALLBACK },
      { id: "hot", title: "人气榜", note: "东财人气排名 = 关注度,不是资金也不是基本面", endpoint: "em_hot_rank", args: { top: 20 } },
      { id: "board_flow", title: "资金去了哪", note: "主力净额;全市场口径,不等于某一只标的的买卖", endpoint: "em_board_fund_flow", args: BOARD_FLOW_ARGS, fallback: BOARD_FLOW_FALLBACK },
    ],
  },

  review: {
    title: "每日复盘",
    intent: "市场处在什么状态:涨跌面与短线情绪、中长线趋势与量能、资金去了哪",
    // 🔴 默认:盘中打开 → 上一个交易日(完整的一天);盘后 → 今天。由后端解析,不让前端按本地时间猜。
    //    用户可在盘中切到 mode=live 看今天(进行中,收盘前还会变)。
    needsContext: true,
    blocks: [
      // ── 短线:当天的涨停 / 跌停 / 接力 ──
      { id: "sentiment", title: "情绪", note: "涨停 / 炸板 / 跌停三个计数", endpoint: "em_limit_up_sentiment", injectContext: true, injectAs: { date_compact: "date" } },
      { id: "zt_pool", title: "涨停梯队", note: "按连板数排;说明栏是取数层原文(含首封时间)", endpoint: "em_zt_pool", injectContext: true, injectAs: { date_compact: "date" } },
      // 昨天涨停的那批今天怎么走 = 打板接力赚不赚钱;晋级(连板)也从这里和今天的涨停池对出来
      { id: "yzt", title: "昨日涨停今日表现", note: "上一个交易日涨停的股票在这一天的涨跌;平均值、红盘比例是按这份名单逐只算的", endpoint: "em_yzt_pool", injectContext: true, injectAs: { date_compact: "date" } },
      { id: "reason", title: "强势股原因", note: "同花顺的题材归因:是市场叙事,不是核验过的因果", endpoint: "ths_hot_reason", injectContext: true, injectAs: { date: "date" } },
      // ⚠️ 要的是**市场级日榜** `em_daily_dragon_tiger`(symbol_kind=none);
      //    `em_dragon_tiger` 是**单只主体**的上榜记录,需要 symbol,放在这一页会永远缺 symbol 报错。
      //    (我先前正是拿错了那个,把它当成"这一页不该有龙虎榜"给删了 —— 删错了。)
      // ⚠️ 这个端点的参数叫 `trade_date`,不是 `date` —— 整包注入过去会 TypeError,
      //    信封 failed、证据 0 条。(它就这么静默失败过一段时间。)
      { id: "dragon", title: "龙虎榜", note: "按净买额排;同一只标的可能因多条上榜理由重复出现", endpoint: "em_daily_dragon_tiger", injectContext: true, injectAs: { date: "trade_date" } },
      // ── 当天快照:下面三个源**只给当天**(不认日期)——
      //    盘中看上一个交易日时,它们是今天的此刻,与本页业务日不是同一天。页面按 realtime_matches_review_day 标出来。
      { id: "breadth", title: "涨跌分布", note: "全市场按涨跌幅分档的家数 + 沪深京三所的涨跌家数与成交额。⚠️ 只给当天:盘中是此刻的快照", endpoint: "em_market_breadth" },
      { id: "board_flow", title: "板块资金流(行业)", note: "主力净额从大到小;全市场口径。⚠️ 此源只给当日:盘中看到的是今天的进行时", endpoint: "em_board_fund_flow", args: BOARD_FLOW_ARGS, fallback: BOARD_FLOW_FALLBACK },
      { id: "turnover", title: "成交额榜", note: "全市场成交最活跃的 20 只;客观榜单,不含推荐。⚠️ 只给当天", endpoint: "em_turnover_rank", args: { top_n: 20 }, fallback: TURNOVER_FALLBACK },
      // ── 中长线:趋势、量能、杠杆、估值(都是按固定公式算的事实,不下判断) ──
      { id: "trend", title: "主要指数中长线", note: "8 条主要指数的 5 / 20 / 60 / 250 日涨跌、年初至今、均线、离一年高点多远 + 沪深两市成交额;按收盘价的固定算法,不是趋势判断", endpoint: "em_market_trend", args: { days: 300 },
        // 截到本页业务日:盘中看上一个交易日时,不把今天没收完的那根算进「当日 / 5 日涨跌」
        injectContext: true, injectAs: { date: "end" } },
      { id: "margin", title: "两融余额", note: "全市场融资融券余额与融资净买入;T 日数据 T+1 才发布", endpoint: "em_market_margin", args: { days: 60 } },
      { id: "valuation", title: "沪深300 估值", note: "中证指数官网指标文件:市盈率与股息率(总股本口径);不含市净率", endpoint: "index_valuation", symbol: "000300" },
      { id: "bond", title: "国债收益率", note: "中债国债收益率曲线(%);和指数股息率放在一起看股债的相对回报", endpoint: "chinabond_yield_curve", args: { curve: "treasury" } },
    ],
  },

  signals: {
    title: "产业信号",
    intent: "上下游温度计:产业链本身冷还是热 —— 这些不是本公司的业绩,是它所在的链条",
    blocks: [
      { id: "gpu_rent", title: "GPU 租金", note: "现货撮合中位 + 远期合约;需求侧温度。⚠️ 参考线是折旧口径,不是保本线" , endpoint: "gpu_rent_thermometer" },
      { id: "tw_revenue", title: "台系月营收", note: "法定月披露,滞后约 10 天 —— 追排产最快的硬数据。⚠️ 必须做差分归因,单看一家会归错因", endpoint: "tw_monthly_revenue" },
      { id: "dram", title: "DRAM 现货", note: "社区转录的影子指标,**不是官方一手价**,也不是 HBM 价格", endpoint: "dram_spot_thermo" },
      { id: "commodity", title: "大宗原材料", note: "全市场定价,**不是本公司的采购价**", endpoint: "cn_commodity_futures", collapsed: true },
      { id: "hiring", title: "招聘信号", note: "锚点公司的公开在招岗位 = 招聘意图,**不是产能**;看变化不看绝对值。未接入 ≠ 零岗位", endpoint: "hiring_anchor_signal", collapsed: true },
    ],
  },

  radar: {
    title: "资讯雷达",
    intent: "一手信源与市场声音 —— 只当线索,不当事实",
    blocks: [
      // 🔴 头条放最前:它是**需求侧一手线索**,而不是又一条新闻瀑布
      { id: "headlines", title: "海外头条", note: "Techmeme river 时间流,48 小时窗口;按产业标签标注相关性", endpoint: "techmeme_headlines" },
      // 🔴 这就是"以前筛好的那份":106 个 tier-1 策展源 × 12 行业,不是随便拉的 RSS
      { id: "curated", title: "策展信源", note: "106 个 tier-1 源 × 12 行业的近 3 天条目(不是泛 RSS);红线关键词已标注",
        endpoint: "rss_news", args: { industry: "ai", per_source: 10 },
        // 行业可由用户切换。**只开这一个键** —— per_source / recent_days 之类改了会悄悄换掉这一块的口径
        userArgs: ["industry"] },
      { id: "telegraph", title: "全市场快讯", note: "财联社电报;悬停标题看正文摘要", endpoint: "cls_telegraph" },
      // 🔴 市场声音**不在这一屏里**:它按主体检索,没有主体就取不到(实测这一块永远是
      //    "端点 exa_market_voice 需要 symbol",一个空壳挂在页面上)。
      //    它在页面下半段"个股线索"里按需取 —— 那里用户已经输了代码。
      //    ⇒ 一块数据属不属于"打开就该有的一屏",判据是**它需不需要用户先给输入**。
    ],
  },

  sectors: {
    title: "产业研究",
    intent: "板块之间此刻的强弱与资金流向",
    blocks: [
      { id: "comparison", title: "行业涨跌排名", endpoint: "em_industry_comparison" },
      { id: "board_flow", title: "行业资金流", note: "主力净额;取全 496 个板块,流出侧才看得到", endpoint: "em_board_fund_flow", args: BOARD_FLOW_ARGS, fallback: BOARD_FLOW_FALLBACK },
    ],
  },
};
