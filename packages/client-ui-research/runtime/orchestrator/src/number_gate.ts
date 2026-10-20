/**
 * 对话的**数字闸门**。阶段报告和辩论早就过数字检查,对话原来只靠提示词里一句「说不清出处的数字就别说」。
 *
 * 规则:回答里的数字要在本轮看得到的内容里找得到 —— 用户消息(含页面上下文)、召回的资料、
 * 工具结果(取数 / 网页 / 计算)、本会话此前的内容 —— 或者是回答里**写出来、算对了、运算数也有出处**的算式的结果。
 * 都不是的,只把那个数字换成「（略※）」,末尾加一条说明。**不整段拒答**:一个数字没出处,不该连累整段回答。
 *
 * 哪些数字算「主张」沿用报告与辩论的 `claimTokens`(日期、年份、编号、序号、小计数不算),
 * 另外不算:名称里的数字(Plugin 注册,如指数名)、时间窗口(「近 30 天」「过去 52 周」)、括号里的参数组(「(12,26,9)」)。
 * 回答里写明「假设 / 假如」的那一句,数字是举例:算进出处,后面用它做的算式也认。读者看得到「假设」二字,不是冒充数据。
 * 🔴 比对**不**沿用 `numberBound`:它对任意数字都试 万 / 亿 / 百分数 六种换算,在报告里没问题 ——
 *    报告每行只和**同一行引用的那几条证据**比;对话却要和整轮资料比,一份几百个价格的工具结果下,
 *    随手编的「156.3」除以 100 就能对上某个价格。所以这里**按写出来的单位换算**:写了「亿」才乘 1 亿,
 *    写了「%」才同时按比例比;容差按数字写到的那一位(「33 亿」容许 ±0.5 亿)。
 * ⚠️ 它只核对「这个数在资料里出现过」,不核对「用在了对的地方」:资料里恰好有个相等的数,照样放行。
 *    百分数另按比例比,所以资料里的小数也能对上它:有 0.35 就放行「35%」,有 1 就放行「100%」。
 */
import { EQ_CHARS, checkStatedArithmetic } from "./arithmetic.ts";

/** 「A ÷ B − 1 = R」里的 1 是写法不是数据;等号和算式核对认的同一组(含 ≈,v2.2.0 审计 Codex 第 7 条) */
const MINUS_ONE = new RegExp(`[-−—–]\\s*1\\s*[${EQ_CHARS}]`);
import { claimTokens } from "./number_fidelity.ts";

export const NUMBER_MARK = "（略※）";

const NUM_RE = /-?\d[\d,]*\.?\d*(?:e[+-]?\d+)?/gi;
const NUM_AT = /^-?\d[\d,]*\.?\d*(?:e[+-]?\d+)?/i;
/** 紧跟在数字后面、决定它该怎么换算的单位 */
const UNIT_AT = /^\s*(万亿|千万|百万|亿|万|%|百分点)/;
const MULT: Record<string, number> = { 万亿: 1e12, 千万: 1e7, 百万: 1e6, 亿: 1e8, 万: 1e4 };
/** 换掉数字时连同紧跟的单位一起换,免得留下「（略※）亿元」 */
const UNIT_AFTER = /^\s*(?:%|倍|百分点|pp|万亿元|亿元|万元|万亿|亿|万|元\/股|美元|港元|元|x(?![A-Za-z0-9]))/;
/**
 * 不是数字主张、但 `claimTokens` 不剥的写法(它是为报告写的):
 * 资料引用 `[资料:<id> p.<页码>]`、行首列表序号、钟点、不带年份的日期(`10-08`、`10/08`、`10月28日`)。
 * ⚠️ 钟点只认 0–23 时、两位分钟 —— `35:65` 这类配比仍然要核对(`claimTokens` 不剥裸时刻正是为此)。
 * ⚠️ `月-日` 后面紧跟单位的不当日期:`12-25%` 是区间。
 */
const PRE_MASK = [
  /\[资料:[^\]\n]*\]/g, /^\s*\d+[.、)）]\s/, /(?<![\d.:])(?:[01]?\d|2[0-3]):[0-5]\d(?![\d:])/g,
  /(?<![\d.\-/])(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])(?![\d.\-/])(?!\s*(?:%|倍|元|亿|万|百分点))/g,
  /(?<![\d.])(?:0?[1-9]|1[0-2])\s*月\s*(?:0?[1-9]|[12]\d|3[01])\s*[日号]?/g,
  // 时间窗口:窗口长度不是数据点
  /(?:近|过去|最近|未来|前|后)\s*\d+\s*(?:个\s*)?(?:日|天|周|星期|月|年|小时|分钟|秒)/g,
  // 括号里的一组小整数是参数(「(12,26,9)」「(5、10、20)」),不是一个个数据
  /[(（]\s*\d{1,3}(?:\s*[,，、]\s*\d{1,3}){1,5}\s*[)）]/g,
];
/** 举例的标记:这一小句里的数字算回答自己给的假设 */
const HYPOTHETICAL = /假设|假如|假定|打个比方/;
/** 按小句切:「A 是 1741 亿元，B 是 862 亿元，假设明年增长 10%」只有最后一小句是假设(千分位的逗号不切) */
const CLAUSE = /(?<=[。！？!?；;，])|(?<=,)(?!\d)/;

