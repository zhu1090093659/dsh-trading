/**
 * 金融垂类的**台账记录种类**。Core 只提供存储与校验(`src/ledger.ts`),种类与字段全在这里。
 *
 * 核心四种构成一个闭环:
 *   计划(thesis) → 判据(criterion) → 现状(position) → 到期要做的事(action)
 * **顺序是有意的**:先写下目标与判据,后面所有"偏离"才有参照物。
 * 另两种在闭环之外:`watch`(自选,还没到写论点的程度)与 `note`(研究记录,只留痕不判定)。
 *
 * 🔴 红线:这些是**用户自己写下的东西**,产品不替他生成建仓建议。
 *    界面只做两件事:把他写的原样呈现出来,以及把"哪条到期了"算出来。
 */
import type { LedgerKindDef } from "../plugin.ts";

/**
 * 主体代码的台账规范形:
 * A 股 `600519` / 港股 `00700.HK` / 美股 `AAPL` 或 `BRK.B`。
 * 界面负责把 `hk00700` 等常见写法归一化，台账只收唯一写法。
 */
const US_SYMBOL_VALUE = "(?:[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?)";
const SYMBOL_VALUE = `(?:[0-9]{6}|[0-9]{5}\\.HK|${US_SYMBOL_VALUE})`;
const SYMBOL = { type: "string", pattern: `^(?:${SYMBOL_VALUE})?$` };
const REQUIRED_SYMBOL = { type: "string", pattern: `^${SYMBOL_VALUE}$` };
/**
 * 日期:留空,或一个**真实存在的日历日**。
 * 🔴 只写 `^\d{4}-\d{2}-\d{2}$` 是不够的 —— `2026-99-99` / `2026-02-31` 都能过,
 *    然后进"到期清单"参与排序与提醒:**永远不触发,保存却报成功**。
 * `format: "date"` 由 Core 的 `ledger.ts` 自己注册(不依赖 ajv-formats 插件,
 * 所以不存在"没装就静默不校验"那种情况)。
 */
const DATE = { type: "string", anyOf: [{ maxLength: 0 }, { format: "date" }] };
const TEXT = (max = 500) => ({ type: "string", maxLength: max });
const NONEMPTY = (max = 500) => ({ type: "string", minLength: 1, maxLength: max, pattern: "\\S" });

/**
 * 字段键 / 枚举值的**中文显示名**。
 *
 * 🔴 这些以前写死在 Core 的表单组件里 —— "cost=成本""decision_point=裁决点"
 *    只在这个行业成立,换个垂类就得改 Core。而前端的纯净度棘轮词表里恰好
 *    没有"成本 / 账户 / 裁决点"这几个词,于是**一路绿灯**。
 *    ⇒ 教训与后端那条一样:词表挡不住它没收录的词,别拿"棘轮是绿的"当边界证明。
 *
 * ⚠️ 不必登记全部字段:界面对没登记的退回**原键名**照常渲染。
 */
export const FINANCE_FIELD_LABELS: Record<string, string> = {
  symbol: "代码", name: "名称", account: "账户", shares: "数量", cost: "成本",
  opened_at: "建立日期", note: "备注", title: "标题", statement: "内容",
  review_by: "复核日期", status: "状态", type: "类型", thesis_id: "关联论点",
  due: "到期日", ref: "关联", tag: "分组", category: "分类", body: "正文",
  judged_at: "判定日", verdict_note: "判定说明",
  date: "日期", price: "价格", fee: "费用", amount: "金额", ratio: "比例", migrated_from: "迁移自",
};

export const FINANCE_ENUM_LABELS: Record<string, string> = {
  active: "进行中", paused: "暂停", closed: "已结束",
  decision_point: "裁决点", falsifier: "证伪条件",
  pending: "待判", met: "已达成", broken: "已触发", dropped: "已放弃",
  open: "待办", done: "已完成",
  review: "复盘", highlight: "今日要点", ask: "问 Agent", debate: "多空辩论", audit: "反思审计",
  backtest: "回测", compare: "研究对比",
  opening: "期初持仓", buy: "买入", sell: "卖出", dividend: "现金分红", split: "送转 / 拆股",
};

