/**
 * 报告扩展章节的**确定性**要求(编排层算 + 校验层强制)。
 *
 * 为什么需要这个文件 —— 产品宪法写着「提示遵循 ≠ 流程保证,纪律必须落执行层和编排层」,
 * 而"扩展章节"这条纪律原来**只活在提示词里的一句条件句**,正是被打脸的那条:
 *   ht14–ht27 共 15 次真实运行,report 提示词从 18.9K 涨到 23K 的过程中,报告章节数从 11–12 掉到 7–10;
 *   ht27 的 risk 交出 12 个 topic,报告里 **2 个 topic 的证据一条都没引**(资金行为 3 条 / 其他线索 4 条),
 *   另有 3 个被降级成 ### 子节、3 个被合并进一个叫「市场、头条与招聘线索」的子节 ——
 *   而 validator 判 complete、退出码 0,**用户完全看不出少了东西**。
 *   (曾以为是 SIGTERM 打断所致,已证伪:ht27 SIGTERM=0 只有 7 章节,ht26 SIGTERM=16 反而 10 章节。)
 *
 * ⇒ 改法:risk 阶段写了哪些 topic、各自绑了哪些证据,是**已经落盘的事实**。由编排器据此算出要求,
 *   ① 作为一份**短清单**注入报告提示词(而不是让 agent 从 1.8K 的条件句里自己挑),
 *   ② 由 validator **强制校验**,缺了就判不通过 → 触发既有的补跑循环(补跑提示词会逐条列出缺什么)。
 *
 * 🔴 边界:只要求**证据被引用**(有专属章节的还要求章节在场),**不要求任何具体结论**。
 *   章节内可以如实写明局限 / 数据不足 —— 本产品宁可写"没有",不可以编。
 *
 * 🔴 fail-safe 而非 fail-open(Codex sections-r1 P1-1 / P2-4):没有专属章节的议题(见插件的 topicMerge)
 *   与**映射表里没有的未知 topic**,都退化成"证据必须在报告里被引用"的全文要求 ——
 *   否则加了新 topic 却忘了登记映射,这层纪律会对它**静默失效**,而事故里丢的恰好就有「其他线索」。
 */

/** risk 阶段 topic → 报告里的专属章节标题(与 stages.ts 的 report EXT_GUIDE 写法一一对应) */
/** 议题 → 报告章节的归并映射**由插件提供**(没列的议题不进专属章节,只作全文要求) */
import { currentPlugin } from "./plugin.ts";

export const topicSections = (): Record<string, string> => currentPlugin().topicSections as Record<string, string>;

/**
 * 有议题但**没有专属章节**的那几个 —— 不要求章节(否则会逼出一个无处安放的空章节),
 * 但**仍要求证据在报告全文里被引用**(见文件头 fail-safe 说明)。
 * 并入哪一章由插件声明(`topicMerge`);空串 = 不指定,按内容并入相邻章节。
 */
export const topicMerge = (): Record<string, string> => currentPlugin().topicMerge as Record<string, string>;
export const topicsWithoutSection = (): string[] => Object.keys(topicMerge());
/**
 * 扩展章节插在骨架的哪两章之间。**"之前"那一章是推出来的**(骨架里 after 的下一章)——
 * 让插件同时声明前后两章,只会多一个能互相矛盾的字段。after 是最后一章时就只说"之后"。
 */
const placement = (): string => {
  const skeleton = currentPlugin().reportSections;
  const after = currentPlugin().extraSectionsAfter;
  const next = skeleton[skeleton.indexOf(after) + 1];
  return next ? `「${after}」之后、「${next}」之前` : `「${after}」之后`;
};

/** 并到哪一章的人话:插件指定了就说并到哪一章,没指定就不多话 */
const mergeHint = (topic: string): string => {
  const into = topicMerge()[topic];
  return into ? `「${into}」` : "内容相关的章节";
};

