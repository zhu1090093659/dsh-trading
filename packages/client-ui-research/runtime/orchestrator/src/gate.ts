/**
 * 合规 gate(确定性后处理):最终报告命中插件给的产出红线模式即拒绝交付(研究宪法 §0 第 3 条;方案 §9)。
 * 纯函数:输入报告文本,输出命中清单。只有整行精确等于固定免责声明的行才豁免(防"不构成建议,但建议……"这种半句翻转)。
 */
import { gateExemptLines, gatePatterns, gateRegexps } from "./config.ts";

/**
 * 硬测试往报告里注入探针时的**那一整行**。
 *
 * 🔴 注册期自检与真正注入**必须用同一个函数拼**。审计 gate-r1-P1 指出:
 *    自检只测裸的 probeLine,而真正写进报告的是带前后缀的一整行 ——
 *    规则若是锚定式(`^…$`),自检过、注入行却拦不住,**硬测试从此永远绿**。
 */
export const probeReportLine = (probe: string): string =>
  `- 【硬测试注入文本】${probe}(此行用于触发合规 gate,重写时必须删除)`;

export interface GateHit {
  line: number;
  pattern: string;
  text: string;
}

export interface GateResult {
  ok: boolean;
  hits: GateHit[];
}

/** 简 → 繁(只覆盖红线词表用到的、繁简不同的字);与 data-access/scripts/sources/textsafe.py TRAD_CHARS 逐字一致 */
export const TRAD_CHARS: Record<string, string> = { 仓: "倉", 减: "減", 满: "滿", 议: "議", 买: "買", 卖: "賣", 评: "評", 级: "級", 损: "損", 标: "標", 价: "價", 荐: "薦" };
const TRAD2SIMP = new Map(Object.entries(TRAD_CHARS).map(([s, t]) => [t, s]));
const CJK = "\u3400-\u9FFF\uF900-\uFAFF";
// 不可见字符:控制 / 格式字符、零宽、CGJ、蒙文 / 变体选择符(它们是 Mn,不在 Cf 里)
// 规范形还剥组合附加符 / 环绕符(U+0301 等),只用于匹配
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Mn}\p{Me}\u200B-\u200D\u2060\uFEFF]/gu;
/** 汉字之间可忽略的分隔符;与 textsafe.py CJK_SEP_CHARS 逐字一致(测试强制) */
export const CJK_SEP_CHARS = " \t\r\n\u3000\u00b7\u2022\u30fb_*~|/\\+.\u2010\u2011\u2012\u2013\u2014\u2015-";
const CJK_SEP_RE = new RegExp(`(?<=[${CJK}])[${CJK_SEP_CHARS.replace(/[\\\]^-]/g, (c) => "\\" + c)}]+(?=[${CJK}])`, "gu");

/** gate 匹配用规范形:NFKC、剥不可见字符、繁→简、汉字之间的空白 / 点线分隔符忽略(插空格、插零宽字符、写成繁体,都要命中同一个词)。与 textsafe.canonical_for_match 同构。 */
export function canonicalForGate(text: string): string {
  let t = text.normalize("NFKC").replace(INVISIBLE_RE, "");
  t = Array.from(t, (ch) => TRAD2SIMP.get(ch) ?? ch).join("");
  return t.replace(CJK_SEP_RE, "");
}

const NO_REFS: ReadonlySet<string> = new Set();
/** Markdown 引用标签的比对形:不分大小写、连续空白算一个 */
const refKey = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
/** 全文里定义过的引用标签(`[仓]: https://…` 这种行);逐行检查看不到别的行,所以先整篇收一遍 */
export function referenceLabels(report: string): Set<string> {
  const out = new Set<string>();
  for (const m of report.matchAll(/^ {0,3}(?:>\s*)*\[([^[\]]+)\]:/gm)) out.add(refKey(m[1]!));
  return out;
}

/**
 * 一行 Markdown **渲染后看得到的文字**:链接 / 图片只留显示文字,去掉行内代码的反引号和 HTML 标签,
 * 解开字符实体(`&#24314;`)和反斜杠转义。只用于匹配。
 * 🔴 合规检查原来只看 Markdown 原文:禁词被链接拆成 `前[后](https://x)` 时,原文里没有连续的禁词,
 *    页面上显示的却是连起来的那个词(Codex 审计第三轮 A2)。⇒ 原文和渲染后的文字两样都查,任一命中就算。
 * `refs` 是全文定义过的引用标签(见 referenceLabels):缩略写法 `[仓]` 只有在别处有 `[仓]: 网址` 时才显示成「仓」(第四轮审计 A1)。
 */