export const FINANCE_LEDGER_KINDS: Record<string, LedgerKindDef> = {
  /** 用户手动记录已发生的清仓，不下单、不自动扣减另一张持有台账。 */
  closed_position: {
    label: "清仓记录",
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      closed_at: { type: "string", format: "date" },
      note: TEXT(1000),
      price: { type: "number", exclusiveMinimum: 0 },
      shares: { type: "number", exclusiveMinimum: 0 },
      cost: { type: "number" },
    },
    required: ["symbol", "closed_at", "price", "shares", "cost"],
  },
  /**
   * 交易流水:持仓页的唯一真相。持有多少、成本、已实现盈亏、分红都由 `holdings.ts` 按日期重放算出,不另存。
   * 各类型要哪些字段(买卖要数量和成交价、分红要金额、送转要比例)由重放逐条检查,不对的写原因、不参与计算 ——
   * 这里只做类型与范围校验(台账校验不支持「按类型要求字段」)。
   * `migrated_from`:从旧 `position` 记录迁移来的期初持仓,记原记录 id,迁移据此去重。
   */
  trade: {
    label: "交易流水",
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      account: TEXT(40),
      type: { type: "string", enum: ["opening", "buy", "sell", "dividend", "split"] },
      date: { type: "string", format: "date" },
      shares: { type: "number", exclusiveMinimum: 0 },
      /** 期初持仓的每股成本可以是负数(分红 / 送转摊薄后),买卖成交价由重放要求大于 0 */
      price: { type: "number" },
      fee: { type: "number", minimum: 0 },
      /** 现金分红到账金额(税后,用户账户实际收到的) */
      amount: { type: "number", exclusiveMinimum: 0 },
      /** 送转拆股:每 1 股变成几股(10 转 5 = 1.5,1 拆 4 = 4,10 合 1 = 0.1) */
      ratio: { type: "number", exclusiveMinimum: 0 },
      note: TEXT(1000),
      migrated_from: TEXT(80),
    },
    required: ["symbol", "type", "date"],
  },
  /**
   * 旧的持有记录(一只一条:数量 + 均价)。现在只当**收件箱**:Agent / MCP / 导入仍可往这里写,
   * 持仓页打开时迁成一笔期初持仓流水(先备份)。还没迁的照样算「持有」(见 `holdings.ts` heldFromLedger)。
   * 成本与数量是用户自己的事实,产品不猜也不改。
   * ⚠️ 显示名保持「持有」:截图导入的提示词用它(「把资料转写成「持有」记录」)。
   */
  position: {
    label: "持有",
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      account: TEXT(40),
      shares: { type: "number", minimum: 0 },
      // 🔴 **成本不设下限**：分红 / 送转吃够了之后，成本价变成负数是真实存在的持仓状态
      //    （开源版 Vibe-Research issue #3 就是用户拿这个来报的）。卡一个 `minimum: 0`
      //    的后果是这类持仓**根本录不进来**，而盈亏本来就按 (现价 − 成本) × 股数 算，
      //    成本为负照样算得出正确结果 —— 拦它换不来任何正确性。
      cost: { type: "number" },
      opened_at: DATE,
      note: TEXT(1000),
    },
    required: ["symbol", "shares", "cost"],
  },

  /** 论点:为什么持有 / 为什么关注。**这是经营闭环的地基** —— 没有它就谈不上"偏离" */
  thesis: {
    label: "论点",
    properties: {
      symbol: SYMBOL,
      title: NONEMPTY(120),
      statement: TEXT(4000),
      review_by: DATE,
      status: { type: "string", enum: ["active", "paused", "closed"] },
      note: TEXT(1000),
    },
    required: ["title"],
  },

  /**
   * 判据:到期必裁的**裁决点**,或写死的**证伪条件**。
   * 两者共用一种记录、靠 `type` 区分 —— 它们的生命周期完全一样(写下 → 到期 → 判定),
   * 拆成两种只会让"到期清单"要去合并两张表。
   */
  criterion: {
    label: "判据",
    properties: {
      symbol: SYMBOL,
      thesis_id: TEXT(80),
      type: { type: "string", enum: ["decision_point", "falsifier"] },
      statement: NONEMPTY(1000),
      /** 到期日:裁决点通常有,证伪条件可以没有(它是随时可能触发的条件,不是日程) */
      due: DATE,
      status: { type: "string", enum: ["pending", "met", "broken", "dropped"] },
      note: TEXT(1000),
      /** 判定那天与判定时写的理由(事件日历页「判据回看」写入;改回待判时清掉) */
      judged_at: DATE,
      verdict_note: TEXT(1000),
    },
    required: ["type", "statement"],
  },

  /**
   * 自选:只是"我盯着它",还没到写论点的程度。
   *
   * 🔴 与产品自带的**研究线**(界面里那几个可展开的分组)是两回事:
   *    那是随产品发的默认清单(让新用户一打开就知道这一页是干嘛的),
   *    这里是**用户自己加的**。两者混成一张表的话,产品更新默认清单就会动到用户的数据。
   * ⚠️ 自选里出现过不代表持有 —— 持有是 `position`,两张表刻意不互相推断。
   */
  watch: {
    label: "自选",
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      /** 用户自己的分组名(想按什么分就按什么分,产品不给固定选项) */
      tag: TEXT(40),
      note: TEXT(1000),
    },
    required: ["symbol"],
  },

  /**
   * 研究记录:把复盘 / 要点 / 问 Agent 的结果沉淀下来,回头能翻。
   *
   * 🔴 分类字段叫 `category` 而**不是 `kind`** —— `kind` 是 Core 的信封键
   *    (`LEDGER_ENVELOPE_KEYS`),重名会被注册期当场拒。这不是风格问题:
   *    真让它重名,记录的"种类"与"分类"会在同一个键上打架。
   * ⚠️ 与判据 / 论点的区别:那两种是**要拿来对账的**(有到期日、有状态);
   *    这里是**留痕**,不参与任何自动判定。
   */
  note: {
    label: "研究记录",
    properties: {
      symbol: SYMBOL,
      category: { type: "string", enum: ["review", "highlight", "ask", "debate", "audit", "backtest", "compare"] },
      title: NONEMPTY(160),
      /** markdown 正文；回测 / 多空辩论会保留完整多阶段报告，不能沿用短笔记的 2 万字上限。 */
      body: TEXT(100000),
    },
    required: ["title"],
  },

  /** 行动:待办。可由判据到期生成,也可以自己写 */
  action: {
    label: "行动",
    properties: {
      symbol: SYMBOL,
      title: NONEMPTY(200),
      due: DATE,
      status: { type: "string", enum: ["open", "done", "dropped"] },
      /** 关联的判据 / 论点 / 研究运行 id —— 只存字符串,不做外键约束 */
      ref: TEXT(120),
      note: TEXT(1000),
    },
    required: ["title"],
  },
};