/**
 * `claimTokens` 是给报告写的:1900–2099 的独立整数当年份剥掉,「35.2x」当情景记号剥掉。
 * 对话里后面紧跟金额 / 点位 / 倍数单位的就是数字主张(「1985 元」「2080 点」「35.2x」),补回来核对。
 */
const YEAR_WITH_UNIT = /(?<![\d.,])(?:19|20)\d{2}(?![\d.,])(?=\s*(?:万亿|千万|百万|亿|万|元|点|%|倍|百分点|美元|港元|股|手))/g;
const MULTIPLE = /(?<![\d.])\d+(?:\.\d+)?(?=x(?![A-Za-z0-9]))/g;
function missedTokens(probe: string, have: readonly { index: number }[]): { n: number; raw: string; index: number }[] {
  const at = new Set(have.map((t) => t.index));
  const out: { n: number; raw: string; index: number }[] = [];
  for (const re of [YEAR_WITH_UNIT, MULTIPLE]) {
    for (const m of probe.matchAll(re)) if (!at.has(m.index!)) out.push({ n: toNum(m[0]), raw: m[0], index: m.index! });
  }
  return out;
}

/**
 * 只有**闭合的、装着代码的**代码块不核对(含两条围栏):标了编程语言的,或者没标语言、一半以上的行像代码的。
 * 没闭合的围栏、装着数据表 / 普通文字 / json 的块照常核对 —— 不然把编的数字放进代码块就能绕过去。
 */
const CODE_LANG = /^(?:python|py|javascript|js|typescript|ts|tsx|jsx|bash|sh|shell|zsh|sql|r|go|rust|java|c|cpp|ruby|php|swift|kotlin|powershell|ps1|toml|yaml|yml|ini|dockerfile|makefile)$/i;
const CODE_LINE = /^\s*(?:import|from|def|class|const|let|var|return|for|while|if|elif|else|print|function|async|await|select|pip|npm|cd|export)\b|^\s*(?:#|\/\/|--)\s|^\s*[A-Za-z_][\w.[\]'"]*\s*[+\-*/]?=(?!=)|[A-Za-z_]\w*\(|[;{}]\s*$/i;
function codeBlockLines(rows: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const open = /^\s*```\s*([\w+#.-]*)\s*$/.exec(rows[i]!);
    if (!open) continue;
    let j = i + 1;
    while (j < rows.length && !/^\s*```\s*$/.test(rows[j]!)) j++;
    if (j >= rows.length) break;   // 没闭合:后面全按正文核对
    const body = rows.slice(i + 1, j).filter((l) => l.trim());
    const lang = open[1] ?? "";
    const looksCode = lang ? CODE_LANG.test(lang) : body.length > 0 && body.filter((l) => CODE_LINE.test(l)).length * 2 >= body.length;
    if (looksCode) for (let k = i; k <= j; k++) out.add(k);
    i = j;
  }
  return out;
}

/**
 * Plugin 给的「名称 / 窗口」写法(finance 包那一份见 finance/lexicon.ts),同样不算主张。
 * 没注册时什么都不剥 —— 只会多略、不会漏核。用于 `.replace()`:必须带 g、不许带 y。
 */
let gateLabels: readonly RegExp[] = [];
export function registerGateLabels(patterns: readonly RegExp[]): void {
  gateLabels = Object.freeze(patterns.map((r, i) => {
    if (!(r instanceof RegExp) || !r.flags.includes("g") || r.flags.includes("y")) throw new Error(`数字闸门标签 [${i}] 必须是带 g、不带 y 的 RegExp`);
    return new RegExp(r.source, r.flags);
  }));
}

const toNum = (raw: string) => Number(raw.replace(/,/g, ""));

/**
 * 一个数按它后面的单位能代表的值:写「亿」的另算一份乘 1 亿的。
 * 资料里的「5.2%」**不**另存 0.052:回答把百分数写成小数的几乎没有,多存只会让编出来的小数更容易对上。
 */
function expand(n: number, unit: string | undefined, add: (v: number) => void) {
  add(n);
  if (unit && MULT[unit]) add(n * MULT[unit]!);
}