export function markdownVisible(line: string, refs: ReadonlySet<string> = NO_REFS): string {
  let t = line;
  for (let i = 0; i < 4; i += 1) {   // 链接套图片这类嵌套:由内往外逐层剥
    let next = t.replace(/!?\[([^[\]]*)\](?:\([^()]*\)|\[[^[\]]*\])/g, "$1");
    if (refs.size) next = next.replace(/!?\[([^[\]]+)\](?!:)/g, (m, label: string) => (refs.has(refKey(label)) ? label : m));
    if (next === t) break;
    t = next;
  }
  t = t.replace(/`+/g, "").replace(/<\/?[A-Za-z][^<>]*>/g, "");
  t = t.replace(/&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi, (m, hex: string | undefined, dec: string | undefined) => {
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
  t = t.replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_m, n: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[n.toLowerCase() as "amp"]);
  return t.replace(/\\([!-\/:-@[-`{-~])/g, "$1");
}

export function complianceGate(
  report: string,
  patterns: string[] = gatePatterns(),
  exemptLines: string[] = gateExemptLines(),
  regexps: { name: string; re: RegExp }[] = gateRegexps(),
): GateResult {
  const hits: GateHit[] = [];
  const exempt = new Set(exemptLines.map((l) => canonicalForGate(l.trim())));
  const refs = referenceLabels(report);
  const raws = report.split(/\r?\n/);
  const stripped: string[] = [];   // 剥掉列表 / 引用前缀后的每一行;豁免行记成空串,段落检查时当分隔
  raws.forEach((raw, i) => {
    // 只剥**真正的 Markdown 前缀**(符号后面得有空白),逐层剥以支持嵌套引用 / 列表。
    // 🔴 原来是 `/^[-*>\s]+/` 一把吞掉行首所有 `- * >` 与空白 —— 那会把**正文语义符号**
    //    也吃掉:`>18% 才触发` → `18% 才触发`、`-1 倍` → `1 倍`、`*ST …` → `ST …`。
    //    ⚠️ 对**当前**这套规则不构成漏判(实测:没有一条规则以 `- * >` 开头,也没有锚定行首的正则),
    //       但它是个埋着的坑:哪天有人写一条 `/^-\d+% 止损/`,它会静默永不命中。
    //       (审计 gate-r3;修的是"以后写规则的人会踩",不是"现在有洞"。)
    let line = raw.trim();
    for (;;) {
      // `>` 后面也要求空白:研究文本里 `>18%` 几乎一定是"大于",不是引用块。
      // 真是无空格引用块也无妨 —— 剥不剥都照样命中,只影响命中行怎么显示。
      // `>` 只在后面是空白**或另一个 `>`**(嵌套引用 `>>`)时才算引用符。
      // 研究文本里 `>18%` 几乎一定是"大于",不是引用块;真是无空格引用块也无妨 ——
      // 剥不剥都照样命中,只影响命中行怎么显示。
      const next = line.replace(/^(?:(?:[-*+]|\d+[.)])\s+|>(?=[>\s])\s*)/, "");
      if (next === line) break;
      line = next.trim();
    }
    line = line.trim();
    stripped.push("");
    if (!line) return;
    const canon = canonicalForGate(line);
    const shown = canonicalForGate(markdownVisible(line, refs));   // 页面上显示出来的那一行(见 markdownVisible)
    if (exempt.has(canon) || exempt.has(shown)) return;
    stripped[i] = line;
    for (const p of patterns) {
      if (canon.includes(p) || shown.includes(p)) hits.push({ line: i + 1, pattern: p, text: line.slice(0, 160) });
    }
    // 正则规则:子串表管不住的动作 + 语气 / 价位 / 英文(全审 r3-P1-1)。
    // ⚠️ 一律不带 g 标志 —— 带 g 的正则 `test()` 会写 lastIndex,跨行复用同一个对象会漏判。
    for (const { name, re } of regexps) {
      if (re.test(canon) || re.test(shown)) hits.push({ line: i + 1, pattern: name, text: line.slice(0, 160) });
    }
  });
  // 🔴 再按段落查一遍:同一段里的换行渲染出来只是一个空格,链接也能跨行写(`前[后](` 换行 `https://x)`),
  //    页面上显示的是连起来的词,逐行查却哪一行都拼不出来(审计 2026-10-11 Codex 范围 4 第 2 条)。
  //    查的是**按行移除之后剩下的样子**:已命中的行会被换成移除提示,把段落隔开 ⇒ 只拼相邻的、还没命中的行。
  //    🔴 不能按「这段里已有同名规则命中」跳过:第一行写了一次、第二三行跨行又写一次,只删第一行,
  //    后两行渲染出来照样是那个词(v2.2.0 审计 Codex 第 1 条)。拼出来命中的,这几行每行都记一条。
  const lineHit = new Set(hits.map((h) => h.line - 1));
  for (const block of paragraphs(raws, stripped)) {
    const runs: number[][] = [];
    let run: number[] = [];
    for (const i of block) {
      if (lineHit.has(i)) { if (run.length) runs.push(run); run = []; } else run.push(i);
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      if (r.length < 2) continue;   // 单独一行逐行已经查过
      const joined = r.map((i) => stripped[i]!).join("\n");
      const canon = canonicalForGate(joined);
      const shown = canonicalForGate(markdownVisible(joined, refs));
      const found = [
        ...patterns.filter((p) => canon.includes(p) || shown.includes(p)),
        ...regexps.filter(({ re }) => re.test(canon) || re.test(shown)).map(({ name }) => name),
      ];
      for (const p of found) for (const i of r) hits.push({ line: i + 1, pattern: p, text: stripped[i]!.slice(0, 160) });
    }
  }
  hits.sort((a, b) => a.line - b.line);
  return { ok: hits.length === 0, hits };
}

