/**
 * 报告数字的**忠实度校验**:报告里写出的每个数字,是否真等于同一行所引 evidence / calc 的值。
 *
 * 🔴 为什么单独成模块(架构审计 2026-08-24):这套能力**早就写好、也被多轮审计打磨过**,
 * 但只活在硬测试里(`hardtest.ts` 的 judgeDisplayFidelity)。生产 `validateReport` 当时只查
 * "章节在不在、引用 id 存不存在" —— **不查数字是否等于所引 id 的值**。
 * 后果:报告可以引用一个**真实的 calc-id 却写另一个数字**,仍然判 complete。
 * 对一个研究产品来说,这是最不能留的缺口。
 * ⇒ 把它抽成共享模块,**生产 validator 与硬测试用同一份实现**(而不是复制两份各自漂移)。
 *
 * ⚠️ 下面这些正则里的每一条豁免,都对应一次真实误伤(速率标签 1.6T、公告文号、HTTP 状态码、
 * 域名里的数字、时间窗口标签、主体编号…)。**改它们之前先看注释,不要"清理"掉。**
 * 领域相关的那部分词表已移入 Plugin(finance 包的见 `finance/lexicon.ts`),这里只留机制。
 */
/**
 * 只声明**本模块真正用到的字段**,不绑死 merge.ts 或 hardtest 的完整类型 ——
 * 两边的 EvidenceItem 形状不同(一个带 endpoint/fetched_at/raw_ref,一个没有),
 * 绑死任一方都会让另一方传不进来。结构化类型足够,也更能说明这个模块依赖什么。
 */
export interface FidelityEvidence { value?: unknown; unit?: unknown }
export interface FidelityCalc {
  output: { value?: unknown; details?: unknown };
  inputs?: unknown;
}
type EvidenceItem = FidelityEvidence;
type CalcRecord = FidelityCalc;
import { resultProjection } from "./calc_projection.ts";
import { currentPlugin } from "./plugin.ts";

/** 从引用 id 收集可解释的数值(证据值、计算输出、计算 details / inputs 的数值叶子) */
export function numbersOf(ids: string[], evById: Map<string, EvidenceItem>, calcById: Map<string, CalcRecord>): { nums: number[]; texts: string[] } {
  const nums: number[] = []; const texts: string[] = [];
  const leaves = (v: unknown, depth = 0) => { if (depth > 4) return; if (typeof v === "number" && Number.isFinite(v)) nums.push(v); else if (typeof v === "string") texts.push(v); else if (Array.isArray(v)) v.forEach((x) => leaves(x, depth + 1)); else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, depth + 1)); };
  for (const id of ids) { const e = evById.get(id); if (e) { leaves(e.value); continue; } const c = calcById.get(id); if (c) { leaves(c.output.value); leaves(c.output.details); leaves(c.inputs); } }
  return { nums, texts };
}
/**
 * 只收 calc 的**输入**(不含 output.value / details)。
 * 🔴 这个区分是数字忠实度的核心:
 *   - calc 的**输入**同行并列是合法出处(`| 结果 34.07 倍 [calc] | 入参 943.0 元 / 27.68 元 |`);
 *   - calc 的**输出原始浮点**照抄则**必须判违规** —— 派生数字要写 display("37.40 倍"),
 *     不是 37.397700293773134。把两者混进同一个池,就等于把"照抄原始浮点"这条纪律废掉。
 */
/**
 * **inputs + output.details** 里的数值 —— 可按指定容差绑定的"中间量"池。
 *
 * 🔴 排除顶层及嵌套结果形对象的 `value`:否则 display 是 "37.00 倍" 时,报告写 "37 倍"
 * 会绕过逐字照抄(Codex fidelity-r2 P1)。
 * ⚠️ 也不能收窄到只剩 inputs:四锚这类结果的锚点(30)住在 `output.details.anchors` 里、
 * inputs 是空的,只认 inputs 会把"30 倍锚"这种**正当写法**误拦(实测被测试抓到)。
 */
export function intermediateNumbersOf(ids: string[], calcById: Map<string, CalcRecord>): number[] {
  const nums = inputNumbersOf(ids, calcById);
  const leaves = (v: unknown, depth = 0): void => {
    if (depth > 4) return;
    if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
    else if (Array.isArray(v)) v.forEach((x) => leaves(x, depth + 1));
    else if (v && typeof v === "object") {
      // 与 resultProjection 使用同一形状判据；情景子结果不是可豁免的中间量。
      const isResult = "status" in v && "value" in v && "unit" in v;
      for (const [key, value] of Object.entries(v)) {
        if (key !== "display" && !(isResult && key === "value")) leaves(value, depth + 1);
      }
    }
  };
  for (const id of ids) {
    const o = calcById.get(id)?.output;
    if (o && typeof o === "object") leaves((o as Record<string, unknown>).details);
  }
  return nums;
}

export function inputNumbersOf(ids: string[], calcById: Map<string, CalcRecord>): number[] {
  const nums: number[] = [];
  const leaves = (v: unknown, depth = 0) => { if (depth > 4) return; if (typeof v === "number" && Number.isFinite(v)) nums.push(v); else if (Array.isArray(v)) v.forEach((x) => leaves(x, depth + 1)); else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, depth + 1)); };
  for (const id of ids) { const c = calcById.get(id); if (c) leaves(c.inputs); }
  return nums;
}

const SCALES = [1, 1e4, 1e8, 100, 0.01, 1e-4, 1e-8];

/**
 * 报告里数字**紧跟着写出的量级**:万 / 亿 / 万亿 是倍数,% / 百分点 是百分数;别的写法(或没写)返回 null。
 * 🔴 第四轮审计 A2:`numberBound` 对每个数都把七种倍率试一遍,证据 1234000000 元、报告写「12.34 万元」
 *    也能靠 ×1e-8 对上 —— 差一万倍判成一致。写了量级就只按写的量级换算(见 unitBound)。
 */
export type WrittenScale = number | "pct";
export function writtenScale(line: string, end: number): WrittenScale | null {
  const m = /^\s*(万亿|亿|万|%|％|百分点)/.exec(line.slice(end));
  if (!m) return null;
  return m[1] === "万亿" ? 1e12 : m[1] === "亿" ? 1e8 : m[1] === "万" ? 1e4 : "pct";
}
/** 证据单位的量级:亿元 / 万股 这类带倍数词的按倍数,元 / 股 / 倍 这类是 1;小数 = 比值;认不出(没单位、文本类)= null */
type EvidenceScale = number | "pct" | "ratio" | null;
function evidenceScale(unit: unknown): EvidenceScale {
  if (typeof unit !== "string" || !unit.trim()) return null;
  const u = unit.trim();
  if (u === "%" || u === "％" || u === "百分点") return "pct";
  if (u === "小数") return "ratio";
  if (/^(?:text|date|bool|status|日期|标志|概率|源单位)$/.test(u)) return null;
  return u.startsWith("万亿") ? 1e12 : u.startsWith("亿") ? 1e8 : u.startsWith("万") ? 1e4 : 1;
}
/** 写了量级时允许的换算倍率(证据值 × 倍率 = 报告写的数) */
function scalesFor(written: WrittenScale, ev: EvidenceScale): number[] {
  if (written === "pct") return ev === "pct" ? [1] : ev === "ratio" ? [100] : [1, 100];
  if (ev === "pct" || ev === "ratio") return [];                    // 百分数不会写成「万 / 亿」
  return (ev === null ? [1, 1e4, 1e8] : [ev]).map((m) => m / written);   // 单位不明时仍只认 元 / 万 / 亿 三档
}
/** 带单位的证据池:证据值的每个数值叶子,连同这条证据的单位量级 */
export function scaledEvidenceOf(ids: string[], evById: Map<string, EvidenceItem>): { v: number; scale: EvidenceScale }[] {
  const out: { v: number; scale: EvidenceScale }[] = [];
  for (const id of ids) {
    const e = evById.get(id); if (!e) continue;
    const scale = evidenceScale(e.unit);
    const leaves = (v: unknown, depth = 0): void => { if (depth > 4) return; if (typeof v === "number" && Number.isFinite(v)) out.push({ v, scale }); else if (Array.isArray(v)) v.forEach((x) => leaves(x, depth + 1)); else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, depth + 1)); };
    leaves(e.value);
  }
  return out;
}
/**
 * 一段原文(用户资料片段、档案引文)里的数,连同紧跟着写的单位:「120.5 亿元」= 120.5 × 亿;
 * 没写单位的按「单位不明」。给没引编号的行用 writtenExact 对 —— 不能拿裸数字比:
 * 资料写 120.5 亿元、报告写 120.5 万元,裸数字相等、差一万倍(v2.1.0 合并审计 Codex 第 1 条)
 * 量级词直接给倍数:evidenceScale 按开头字判断,「百万港元」会被当成 1 倍
 */
