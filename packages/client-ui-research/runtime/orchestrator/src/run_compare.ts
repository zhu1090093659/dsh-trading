/**
 * 研究对比:同一对象的几次研究(多半是换了一家 Agent 再跑),把**研究过程的质量**并排摆出来。
 *
 * 🔴 只比过程,不比结论对错;不出总分、不排名次 —— 每一项各自是一个事实。
 * 🔴 读不到的一律给 null(界面显示「—」),**不给 0**:0 会被读成「一条都没有」,而真相是「不知道」。
 *    开跑时清单里先放的空占位(冲突、红线、取数账本)也一样:没写到真值就是不知道。
 * 🔴 只读:不改运行目录里的任何东西,也不重新跑校验。只读普通文件:符号链接、命名管道一律当读不到
 *    (对命名管道读取会一直卡住,把整个接口拖死)。检查和读取之间被换掉的情况不管 ——
 *    能在那一瞬间换文件的人,本来也能直接改清单。
 */
import fs from "node:fs";
import path from "node:path";

import { listFiles, readJsonIfExists } from "./fsutil.ts";
import { loadCalcs } from "./merge.ts";
import { checkNumberFidelity, quotedHistory } from "./number_fidelity.ts";
import { currentPlugin } from "./plugin.ts";
import { loadRun } from "./validator.ts";

export interface RunMetrics {
  run_id: string;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** 跑这次研究的 Agent:来源名、CLI 自报的版本、模型(本机订阅 CLI 多半不回报模型) */
  engine: { provider: string | null; version: string | null; model: string | null };
  /** 取数范围(全量 / 核心):范围不同,证据数量不能直接比 */
  endpoint_scope: string | null;
  /** 开始到结束的总用时(含取数) */
  duration_s: number | null;
  /** Agent 自己干活的时间(各阶段每一轮相加) */
  agent_s: number | null;
  /** 资料齐全的阶段(状态 complete:必需的数据和计算都在)/ 这次要跑的阶段(清单里的执行范围,中途停下时没跑到的也算)。
   *  其余是资料不完整、跳过、失败或没跑到 */
  stages: { complete: number; total: number } | null;
  /** 第一次交上来就过了校验的阶段 / 跑过校验的阶段 */
  first_pass: { passed: number; total: number } | null;
  /** 报告里**引了证据或计算编号的那些行**上的数字:对得上的 / 核对了的(没引编号的行不核对,不进分母) */
  numbers: { exact: number; total: number } | null;
  /** 取到的证据条数 / 各阶段实际引用的(去重、且确实存在的) */
  evidence: { fetched: number | null; cited: number | null };
  /** 各阶段引用的计算 / 本次全部计算 */
  calcs: { cited: number | null; total: number | null };
  /** 各阶段自己写出的缺口条数 */
  gaps: number | null;
  /** 跨来源对不上的证据 */
  conflicts: number | null;
  /** 产出红线命中 */
  gate_hits: number | null;
  /** 收尾时被拦回去补做的次数 */
  stop_blocks: number | null;
  /** 取数脚本:成功 / 只取到一部分 / 失败(含超时、出错) */
  fetch: { ok: number; partial: number; failed: number } | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const len = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);
const STAGE_NAME = /^[a-z][a-z0-9_]*$/;