export interface ExtraFinding { topic?: unknown; evidence_ids?: unknown }
/** 一个 topic 的证据要求。section 为 null = 不要求专属章节,只要求全文引用。 */
export interface TopicRequirement { topic: string; evidenceIds: string[] }
export interface RequiredSection { section: string; topics: TopicRequirement[]; get evidenceIds(): string[] }
export interface ExtraRequirements { sections: RequiredSection[]; unsectioned: TopicRequirement[] }

function asFindings(stageOutput: unknown): ExtraFinding[] {
  const o = stageOutput as { extra_findings?: unknown } | null | undefined;
  return Array.isArray(o?.extra_findings) ? (o!.extra_findings as ExtraFinding[]) : [];
}

/** 证据 id 只收非空字符串 —— 空串会让任何 `includes` 判定永远为真(Codex sections-r1 P2-5) */
function cleanIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
}

function mergeTopic(list: TopicRequirement[], topic: string, ids: string[]): void {
  const cur = list.find((t) => t.topic === topic);
  if (!cur) { list.push({ topic, evidenceIds: [...new Set(ids)] }); return; }
  for (const id of ids) if (!cur.evidenceIds.includes(id)) cur.evidenceIds.push(id);
}

/**
 * 由 risk 阶段产物算出本次的扩展章节要求。
 * 同一章节被多个 topic 命中时章节合并,但**每个 topic 的证据分开保留** ——
 * 合成并集后只查"命中任意一条"会让「资金行为」满足了、「解禁」全丢也照样通过(Codex sections-r1 P1-2)。
 */
export function requiredExtraSections(riskStageOutput: unknown): ExtraRequirements {
  const bySection = new Map<string, TopicRequirement[]>();
  const unsectioned: TopicRequirement[] = [];
  for (const f of asFindings(riskStageOutput)) {
    const topic = typeof f.topic === "string" && f.topic.trim() ? f.topic.trim() : "";
    if (!topic) continue;
    const ids = cleanIds(f.evidence_ids);
    const section = topicSections()[topic];
    if (!section) { mergeTopic(unsectioned, topic, ids); continue; }   // 无专属章节 / 未知 topic → 全文要求
    const list = bySection.get(section) ?? [];
    mergeTopic(list, topic, ids);
    bySection.set(section, list);
  }
  const sections = [...bySection.entries()].map(([section, topics]) => ({
    section, topics, get evidenceIds() { return topics.flatMap((t) => t.evidenceIds); },
  }));
  return { sections, unsectioned };
}

/**
 * 标题匹配用的规范形:去掉空白与各种分隔符 —— 「公告 · 互动易 · 新闻线索」与「公告·互动易·新闻线索」
 * 必须算同一个章节,否则一个分隔符写法差异就会造成假失败。
 */
export function normalizeHeading(s: string): string {
  return s.replace(/[\s·・‧•\-—–_/|]/g, "");
}

/** Markdown 标题:允许 0–3 个前导空格(CommonMark 合法,不认会造成假失败;Codex sections-r1 P2-6) */
const HEADING_RE = /^ {0,3}(#{1,6})[\t ]+(.*)$/;
/** 围栏代码块开闭:``` 或 ~~~,允许 0–3 个前导空格 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface HeadingBlock { level: number; title: string; body: string; line: number }
interface HeadPos { i: number; level: number; title: string }

/**
 * 扫出所有**围栏代码块之外**的标题 —— 报告里引用 Markdown 片段时,代码块内的 `## 市场声音`
 * 既可能让缺失章节假通过、也可能提前截断真章节造成假失败(Codex sections-r2 P2-1)。
 * 🔴 headingBlocks 与 sectionBody **共用本函数**,避免两处解析规则漂移。
 */
function parseHeadings(lines: string[]): HeadPos[] {
  const heads: HeadPos[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE_RE.exec(lines[i]);
    if (f) {
      const mark = f[1];
      // CommonMark:**只有反引号围栏**禁止 info string 含反引号;波浪线围栏的 info string 可以含 ~
      // (统一禁止会让 `~~~text a~b` 不被认作开栏 → 块内标题被当真章节,其后的闭栏又被当开栏,连锁吞掉后文)
      if (fence === null) { if (mark[0] !== "`" || !f[2].includes("`")) fence = mark; continue; }
      if (mark[0] === fence[0] && mark.length >= fence.length && !f[2].trim()) { fence = null; continue; }
      continue;
    }
    if (fence !== null) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m) heads.push({ i, level: m[1].length, title: m[2].trim() });
  }
  return heads;
}