const TEXT_SCALE: Record<string, number> = { 万亿: 1e12, 千亿: 1e11, 百亿: 1e10, 亿: 1e8, 千万: 1e7, 百万: 1e6, 万: 1e4, 千: 1e3, billion: 1e9, bn: 1e9, million: 1e6, mn: 1e6 };
function scaledNumbersInText(text: string): { v: number; scale: EvidenceScale }[] {
  const out: { v: number; scale: EvidenceScale }[] = [];
  const t = text.replace(/[\u2212\uFF0D]/g, "-");
  const re = /(?<![\d.])(\d{1,3}(?:,\d{3})+(?![\d,])(?:\.\d+)?|\d+(?:\.\d+)?)\s*(个百分点|百分点|%|％|万亿|千亿|百亿|千万|百万|亿|万|千(?=[美港]?元)|(?:billion|bn|million|mn)\b)?\s*(元|美元|港元|股|倍)?/gi;
  for (const m of t.matchAll(re)) {
    const n = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const mag = m[2]?.toLowerCase();
    const scale: EvidenceScale = !mag ? (m[3] ? 1 : null) : /百分点|%|％/.test(mag) ? "pct" : TEXT_SCALE[mag] ?? null;
    out.push({ v: textNegated(t, m.index!) ? -n : n, scale });
  }
  return out;
}
/**
 * 原文里数前面的「-」是不是负号。紧挨在数 / % / 单位后面的(「31.2%-35.8%」「1,200亿-1,500亿」)、
 * 两边都有空格的(「31.3 - 35.8」)是区间号;「15.2% -3.4%」是表格压平后的两个数,后一个是负数;
 * 行首「- 」是列表标记(v2.1.0 合并审计复核第 2 条)
 */
function textNegated(t: string, idx: number): boolean {
  const head = t.slice(t.lastIndexOf("\n", idx - 1) + 1, idx);
  const m = /(\S?)([ \t]*)-([ \t]*)$/.exec(head);
  if (!m) return false;
  const [, prev, spaceBefore, spaceAfter] = m;
  if (!prev) return !spaceAfter;
  if (/[\d%％亿万元倍股]/.test(prev!)) return !!spaceBefore && !spaceAfter;
  return true;
}
/** 写了量级的数字按写的量级去对证据;容差与 numberBound 相同 */
export function unitBound(token: number, written: WrittenScale, pool: { v: number; scale: EvidenceScale }[], relTol = 2e-3): boolean {
  const tol = Math.max(Math.abs(token) * relTol, relTol * 2.5);
  return pool.some(({ v, scale }) => scalesFor(written, scale).some((s) => {
    const w = v * s; if (!Number.isFinite(w)) return false;
    return Math.abs(w - token) <= tol || Math.abs(Math.round(w * 100) / 100 - token) <= tol;
  }));
}
/**
 * 按**写出来的位数**精确对:证据值换算到写的量级后,四舍五入到报告写的小数位,必须正好等于写的数。
 * 给「同行没引 id」的数字用 —— 那时候候选池是整次运行的全部证据(上千个值),
 * numberBound 的千分之二容差会让 17%~42% 的随机数碰巧对上(2026-10-11 在 9 份真实报告的证据上实测)。
 */
export function writtenExact(token: number, decimals: number, written: WrittenScale | null, pool: { v: number; scale: EvidenceScale }[]): boolean {
  const f = 10 ** decimals;
  return pool.some(({ v, scale }) => (written === null ? [1] : scalesFor(written, scale)).some((s) => {
    const w = v * s;
    return Number.isFinite(w) && Math.abs(Math.round(w * f) / f - token) < 0.5 / f / 10;
  }));
}
export function numberBound(token: number, pool: number[], relTol = 2e-3): boolean {
  return pool.some((v) => SCALES.some((s) => { const w = v * s; if (!Number.isFinite(w)) return false; const tol = Math.max(Math.abs(token) * relTol, relTol * 2.5); return Math.abs(w - token) <= tol || Math.abs(Math.round(w * 100) / 100 - token) <= tol; }));
}
/** 一行里需要证据支撑的数字:排除日期 / 年份 / FY / 代码 / id 内数字 / 序号 / ×倍数记号 / 小整数计数 */

export function claimNumbers(line: string, symbol?: string): number[] { return claimTokens(line, symbol).map((t) => t.n); }
/** 数字及其书写形态(含紧随的单位字符,用于在字符串证据——如公告标题——里做原文匹配) */
/**
 * **领域词表契约**(Plugin 的一个插槽)。机制通用、词表随垂类而变 ——
 * finance 包的在 `finance/lexicon.ts`;餐饮 AgentOS 会提供完全不同的一份。
 */
export interface Lexicon {
  //! 契约:所有正则必须是**原生 RegExp 字面量 / `new RegExp(...)`**,不许是子类、Proxy、
  //! 或带自定义 `flags`/`source` getter 的对象 —— 注册期会多次读取它们的属性。
  /** 金额语境(数值之前)——判断紧跟的字母后缀是金额单位还是类别标签 */
  moneyBefore: RegExp;
  /** 金额语境(数值之后):`1.6T 美元` */
  moneyAfter: RegExp;
  /** 类别标签语境:光通信的 1.6T / 800G 是产品类别名,不是数字主张 */
  categoryLabelContext: RegExp;
  /** 主体编号形态;数组按顺序全部剥除 */
  subjectCodePatterns: RegExp[];
  /** 时间窗口标签:窗口长度本身不是数字主张 */
  windowLabelPattern: RegExp;
  /** 本次主体编号是否为 6 位数字(决定要不要把裸写的编号也剥掉) */
  subjectCodeIsSixDigits: boolean;
  /**
   * 可选:名称或方法规则里的数字(给 `.replace()` 用,必须带 g)。它们是名字、或本产品写死的规则阈值,
   * 不是数据主张,也没有证据可引。只放垂类里**确定**是名称 / 规则的写法 ——
   * 后面跟单位、其实是数值的写法要由各垂类的正则自己排除。
   */
  labelPatterns?: RegExp[];
}

let activeLexicon: Lexicon | null = null;
/** 注册时传进来的原始对象 —— 只用于"是不是同一份"的身份判断(活动词表本身是冻结快照) */
let registeredSource: Lexicon | null = null;

/**
 * 注入领域词表。**入口处调用一次**(见 `finance/register.ts`)。
 * 🔴 未注入就调用 claimTokens 会**直接抛错**,不给默认值 —— 若默认成"什么都不剥",
 * 某条没接上的路径会静默地把类别标签、主体编号都当成数字主张,表现为一堆假违规,
 * 而"为什么突然多了违规"是极难查的。**宁可当场炸。**
 */
