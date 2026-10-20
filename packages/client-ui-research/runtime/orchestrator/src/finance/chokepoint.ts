/**
 * 卡口事件分类器(确定性,不拉新数据):risk 阶段取数后扫描公司自己的公告 / 新闻信封,按 datasources/chokepoint_keywords.json
 * 打类别(涨价 / 扩产 / 减产停产 / 订单合同 / 认证导入 / 收购合资 / 供需 / 管制制裁),每条命中引用原证据 id,写 fetch/_chokepoints.json
 * (编排器产物,受保护)。提示词把命中清单与 decision_hint 注入 risk / report 阶段 → topic「卡口事件」/ 报告「## 卡口事件」,直接喂裁决点。
 * 移植自 Vibe-Trading-Simon 资讯中心事件雷达的 CHOKE_KW 筛子(2026-08-23)。
 */
import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists, writeJson } from "../fsutil.ts";

export interface ChokeCategory { keywords: string[]; negatives?: string[]; decision_hint: string }
export interface ChokeTable { scan_fields: string[]; categories: Record<string, ChokeCategory> }
export interface ChokeHit { id: string; script: string; field: string; date: string; title: string; categories: string[]; link: string | null; duplicates: string[] }
export interface ChokeFile { scanned: number; hits: ChokeHit[]; by_category: Record<string, number>; hints: Record<string, string>; scripts: string[] }

export const CHOKE_TABLE_REL = path.join("datasources", "chokepoint_keywords.json");
export const CHOKE_FILE_REL = path.join("fetch", "_chokepoints.json");
/** 扫描哪些取数脚本的信封(公司自己的公告 / 新闻;互动易是提问不是事件,不扫) */
export const CHOKE_SCRIPTS = ["fetch_announcements", "cninfo_announcements", "exchange_announcements", "em_stock_news", "sec_fulltext_search", "yahoo_news"];

export function loadChokeTable(repoRoot: string): ChokeTable {
  const p = path.join(repoRoot, CHOKE_TABLE_REL);
  if (!fs.existsSync(p)) throw new Error(`卡口事件分类表缺失:${p}`);
  let t: ChokeTable;
  try { t = JSON.parse(fs.readFileSync(p, "utf8")) as ChokeTable; } catch (e) { throw new Error(`卡口事件分类表不是合法 JSON:${e instanceof Error ? e.message : String(e)}`); }
  const strs = (a: unknown, allowEmpty = false) => Array.isArray(a) && (allowEmpty || a.length > 0) && a.every((x) => typeof x === "string" && x.trim().length > 0) && new Set((a as string[]).map((x) => x.trim())).size === a.length;
  if (!t || typeof t !== "object" || Array.isArray(t) || !strs(t.scan_fields) || !t.categories || typeof t.categories !== "object" || Array.isArray(t.categories) || !Object.keys(t.categories).length) throw new Error("卡口事件分类表结构非法(需非空 scan_fields[] 与非空 categories 对象)");
  for (const [k, v] of Object.entries(t.categories)) {
    if (!v || typeof v !== "object" || !strs(v.keywords) || typeof v.decision_hint !== "string" || !v.decision_hint.trim()) throw new Error(`卡口事件类别 ${k} 结构非法(需非空、不重复、无空白的 keywords[] / decision_hint)`);
    if (v.negatives !== undefined && !strs(v.negatives, true)) throw new Error(`卡口事件类别 ${k} 的 negatives 非法(须为无空白、不重复的字符串数组)`);
    for (const kw of v.keywords) if (kw.startsWith("re:")) { try { new RegExp(kw.slice(3)); } catch { throw new Error(`卡口事件类别 ${k} 的正则关键词非法:${kw}`); } }
  }
  return t;
}