/**
 * 把行分成 Markdown 段落(行号从 0 起):空行、豁免行、代码围栏结束一段;
 * 以列表 / 引用 / 标题 / 表格符号开头的行另起一段(没有这些符号的续行接在上一段后面)。
 * 标题和表格行自成一段;代码围栏里的行原样显示,不和别的行拼。
 */
function paragraphs(raws: readonly string[], stripped: readonly string[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let fence = false;
  let quoteBlock = false;
  const close = () => { if (cur.length) out.push(cur); cur = []; quoteBlock = false; };
  raws.forEach((raw, i) => {
    const t = raw.trim();
    if (/^(?:```|~~~)/.test(t)) { close(); fence = !fence; return; }
    if (fence || !stripped[i]) { close(); return; }
    if (/^(?:#{1,6}\s|\|)/.test(t)) { close(); out.push([i]); return; }
    // 列表项各自成段;引用块打断普通段落,但连续的引用行(及其后紧跟的无标记行)是同一段
    const quote = t.startsWith(">");
    if (/^(?:[-*+]|\d+[.)])\s/.test(t) || (quote && !quoteBlock)) close();
    if (!cur.length) quoteBlock = quote;
    cur.push(i);
  });
  close();
  return out;
}

/** 报告必须包含的章节标题是否齐全 */
export function missingSections(report: string, sections: string[]): string[] {
  return sections.filter((s) => !new RegExp(`^#{1,3}\\s*.*${escapeRe(s)}`, "m").test(report));
}

/**
 * 报告中引用的 ev- / calc- id。
 * 🔴 必须带**整 token 边界**:没有边界时 `ev-abcdef123456xyz` 会截出合法前缀 `ev-abcdef123456`,
 * 于是"至少引用一条证据""引用的 id 存在"两项都被伪引用满足,而数字忠实度那边(边界严格)看不到这个 id、
 * 不会去核对同行的数字 —— 报告可以带着无效引用通过(全审 r1-P2-4)。
 * `report_sections.ts` 的 `citedIds()` 一直是严格的,这里是**同一概念的第二份实现没跟上**。
 */
export function referencedIds(report: string): { evidence: string[]; calculation: string[] } {
  const ev = new Set(report.match(/(?<![0-9A-Za-z_-])ev-[0-9a-f]{6,}(?![0-9A-Za-z_-])/g) ?? []);
  const calc = new Set(report.match(/(?<![0-9A-Za-z_-])calc-[0-9a-f]{16}(?![0-9A-Za-z_-])/g) ?? []);
  return { evidence: [...ev], calculation: [...calc] };
}

/** 报告首行的状态标记 */
export function reportStatusToken(report: string): string | null {
  const m = report.split(/\r?\n/)[0]?.match(/状态[::]\s*(complete|incomplete|failed|stale)/);
  return m ? m[1] : null;
}

/** 把首行状态标记改写为 expected(编排器确定性归一,不动正文) */
export function normalizeReportStatus(report: string, expected: string): { text: string; changed: boolean } {
  const lines = report.split(/\r?\n/);
  const before = lines[0] ?? "";
  const after = before.replace(/(状态[::]\s*)(complete|incomplete|failed|stale)/, `$1${expected}`);
  if (after === before) return { text: report, changed: false };
  lines[0] = after;
  return { text: lines.join("\n"), changed: true };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