/**
 * 注册领域词表。**同一进程只允许一份** —— 换成另一份会当场抛错。
 *
 * 🔴 为什么要拦:这是**进程级单例**,先注册 A 包再注册 B 包会静默覆盖,
 * 之后 A 的请求会拿 B 的词表去判数字,结果取决于注册顺序(Codex lexicon-r1 P1)。
 * 真正的解法是把词表做成**实例级依赖**、从 composition root 一路传下去(见文件末尾的"待办")。
 * 在那之前,**把静默串包变成当场失败** —— 这条纪律在本产品里比"能跑"更重要。
 *
 * ⚠️ 同时按**用途**校验正则标志。这条不能一刀切:
 * - 给 `.test()` 用的(moneyBefore / moneyAfter / categoryLabelContext)**不许带 `g`/`y`** ——
 *   它们有 `lastIndex` 状态,共享后反复 test 会交替命中 / 漏掉;
 * - 给 `.replace()` 用的(subjectCodePatterns / windowLabelPattern)**必须带 `g`** ——
 *   不带只会替换第一处,一行里出现两个主体编号时第二个剥不掉。
 * (我一度按"一律禁 g"实现,立刻被既有测试打红:finance 包那两条本来就必须带 g。)
 */
const TEST_FIELDS = ["moneyBefore", "moneyAfter", "categoryLabelContext"] as const;

const isRe = (v: unknown): v is RegExp => v instanceof RegExp;
/** 克隆正则:`RegExp.prototype.compile()` 能**原地改**一个正则的 source 与 flags —— 共享对象就不叫快照 */
const cloneRe = (r: RegExp) => new RegExp(r.source, r.flags);

/**
 * 注册期间的重入守卫。
 *
 * 🔴 `lex` 的字段各读一次了,但 `r.flags` / `r.source` 仍会被读多次 —— 一个带自定义 `flags`
 * getter 的正则可以在校验途中**重入注册另一份词表**,内层注册成功、外层继续跑完再覆盖,
 * "已注册过另一份就不许覆盖"这条约束就被绕过了(Codex lexicon-r8)。
 * ⚠️ 这只对**敌意 / 带行为的正则**成立;契约本来就要求原生正则(见 `Lexicon` 文档)。
 * 守卫三行,顺带防住无意的重入,加上不亏。
 */
let registering = false;

export function setLexicon(lex: Lexicon): void {
  if (registering) throw new Error("setLexicon 不支持重入(注册过程中不许再次注册)");
  registering = true;
  try {
    setLexiconInner(lex);
  } finally {
    registering = false;
  }
}

function setLexiconInner(lex: Lexicon): void {
  // 🔴 同源幂等判断必须在**所有校验之前**:放在后面的话,"注册后外部改了原对象、再注册一次"
  //    会先在校验处抛错,而不是安静返回 —— 那就不是幂等(Codex lexicon-r4)。
  if (registeredSource === lex) return;
  if (registeredSource) {
    throw new Error("已注册过另一份领域词表:进程级单例不支持多垂类并存,请在各自进程 / composition root 里注入");
  }
  // 🔴 **每个字段各读一次**,之后只用局部值校验与建快照。
  //    词表若是带 getter 的对象 / Proxy,反复读取可以让"被校验的值"和"进快照的值"不是同一个;
  //    而 `{ ...lex }` 还会读遍**所有**可枚举属性 —— 一个与词表无关的 getter 抛错就能让注册失败
  //    (Codex lexicon-r7)。所以这里逐字段取,不用展开。
  const read = {
    moneyBefore: lex.moneyBefore, moneyAfter: lex.moneyAfter,
    categoryLabelContext: lex.categoryLabelContext,
    subjectCodePatterns: lex.subjectCodePatterns,
    windowLabelPattern: lex.windowLabelPattern,
    subjectCodeIsSixDigits: lex.subjectCodeIsSixDigits,
    labelPatterns: lex.labelPatterns,
  };

  // 给 `.test()` 用的:必须是单个 RegExp,且**不许带 g/y** —— 它们有 lastIndex 状态,
  // 共享后反复 test 会交替命中 / 漏掉。
  for (const k of TEST_FIELDS) {
    const r = read[k];
    if (!isRe(r)) throw new Error(`词表 ${k} 必须是 RegExp,收到 ${Array.isArray(r) ? "数组" : typeof r}`);
    if (/[gy]/.test(r.flags)) throw new Error(`词表 ${k} 用于 .test(),不许带 g/y 标志`);
  }
  // 给 `.replace()` 用的:必须带 g(否则一行里只剥掉第一处)且不许带 y(sticky 常常一次都匹配不到)。
  // ⚠️ 两个字段的**形状不同**,不能用"RegExp 或其数组"一把抓 —— 那样 `subjectCodePatterns: /x/g`
  //    能过校验却在展开时炸,`windowLabelPattern: [/x/g]` 能存进去却让替换逻辑收到数组(Codex lexicon-r5)。
  const checkReplace = (k: string, r: unknown): RegExp => {
    if (!isRe(r)) throw new Error(`词表 ${k} 必须是 RegExp,收到 ${Array.isArray(r) ? "数组" : typeof r}`);
    if (!r.flags.includes("g") || r.flags.includes("y")) throw new Error(`词表 ${k} 用于 .replace(),必须带 g 且不许带 y`);
    return r;
  };
  if (!Array.isArray(read.subjectCodePatterns)) throw new Error("词表 subjectCodePatterns 必须是 RegExp 数组");
  const codes = [...read.subjectCodePatterns].map((r, i) => cloneRe(checkReplace(`subjectCodePatterns[${i}]`, r)));
  const window = cloneRe(checkReplace("windowLabelPattern", read.windowLabelPattern));
  if (read.labelPatterns !== undefined && !Array.isArray(read.labelPatterns)) throw new Error("词表 labelPatterns 必须是 RegExp 数组");
  const labels = [...(read.labelPatterns ?? [])].map((r, i) => cloneRe(checkReplace(`labelPatterns[${i}]`, r)));

  // 🔴 先把快照建好,**最后再一起提交**。中途抛错会留下"registeredSource 已写、activeLexicon 还是 null"
  //    的半注册状态:同一对象重试被幂等判断直接返回、换一份又报"已注册过另一份",
  //    进程从此卡死在"未注入"(Codex lexicon-r5)。
  const snapshot = Object.freeze({
    moneyBefore: cloneRe(read.moneyBefore), moneyAfter: cloneRe(read.moneyAfter),
    categoryLabelContext: cloneRe(read.categoryLabelContext),
    subjectCodePatterns: Object.freeze(codes) as unknown as RegExp[],
    windowLabelPattern: window,
    subjectCodeIsSixDigits: Boolean(read.subjectCodeIsSixDigits),
    labelPatterns: Object.freeze(labels) as unknown as RegExp[],
  });
  activeLexicon = snapshot;
  registeredSource = lex;
}

/** 仅供测试:清掉已注册的词表(生产路径不该用) */
export function resetLexicon(): void { activeLexicon = null; registeredSource = null; }
/**
 * 当前活动词表;未注入直接抛错(不给静默默认值)。
 *
 * ⚠️ **已接受的残留**:返回的是冻结快照,但里面的 `RegExp` 对象本身仍可被 `compile()` 原地改。
 *
 * 这条边界的目标是"**注册方持有的原对象改不动已生效的词表**"(已做到:注册时克隆),
 * 不是"防住 Core 内部消费者乱改"。三条路都掂量过:
 * 1. `Object.freeze(regex)` —— **实测不行**:V8 的 `RegExp.prototype.exec` 会无条件写 `lastIndex`,
 *    冻结之后连 `.test()` 都抛 `TypeError: Cannot assign to read only property 'lastIndex'`,
 *    全局正则的 `.replace()` 更是直接废掉。**这条路是死的,别再试。**
 * 2. 每次调用返回深拷贝 —— 本函数在**逐行热路径**上调用,每行分配一批正则不划算。
 * 3. 改成函数门面(不暴露正则对象)—— 可行,但要重构 `claimTokens` 的内部 API,留作后续。
 *
 * ⇒ 现状:**内部调用方只读,不要改它**。要利用它得先能在进程内执行代码,
 *   那时攻击者已有更直接的手段 —— 在本产品的信任边界内可接受(Codex lexicon-r7~r9 反复讨论过)。
 */