/** 关键词命中:`re:` 前缀 = 正则;纯 ASCII = 词边界;中文 = 子串 */
export function kwHit(text: string, kw: string): boolean {
  if (kw.startsWith("re:")) return new RegExp(kw.slice(3), "i").test(text);
  const t = text.toLowerCase(), k = kw.toLowerCase();
  if (/^[a-z0-9 .\-]+$/i.test(kw)) return new RegExp(`(?<![a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i").test(t);
  return t.includes(k);
}

/** 标题拆子句(; ； , ， 。 |;顿号与括号**不**切——它们通常在同一事项内,切开会让 negatives 脱离修饰对象):keywords / negatives 在同一子句内判定,
 *  "A 提价,B 承诺不涨价"仍命中涨价;"关于终止(部分)扩产项目"不命中扩产(保守漏判可接受,误判不可——Codex choke-r3) */
export function splitClauses(text: string): string[] {
  return text.split(/[;；,，。|]+/).map((x) => x.trim()).filter(Boolean);
}
/** 明确的"新动作"标记:子句里有 negatives 时,只有 negative 之后出现新动作词、且新动作词之后还有关键词才放行
 *  ("终止原扩产方案、启动新扩产" 放行;"已启动终止扩产项目的审议程序" 不放行 —— Codex choke-r4) */
const NEW_ACTION_RE = /(启动|重启|新增|新建|另行|重新)/;
function lastIndexOfAny(text: string, words: string[]): number {
  let best = -1;
  for (const w of words) {
    if (w.startsWith("re:")) { const m = new RegExp(w.slice(3), "gi"); let mm; while ((mm = m.exec(text))) best = Math.max(best, mm.index + mm[0].length); }
    else { const i = text.toLowerCase().lastIndexOf(w.toLowerCase()); if (i >= 0) best = Math.max(best, i + w.length); }
  }
  return best;
}
function newActionAllows(clause: string, def: ChokeCategory): boolean {
  const negEnd = lastIndexOfAny(clause, def.negatives ?? []);
  if (negEnd < 0) return false;
  const after = clause.slice(negEnd);
  const na = NEW_ACTION_RE.exec(after);
  if (!na) return false;
  const tail = after.slice(na.index + na[0].length);
  return def.keywords.some((k) => kwHit(tail, k));
}

/** 一段文本命中的类别:任一子句命中 keywords 且该子句无 negatives */
export function classifyText(text: string, table: ChokeTable): string[] {
  const clauses = splitClauses(text);
  const out: string[] = [];
  for (const [cat, def] of Object.entries(table.categories)) {
    const hit = clauses.some((c) => def.keywords.some((k) => kwHit(c, k)) && (!(def.negatives ?? []).some((n) => kwHit(c, n)) || newActionAllows(c, def)));
    if (hit) out.push(cat);
  }
  return out;
}

interface EvLite { id: string; field: string; value: unknown; period?: string; note?: string; as_of?: string }
function linkOfNote(note: unknown): string | null {
  const m = /(?:^|;|\s)(?:url|link)=(https?:\/\/[^;\s|]+)/.exec(String(note ?? "")) ?? /(https?:\/\/[^;\s|]+)/.exec(String(note ?? ""));
  return m ? m[1] : null;
}
/** 去重键:只剥"公司简称:"这种前缀(后面紧跟 关于 / 公告 / H股 / 第 / 年份,且前缀本身不含任何类别语义——"涨价:关于…"不剥),再去标点与空白 */
export function normTitle(s: string, table: ChokeTable): string {
  const m = /^([^：:]{2,12})[：:]\s*(?=关于|公告|H股|第|20\d\d)/.exec(s);
  const stripped = m && !classifyText(m[1], table).length ? s.slice(m[0].length) : s;
  return stripped.replace(/[\s，,。．.、:：;；()（）【】\[\]《》"'“”‘’·\-—]/g, "").toLowerCase();
}

/** 扫描运行目录里已落盘的信封 → 命中清单(同题跨脚本去重:保留首条,其余 id 记进 duplicates,**类别取并集**) */
export function scanChokepoints(runDir: string, table: ChokeTable): ChokeFile {
  const hits: ChokeHit[] = [];
  const seen = new Map<string, ChokeHit>();
  let scanned = 0;
  const scripts: string[] = [];
  for (const script of CHOKE_SCRIPTS) {
    const env = readJsonIfExists<{ evidence?: EvLite[] }>(path.join(runDir, "fetch", `${script}.json`));
    if (!env || !Array.isArray(env.evidence)) continue;
    scripts.push(script);
    for (const e of env.evidence) {
      if (!table.scan_fields.includes(String(e.field)) || typeof e.value !== "string") continue;
      scanned++;
      const cats = classifyText(e.value, table);
      if (!cats.length) continue;
      const key = normTitle(e.value, table);
      const prev = seen.get(key);
      if (prev) { prev.duplicates.push(e.id); for (const c of cats) if (!prev.categories.includes(c)) prev.categories.push(c); continue; }
      const h: ChokeHit = { id: e.id, script, field: String(e.field), date: String(e.period ?? e.as_of ?? ""), title: e.value.slice(0, 200), categories: cats, link: linkOfNote(e.note), duplicates: [] };
      seen.set(key, h);
      hits.push(h);
    }
  }
  hits.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const by_category: Record<string, number> = {};
  for (const h of hits) for (const c of h.categories) by_category[c] = (by_category[c] ?? 0) + 1;
  return { scanned, hits, by_category, hints: Object.fromEntries(Object.entries(table.categories).map(([k, v]) => [k, v.decision_hint])), scripts };
}

export const PROMPT_MAX_HITS = 40;
/** 提示词展示子集:每个类别至少保底 1 条(最新的),再按日期倒序填满 40;返回 {shown, omitted} */
export function selectForPrompt(hits: ChokeHit[], max = PROMPT_MAX_HITS): { shown: ChokeHit[]; omitted: number } {
  if (hits.length <= max) return { shown: hits, omitted: 0 };
  const chosen = new Set<string>();
  for (const h of hits) if (h.categories.some((c) => ![...chosen].some((id) => hits.find((x) => x.id === id)!.categories.includes(c)))) chosen.add(h.id);
  for (const h of hits) { if (chosen.size >= max) break; chosen.add(h.id); }
  const shown = hits.filter((h) => chosen.has(h.id)).slice(0, max);
  return { shown, omitted: hits.length - shown.length };
}

export function writeChokeFile(runDir: string, file: ChokeFile): void {
  fs.mkdirSync(path.join(runDir, "fetch"), { recursive: true });
  writeJson(path.join(runDir, CHOKE_FILE_REL), file);
}
export function readChokeFile(runDir: string): ChokeFile | null {
  return readJsonIfExists<ChokeFile>(path.join(runDir, CHOKE_FILE_REL));
}

/** 提示词块:命中清单(每条 日期 · 类别 · 标题 [ev-id])+ 各类别的裁决提示;无命中也要告诉 agent"扫过了,零命中" */
export function chokePromptBlock(runDir: string): string {
  const f = readChokeFile(runDir);
  if (!f) return "";
  if (!f.hits.length) return `\n【卡口事件(确定性分类)】已扫描 ${f.scanned} 条公告 / 新闻标题(${f.scripts.join(" / ")}),**零命中**——报告不写「## 卡口事件」章节,也不要把别的证据写成卡口事件。`;
  const { shown, omitted } = selectForPrompt(f.hits);
  const lines = shown.map((h) => `   - ${h.date} · ${h.categories.join("/")} · ${h.title} [${h.id}]${h.duplicates.length ? `(同题重复:${h.duplicates.join(" ")})` : ""}`);
  const hints = Object.entries(f.by_category).map(([c, n]) => `   - ${c}(${n} 条):${f.hints[c]}`);
  const trunc = omitted ? `(清单共 ${f.hits.length} 条,这里展示 ${shown.length} 条、省略 ${omitted} 条——每个类别已保底展示最新一条;全量在 fetch/_chokepoints.json)` : "";
  return `\n【卡口事件(确定性分类,已扫描 ${f.scanned} 条标题)${trunc}】只能引用下面清单里的 id,不得把清单外的证据写成卡口事件,也不得改写标题里的数字:\n${lines.join("\n")}\n   各类别的裁决提示:\n${hints.join("\n")}\n   写法:risk 阶段 extra_findings(topic "卡口事件",按类别各一条,summary 只写"日期 · 类别 · 标题原文 [ev-id] → 对裁决点的含义",**标题里的数字照抄不换算**);报告「## 卡口事件」每条一行同格式,末尾一句该事件对应哪个裁决点 / 扳机(带 id)。送样 ≠ 订单、"被建议列入" ≠ "已列入",判定从严。`;
}