/** 把报告切成"标题 → 该标题下的正文"(到下一个同级或更高级标题为止) */
export function headingBlocks(report: string): HeadingBlock[] {
  const lines = report.split("\n");
  const heads = parseHeadings(lines);
  return heads.map((h, k) => {
    let end = lines.length;
    for (let j = k + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].i; break; }
    return { level: h.level, title: h.title, body: lines.slice(h.i + 1, end).join("\n"), line: h.i + 1 };
  });
}

/**
 * 一个标题算不算某个要求章节:规范形包含该章节名,**且不同时包含别的要求章节名**。
 * 后半句防的是合并标题 —— 「市场声音、海外头条与招聘信号」若放行,三个要求会被一个含糊章节一次性满足,
 * 逐 topic 的护栏也就无从核验(Codex sections-r1 P2-1;ht27 真实出现过「市场、头条与招聘线索」这种合并)。
 */
function headingMatches(title: string, section: string, allSections: string[]): boolean {
  const h = normalizeHeading(title);
  if (!h.includes(normalizeHeading(section))) return false;
  return !allSections.some((o) => o !== section && h.includes(normalizeHeading(o)));
}

/** 报告里缺了哪些要求的扩展章节(容忍分隔符、空白与标题级别差异;不容忍合并改名) */
export function missingExtraSections(report: string, sections: string[]): string[] {
  const blocks = headingBlocks(report);
  return sections.filter((s) => !blocks.some((b) => headingMatches(b.title, s, sections)));
}

/**
 * 某个要求章节的正文:从它的标题起,到**下一个同级或更高级标题**、或**下一个属于别的要求章节的标题**为止
 * (无论那个标题是几级)。后者防的是"空壳 ## 市场声音 后面跟着 ### 招聘信号,招聘信号的 id 被算进市场声音"
 * (Codex sections-r1 P2-2)。
 */
function sectionBody(report: string, section: string, allSections: string[]): string {
  const lines = report.split("\n");
  const heads = parseHeadings(lines);
  const out: string[] = [];
  heads.forEach((h, k) => {
    if (!headingMatches(h.title, section, allSections)) return;
    let end = lines.length;
    for (let j = k + 1; j < heads.length; j++) {
      const other = allSections.some((o) => o !== section && headingMatches(heads[j].title, o, allSections));
      if (heads[j].level <= h.level || other) { end = heads[j].i; break; }
    }
    out.push(lines.slice(h.i + 1, end).join("\n"));
  });
  return out.join("\n");
}

/** 文本里出现的证据 / 计算 id(整 token 提取,避免 ev-abc123 被 ev-abc1234 假匹配;Codex sections-r1 P2-3) */
export function citedIds(text: string): Set<string> {
  // 两端加标识符边界:否则 `ev-abc123xyz` 会截出合法前缀 `ev-abc123` 造成假通过(Codex sections-r2 P2-2)
  return new Set((text.match(/(?<![0-9A-Za-z_-])(?:ev|calc)-[0-9a-f]+(?![0-9A-Za-z_-])/g) ?? []));
}