export function currentLexicon(): Lexicon {
  if (!activeLexicon) throw new Error("未注入 Lexicon:入口处应先调用 setLexicon(见 finance/register.ts)");
  return activeLexicon;
}

/** 类别标签(如 1.6T / 800G)不是数字主张——但只在"有类别语境、无金额语境"时剥;两个语境正则都由 Plugin 提供(Codex 审查 voice-r1/r2) */
export function stripSpeedLabels(s: string, lex: Lexicon = currentLexicon()): string {
  return s.replace(/(?<![\d.])\d+(?:\.\d+)?\s?[TG](?:bps|b)?(?![A-Za-z0-9])/g, (m, off: number, str: string) => {
    const before = str.slice(Math.max(0, off - 12), off);
    const after = str.slice(off + m.length, off + m.length + 12);
    if (lex.moneyBefore.test(before) || lex.moneyAfter.test(after)) return m;
    return lex.categoryLabelContext.test(before) || lex.categoryLabelContext.test(after) ? " ".repeat(m.length) : m;
  });
}
export function claimTokens(line: string, symbol?: string, lex: Lexicon = currentLexicon()): { n: number; raw: string; index: number }[] {
  // 先剥离 id、日期、年份 / FY、6 位代码、字母前缀代码(C39)、序号 / 计数 / ×N / 季度标记 / 情景锚点记号(30x);年份与代码只在独立数字时剥离,不能咬进 19826269128.43 这类长数字
  // 先剥 URL(链接里的数字不是主张)与速率标签(1.6T / 800G / 3.2T / 400Gbps 是产品类别名,不是数字主张);
  // 但金额语境不剥:"$1.6T" / "1.6T 美元" / "800G 元" 前有货币符号或后接金额 / 百分比单位时仍是数字主张(Codex 审查 voice-r1)
  // 先剥 URL 与域名(163.com / 36kr.com 里的数字不是主张;ht6 真踩),再剥速率标签
  // HTTP 状态码(HTTP 429 / 状态码 402)是故障描述不是数字主张(ht11:agent 如实写"H100 因 HTTP 429 未获取"被判未绑定)
  // 联邦公报文号 2026-11571 / 公告编号 2026-001 是编号不是数字(年份剥掉后会留下 -11571 负数 —— Codex policy-r1)
  // 先把"日期 + 时刻"当整体剥掉(报告里发布时间的写法:2026-08-24 20:45 / 2026-08-24T20:45:00);
  // **裸时刻不剥** —— 否则"配比 35:65"这种真主张会被漏掉(Codex headlines-r2)
  // 所有被忽略的片段都用**等长空白**遮掉，让 match.index 始终对应原始行。
  // 缩成单个空格会破坏位置映射，随后在原文里判断正负号 / 方向词时可能落到 ev-id 的数字上。
  const mask = (m: string) => " ".repeat(m.length);
  const sourceLine = line;
  line = line.replace(/\d{4}-\d{2}-\d{2}[\sT]{0,3}\d{1,2}:\d{2}(?::\d{2})?/g, mask);
  // 用户资料引用 [资料:<32 位编号> p.3] 整个剥掉:编号里的「48610」「7e8」不是数字主张,遮了引用就坏了(v2.2.0 审计 Opus 第 1 条);
  // 点分日期 2026.10.11 也剥掉 —— 带两个点的不可能是一个数,不剥会读出 2026.10
  line = line.replace(/\[资料:[^\]\n]*\]/g, mask).replace(/(?<![\d.])(?:19|20)\d{2}\.\d{1,2}\.\d{1,2}(?![\d.])/g, mask);
  let s = stripSpeedLabels(line.replace(/https?:\/\/[^\s)\]]+/g, mask).replace(/(HTTP|状态码|status)\s?[1-5]\d{2}(?!\d)/gi, mask).replace(/(?<![\d.])(19|20)\d{2}-\d{3,6}(?![\d.-])/g, mask).replace(/(?<![\d.])1260H\b/g, mask).replace(/(?<![\w.])[\w-]+(?:\.[\w-]+)*\.(?:com|cn|net|org|io|co|hk|tw|jp|kr|de|uk|info|biz|tv|me|ai|app)(?:\.[a-z]{2})?(?![\w.])/gi, mask)).replace(/(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})(?![0-9a-zA-Z_])/g, mask).replace(/\d{4}-\d{2}-\d{2}/g, mask).replace(/\d{4}Q[1-4]|\d{4}H[12]/g, mask)
    .replace(/FY\s?\d{4}/g, mask).replace(/(?<![\d.])(19|20)\d{2}(?![\d.])\s*[年]?/g, mask)// 主体编号默认剥掉,**但后面紧跟单位就是真数字**(踩坑实例见 finance/lexicon.ts)
    // 主体编号剥离的条件由 Plugin 的 subjectCodePatterns 给出,或**等于本次运行的主体编号**。
    // 单位白名单永远补不全(辆 / 平方米 / 千瓦…—— Codex commodity-r3),所以裸的、又不是本次主体编号的数字一律当真主张交给绑定校验
    ;
  for (const re of lex.subjectCodePatterns) s = s.replace(re, mask);
  s = s
    .replace(/(?<![\d.])[A-Za-z]\d+(?![\d.])/g, mask)
    .replace(/第\s*\d+\s*[次条行名]|\d+\s*[次条行个家名项]\b|×\s*\d+|\d+\s*季度?|Q\d|(?<![\d.])\d+(?:\.\d+)?x\b/g, mask)
    // 时间**窗口标签**不是数字主张(窗口长度 ≠ 数据点)—— 具体词表由 Plugin 提供,踩坑记录见 finance/lexicon.ts
    // 只有**后接窗口词**才算窗口标签;"回款周期约 30 天" / "交付周期约 45 日" 是真主张,不能剥(Codex commodity-r2)
    .replace(lex.windowLabelPattern, mask);
  for (const re of lex.labelPatterns ?? []) s = s.replace(re, mask);   // 名称 / 规则阈值里的数字
  if (lex.subjectCodeIsSixDigits && symbol && /^\d{6}$/.test(symbol)) s = s.replace(new RegExp(`(?<![\\d.])${symbol}(?![\\d.])`, "g"), mask);  // 本次主体编号在正文里裸写也当编号
  const out: { n: number; raw: string; index: number }[] = [];
  // 逗号只有后面正好 3 位数字才算千分位：模型写 "years=1,33 家" / "1,2,3" 时不能拼成 133 / 123（ht-global3 真踩）
  for (const m of s.matchAll(/-?\d{1,3}(?:,\d{3})+(?![\d,])(?:\.\d+)?(?:e[+-]?\d+)?|-?\d+\.?\d*(?:e[+-]?\d+)?/gi)) {
    const raw = m[0]; const n = Number(raw.replace(/,/g, "")); if (!Number.isFinite(n)) continue;
    const after = s.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 3);
    // ≤20 的小整数:只有紧跟单位 / 百分号 / 倍 / 元 / 亿 / 万 时才算实质数字(否则视为计数)
    // ≤20 的小整数只在**纯整数写法**时视为计数跳过("近 5 年" / "第 2 批");带小数点的是 calc 0.3.2 display 写法("2.00 年" / "0.00 年"),必须绑定证据。
    // "期" 进白名单:quarterize 的期数 display 就是整数("11 期"),必须绑定;"年" 不进(叙述里"近 5 年"太常见,交给 judgeDisplayFidelity 的叙述豁免规则处理)。
    if (Number.isInteger(n) && Math.abs(n) <= 20 && !/e/i.test(raw) && !/\.\d/.test(raw) && !/^\s*(%|倍|元|亿|万|x|X|pp|百分点|期)/.test(after)) continue;  // "1." 列表编号不算小数
    out.push({ n, raw: raw + (/^\s*(%|倍|元|亿|万|百分点|年|期)/.exec(after)?.[0]?.trim() ?? ""), index: m.index ?? sourceLine.indexOf(raw) });
  }
  return out;
}

