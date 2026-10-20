/**
 * **算式自查** —— 文本里自己写出来的算式，重算一遍看对不对。
 *
 * 🔴 为什么需要这一层：引用来的数字可以跟已知值比对，**算出来的数字比不了** ——
 *    它不等于任何一个已知值。于是它成了唯一一类「谁都没在看」的数字，
 *    而它就摆在核对过的数字旁边，看着一样可信。
 *    真实案例：一段文字写「444.64 对 453.90，同比仅增 +0.2%」——
 *    实际是 −2.04%，**方向都反了**；同一段文字在别处又写了 −2.04%，自相矛盾。
 *
 * ⇒ 做法：只要文本把算式写出来了（`A ÷ B − 1 = R%`、`A − B = R` 之类），
 *    就地重算，对不上就点名。**写不出算式的数字另有一条规则**（见 `auditNumbers`）。
 *
 * ⚠️ 这里**只查它自己写下的算式**，不判断算式选得对不对
 *    （拿错了年份的两个数相除，算式本身可以是自洽的）。能查的和不能查的要分清楚，
 *    别让「算式对」被读成「结论对」。
 */

/** 千分位、全角减号、各种除号都归一 */
function toNum(raw: string): number | null {
  const s = raw.replace(/,/g, "").replace(/[−—–]/g, "-").replace(/^\+/, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// ⚠️ 正号要允许:真实文本里写的是 `= +0.2%`,不认正号就**整条算式识别不出来**,
//    于是那句错话安然过关(第一版就是这么漏掉真案例的)。
const NUM = String.raw`[+\-−—–]?\d[\d,]*(?:\.\d+)?`;
// ⚠️ 数字与运算符之间常夹着单位:`444.64 亿 ÷ 453.90 亿 − 1`。
//    不留这个口子,带单位的算式一条都识别不出来 —— 而真实文本里几乎都带单位。
//    只放行**紧跟数字**的少量单位字,不吃普通文字。
// 🔴 单位要**参与运算**,不能只吃掉(Codex 审计 2026-10-09 A7):「2 亿 + 3 万 = 5 亿元」按裸数重算是 2 + 3 = 5,判成对的。
//    数量级(万亿 / 亿 / 万)与 % 各捕获一组,重算前归一;元 / 股 / 倍 只是单位名,不改数值。
const UNIT = String.raw`\s*(万亿|亿|万)?(%|[元股倍]{0,2})`;
/** 结果后面的单位:数量级 + 单位名(写了「元」「倍」也算明确给了单位) */
const RESULT_UNIT = String.raw`\s*(万亿|亿|万)?\s*(%|[元股倍])?`;
const MAG: Record<string, number> = { 万亿: 1e12, 亿: 1e8, 万: 1e4 };
/** 去掉数量级、只留 % 的归一系数 */
const pctK = (t: Term) => (t.dim === "%" ? 0.01 : 1);

/**
 * 一个带单位的数:v 写出来的数,k 归一系数(亿 = 1e8、% = 0.01),scaled 有没有写数量级或 %,
 * dim 量纲(`%` / `元` / `股` / `倍`,没写单位名是空串),mag 写没写数量级(亿 / 万;% 不算)。
 */
interface Term { v: number; k: number; scaled: boolean; dim: string; mag: boolean }
function term(raw: string | undefined, mag: string | undefined, suffix: string | undefined): Term | null {
  const v = toNum(raw ?? "");
  if (v === null) return null;
  const dim = suffix === "%" ? "%" : (suffix ?? "").slice(0, 1);
  return { v, k: (mag ? MAG[mag]! : 1) * (suffix === "%" ? 0.01 : 1), scaled: !!mag || suffix === "%", dim, mag: !!mag };
}

/**
 * 加减两边是不是同一种量。没写单位名的一边按同一种看(「100 元 + 20 = 120 元」);
 * 但 % 必须两边都写:「100 元 + 20% = 100.2 元」把金额和比例相加,不能判成对、更不能让 100.2 拿到出处(审计第二轮 A7)。
 */
const sameDim = (x: string, y: string) => x === y || (x !== "%" && y !== "%" && (!x || !y));

/**
 * 没写数量级、也没写单位名的数(裸数或百分比):结果写了数量级时才可能是「省略写法」。
 * 🔴 明确写了「元 / 股 / 倍」的就是那个单位本身:「2 元 + 3 元 = 5 亿元」按 5 元算,不按 5 亿读(审计 2026-10-11 Codex 范围 4 第 3 条)
 */
const unitless = (t: Term) => !t.mag && (!t.dim || t.dim === "%");
/** 自己写清了单位的数:写了数量级,或写了单位名(百分比不算单位名) */
const ownUnit = (t: Term) => t.mag || (!!t.dim && t.dim !== "%");

/**
 * 只有结果写了数量级时有两种读法:运算数按结果的数量级读(省略写法「19005.40 − 16821.09 = 2184.31 亿元」),
 * 或运算数按字面读、结果换了个单位写(「5 × 2000 = 1 万」「3000 + 7000 = 1 万」)。取数量级离写出来的结果更近的那种:
 * 两种读法差一个数量级系数(至少 1 万倍),对得上的那种一定更近;都对不上时「重算应为」也按更说得通的那种报。
 * 🔴 原来只认第一种:一条对的单位换算被标成算错(审计 2026-10-11 Opus 范围 4 待核实,实跑确认)。
 */
function eitherReading(stated: number, omitted: number, literal: number): number {
  const off = (x: number) => (x === 0 || stated === 0 ? Number.POSITIVE_INFINITY : Math.abs(Math.log10(Math.abs(x / stated))));
  return off(literal) < off(omitted) ? literal : omitted;
}

/**
 * 两数运算后的结果,换算回**结果写出来的单位**;单位对不上又判断不了时返回 null(不认这条算式,既不算对也不算错)。
 * - 结果没写单位:加减要求两边同一数量级(「2 亿 + 3 亿 = 5」是省略写法);乘法要求两边都没数量级;
 *   除法要求两边都写或都没写数量级(都写 = 两个金额之比)。否则说不清结果是哪个数量级 → null。
 * - 两边都没单位、结果只写了 %(「35 − 20 = 15%」「0.35 × 100 = 35%」)按老写法直接比。
 */
function binaryResult(op: string, a: Term, b: Term, r: Term & { explicit: boolean; pct: boolean }): number | null {
  // 加减和多项加减同一套规则
  if (/^\+$/.test(op) || new RegExp(`^${MINUS}$`).test(op)) return sumResult([{ t: a, sign: 1 }, { t: b, sign: /^\+$/.test(op) ? 1 : -1 }], r);
  // ⚠️ 乘除不查量纲:「金额 × 百分比」「金额 ÷ 金额 = %」「金额 ÷ 股数 = 元」都是正常写法
  // 🔴 数量级只写在结果上(「19005.40 − 16821.09 = 2184.31 亿元」「100 ÷ 8 = 12.5 亿」)是省略写法:运算数按结果的数量级读。
  //    不认这种写法时,结果被换算成亿、运算数还是裸数,一条对的算式被判成「重算应为 0.00」(VA 复盘实跑 2026-10-10)。
  if (r.mag && unitless(a) && unitless(b)) {
    const raw = new RegExp(DIV).test(op) ? (b.v === 0 ? null : (a.v * a.k) / (b.v * b.k)) : a.v * a.k * b.v * b.k;
    return raw === null ? null : eitherReading(r.v, raw / pctK(r), raw / r.k);
  }
  if (new RegExp(DIV).test(op)) {
    if (b.v === 0) return null;
    if (!r.explicit) return a.scaled === b.scaled ? (a.v * a.k) / (b.v * b.k) : null;
    return (a.v * a.k) / (b.v * b.k) / r.k;
  }
  const legacyPct = r.pct && !r.mag && a.k === 1 && b.k === 1 && !a.dim && !b.dim;
  if (!r.explicit) return a.k === 1 && b.k === 1 ? a.v * b.v : null;
  if (legacyPct) return a.v * b.v;
  return (a.v * a.k * b.v * b.k) / r.k;
}

/**
 * 加减(两项或多项)的结果,换算回结果写出来的单位;说不清时返回 null。
 * - 量纲不同不认(既不算对也不算错);结果写的量纲和运算数不同也不认。
 * - 运算数都没写数量级和单位名、只有结果写了:省略写法按结果的数量级读,或按字面读、结果换了单位(见 eitherReading)。
 * - 运算数都写清了单位(「2 元 + 3 元 = 5 亿元」):各按自己的单位算,再换成结果的单位。
 * - 有的写清了、有的没写,结果写了数量级(「2 亿 + 3 = 5 亿」「2 元 + 3 = 5 亿元」):说不清没写的那项是多少,不认。
 */
function sumResult(terms: { t: Term; sign: 1 | -1 }[], r: Term & { explicit: boolean; pct: boolean }): number | null {
  const opDim = terms.find((x) => x.t.dim)?.t.dim ?? "";
  if (!terms.every((x) => sameDim(x.t.dim, opDim))) return null;
  const total = (f: (t: Term) => number) => terms.reduce((acc, x) => acc + x.sign * f(x.t), 0);
  if (r.mag && terms.every((x) => unitless(x.t))) {
    if (opDim && !sameDim(opDim, r.dim)) return null;
    const raw = total((t) => t.v * t.k);
    return eitherReading(r.v, raw / pctK(r), raw / r.k);
  }
  if (r.mag && !terms.every((x) => ownUnit(x.t))) return null;
  if (!r.explicit) return terms.every((x) => x.t.k === terms[0]!.t.k) ? total((t) => t.v) : null;
  if (r.pct && !r.mag && terms.every((x) => x.t.k === 1 && !x.t.dim)) return total((t) => t.v);
  if (r.dim && opDim && !sameDim(opDim, r.dim)) return null;
  return total((t) => t.v * t.k) / r.k;
}
// ⚠️ 运算符与数字之间常夹着一小段**标签**：`÷ 甲项 910.94 亿元`、`= 占比 49.83%`。
//    不留口子的话，这类（实测里最常见的）写法一条都识别不出来 ——
//    而识别不到和「没有算式可查」在结果上长得一模一样。
//    上限 8 个字符，且**不含数字 / 运算符 / 等号**，避免跨到无关的数上去。
const LABEL = String.raw`(?:\s*[^\d=＝≈+\-−—–*×/÷()（）,，;；]{0,8})?`;
const DIV = String.raw`[/÷]`;
// 结果是四舍五入的,模型常写「≈」(「40 ÷ 69 ≈ 58.0%」);不认的话这类算式整条识别不出来
/** 算式里认的等号(调用方判断「− 1 =」这类写法时用同一组,别各写一份) */
export const EQ_CHARS = "=＝≈";
const EQ = `[${EQ_CHARS}]`;
const MINUS = String.raw`[-−—–]`;
const MUL = String.raw`[*×]`;

/**
 * 这条匹配只是更长算式的尾巴:前面紧挨着「数 运算符」,或者匹配自己以正负号开头、前面紧挨着一个数。
 * 「…+94.17+86.77+84.89=1277.54」里的「+86.77+84.89=1277.54」、「1+2×3=7」里的「2×3=7」都是这样。
 * 🔴 只拿最后两项重算,对的合计被判成算错(VA 复盘实跑 2026-10-10),错的也可能被判对 —— 尾巴一律不单独认。
 */
const NUM_END = String.raw`\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:万亿|亿|万)?(?:%|[元股倍]{0,2})`;
function isTail(line: string, m: RegExpMatchArray): boolean {
  const before = line.slice(0, m.index).trimEnd();
  if (new RegExp(String.raw`${NUM_END}\s*(?:${MINUS}|\+|${MUL}|${DIV})$`).test(before)) return true;
  return /^[+\-−—–]/.test(m[0]) && new RegExp(`${NUM_END}$`).test(before);
}

/** 一条被重算过的算式 */
export interface StatedCalc {
  /** 原文片段 */
  raw: string;
  /** 文本自己给出的结果 */
  stated: number;
  /** 我们重算出来的结果 */
  recomputed: number;
  /** 结果是不是按百分数写的 */
  percent: boolean;
  ok: boolean;
}

/**
 * 允许的误差。写作时会四舍五入（`−2.04%` 其实是 −2.0402…），
 * 所以按**结果量级**给一个宽度，而不是要求逐位相等。
 * ⚠️ 宽度只到能容下四舍五入 —— 再宽就会把「+0.2% vs −2.04%」这种真错也放过去。
 */
function closeEnough(stated: number, recomputed: number, approxTol = 0): boolean {
  const tol = Math.max(Math.abs(recomputed) * 5e-3, 0.011, approxTol);
  return Math.abs(stated - recomputed) <= tol;
}

/**
 * 「≈」后面的数只承诺写出来的那几位:「≈ 2200」是按百位取整,「≈ 58.0%」是按 0.1 取整。
 * 容差给到最后一位有效数字的半格,和「=」一样严的话,两位有效数字的近似会被标成算错(v2.2.0 审计 Opus 第 6 条)。
 * 半格再封顶到结果的 5%(不低于个位的半格 0.5):「≈ 100%」「≈ 20%」末尾的 0 不一定是取整位,只按半格算,
 * 「30 ÷ 49 ≈ 100%」(实为 61%)也会判对(v2.1.0 合并审计 Opus 第 1 条);「10 ÷ 3 ≈ 3 倍」照旧算对(复核第 1 条)。
 */
function approxTolerance(stated: string): number {
  const s = stated.replace(/[,\s]/g, "").replace(/^[-+−]/, "");
  const dec = /\.(\d+)$/.exec(s)?.[1]?.length;
  if (dec !== undefined) return 0.5 * 10 ** -dec;
  if (/^0+$/.test(s)) return 0.5;
  const half = 0.5 * 10 ** (/0*$/.exec(s)?.[0].length ?? 0);
  return Math.min(half, Math.max(Math.abs(toNum(stated) ?? 0) * 0.05, 0.5));
}

/**
 * 找出一行里**写出来的算式**并重算。
 * 支持四种形状（覆盖「两数相除减一」「差」「和」「倍」）：
 *   `A ÷ B − 1 = R%` · `A − B = R` · `A + B = R` · `A × B = R`
 */
export function checkStatedArithmetic(rawLine: string): StatedCalc[] {
  const out: StatedCalc[] = [];
  // 🔴 先把**标注**剥掉再匹配。算式里常夹着两类东西,它们是注解不是运算数:
  //    ① 证据引用 `[ev-xxxx]` ② 期间标签 `2026H1` / `2025Q3` / `2024FY`。
  //    不剥的话 `2026H1 444.64 亿 ÷ 2025H1 453.90 亿 − 1 = −2.04%` **一条都识别不出来** ——
  //    而这正是我们要求模型写出来的那种形状,识别不出等于这层校验对它完全失效。
  //    ⚠️ 期间标签必须整体剥掉(不能只剥字母):留下 `2026` 会被当成一个运算数。
  const line = rawLine
    .replace(/\[(?:ev|calc)-[0-9a-zA-Z]+(?:\s*[,;]\s*(?:ev|calc)-[0-9a-zA-Z]+)*\]/g, " ")
    .replace(/\b\d{4}\s*(?:[HhQq][1-4]|FY|fy)\b/g, " ")
    .replace(/\b\d{4}\s*年度?/g, " ")
    // 中文破折号「——」是标点,不是负号:不剥的话「结论——19005.40-16821.09=2184.31」的第一个数被读成负数
    .replace(/——/g, " ");
  const push = (raw: string, stated: string, recomputed: number, percent: boolean) => {
    const st = toNum(stated);
    if (st === null || !Number.isFinite(recomputed)) return;
    out.push({ raw: raw.trim(), stated: st, recomputed, percent, ok: closeEnough(st, recomputed, /≈/.test(raw) ? approxTolerance(stated) : 0) });
  };

  // A ÷ B − 1 = R（R 可带 %；带 % 时重算值要 ×100）。两数各按自己的数量级归一后再相除
  const ratio = new RegExp(
    String.raw`(${NUM})${UNIT}\s*${DIV}${LABEL}\s*(${NUM})${UNIT}\s*${MINUS}\s*1\s*${EQ}${LABEL}\s*(${NUM})${RESULT_UNIT}`, "g");
  for (const m of line.matchAll(ratio)) {
    if (isTail(line, m)) continue;
    const a = term(m[1], m[2], m[3]), b = term(m[4], m[5], m[6]), r = term(m[7], m[8], m[9]);
    if (!a || !b || !r || b.v === 0) continue;
    push(m[0]!, m[7]!, ((a.v * a.k) / (b.v * b.k) - 1) / r.k, m[9] === "%");
  }

  // A − B = R / A + B = R / A × B = R / A ÷ B = R（结果可带 %）
  // ⚠️ **纯除法必须支持**：实测里模型写的大多是这种形状
  //    （`453.90 ÷ 910.94 = 49.83%`、`6.43 ÷ 18.14 = 35.4%` —— 两个数相除得一个占比）。
  //    第一版漏了它，于是一段写满算式的产出只认出 1 条 —— 校验覆盖不到的地方，
  //    看起来和"没有算式可查"一模一样。
  const binary = new RegExp(
    String.raw`(${NUM})${UNIT}\s*(${MINUS}|\+|${MUL}|${DIV})${LABEL}\s*(${NUM})${UNIT}\s*${EQ}${LABEL}\s*(${NUM})${RESULT_UNIT}`, "g");
  // 多项加减 A + B + C … = R(「前十合计 210.92+160.28+…+84.89=1277.54 亿元」)。
  // 两数式只认得最后两项,多项要整条拆开重算;重算过的范围记下来,两数式不再从里面挑尾巴。
  const chain = new RegExp(
    String.raw`^(${NUM}${UNIT}(?:\s*(?:${MINUS}|\+)${LABEL}\s*\d[\d,]*(?:\.\d+)?${UNIT}){2,})\s*${EQ}${LABEL}\s*(${NUM})${RESULT_UNIT}$`);
  const covered: [number, number][] = [];
  for (const m of line.matchAll(new RegExp(String.raw`${NUM}${UNIT}(?:\s*(?:${MINUS}|\+)${LABEL}\s*\d[\d,]*(?:\.\d+)?${UNIT}){2,}\s*${EQ}${LABEL}\s*${NUM}${RESULT_UNIT}`, "g"))) {
    if (isTail(line, m)) continue;
    const c = chain.exec(m[0]);
    if (!c) continue;
    const terms: { t: Term; sign: 1 | -1 }[] = [];
    const termRe = new RegExp(String.raw`(^|${MINUS}|\+)${LABEL}\s*(\d[\d,]*(?:\.\d+)?)${UNIT}`, "g");
    for (const t of c[1]!.matchAll(termRe)) {
      const v = term(t[2], t[3], t[4]);
      if (v) terms.push({ t: v, sign: t[1] && t[1] !== "+" ? -1 : 1 });
    }
    // 拆出来的项要正好拼回整条左边,拼不回(中间混了乘除之类)就不认
    if (terms.length < 3 || c[1]!.replace(termRe, "").trim() !== "") continue;
    // 结果是最后三组(数 / 数量级 / 单位名);前面 UNIT 自带捕获组,按位置数容易数错
    const [rNum, rMag, rSuffix] = c.slice(-3);
    const stated = term(rNum, rMag, rSuffix);
    if (!stated) continue;
    const r = sumResult(terms, { ...stated, explicit: !!(rMag || rSuffix), pct: rSuffix === "%" });
    covered.push([m.index!, m.index! + m[0].length]);
    if (r === null) continue;
    push(m[0], rNum!, r, rSuffix === "%");
  }

  for (const m of line.matchAll(binary)) {
    if (isTail(line, m) || covered.some(([s, e]) => m.index! >= s && m.index! < e)) continue;
    const a = term(m[1], m[2], m[3]), b = term(m[5], m[6], m[7]), stated = term(m[8], m[9], m[10]);
    if (!a || !b || !stated) continue;
    const op = m[4]!;
    // ⚠️ `A ÷ B − 1 = R` 已被上一条吃掉；这里再匹到的 `− 1 =` 会重复报，跳过
    if (/^[-−—–]$/.test(op) && b.v === 1 && new RegExp(DIV).test(line)) continue;
    const pct = m[10] === "%";
    // 带 % 的除法是占比：r.k = 0.01，相当于 ×100
    const r = binaryResult(op, a, b, { ...stated, explicit: !!(m[9] || m[10]), pct });
    if (r === null) continue;
    push(m[0]!, m[8]!, r, pct);
  }
  return out;
}

/** 一个没有着落的数字 */
export interface LooseNumber {
  /** 它出现在哪一行（截断后的） */
  line: string;
  value: number;
  raw: string;
}

export interface NumberAudit {
  /** 需要有着落的数字总数 */
  total: number;
  /** 对得上已知值的 */
  bound: number;
  /** 出现在**自洽算式**里的（算式重算通过） */
  derived: number;
  /** 既对不上已知值、也没写算式的 */
  loose: LooseNumber[];
  /** 写了算式但**重算对不上**的 —— 最要紧的一类 */
  badMath: StatedCalc[];
}

/**
 * 审一段文本里的数字。
 *
 * 三档，**必须分开报**：
 * - `bound`  ——  与已知值对得上（可溯源）
 * - `derived` —— 没有对应的已知值，但文本把算式写出来了且重算通过
 * - `loose`  ——  两样都不是。**不等于错**，但它是「没人在看」的那一档，要让人知道有多少
 *
 * `badMath` 是唯一可以断言「这里错了」的一类：算式是它自己写的，结果对不上。
 */
export function auditNumbers(
  text: string,
  known: number[],
  claims: (line: string) => { n: number; raw: string }[],
  bound: (n: number, pool: number[]) => boolean,
): NumberAudit {
  const res: NumberAudit = { total: 0, bound: 0, derived: 0, loose: [], badMath: [] };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const calcs = checkStatedArithmetic(line);
    res.badMath.push(...calcs.filter((c) => !c.ok));
    // 算式里出现过的数（含结果）都算「有交代」
    const inCalc = new Set<number>();
    for (const c of calcs) {
      if (!c.ok) continue;
      inCalc.add(c.stated);
      for (const m of c.raw.matchAll(new RegExp(NUM, "g"))) {
        const v = toNum(m[0]!);
        if (v !== null) inCalc.add(v);
      }
    }
    for (const t of claims(line)) {
      res.total++;
      if (bound(t.n, known)) res.bound++;
      else if (inCalc.has(t.n)) res.derived++;
      else res.loose.push({ line: line.trim().slice(0, 160), value: t.n, raw: t.raw });
    }
  }
  return res;
}
