/**
 * 产业温度计(注册表第 13 层)的挂载:端点带 `industry_tags`,只在研究标的命中对应产业标签时才真的去取。
 * 判定依据 = profile 阶段已拉到的行业 / 概念归属(fetch_profile.industry_em / industry_csrc、sw_industry 代码、
 * em_concept_blocks.board_membership)对 `datasources/industry_tags.json` 的 keywords / sw_prefixes 做匹配。
 * 没命中任何标签 = 不相关(不是故障),带标签的端点整体跳过并记事件;结果写 `fetch/_industry.json`(编排器产物,受保护),
 * risk / report 阶段的提示词据此注入该标签的读法护栏。
 */
import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists, writeJson } from "../fsutil.ts";
import type { EndpointDef } from "../registry.ts";

export interface IndustryTagDef { title: string; strong_keywords: string[]; weak_keywords?: string[]; sw_prefixes?: string[]; thermometers: string[]; guard: string }
export interface IndustryTable { tags: Record<string, IndustryTagDef> }
export interface IndustryDetection { tags: string[]; matched: Record<string, string[]>; signals: number }
export interface IndustryGate { included: string[]; skipped: { id: string; tags: string[] }[] }
export interface IndustryFile { tags: string[]; matched: Record<string, string[]>; titles: Record<string, string>; guards: Record<string, string>; thermometers: Record<string, string[]>; skipped: string[]; signals: number }

export const INDUSTRY_TAGS_REL = path.join("datasources", "industry_tags.json");
export const INDUSTRY_FILE_REL = path.join("fetch", "_industry.json");

/** 标签表缺失 / 损坏 = 配置错误,直接抛(不能当"零标签"静默跳过全部温度计 —— Codex industry-r2) */
export function loadIndustryTags(repoRoot: string): IndustryTable {
  const p = path.join(repoRoot, INDUSTRY_TAGS_REL);
  if (!fs.existsSync(p)) throw new Error(`产业标签表缺失:${p}(第 13 层温度计无法门控)`);
  let t: IndustryTable;
  try { t = JSON.parse(fs.readFileSync(p, "utf8")) as IndustryTable; } catch (e) { throw new Error(`产业标签表不是合法 JSON:${p}:${e instanceof Error ? e.message : String(e)}`); }
  // 数组 / null / 空对象都不算合法标签表(`{"tags":[]}` 的 typeof 也是 "object",会被当零标签静默跳过 —— Codex industry-r3)
  if (!t || typeof t !== "object" || Array.isArray(t) || !t.tags || typeof t.tags !== "object" || Array.isArray(t.tags) || !Object.keys(t.tags).length) throw new Error(`产业标签表结构非法(需非空 tags 对象):${p}`);
  const strs = (a: unknown) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === "string" && x.trim().length > 0);
  for (const [k, v] of Object.entries(t.tags)) {
    if (!v || typeof v !== "object" || !strs(v.strong_keywords) || !strs(v.thermometers) || typeof v.guard !== "string" || !v.guard.trim()) throw new Error(`industry_tags.json 标签 ${k} 结构非法(需非空 strong_keywords[] / thermometers[] / guard)`);
    if (v.weak_keywords !== undefined && !(Array.isArray(v.weak_keywords) && v.weak_keywords.every((x) => typeof x === "string"))) throw new Error(`industry_tags.json 标签 ${k} 的 weak_keywords 非法`);
    if (v.sw_prefixes !== undefined && !(Array.isArray(v.sw_prefixes) && v.sw_prefixes.every((x) => typeof x === "string"))) throw new Error(`industry_tags.json 标签 ${k} 的 sw_prefixes 非法`);
  }
  return t;
}

interface EvLite { field?: string; value?: unknown }
function evidenceOf(runDir: string, script: string): EvLite[] {
  const env = readJsonIfExists<{ evidence?: EvLite[] }>(path.join(runDir, "fetch", `${script}.json`));
  return Array.isArray(env?.evidence) ? env!.evidence! : [];
}

/** 从 profile 阶段产物收集行业信号:文本(行业名 / 概念名)与申万代码 */
export function industrySignals(runDir: string): { texts: string[]; swCodes: string[] } {
  const texts: string[] = [];
  const swCodes: string[] = [];
  for (const e of evidenceOf(runDir, "fetch_profile")) if ((e.field === "industry_em" || e.field === "industry_csrc") && typeof e.value === "string") texts.push(e.value);
  for (const e of evidenceOf(runDir, "sw_industry")) if (/^sw_(industry|l1|l2)_code$/.test(String(e.field)) && e.value != null) swCodes.push(String(e.value));
  for (const e of evidenceOf(runDir, "em_concept_blocks")) if (e.field === "board_membership" && typeof e.value === "string") texts.push(e.value);
  return { texts, swCodes };
}