/** calc 0.3.2 起给每个结果附 `display`。更早的版本没有,是**正常的旧运行**不是缺陷。 */
export function supportsDisplay(v: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return false;                       // 版本读不出来 → 不做要求(宁可漏报也不误杀旧运行)
  const [, a, b, c] = m.map(Number) as unknown as [string, number, number, number];
  return a > 0 || b > 3 || (b === 3 && c >= 2);
}

export const normDisp = (s: string) => s.replace(/\s+/g, "");

/**
 * 在历史文本里找一个数字写法。**只要求左边界**(左边不能紧邻数字 / 小数点)。
 *
 * 左边界防的是"59.09%"里藏着一个编造的"9.09%"(Codex fidelity-r1 P1)。
 * ⚠️ 右边界**故意不要**:引用旧值时截位是正常写法(档案里是 0.6328580294544913,
 * 报告写"旧值 0.632858 不再适用"),加了右边界会把这种正当引用判成编造 —— 实测拦掉 3 处。
 * 与 display 的"逐字照抄"不同:那是**本次算出来的数**,截位就是丢精度;这是**引用旧值**,性质不同。
 */
/**
 * 符号规范化:Unicode 负号(U+2212 等)统一成 ASCII `-`,并把"符号与数字之间的空白"去掉。
 * 不做这一步,`- 1.92%` 与 `−1.92%` 都能绕过下面的符号边界(Codex fidelity-r4)。
 */
export const normSign = (s: string) => s.split("\n").map((line) => {
  // 🔴 只认**真负号**:U+2212 与全角负号。en dash / em dash 是标点(破折号、区间号),
  //    一律当负号会误伤"毛利率—1.92%"这类正当写法(Codex fidelity-r5)。
  // 🔴 行首的 markdown 列表标记 `- ` 不是负号,原样保留 —— 否则"- 1.92% 为历史值"整行被当成负值。
  const head = /^(\s*[-*+]\s+)?/.exec(line)![0];
  return head + line.slice(head.length).replace(/[\u2212\uFF0D]/g, "-").replace(/([+-])\s+(?=[\d.])/g, "$1");
}).join("\n");

/**
 * token 在行内**是否带负号**。`claimTokens` 的正则不吃符号,`−1.92%` 会被解析成正数 1.92,
 * 直接拿去绑一个正值证据 —— 方向反了却判通过(Codex fidelity-r5 P1)。
 * ⚠️ 行首的 markdown 列表标记 `- ` 不算负号(它前面没有任何非空白字符)。
 */
export function negatedAt(line: string, idx: number): boolean {
  if (idx <= 0) return false;
  const head = line.slice(0, idx);
  const m = /([-+\u2212\uFF0D])\s*$/.exec(head);
  if (!m || m[1] === "+") return false;
  // 🔴 "行首 = 列表标记"这条豁免**只对 ASCII 连字符成立** —— markdown 的列表标记是 `-`,
  //    不会是 U+2212 / 全角负号。行首写 `−1.92%` 就是个负数,不是列表项(Codex fidelity-r6)。
  if (m[1] !== "-") return true;
  return /\S/.test(head.slice(0, m.index));      // ASCII `-`:前面还有内容才算负号
}

export function quotedIncludes(rawHay: string, rawNeedle: string): boolean {
  const hay = normSign(rawHay), needle = normSign(rawNeedle);
  if (!needle) return false;
  const signedNeedle = /^[+-]/.test(needle);
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 ? hay[i - 1] : "";
    if (/[\d.]/.test(before)) continue;
    // 🔴 无符号的 token 不许绑到**带负号**的文本:证据写"同比 -1.92%"、报告写"1.92%",
    //    方向就反了。带符号的 needle(方向词那条路径传的 `-1.92%`)不受此限(Codex fidelity-r3 P1)。
    if (!signedNeedle && /[+-]/.test(before)) continue;
    return true;
  }
  return false;
}
export const PROSE_BEFORE = /(近|过去|未来|连续|第|每|共|约|前|后|历时|超过|不足|以上|以下|至少|最多)\s*$/;
/**
 * 中文用**方向词**承载正负号:证据值是 -1.92,报告写"下降 1.92 美元/卡时"是正确写法,
 * 不是丢了符号(实测这类占误报的一大半)。命中这些词时,允许按绝对值绑定。
 * ⚠️ 仅放宽**符号**,不放宽数值本身。正向词(上升 / 增加…)不放宽,见 `signedBefore`;
 *    负向词写反(该"升"写成"降",配正值证据)这里仍抓不到 —— 正值本来就能直接绑上。
 */
export const SIGNED_BEFORE = /(下降|上升|下跌|上涨|回落|回升|减少|增加|降低|提高|收窄|扩大|低|高|多|少|降|升|增|减|差)\s*$/;
/**
 * 正向方向词:后面的数本该是正值。「同比上升 1.92%」配证据 -1.92% 是方向写反,不能借上面的放宽绑上去(审计 2026-10-11 Codex 范围 4 第 4 条)。
 * 例外:前面有把方向反过来的名词 ——「亏损增加 2 亿」「跌幅扩大」配负值证据是对的,照旧放宽。
 * 「收窄 / 扩大 / 差」本身方向不定,不在这里。
 */
const UP_BEFORE = /(上升|上涨|回升|增加|提高|高|多|升|增)\s*$/;
const INVERTED_BEFORE = /(亏|跌|降幅|负|缺口|逆差|赤字)/;
/** 方向词允许按绝对值绑负值证据吗 */
export const signedBefore = (before: string): boolean => SIGNED_BEFORE.test(before) && !(UP_BEFORE.test(before) && !INVERTED_BEFORE.test(before));

export function reportSections(report: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}; let cur = "_head";
  out[cur] = [];
  // 🔴 同名标题再出现一次时**接着往后加**,不清空:以前第二个「## 事实」把第一节整个换掉,
  //    第一节里带真实引用的错数从此没人核对,报告照样交付(Codex 审计第三轮 A4)
  for (const line of report.split("\n")) { const m = /^##\s+(.+)$/.exec(line); if (m) { cur = m[1].trim(); out[cur] ??= []; continue; } out[cur].push(line); }
  return out;
}

export interface FidelityResult {
  /** 该写 display 却没写 —— 不是"不适用",是 calc 侧缺陷,必须报出来 */
  missingDisplay?: boolean;
  /** 纯 evidence 行的违规。**不受 `applicable` 门控** —— 它与 display 无关 */
  evidenceViolations?: string[];
  /** 本次运行是否有带 display 的 calc(旧运行没有 → 不适用,不判失败) */
  applicable: boolean;
  total: number;
  exact: number;
  violations: string[];
  /** 给补跑 Agent 的结构化定位信息；字符串 violations 保留给既有调用方与日志。 */
  violationDetails: FidelityViolationDetail[];
  evidenceViolationDetails: FidelityViolationDetail[];
  /** 同行没引任何 id、本次证据 / 计算 / 档案里也找不到的数字:交付前遮掉,报告标「不完整」 */
  uncited: UncitedNumber[];
}