/**
 * 校验:① 有专属章节的 topic —— 章节标题在场,且**每个 topic 各自**至少引到一条自己的证据(引用要落在这一节正文里);
 *      ② 无专属章节 / 未知 topic —— 证据在报告**全文**里至少引到一条。
 * 都不对结论提任何要求。某 topic 一条证据都没有(schema 要求 ≥1,理论情形)时跳过它,不制造无法满足的要求。
 */
export function extraSectionErrors(report: string, req: ExtraRequirements): string[] {
  const errors: string[] = [];
  const names = req.sections.map((r) => r.section);
  const miss = missingExtraSections(report, names);
  const all = citedIds(report);
  for (const r of req.sections) {
    if (miss.includes(r.section)) {
      errors.push(`report.md 缺少扩展章节「${r.section}」(risk 阶段有 topic ${r.topics.map((t) => t.topic).join(" / ")},共 ${r.evidenceIds.length} 条证据);章节内可如实写明局限,但不得整章省略,也不得与别的扩展章节合并成一个标题`);
      continue;
    }
    const cited = citedIds(sectionBody(report, r.section, names));
    for (const t of r.topics) {
      if (!t.evidenceIds.length) continue;
      if (!t.evidenceIds.some((id) => cited.has(id))) {
        errors.push(`report.md 的「${r.section}」章节没有引用 topic「${t.topic}」的任何证据 id(应引其中之一:${t.evidenceIds.slice(0, 3).join(" / ")})`);
      }
    }
  }
  for (const t of req.unsectioned) {
    if (!t.evidenceIds.length) continue;
    if (!t.evidenceIds.some((id) => all.has(id))) {
      errors.push(`report.md 全文没有引用 topic「${t.topic}」的任何证据 id(该议题无专属章节,内容应并入${mergeHint(t.topic)};应引其中之一:${t.evidenceIds.slice(0, 3).join(" / ")})`);
    }
  }
  return errors;
}

/**
 * 注入报告提示词的短清单。**不重复各章节的写法要求**(那些在 EXT_GUIDE 里),
 * 只把"这次到底要写哪几章、每章必须引谁的证据"从条件判断变成一份点名清单 ——
 * 这正是 agent 在长提示词里丢掉的那一步。
 */
export function extraSectionsPromptBlock(riskStageOutput: unknown): string {
  const req = requiredExtraSections(riskStageOutput);
  if (!req.sections.length && !req.unsectioned.length) return "";
  // 🔴 某 topic 一条有效证据都没有时(risk 产物损坏 / 旧版数据),校验器会跳过它 ——
  //    提示词也**绝不能**要求"至少引 1 条",那是无法满足的指令,会直接诱导编造 id(Codex sections-r2 P1)。
  const demand = (t: TopicRequirement) => (t.evidenceIds.length
    ? `${t.topic} 至少引 1 条(如 ${t.evidenceIds.slice(0, 2).join(" / ")})`
    : `${t.topic} **没有有效证据 id,不得编造**,只如实写明证据缺失`);
  const secLines = req.sections.map((r) => `   - ## ${r.section} —— ${r.topics.map(demand).join(";")}`);
  const unsecLines = req.unsectioned.map((t) => `   - topic「${t.topic}」无专属章节,内容并入${mergeHint(t.topic)}:${demand(t)}`);
  const n = req.sections.length;
  return `\n【本次必须写出的扩展章节 —— 逐个核对,一个都不能省】risk 阶段已就以下主题落了证据,报告**必须**为每个有专属章节的主题写出对应章节(写法见上面各章节的要求,位置在${placement()}):\n${[...secLines, ...unsecLines].join("\n")}\n   ⚠️ 每个标题**单独成章、不得与别的扩展章节合并**(如"市场、头条与招聘线索"这种合并写法不算数);章节内容可以如实写明数据不足或局限,**但不得整章省略**;写完后请自查这 ${n} 个章节标题是否都在报告里、每个**有有效证据 id 的** topic 是否都至少引了一条,**没有有效 id 的 topic 是否如实说明了证据缺失(不得编造 id)**。`;
}