/** 纯 ASCII 关键词(GPU / CPO / PCB / IDC…)按词边界匹配,避免 "GPU" 撞 "GPUS"、"IDC" 撞别的缩写;中文按子串 */
export function keywordHit(text: string, kw: string): boolean {
  const t = text.toLowerCase(), k = kw.toLowerCase();
  if (/^[a-z0-9 ]+$/i.test(kw)) return new RegExp(`(?<![a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i").test(t);
  return t.includes(k);
}

/** 命中规则:任一强关键词;或(任一弱关键词 且 申万代码命中前缀)。"通信设备"这种宽泛行业词单独不挂整套温度计(Codex industry-r1) */
export function detectIndustryTags(runDir: string, table: IndustryTable): IndustryDetection {
  const { texts, swCodes } = industrySignals(runDir);
  const matched: Record<string, string[]> = {};
  for (const [tag, def] of Object.entries(table.tags)) {
    const strong = new Set<string>(), weak = new Set<string>(), sw = new Set<string>();
    for (const kw of def.strong_keywords) for (const t of texts) if (keywordHit(t, kw)) strong.add(`${kw}←${t}`);
    for (const kw of def.weak_keywords ?? []) for (const t of texts) if (keywordHit(t, kw)) weak.add(`弱:${kw}←${t}`);
    for (const pre of def.sw_prefixes ?? []) for (const c of swCodes) if (c.startsWith(pre)) sw.add(`sw:${pre}←${c}`);
    const hit = strong.size > 0 || (weak.size > 0 && sw.size > 0);
    if (hit) matched[tag] = [...strong, ...weak, ...sw].sort().slice(0, 12);
  }
  return { tags: Object.keys(matched).sort(), matched, signals: texts.length + swCodes.length };
}

/** 带 industry_tags 的端点:与命中标签有交集才保留;不带标签的端点原样保留 */
export function applyIndustryGate(scripts: string[], endpoints: Record<string, Pick<EndpointDef, "industry_tags">>, active: string[]): IndustryGate {
  const included: string[] = [];
  const skipped: { id: string; tags: string[] }[] = [];
  for (const id of scripts) {
    const tags = (endpoints[id]?.industry_tags as string[] | undefined) ?? [];
    if (!tags.length || tags.some((t) => active.includes(t))) included.push(id);
    else skipped.push({ id, tags });
  }
  return { included, skipped };
}

export function writeIndustryFile(runDir: string, table: IndustryTable, det: IndustryDetection, gate: IndustryGate): IndustryFile {
  const payload: IndustryFile = {
    tags: det.tags, matched: det.matched, signals: det.signals,
    titles: Object.fromEntries(det.tags.map((t) => [t, table.tags[t]?.title ?? t])),
    guards: Object.fromEntries(det.tags.map((t) => [t, table.tags[t]?.guard ?? ""])),
    thermometers: Object.fromEntries(det.tags.map((t) => [t, table.tags[t]?.thermometers ?? []])),
    skipped: gate.skipped.map((s) => s.id),
  };
  fs.mkdirSync(path.join(runDir, "fetch"), { recursive: true });
  writeJson(path.join(runDir, INDUSTRY_FILE_REL), payload);
  return payload;
}

export function readIndustryFile(runDir: string): IndustryFile | null {
  return readJsonIfExists<IndustryFile>(path.join(runDir, INDUSTRY_FILE_REL));
}

/** 确定性"下一个数据点"日期(第 15 层数据日历的规则部分,Codex 判定按同一规则复算):
 *  台股法定月营收每月 10 日前披露 → 最新资料期 M 的下一档 = M+1 月报,期限 = M+2 月 10 日;
 *  Kalshi 月度合约 → 合约月(record_key KXB200MS:YYYY-MM)结束后结算(具体结算时点以 Kalshi 规则为准,不造日期)。 */
/** 下一档法定期限按**今天**推(法定节律是日历驱动,不是数据驱动;Codex datacal-r1:按最新资料期推会把已过去的期限当"下一个数据点"):
 *  today ≤ 本月 10 日 → 期限 = 本月 10 日(数据月 = 上月);否则期限 = 下月 10 日(数据月 = 本月)。
 *  lagging = 最新资料期落后于"数据月 − 1"(中间有月份缺失,资料源滞后要出声,别把旧数当新)。 */
export function twNextDisclosure(latestPeriodStart: string, today: string): { data_month: string; deadline: string; lagging: boolean } | null {
  const m = /^(\d{4})-(\d{2})/.exec(latestPeriodStart);
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m || !t) return null;
  const ly = Number(m[1]), lm = Number(m[2]);
  const ty = Number(t[1]), tm = Number(t[2]), td = Number(t[3]);
  if (lm < 1 || lm > 12 || tm < 1 || tm > 12) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const ddl = td <= 10 ? { y: ty, m: tm } : tm === 12 ? { y: ty + 1, m: 1 } : { y: ty, m: tm + 1 };
  let dataM = ddl.m === 1 ? { y: ddl.y - 1, m: 12 } : { y: ddl.y, m: ddl.m - 1 };
  // lagging 按日历目标月判(中间月份缺失 = 资料源滞后);但"下一档"不能指向已拿到的数据月——
  // 月报常提前披露(Codex datacal-r2:9-05 手里已有 8 月数据时,下一档是 9 月月报、期限 10-10),与"最新资料期 + 1 月"取较晚者
  const lagging = ly * 12 + lm < dataM.y * 12 + dataM.m - 1;
  if (ly * 12 + lm >= dataM.y * 12 + dataM.m) dataM = lm === 12 ? { y: ly + 1, m: 1 } : { y: ly, m: lm + 1 };
  const ddlF = dataM.m === 12 ? { y: dataM.y + 1, m: 1 } : { y: dataM.y, m: dataM.m + 1 };
  return { data_month: `${dataM.y}-${pad(dataM.m)}`, deadline: `${ddlF.y}-${pad(ddlF.m)}-10`, lagging };
}

export function industryNextDateLines(runDir: string, today?: string): string[] {
  const lines: string[] = [];
  // 信封存在但损坏时这里静默跳过是可接受的:validateFetchIntegrity 会对每个 fetch/*.json 做解析 + sha 校验,损坏一定在阶段校验里出声(判定与提示词不重复报警)
  const tw = readJsonIfExists<{ evidence?: { field?: string; period?: string }[] }>(path.join(runDir, "fetch", "tw_monthly_revenue.json"));
  const periods = (tw?.evidence ?? []).filter((e) => e.field === "tw_monthly_revenue" && typeof e.period === "string").map((e) => String(e.period)).sort();
  const latest = periods[periods.length - 1];
  if (latest) {
    const n = twNextDisclosure(latest, today ?? new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10));
    if (n) lines.push(`台系月营收下一档:${n.data_month} 月报,法定 ${n.deadline} 前披露(台股月营收每月 10 日前;规则推算,非抓取)${n.lagging ? `;⚠️ 端点最新资料期仅到 ${latest.slice(0, 7)},中间月份缺失 = 资料源滞后,先补缺口再谈下一档` : ""}`);
  }
  const gpu = readJsonIfExists<{ evidence?: { field?: string; record_key?: string }[] }>(path.join(runDir, "fetch", "gpu_rent_thermometer.json"));
  const fwd = (gpu?.evidence ?? []).find((e) => e.field === "gpu_forward_p_below_lowest_strike" && /^KXB200MS:\d{4}-\d{2}$/.test(String(e.record_key)));
  if (fwd) lines.push(`Kalshi KXB200MS 合约月 ${String(fwd.record_key).split(":")[1]}:合约月结束后结算(具体结算时点以 Kalshi 规则为准);现货中位为日更`);
  return lines;
}

/** 提示词用:本次挂载的温度计与护栏(无标签 → 空串) */
export function industryPromptBlock(runDir: string): string {
  const f = readIndustryFile(runDir);
  if (!f || !f.tags.length) return "";
  const lines = f.tags.map((t) => `   - ${f.titles[t] ?? t}(tag=${t};端点:${(f.thermometers[t] ?? []).join(" / ")})。护栏:${f.guards[t] ?? ""}`);
  const nextDates = industryNextDateLines(runDir);
  const nd = nextDates.length ? `\n   【下一个数据点(规则推算)】${nextDates.join(";")}。写进 decision_points 的 next_data_point 时照抄日期并注明"法定披露期限 / 规则推算"。` : "";
  return `\n【本次挂载的产业温度计】研究标的命中产业标签 ${f.tags.join(", ")}(依据:${Object.values(f.matched).flat().slice(0, 6).join("、")})。\n${lines.join("\n")}${nd}\n   温度计是产业链上下游的硬数据,不是本公司的数据;写法:每个数字必须照抄证据 value 并带 [ev-id]、带资料期与来源,**护栏句必须与数字同段出现**;它们只用来印证或反证本报告的事实 / 估值,不得单独推出任何结论。`;
}