export interface UncitedNumber {
  section: string;
  /** 所在行(原文),遮挡时按整行定位 */
  line: string;
  /** 数字本身(不含单位)在行内的位置和写法 */
  index: number;
  num: string;
}

export interface FidelityViolationDetail {
  section: string;
  token: string;
  line: string;
  citedIds: string[];
  /** 本次运行里值正好等于这个数、同行却没引的证据或计算（最多 3 条）：补上或换成它 */
  foundIn?: string[];
}

/** 明确写成假设 / 情景的行:数字是设定,不是事实 */
const ASSUMPTION_LINE = /假设|假定|情景|设定|如果|倘若|若按|若以/;

/** 遮挡未核实数字时的占位 */
export const UNVERIFIED_MARK = "〔未核实〕";

/** 像代码（6 位 / 0 开头 5 位）或紧凑日期（20260903）的整数：是编号不是数据 */
const CODE_OR_DATE = /^-?(?:\d{6}|0\d{4}|(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))\.?$/;

/**
 * 把逐 token 报错压成逐行修复清单：既不会只露出前三个问题，也不会让同一长行重复几十次。
 * Agent 可据同行 id 回读 evidence / calc，决定补齐来源 id、照抄 display，或删掉无展示值的数字。
 */
export function summarizeFidelityViolations(items: FidelityViolationDetail[], maxLines = Number.POSITIVE_INFINITY): string {
  const grouped = new Map<string, { section: string; line: string; tokens: string[]; ids: string[]; found: string[] }>();
  for (const item of items) {
    const key = `${item.section}\u0000${item.line}`;
    const group = grouped.get(key) ?? { section: item.section, line: item.line, tokens: [], ids: [], found: [] };
    for (const id of item.foundIn ?? []) if (!group.found.includes(id)) group.found.push(id);
    if (!group.tokens.includes(item.token)) group.tokens.push(item.token);
    for (const id of item.citedIds) if (!group.ids.includes(id)) group.ids.push(id);
    grouped.set(key, group);
  }
  const groups = [...grouped.values()];
  const shown = groups.slice(0, maxLines).map((group) => {
    const snippet = group.line.replace(/\s+/g, " ").trim().slice(0, 220);
    const found = group.found.length ? `；这个数在 ${group.found.join(",")}（同行没引它，或引错了 id）` : "";
    return `[${group.section}] 错误数字=${group.tokens.join(",")}；同行 id=${group.ids.join(",") || "无"}${found}；原句=${snippet}`;
  });
  if (groups.length > maxLines) shown.push(`另有 ${groups.length - maxLines} 行未展开`);
  return shown.join(" | ");
}

/**
 * 逐行检查:一行里若引了 calc,则该行的数字必须能对上所引 calc 的 display,
 * 或对上同行 evidence 的原值(事实数字照抄),或是 calc 的输入 / 中间量。
 * `symbol` 用于把本次主体代码从"数字主张"里剔掉(裸写的 6 位代码不是数字)。
 */