/** 是普通文件,或者不存在。符号链接、命名管道、目录都不算 */
function absentOrPlain(p: string): boolean {
  try { return fs.lstatSync(p).isFile(); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
}
/** 目录不存在,或者它本身不是链接、里面每一项都是普通文件(点开头的不读,不管) */
function plainDir(d: string): boolean {
  let st: fs.Stats;
  try { st = fs.lstatSync(d); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
  if (!st.isDirectory()) return false;
  try { return fs.readdirSync(d).every((n) => n.startsWith(".") || absentOrPlain(path.join(d, n))); } catch { return false; }
}

/**
 * 取数 / 计算文件是不是**完整**:开跑时一定建好 fetch/ 与 calcs/ 两个目录,所以目录不在 = 丢了(恢复备份漏拷之类);
 * 取数文件每个都要读得出,账本里记过的每个文件都要在;计算文件每个都要读得出。
 * 少一样,数出来的就是「剩下的那些」,不能当成全部(Codex 审计 2026-10-09 A9)。
 */
function fetchAndCalcsWhole(runDir: string, m: Obj | null): boolean {
  const isDir = (d: string) => { try { return fs.lstatSync(d).isDirectory(); } catch { return false; } };
  const fetchDir = path.join(runDir, "fetch"), calcDir = path.join(runDir, "calcs");
  if (!isDir(fetchDir) || !isDir(calcDir)) return false;
  const fetchFiles = listFiles(fetchDir, ".json").filter((f) => !path.basename(f).startsWith("_"));
  if (!fetchFiles.every((f) => typeof obj(readJsonIfExists(f))?.script === "string")) return false;
  for (const [key, entry] of Object.entries(obj(m?.fetch_ledger) ?? {})) {
    const e = obj(entry);
    // 🔴 生产清单里的账本摘要**不带 file**,只带 sha256(见 fetchrun.ledgerSummary):有 sha256 = 当时写出了
    //    fetch/<脚本名>.json。以前只认 file 字段,生产路径上这条检查从来不执行(审计第二轮 A9)
    const file = str(e?.file) ?? (str(e?.sha256) && /^[A-Za-z0-9_.-]+$/.test(key) ? `fetch/${key}.json` : null);
    if (file && !fs.existsSync(path.join(runDir, file))) return false;
  }
  const calcs = loadCalcs(runDir);
  if (!calcs.every((c) => c.record !== null)) return false;
  // 计算文件删掉几个(目录还在)、甚至删光,剩下的照样「每个都读得出」。收尾时写下的合并产物
  // calculations.json 与清单里的 calculation_count 是当时的全集,拿它们对(审计第二轮 A9)
  const have = new Set(calcs.map((c) => str(obj(c.record)?.calculation_id)));
  const mergedPath = path.join(runDir, "calculations.json");
  if (!absentOrPlain(mergedPath)) return false;
  const merged = readJsonIfExists(mergedPath);
  if (Array.isArray(merged) && !merged.every((c) => { const id = str(obj(c)?.calculation_id); return id === null || have.has(id); })) return false;
  const count = int(m?.calculation_count);
  return count === null || calcs.length >= count;
}

function seconds(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const s = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isFinite(s) && s >= 0 ? Math.round(s) : null;
}

/** 各阶段每一轮的 duration_ms 相加;一轮都没记到就是 null(不是 0 秒) */
function agentSeconds(runDir: string): number | null {
  const p = path.join(runDir, "events.jsonl");
  let text: string;
  try { if (!fs.lstatSync(p).isFile()) return null; text = fs.readFileSync(p, "utf8"); } catch { return null; }
  let ms = 0, seen = 0;
  for (const line of text.split("\n")) {
    if (!line.includes("turn_end")) continue;
    try {
      const e = JSON.parse(line) as Obj;
      if (typeof e.type === "string" && e.type.endsWith(".turn_end") && typeof e.duration_ms === "number" && e.duration_ms >= 0) { ms += e.duration_ms; seen += 1; }
    } catch { /* 半行 / 坏行跳过 */ }
  }
  return seen ? Math.round(ms / 1000) : null;
}

function stagesOf(m: Obj | null): Obj[] | null {
  return Array.isArray(m?.stages) ? (m.stages as unknown[]).map(obj).filter((s): s is Obj => !!s) : null;
}

/** 一次研究的各项指标。运行目录读不出来的部分给 null,其余照常给 */
export function runMetrics(runDir: string): RunMetrics {
  const mp = path.join(runDir, "manifest.json");
  const manifestPlain = absentOrPlain(mp);
  const m = manifestPlain ? obj(readJsonIfExists(mp)) : null;
  const provider = obj(m?.provider);
  const stages = stagesOf(m);
  const started = str(m?.started_at), finished = str(m?.finished_at);

  // 阶段:资料齐全数 / 这次要跑的数;首轮过校验 = 只交了一次、且校验通过。
  // 清单里的阶段记录是跑一个记一个,中途停下的只有跑到的那几个 —— 拿它当分母会把「停在第 3 个」算成「3 个全齐」,
  // 所以分母用开跑时写下的执行范围
  const scope = Array.isArray(m?.execution_scope) && (m.execution_scope as unknown[]).every((s) => typeof s === "string") ? (m.execution_scope as string[]).length : 0;
  const stagesDone = stages ? { complete: stages.filter((s) => s.status === "complete").length, total: Math.max(stages.length, scope) } : null;
  const tried = stages?.filter((s) => int(s.attempts) !== null && (s.attempts as number) >= 1) ?? [];
  const firstPass = tried.length ? { passed: tried.filter((s) => s.attempts === 1 && s.validator_ok === true).length, total: tried.length } : null;

  // 取数账本:超时、出错也算失败;认不出的状态不归到任何一类。账本是空的(还没取过数就停了)给 null
  const fl = Object.values(obj(m?.fetch_ledger) ?? {});
  let fetchCounts: RunMetrics["fetch"] = null;
  if (fl.length) {
    fetchCounts = { ok: 0, partial: 0, failed: 0 };
    for (const f of fl) {
      const st = obj(f)?.status;
      if (st === "ok" || st === "partial") fetchCounts[st] += 1;
      else if (st === "failed" || st === "timeout" || st === "error") fetchCounts.failed += 1;
    }
  }

  // 证据 / 计算 / 缺口 / 报告数字:要把运行读进来。读不出来(目录残缺)时这几项给 null
  let evidence: RunMetrics["evidence"] = { fetched: null, cited: null };
  let calcs: RunMetrics["calcs"] = { cited: null, total: null };
  let gaps: number | null = null;
  let numbers: RunMetrics["numbers"] = null;
  // 要读的文件里有链接 / 命名管道:整块不读
  const plain = manifestPlain && absentOrPlain(path.join(runDir, "report.md")) && ["stages", "fetch", "calcs"].every((d) => plainDir(path.join(runDir, d)));
  if (plain) try {
    const run = loadRun(runDir);
    const raw = stages?.map((s) => s.stage) ?? [];
    const names = raw.filter((s): s is string => typeof s === "string" && STAGE_NAME.test(s));
    // 没有文件的阶段 = 没跑到(失败的运行),不数;**有文件却读不出来**(或者阶段名不像阶段名,找不到它的文件)
    // 就不知道它引了什么、写了几条缺口,只数其余阶段会少算,所以这几项整体给 null
    const unreadable = names.length !== raw.length || names.some((s) => fs.existsSync(path.join(runDir, "stages", `${s}.json`)) && !obj(run.stage(s as never)));
    const outs = unreadable ? [] : names.map((s) => obj(run.stage(s as never))).filter((o): o is Obj => !!o);
    // 某个阶段的这一栏不是列表 = 数不出来,同理整栏给 null
    const listed = (field: string) => outs.length > 0 && outs.every((o) => Array.isArray(o[field]));
    const ids = (field: string, has: Set<string>) => {
      if (!listed(field)) return null;
      const set = new Set<string>();
      for (const o of outs) for (const id of o[field] as unknown[]) if (typeof id === "string" && has.has(id)) set.add(id);
      return set.size;
    };
    // 取数 / 计算文件不完整:证据、计算、报告数字三项都只数得到剩下的那部分 → 给 null;缺口条数照常
    const whole = fetchAndCalcsWhole(runDir, m);
    if (whole) {
      evidence = { fetched: run.evidenceIds.size, cited: ids("evidence_ids", run.evidenceIds) };
      calcs = { cited: ids("calculation_ids", run.calcIds), total: run.calcIds.size };
    }
    gaps = listed("gaps") ? outs.reduce((n, o) => n + (o.gaps as unknown[]).length, 0) : null;
    if (run.report && whole) {
      const symbol = str(m?.symbol) ?? undefined;
      const fid = checkNumberFidelity(run.report, run.evidence as never, run.calcById as never, symbol,
        quotedHistory((st) => run.stage(st as never) as never), currentPlugin().lexicon, currentPlugin().fidelityExcludedSections);
      numbers = { exact: fid.exact, total: fid.total };
    }
  } catch { /* 残缺的运行:上面几项保持 null */ }

  // 冲突和红线是收尾时才写进清单的(开跑时先放空占位);收尾时一定同时写下 quote_decision 这一项(值可以是 null)。
  // 没有它 = 没收尾(取消、崩溃),这两项不知道 —— 不能把占位的空列表当成「0 条」
  const finalized = !!m && Object.prototype.hasOwnProperty.call(m, "quote_decision");

  return {
    run_id: str(m?.run_id) ?? path.basename(runDir),
    status: str(m?.status),
    started_at: started,
    finished_at: finished,
    engine: { provider: str(provider?.name), version: str(m?.engine_version), model: str(m?.model) },
    endpoint_scope: str(m?.endpoint_scope),
    duration_s: seconds(started, finished),
    agent_s: agentSeconds(runDir),
    stages: stagesDone,
    first_pass: firstPass,
    numbers,
    evidence,
    calcs,
    gaps,
    conflicts: finalized ? len(m?.evidence_conflicts) : null,
    gate_hits: finalized ? len(obj(m?.gate)?.hits) : null,
    stop_blocks: int(obj(m?.stop_guard)?.blocks),
    fetch: fetchCounts,
  };
}