/**
 * 资料里出现过的数,去重后升序。负数另收绝对值(「下降 5.2%」写的是 5.2,资料里是 -5.2);
 * 千分位写法和 JSON 里逗号隔开的整数数组两种读法都收 —— 多收只会更宽松,不会误杀。
 */
export function sourceNumbers(texts: readonly string[]): number[] {
  return sourcePools(texts).all;
}

/**
 * 资料里的数分两池:`all` 是全部读法;`plain` 只收**后面没跟 万 / 亿 这类数量级**的原数(数量级不知道,只能按原样比)。
 * 回答写了数量级(「2 亿元」)时,原样那一读只和 `plain` 比:资料里的「2 万元」不能替「2 亿元」作证(Codex 审计 2026-10-09 A6)。
 */
export function sourcePools(texts: readonly string[]): { all: number[]; plain: number[] } {
  const pool = new Set<number>();
  const plainPool = new Set<number>();
  const add = (v: number) => { if (Number.isFinite(v)) { pool.add(v); pool.add(Math.abs(v)); } };
  const addPlain = (v: number) => { add(v); if (Number.isFinite(v)) { plainPool.add(v); plainPool.add(Math.abs(v)); } };
  for (const t of texts) {
    const text = String(t ?? "");
    // 取数结果里的数带着自己的单位字段(`"value": 18234.56, "unit": "亿元"`):按那个单位另存一份,回答换算成「1.82 万亿元」也对得上
    // 🔴 这些 value 的数量级是**知道的**:下面通扫时不能再把它当「没写数量级」收进 plain ——
    //    否则资料 `{"value":2,"unit":"万元"}` 照样替回答「2 亿元」作证(审计第二轮 A6)
    const knownScale: [number, number][] = [];
    if (text.includes('"unit"')) {
      for (const obj of text.matchAll(/\{[^{}]*\}/g)) {
        const v = /"value"\s*:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(obj[0]);
        const u = /"unit"\s*:\s*"(万亿|千万|百万|亿|万)/.exec(obj[0]);
        if (v && u) {
          add(Number(v[1]) * MULT[u[1]!]!);
          const start = (obj.index ?? 0) + v.index + v[0].length - v[1]!.length;
          knownScale.push([start, start + v[1]!.length]);
        }
      }
    }
    for (const m of text.matchAll(NUM_RE)) {
      const raw = m[0];
      const at = m.index ?? 0;
      const unit = UNIT_AT.exec(text.slice(at + raw.length, at + raw.length + 6))?.[1];
      const scaled = !!(unit && MULT[unit]) || knownScale.some(([s, e]) => at >= s && at < e);
      expand(toNum(raw), unit, scaled ? add : addPlain);
      if (raw.includes(",")) for (const part of raw.split(",")) if (part) (scaled ? add : addPlain)(toNum(part));
    }
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { all: sorted(pool), plain: sorted(plainPool) };
}

/** 第一个 ≥ x 的位置 */
function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** 资料里有没有落在 [v − tol, v + tol] 里的数 */
export function nearInPool(v: number, tol: number, sorted: readonly number[]): boolean {
  const i = lowerBound(sorted, v - tol);
  return i < sorted.length && sorted[i]! <= v + tol;
}

/**
 * 回答里一个数字有没有出处。`raw` 是它的写法(决定写到了哪一位),`unit` 是紧跟的单位,
 * `hint` 是这一行 / 这张表表头里出现过的单位(「金额(亿元)」表头下面的 325.27 按亿算)。
 * 容差取两者中较宽的:相对 0.2%,或写到的那一位的一半。
 */
export function bound(raw: string, unit: string | undefined, hint: readonly string[], sorted: readonly number[], plain?: readonly number[]): boolean {
  const n = toNum(raw);
  if (!Number.isFinite(n)) return true;
  const decimals = /\.(\d+)/.exec(raw)?.[1]?.length ?? 0;
  const half = 0.5 * 10 ** -decimals;
  const units = unit ? [unit] : hint;
  const tries: [number, number, readonly number[]][] = [];
  const push = (v: number, step: number, pool: readonly number[] = sorted) => { tries.push([v, step, pool], [Math.abs(v), step, pool]); };
  // 带了数量级:原样那一读只认资料里同样没写数量级的数(「2 万」不能替「2 亿」作证)
  push(n, half, plain && units.some((u) => MULT[u]) ? plain : sorted);
  for (const u of units) {
    if (MULT[u]) push(n * MULT[u]!, half * MULT[u]!);
    if (u === "%" || u === "百分点") push(n / 100, half / 100);
  }
  return tries.some(([v, step, pool]) => nearInPool(v, Math.max(Math.abs(v) * 2e-3, step) + 1e-12, pool));
}

/** 一行文字里提到的单位(表头、或「单位:亿元」这类说明) */
function unitsIn(text: string): string[] {
  const out: string[] = [];
  if (/万亿/.test(text)) out.push("万亿");
  if (/亿/.test(text.replace(/万亿/g, ""))) out.push("亿");
  if (/万(?!亿)/.test(text)) out.push("万");
  if (/%|百分比|百分点/.test(text)) out.push("%");
  return out;
}

export interface NumberGateResult { reply: string; masked: number }

/** 核对一段回答。`sources` 是本轮看得到的全部文字(消息、资料、工具结果、此前的对话)。 */
export function gateNumbers(reply: string, sources: readonly string[]): NumberGateResult {
  if (!reply.trim()) return { reply, masked: 0 };
  const rows = reply.split("\n");
  const code = codeBlockLines(rows);
  // 写明「假设」的小句:数字算出处(整段回答都认,后面的算式会用到它)
  const assumed: string[] = [];
  rows.forEach((line, i) => {
    if (!code.has(i)) for (const seg of line.split(CLAUSE)) if (HYPOTHETICAL.test(seg)) assumed.push(seg);
  });
  const { all: pool, plain } = sourcePools([...sources, ...assumed]);
  let masked = 0;
  let tableHint: string[] = [];
  let prev = "";
  const lines = rows.map((line, i) => {
    const before = prev;
    prev = line;
    // 闭合的代码块里是示例代码,不是数字主张
    if (code.has(i)) return line;
    // 表格:第一行是表头,表头和表格上面那一行里的单位管整张表
    const isRow = /^\s*\|/.test(line);
    if (isRow && !/^\s*\|/.test(before)) tableHint = unitsIn(`${before} ${line}`);
    if (!isRow) tableHint = [];
    const hint = [...new Set([...unitsIn(line), ...tableHint])];

    let probe = line;
    for (const re of [...PRE_MASK, ...gateLabels]) probe = probe.replace(re, (m) => " ".repeat(m.length));
    const unitAfter = (i: number, raw: string) => UNIT_AT.exec(probe.slice(i + raw.length, i + raw.length + 6))?.[1];
    const has = (raw: string, i: number) => bound(raw, unitAfter(i, raw), hint, pool, plain);
    // 写出来、算对了、**运算数都有出处**的算式,结果才算有出处 —— 拿编的数做一道对的算术,结果照样是编的。
    // 运算数按顺序认:前一道算式的结果可以当后一道的运算数;「A ÷ B − 1 = R」里的 1 是写法不是数据。
    // 存绝对值:算式里的「−2.04%」用的是全角减号,`claimTokens` 读出来是 2.04
    const derived = new Set<number>();
    for (const c of checkStatedArithmetic(probe)) {
      if (!c.ok) continue;
      const nums = [...c.raw.matchAll(NUM_RE)].map((m) => m[0]).slice(0, -1);
      const ops = MINUS_ONE.test(c.raw) ? nums.slice(0, -1) : nums;
      if (ops.every((raw) => derived.has(Math.abs(toNum(raw))) || bound(raw, undefined, hint, pool, plain))) derived.add(Math.abs(c.stated));
    }
    const claimed = claimTokens(probe);
    const loose = [...claimed, ...missedTokens(probe, claimed)].filter((t) => {
      const raw = NUM_AT.exec(probe.slice(t.index))?.[0] ?? String(t.n);
      return !derived.has(Math.abs(t.n)) && !has(raw, t.index);
    });
    let out = line;
    for (const t of loose.sort((a, b) => b.index - a.index)) {
      const num = NUM_AT.exec(out.slice(t.index));
      if (!num) continue;
      // 「2.5-3.0」里的「-」是区间号,不是负号:留下它
      const start = num[0].startsWith("-") && /\d/.test(out[t.index - 1] ?? "") ? t.index + 1 : t.index;
      let end = t.index + num[0].length;
      end += UNIT_AFTER.exec(out.slice(end))?.[0].length ?? 0;
      out = out.slice(0, start) + NUMBER_MARK + out.slice(end);
      masked += 1;
    }
    return out;
  });
  if (!masked) return { reply, masked: 0 };
  return {
    reply: `${lines.join("\n")}\n\n※ 有 ${masked} 处数字在本轮看得到的内容里(你发的消息和页面内容、取到的数据和网页、此前的对话)找不到出处，`
      + `也不是回答里写出的算式算出来的，已换成「${NUMBER_MARK}」。需要这些数字时，可以让 Agent 先查到数据再回答。`,
    masked,
  };
}

/** 写进提示词:先告诉模型会核对,它就会把自己算的数写成算式,少被略掉 */
export const NUMBER_GATE_RULE = "回答里的数字会被逐个核对：要能在本轮给你的内容或工具结果里找到；自己算出来的数写出算式（如 A ÷ B = C）；举例用的数在那句话里写明「假设」。否则会被略去。";