export function checkNumberFidelity(report: string, evById: Map<string, EvidenceItem>,
                                    calcById: Map<string, CalcRecord>, symbol?: string,
                                    quoted: string[] = [], lex: Lexicon = currentLexicon(),
                                    excludedSections: readonly string[] = [],
                                    library?: { ids: ReadonlySet<string>; text: string }): FidelityResult {
  // `quoted` = 可**逐字引用**的历史文本(知识档案召回内容、knowledge_conflicts 的 claim)。
  // 报告写"旧前瞻 CAGR 59.09% 不再适用,本次为 58.85%"时,59.09% 是对档案的**引用**,
  // 本次运行的证据里当然没有它 —— 不把这类纳入可绑定池,就会把"如实标注新旧差异"这个**正确行为**判成违规。
  const quotedText = quoted.join("\n");
  const secs = reportSections(report);
  let total = 0, exact = 0, anyDisplay = false, shouldHaveDisplay = 0;
  const violations: string[] = [];        // display 纪律相关(引用了 calc 的行)—— 受 applicable 门控
  const evidenceViolations: string[] = []; // 纯 evidence 行 —— **与 display 无关,始终上报**
  const violationDetails: FidelityViolationDetail[] = [];
  const evidenceViolationDetails: FidelityViolationDetail[] = [];
  const uncited: UncitedNumber[] = [];
  // 没引 id 的行:本次任一证据(按写的量级换算、或文本里逐字出现)、任一计算的 display / 输入 / 中间量,都算有出处
  const allEvIds = [...evById.keys()];
  const allEvTexts = numbersOf(allEvIds, evById, calcById).texts;
  const allEvScaled = scaledEvidenceOf(allEvIds, evById);
  // 计算的输入 / 中间量没有单位:按「元级 / 比值」处理(写了 % 的允许 ×100,写了万 / 亿的按元换算)
  const calcInputsAll = intermediateNumbersOf([...calcById.keys()], calcById).map((v) => ({ v, scale: null as EvidenceScale }));
  // 档案引文、本次用户资料片段里的数,连同写在后面的单位
  const quotedScaled = scaledNumbersInText(quotedText);
  const libraryScaled = library ? scaledNumbersInText(library.text) : [];
  // 本次运行里已有的数:证据里的数值、各 calc 成功结果的 display。档案引用的豁免只给**本次没有**的旧值 ——
  // 本次证据 / 计算里就有的数,同行必须引它的编号。ht-global3 真踩:一组本次证据里就有的数早写进了上次的档案,
  // 表格那行只引了另一个计算编号,这两个数靠档案放行,读者在这一行点不到出处;档案里的旧数也可能被当作这次的数写进来。
  const currentEv = new Map<number, string[]>();
  for (const [id, e] of evById) if (typeof e.value === "number" && Number.isFinite(e.value)) currentEv.set(e.value, [...(currentEv.get(e.value) ?? []), id]);
  const currentDisp: [string, string][] = [];
  for (const [id, c] of calcById) for (const r of resultProjection(c.output)) if (r.display && r.status === "ok") currentDisp.push([normDisp(r.display), id]);
  const dispIds = (raw: string): string[] => {
    const n = normDisp(raw);
    return currentDisp.filter(([d]) => d === n || (d.startsWith(n) && !/^[\d.]/.test(d.slice(n.length)))).map(([, id]) => id);
  };
  const inRunIds = (raw: string, val: number): string[] => [...new Set([...(currentEv.get(val) ?? []), ...dispIds(raw)])];
  for (const [sec, lines] of Object.entries(secs)) {
    // 标题带序号或后缀(「七、数据缺口」「数据缺口与局限」)也算:和必需章节检查同一口径(v2.2.0 审计 Opus 第 3 条)
    if (sec === "_head" || excludedSections.some((x) => sec.includes(x))) continue;
    let assumedTable = false;
    for (const line of lines) {
      // 表头写了「情景 / 假设」的表格,下面的数据行(「| 乐观 | 35.2 倍 |」)也是设定;遇到非表格行就结束
      if (!/^\s*\|/.test(line)) assumedTable = false;
      else if (/^\s*\|[\s:|-]*$/.test(line)) { /* 分隔行 */ }
      else if (!assumedTable && ASSUMPTION_LINE.test(line)) assumedTable = true;
      const ids = [...line.matchAll(/(?<![0-9a-zA-Z_-])(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})(?![0-9a-zA-Z_])/g)].map((m) => m[1]);
      const calcIds = ids.filter((id) => calcById.has(id));
      const evIds = ids.filter((id) => evById.has(id));
      // 🔴 **纯 evidence 行也要查**。原先只查引用了 calc 的行,于是"引了一个真实的 ev-id 却写了
      //    另一个数字"在事实表里完全没人管 —— 而事实表恰恰是整篇报告数字最密集的地方。
      //    ⚠️ 这条不是拍脑袋加的:在本机 48 个真实运行上实测过 —— 1209 行纯 evidence 行、
      //    806 个需校验 token,报出 5 个,逐个核对后 **4 个是真缺陷**
      //    (某次运行的事实表把证据 id 整体错位了一行:70.96 那行引的 id 实际值是 39.03),
      //    1 个是空格造成的误报(已在下面的文本匹配里规范化空白)(Codex fidelity-r1 P1)。
      if (!calcIds.length && !evIds.length) {
        // 🔴 没引 id 的行原来整行跳过 —— 编造的数字只要不写 id 就不被核对(审计 2026-10-09 第 2 轮 A5)。
        //    现在:本次证据 / 计算 / 档案里找得到这个值的放过(有出处、只是没标),找不到的记下来,交付前遮掉
        if (ASSUMPTION_LINE.test(line) || assumedTable) continue;
        const libCited = !!library && [...line.matchAll(/\[资料:([0-9a-f]{32}) p\.(?:\d+|-)\]/g)].some((m) => library.ids.has(m[1]!));
        for (const tok of claimTokens(line, symbol, lex)) {
          // 「31.2%-35.8%」「1,200-1,500 亿元」:连字符前紧挨着数 / % / 单位,是区间号,后一个数按正数核对(v2.2.0 审计 Opus 第 2 条)
          const rangeAt = (i: number) => /[\d%亿万元倍xX]\s*[-－]\s*$/.test(line.slice(0, i));
          const t = tok.raw.startsWith("-") && rangeAt(tok.index + 1) ? { n: -tok.n, raw: tok.raw.slice(1), index: tok.index + 1 } : tok;
          const unit = /[^0-9.,e+-]+$/.exec(t.raw)?.[0] ?? "";
          const num = t.raw.slice(0, t.raw.length - unit.length);
          const decimal = /\.\d/.test(num);
          // 明写了「元 / 股」的按倍率 1 去和证据单位换算(证据 1.2345 万元、报告 12345 元也对得上);没写单位的才只比原值。
          // 区间「31.2-35.8 亿元」「99~150 亿元」「31.3 至 35.8 亿元」左端没写单位,用右端写的(v2.1.0 合并审计 Codex 第 2 条、复核第 3、4 条)
          const rangeTail = /^\s*(?:-|－|~|～|〜|–|—|至|到)\s*\d[\d,]*(?:\.\d+)?/.exec(line.slice(t.index + num.length));
          const unitAt = t.index + num.length + (rangeTail?.[0].length ?? 0);
          const written = writtenScale(line, unitAt) ?? (/^\s*(?:元|股)/.test(line.slice(unitAt)) ? 1 : null);
          // 整数、没写单位的按计数跳过;区间左端借到了右端的单位就不是计数(「99-150 亿元」的 99 要查)
          if (!decimal && !unit && written === null && (Math.abs(t.n) < 1e4 || CODE_OR_DATE.test(num))) continue;
          const before = line.slice(Math.max(0, t.index - 6), t.index);
          if (!decimal && PROSE_BEFORE.test(before)) continue;
          const signed = signedBefore(before);
          const neg = negatedAt(line, t.index) && !rangeAt(t.index);
          const val = neg ? -t.n : t.n;
          const raw = neg ? `-${t.raw}` : t.raw;
          const places = /\.(\d+)/.exec(num)?.[1].length ?? 0;
          // 🔴 证据只按 writtenExact 对(带单位换算):不能拿「数值和某条证据相等」直接放行 ——
          //    证据 37.42 亿元、报告写 37.42 万元,数值相等、差一万倍(v2.2.0 审计 Codex 第 2 条)
          const known = (x: number, r: string) => dispIds(r).length > 0
            || writtenExact(x, places, written, allEvScaled)
            || allEvTexts.some((tx) => quotedIncludes(normDisp(tx), normDisp(r)))
            || writtenExact(x, places, written, calcInputsAll)
            // 档案引文 / 同行引了的本次用户资料:片段里有这个数、按写的位数和单位对得上才算有出处
            || writtenExact(x, places, written, quotedScaled)
            || (libCited && writtenExact(x, places, written, libraryScaled));
          if (known(val, raw) || (signed && known(-t.n, `-${t.raw}`))) continue;
          uncited.push({ section: sec, line, index: t.index, num: line.slice(t.index, t.index + num.length) });
        }
        continue;
      }
      const displays = new Set<string>();
      for (const id of calcIds) {
        const rec = calcById.get(id)!;
        // 判据用**这条记录自己的 calc_version**:0.3.2 起才写 display,更早的版本没有属正常。
        // 用"引用了 calc 却没 display"当判据会把真·旧运行一并判失败(实测把全部端到端夹具打红)。
        const expectsDisplay = supportsDisplay(String((rec as { calc_version?: unknown }).calc_version ?? ""));
        for (const r of resultProjection(rec.output)) {
        // 只有**成功**的结果才被要求写 display:失败结果合理地没有 display,
        // 拿它触发 missingDisplay 会把正常运行拦下(Codex fidelity-r2)。
        const succeeded = r.status === "ok";
        if (expectsDisplay && succeeded && !r.hasDisplay) shouldHaveDisplay++;
        // `anyDisplay` 与"合法靶子"必须同一判据:只有失败结果残留 display 时,
        // 本该"不适用"却会打开上报门控(Codex fidelity-r3)。
        if (r.hasDisplay && succeeded) anyDisplay = true;
        // 只有**成功且数值有限**的结果的 display 才是合法靶子:失败子结果残留的 display
        // 会让一个本不该出现的数字看着"照抄了 display"(Codex fidelity-r1 P1)
        // status 必须**明确是 ok**(不再放行 undefined)。
        // value 允许 null:`resultProjection` 把**非数值 value 归一成 null**
        // (`typeof o.value === "number" ? o.value : null`),所以判定类结果(value 是文本)
        // 到这里就是 null —— 它们的 display 同样是合法靶子,写成"只收有限数"会把它们误杀。
        if (r.display && succeeded && (r.value === null || Number.isFinite(r.value))) {
          displays.add(normDisp(r.display));
        }
        }
      }
      const evPool = numbersOf(evIds, evById, calcById);
      const evScaled = scaledEvidenceOf(evIds, evById);
      const calcPool = numbersOf(calcIds, evById, calcById);
      // 🔴 `startsWith` 允许**截断数字**:display 是 "37.40 倍" 时,报告写 "37.4" 也会命中 ——
      //    而"少写一位有效数字"正是这个判定要抓的东西(Codex fidelity-r1 P1)。
      //    只允许截掉**单位后缀**(剩余部分不以数字开头),不允许截掉数字本身。
      const hasDisp = (raw: string) => {
        const n = normDisp(raw);
        return [...displays].some((x) => x === n || (x.startsWith(n) && !/^[\d.]/.test(x.slice(n.length))));
      };
      for (const t of claimTokens(line, symbol, lex)) {
        const unit = /[^0-9.,e+-]+$/.exec(t.raw)?.[0] ?? "";
        const num = t.raw.slice(0, t.raw.length - unit.length);
        const decimal = /\.\d/.test(num);
        // 纯整数计数（"3 家" / "近 5 年"）豁免；但 ≥1 万的整数是数据（持股 1079451366 股、成交量 20422500 股），
        // 引错 id 一样要报 —— 2026-10-09 一次真跑里三处引错 id 都是这类大整数，原先一律放过。
        // 长得像代码 / 紧凑日期的仍豁免（600088、00700、300308.SZ、ds2-20260903）：在本机 181 个真实运行上核对，
        // 放开后只多报出那三处真错，没有误报。代价：恰好 6 位的真数字（如 221117 股）仍不查。
        if (!decimal && !unit && (Math.abs(t.n) < 1e4 || CODE_OR_DATE.test(num))) continue;
        // claimTokens 用等长空白遮掉 id / 日期 / URL 后保留了原始位置。
        // 不能再用 line.indexOf:同行前面的 `ev-1f...` 会把真实的 `1%` 错定位到 id 内部，
        // 继而把 id 的连字符误当负号，导致公告标题里明明有 1% 却被误判为无证据。
        const idx = t.index;
        const before = idx >= 0 ? line.slice(Math.max(0, idx - 6), idx) : "";
        if (!decimal && PROSE_BEFORE.test(before)) continue;               // "近 5 年" / "连续 3 期":叙述,豁免
        total++;
        const signed = signedBefore(before);              // "下降 1.92" ← 证据 / display 为 -1.92
        // 行内**显式写了负号**时,要拿负值去绑:否则 "−1.92%" 会被当成 1.92 绑上一个正值证据
        const neg = negatedAt(line, idx);
        const val = neg ? -t.n : t.n;
        const raw = neg ? `-${t.raw}` : t.raw;
        if (hasDisp(raw) || (signed && hasDisp(`-${t.raw}`))) { exact++; continue; }
        // 原始事实数字照抄 evidence。文本匹配要**规范化空白**:证据里写"12.34 亿元"、
        // 报告写"12.34亿",本是同一个数,不该因为一个空格判成编造。
        // 文本证据同样要**左边界**:裸 includes 会让 "59.09%" 承载一个编造的 "9.09%"(fidelity-r2 P1)。
        // 右边界仍不加(单位后缀 / 合理截位要放行),空白规范化后再比。
        const inText = (needle: string) => evPool.texts.some((x) => quotedIncludes(normDisp(x), normDisp(needle)));
        // 写了万 / 亿 / %:只按写的量级和证据自己的单位换算(第四轮审计 A2);没写量级的照旧
        const written = writtenScale(line, idx + num.length);
        const evBound = (x: number) => (written === null ? numberBound(x, evPool.nums) : unitBound(x, written, evScaled));
        if (evBound(val) || (signed && evBound(-t.n))
            || inText(raw) || (signed && inText(`-${t.raw}`))) { exact++; continue; }
        // 逐字引用知识档案里的旧值。⚠️ **必须带边界**:裸 `includes` 会让 "59.09%" 里
        // 命中一个编造的 "9.09%"(Codex fidelity-r1 P1) —— 那不是"引用",是巧合。
        // ⚠️ 引用历史负值时也要走方向词那条路:档案是 "-1.92%"、报告写"下降 1.92%",
        //    加了符号边界后若不给这条路径补 `-token`,正当写法反而被拦(这是 r3 修复引入的,r4 抓到)。
        const inRun = [...inRunIds(raw, val), ...(signed ? inRunIds(`-${t.raw}`, -t.n) : [])].filter((id) => !ids.includes(id));
        // 写了万 / 亿 / % 的按写的位数和单位对档案(档案 120.5 亿元、报告 120.5 万元不算引用);没写量级的照旧允许截位(复核第 6 条)
        const places = /\.(\d+)/.exec(num)?.[1].length ?? 0;
        const fromArchive = (x: number, r: string) => written === null
          ? quotedIncludes(quotedText, r) || quotedIncludes(quotedText, String(x))
          : writtenExact(x, places, written, quotedScaled);
        if (!inRun.length && quotedText && (fromArchive(val, raw) || (signed && fromArchive(-t.n, `-${t.raw}`)))) { exact++; continue; }
        // PR #42: 输入和 details 中间量可舍入、换算单位；不纳入 output.value。
        // 小数用紧容差，不能把 27.30 改写为 27.35；主结果仍必须照抄 display。
        // 年/期不走此豁免，避免把倍数锚误绑成年数。
        if (!/^(年|期)$/.test(unit) && numberBound(val, intermediateNumbersOf(calcIds, calcById), decimal ? 1e-6 : 2e-3)) { exact++; continue; }
        // 🔴 两类违规必须分开:`applicable`(本次有没有 display)只能决定**display 纪律**适不适用,
        //    决定不了"引了一个真实 ev-id 却写了别的数"要不要报 —— 那与 display 无关。
        //    合在一起的后果:旧 calc 运行 / 纯取数运行里,事实表写错数字完全不会被报出来(Codex fidelity-r2 P1)。
        const foundIn = [...new Set(inRun)].slice(0, 3);
        const detail = { section: sec, token: raw, line, citedIds: ids, ...(foundIn.length ? { foundIn } : {}) };
        if (calcIds.length) {
          violations.push(`[${sec}] ${t.raw} ← ${line.slice(0, 80)}`);
          violationDetails.push(detail);
        } else {
          evidenceViolations.push(`[${sec}] ${t.raw} ← ${line.slice(0, 80)}`);
          evidenceViolationDetails.push(detail);
        }
      }
    }
  }
  // 🔴 `applicable=false` 有两种截然不同的原因,生产里必须分开(Codex fidelity-r1 P1):
  //    ① 报告根本没引用带结果的 calc(旧运行 / 纯取数运行)→ 确实不适用;
  //    ② calc 版本本该写 display 却没写 → 那是 calc 侧的缺陷,
  //       此时静默跳过等于把整条数字忠实度防线关掉,而外面看不出来。⇒ 用 `missingDisplay` 报出来。
  return { applicable: anyDisplay, total, exact, violations, evidenceViolations, violationDetails,
    evidenceViolationDetails, missingDisplay: shouldHaveDisplay > 0, uncited };
}


/**
 * 把没有出处的数字换成占位(只换数字本身,单位和上下文留着),开头加一句说明。
 * 同一行原文出现几次就换几次;位置对不上的(行已被改过)不换。返回遮了几处。
 */
export function maskUncited(report: string, uncited: readonly UncitedNumber[]): { text: string; count: number } {
  if (!uncited.length) return { text: report, count: 0 };
  // 按「章节 + 行」定位:别处(比如数据缺口)一字不差的同一行不跟着遮
  const key = (sec: string, line: string) => `${sec}\u0000${line}`;
  const byLine = new Map<string, Map<number, string>>();
  for (const u of uncited) { const k = key(u.section, u.line); (byLine.get(k) ?? byLine.set(k, new Map()).get(k)!).set(u.index, u.num); }
  let count = 0;
  let sec = "_head";
  const lines = report.split("\n").map((line) => {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { sec = h[1]!.trim(); return line; }
    const at = byLine.get(key(sec, line));
    if (!at) return line;
    let out = line;
    for (const [index, num] of [...at].sort((a, b) => b[0] - a[0])) {
      if (out.slice(index, index + num.length) !== num) continue;
      out = out.slice(0, index) + UNVERIFIED_MARK + out.slice(index + num.length);
      count++;
    }
    return out;
  });
  if (!count) return { text: report, count: 0 };
  // 放在首行(标题 + 状态)之后:读者先看到,也不进任何章节
  const note = `> 有 ${count} 处数字在本次取到的数据和计算里找不到出处，已替换为${UNVERIFIED_MARK}，本报告因此标为不完整。`;
  return { text: [lines[0], "", note, ...lines.slice(1)].join("\n"), count };
}


/** 各阶段 knowledge_conflicts 的 claim / refuted_by 文本 —— 报告引用"旧值"时的可追溯来源 */
export function quotedHistory(stageOf: (s: string) => Record<string, unknown> | null): string[] {
  const out: string[] = [];
  for (const st of currentPlugin().stages) {   // 阶段清单由契约给,不写死(全审 r4)
    const kc = (stageOf(st) as { knowledge_conflicts?: unknown } | null)?.knowledge_conflicts;
    if (!Array.isArray(kc)) continue;
    for (const c of kc) {
      if (c && typeof c === "object") for (const k of ["claim", "refuted_by"]) {
        const v = (c as Record<string, unknown>)[k];
        if (typeof v === "string") out.push(v);
      }
    }
  }
  return out;
}
