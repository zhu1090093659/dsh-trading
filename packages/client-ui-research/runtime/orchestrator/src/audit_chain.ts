/**
 * **防篡改登记簿**(Core):研究运行和用户台账的内容指纹,串成一条只追加的链。
 *
 * 每条登记 = 某个对象这一刻的内容指纹 + 上一条登记的指纹 ⇒ 改掉、删掉、插进中间任何一条,
 * 后面就接不上。「核对」做三件事:① 逐条复算链;② 现在的内容和最后一次登记是否一致;
 * ③ 登记过的东西是不是还在(从软件里删的会先记一条「删除」)。
 *
 * 🔴 **它证明不了什么,要说清楚**:登记簿和数据在同一个文件夹 —— 能改数据的人,也能把整份登记簿
 *    按新内容重算一遍,链照样是通的。防这种情况只有一个办法:把**链头**(最后一条的序号 + 指纹)
 *    另存到别处,以后拿来比(`checkHead`)。界面必须把这句话说出来,不能让人以为点一下「核对」就证明了一切。
 * ⚠️ 只登记,不备份:内容被改了,这里能说出「哪个文件变了」,拿不回原来的内容。
 * ⚠️ 登记失败**不能**拦住原来的操作(研究照常结束、台账照常保存)——调用方吞掉错误、只打一行日志;
 *    没登记上的对象下次核对会显示成「没登记」或「和登记时不一样」,不会被说成没问题。
 *
 * 落盘:`<dataRoot>/audit/chain.jsonl`,一行一条,只追加,写入持台账同一套文件锁(`ledger.withLock`)。
 * ⚠️ 这把锁挡得住同时写;只有「上一个持锁的进程已经死掉、锁被回收」那一瞬间有竞争窗口(见 ledger.ts)。
 *    万一两条因此撞上同一个序号,核对会把后一条报成「接不上」—— 宁可多报一处,不会悄悄漏掉。
 *    不为此放宽链的规则:放宽了,别人也就能往链上插一条「同号」的登记。
 */
import fs from "node:fs";
import path from "node:path";

import { NOFOLLOW_FLAG, nowIso, sha256File, sha256Text } from "./fsutil.ts";
import { withLock } from "./ledger.ts";

export const GENESIS = "0".repeat(64);

export type AuditSubject = "run" | "ledger";
/**
 * - `seal`   研究运行结束时登记
 * - `save`   台账新增 / 修改(从软件里)
 * - `remove` 从软件里删除(研究运行或台账记录)
 * - `backfill` 补登:功能上线前就有、或当时没登记上的
 * - `reseal` 按现在的内容重新登记(用户确认接受改动;旧登记仍在链上)
 * - `drop`   用户确认「已经不在了」(不是从软件里删的)
 */
export type AuditAction = "seal" | "save" | "remove" | "backfill" | "reseal" | "drop";
const SUBJECTS: readonly AuditSubject[] = ["run", "ledger"];
const ACTIONS: readonly AuditAction[] = ["seal", "save", "remove", "backfill", "reseal", "drop"];
const GONE: readonly AuditAction[] = ["remove", "drop"];

export interface AuditInput {
  subject: AuditSubject;
  /** 研究运行 = run id;台账 = `种类/记录 id` */
  ref: string;
  action: AuditAction;
  /** 内容指纹;删除类为 null */
  content: string | null;
  /** 研究运行逐个文件的指纹(核对时据此说出哪个文件变了);台账没有 */
  files?: Record<string, string>;
}
export interface AuditEntry extends AuditInput { seq: number; at: string; prev: string; hash: string }

export interface ChainProblem {
  /** 登记簿里的第几行(从 1 起) */
  line: number;
  seq: number | null;
  why: string;
  /** false = 读不出来的一行(多半是写到一半被中断):它藏不住任何改动,不算链断 */
  serious: boolean;
}

export class AuditError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuditError";
    this.code = code;
  }
}

export function chainFile(dataRoot: string): string {
  return path.join(dataRoot, "audit", "chain.jsonl");
}

/** 键排序、无空白的 JSON:同一份内容永远得到同一个字符串(指纹才稳定) */
export function canonicalJson(v: unknown): string {
  if (v === undefined || v === null || typeof v === "function" || typeof v === "symbol") return "null";
  if (typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function fingerprint(v: unknown): string {
  return sha256Text(canonicalJson(v));
}

function entryHash(e: Omit<AuditEntry, "hash">): string {
  return fingerprint({ seq: e.seq, at: e.at, subject: e.subject, ref: e.ref, action: e.action, content: e.content, files: e.files, prev: e.prev });
}

/* ---------------- 研究运行的内容 ---------------- */

/**
 * 研究运行里**算作内容**的文件:清单、报告、证据、计算、冲突、报告附录、证据查看器、阶段结果、计算记录、取数信封、原始文件。
 * 附录和查看器虽然由上面这些生成,但界面直接给人看(附录显示在报告下面,查看器里嵌着报告),登记前也已写好 —— 改了要能查出来。
 * 🔴 不含 `events.jsonl`:过程日志,收尾后还会追加。
 */
const RUN_FILES = ["manifest.json", "report.md", "evidence.json", "calculations.json", "conflicts.json", "report_appendix.md", "viewer.html"];
const RUN_DIRS = ["stages", "calcs", "fetch", "raw"];

/** 运行目录的逐文件指纹(相对路径 → sha256)。符号链接不跟随、不计入 */
export function runFiles(runDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (abs: string, rel: string, depth: number) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) { out[rel] = sha256File(abs); return; }
    if (st.isDirectory() && depth < 4) {
      for (const name of fs.readdirSync(abs).sort()) if (!name.startsWith(".")) add(path.join(abs, name), `${rel}/${name}`, depth + 1);
    }
  };
  for (const f of RUN_FILES) add(path.join(runDir, f), f, 0);
  for (const d of RUN_DIRS) add(path.join(runDir, d), d, 0);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function runSeal(runId: string, runDir: string, action: AuditAction = "seal"): AuditInput {
  const files = runFiles(runDir);
  return { subject: "run", ref: runId, action, content: fingerprint(files), files };
}

export function ledgerSeal(kind: string, record: { id: string } & Record<string, unknown>, action: AuditAction = "save"): AuditInput {
  return { subject: "ledger", ref: `${kind}/${record.id}`, action, content: fingerprint(record) };
}

/* ---------------- 读链 ---------------- */

const HEX64 = /^[0-9a-f]{64}$/;

function asEntry(v: unknown): AuditEntry | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1) return null;
  if (typeof e.at !== "string" || typeof e.ref !== "string" || !e.ref) return null;
  if (!SUBJECTS.includes(e.subject as AuditSubject) || !ACTIONS.includes(e.action as AuditAction)) return null;
  if (!(e.content === null || (typeof e.content === "string" && HEX64.test(e.content)))) return null;
  if (typeof e.prev !== "string" || !HEX64.test(e.prev) || typeof e.hash !== "string" || !HEX64.test(e.hash)) return null;
  if (e.files !== undefined) {
    if (!e.files || typeof e.files !== "object" || Array.isArray(e.files)) return null;
    if (!Object.values(e.files as Record<string, unknown>).every((h) => typeof h === "string" && HEX64.test(h))) return null;
  }
  return e as unknown as AuditEntry;
}

export interface ParsedChain {
  /** 格式完整的登记(含指纹对不上 / 接不上的 —— 它们照样参与「最后一次登记」,同时记进 problems) */
  entries: (AuditEntry & { line: number })[];
  problems: ChainProblem[];
}

/**
 * 逐行复算。一处改动只报一次:被改的那行之后,下一行照常和它比(而不是和更早的一行比),
 * 否则删掉一条会让后面每一条都报「接不上」,看不出到底是哪里动过。
 */
export function parseChain(text: string): ParsedChain {
  const entries: ParsedChain["entries"] = [];
  const problems: ChainProblem[] = [];
  const lines = text.split("\n");
  let prev: AuditEntry | null = null;
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    let v: unknown;
    try { v = JSON.parse(raw); } catch {
      const tail = i === lines.length - 1;   // 文件不是以换行结尾,最后一段就是没写完的那条
      problems.push({ line, seq: null, serious: false,
        why: tail ? "最后一行没写完（多半是写的时候程序被关掉了），这一条不算数" : "这一行读不出来（多半是当时写到一半被中断），这一条不算数" });
      return;
    }
    const e = asEntry(v);
    if (!e) { problems.push({ line, seq: null, serious: true, why: "这一行格式不对（不是软件写的登记）" }); return; }
    if (entryHash(e) !== e.hash) problems.push({ line, seq: e.seq, serious: true, why: "这一条被改过（重算的指纹和记下的不一样）" });
    const wantPrev = prev?.hash ?? GENESIS;
    const wantSeq = (prev?.seq ?? 0) + 1;
    if (e.prev !== wantPrev) problems.push({ line, seq: e.seq, serious: true, why: "和上一条接不上（中间有登记被删掉、插入或改写）" });
    else if (e.seq !== wantSeq) problems.push({ line, seq: e.seq, serious: true, why: `序号不连续（应为第 ${wantSeq} 条）` });
    entries.push({ ...e, line });
    prev = e;
  });
  return { entries, problems };
}

/** 登记簿所在的文件夹不能是链接:否则读写都落到别处去了 */
function guardChainDir(dataRoot: string): void {
  let st: fs.Stats;
  try { st = fs.lstatSync(path.dirname(chainFile(dataRoot))); } catch { return; }
  if (st.isSymbolicLink()) throw new AuditError("chain_link", "登记簿所在的文件夹是一个符号链接，不读它（可能被人换掉了）");
}

function readChainText(dataRoot: string): string {
  guardChainDir(dataRoot);
  const file = chainFile(dataRoot);
  if (!fs.existsSync(file)) return "";
  if (fs.lstatSync(file).isSymbolicLink()) throw new AuditError("chain_link", "登记簿是一个符号链接，不读它（可能被人换掉了）");
  return fs.readFileSync(file, "utf8");
}

/* ---------------- 写链 ---------------- */

/** 最后一条格式完整的登记:先看最后一行,读不出来再整份解析 */
function lastEntry(text: string): AuditEntry | null {
  const lines = text.split("\n").filter((l) => l.trim());
  const tail = lines.at(-1);
  if (tail) {
    try { const e = asEntry(JSON.parse(tail)); if (e) return e; } catch { /* 走整份解析 */ }
  }
  return parseChain(text).entries.at(-1) ?? null;
}

/** 追加若干条(同一次写入、同一把锁)。返回写进去的登记 */
export function appendAudit(dataRoot: string, items: readonly AuditInput[]): AuditEntry[] {
  if (!items.length) return [];
  const file = chainFile(dataRoot);
  guardChainDir(dataRoot);   // 锁文件也建在这个文件夹里:先查,别把锁写到别处
  return withLock(file, () => {
    const text = readChainText(dataRoot);
    const last = lastEntry(text);
    let prev = last?.hash ?? GENESIS;
    let seq = last?.seq ?? 0;
    const at = nowIso();
    const out = items.map((it) => {
      seq += 1;
      const base: Omit<AuditEntry, "hash"> = { seq, at, subject: it.subject, ref: it.ref, action: it.action, content: it.content, ...(it.files ? { files: it.files } : {}), prev };
      const e: AuditEntry = { ...base, hash: entryHash(base) };
      prev = e.hash;
      return e;
    });
    // 上一次写到一半断掉、没留换行:先补一个,别让新登记和半截粘成同一行(那样新的这条也读不出来)
    const lead = text && !text.endsWith("\n") ? "\n" : "";
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW_FLAG, 0o600);
    try {
      fs.writeSync(fd, Buffer.from(lead + out.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8"));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return out;
  });
}

/* ---------------- 核对 ---------------- */

/** 调用方给出的「现在有什么」。Core 不知道台账有哪些种类、运行目录长什么样之外的事 */
export interface AuditSnapshot {
  /** 运行目录:run id → { 目录, 是否已结束 }。没结束的不判「没登记」 */
  runs: ReadonlyMap<string, { dir: string; finished: boolean }>;
  /** 台账现有记录:`种类/id` → 记录 */
  ledger: ReadonlyMap<string, Record<string, unknown>>;
}

export type AuditIssueKind = "changed" | "missing" | "unregistered";
export interface AuditIssue {
  subject: AuditSubject;
  ref: string;
  kind: AuditIssueKind;
  why: string;
  /** 研究运行:哪些文件变了 / 多出来 / 不见了 */
  files?: { changed: string[]; added: string[]; removed: string[] };
  /** 最后一次登记 */
  last?: { seq: number; at: string; action: AuditAction };
}

export interface AuditReport {
  entries: number;
  head: { seq: number; hash: string; at: string } | null;
  /** 链本身:没有「严重」问题才算通(读不出来的半截行不算) */
  chain_ok: boolean;
  problems: ChainProblem[];
  issues: AuditIssue[];
  /** 现在和登记一致的对象数 */
  consistent: { run: number; ledger: number };
}

function diffFiles(was: Record<string, string> | undefined, now: Record<string, string>): AuditIssue["files"] {
  const old = was ?? {};
  return {
    changed: Object.keys(now).filter((k) => k in old && old[k] !== now[k]),
    added: Object.keys(now).filter((k) => !(k in old)),
    removed: Object.keys(old).filter((k) => !(k in now)),
  };
}

const keyOf = (subject: AuditSubject, ref: string) => `${subject}\u0000${ref}`;

/** 只读:复算链、对比现状。不写任何东西 */
export function verifyAudit(dataRoot: string, snap: AuditSnapshot): AuditReport {
  const { entries, problems } = parseChain(readChainText(dataRoot));
  const latest = new Map<string, AuditEntry>();
  for (const e of entries) latest.set(keyOf(e.subject, e.ref), e);
  const issues: AuditIssue[] = [];
  const consistent = { run: 0, ledger: 0 };
  const lastOf = (e: AuditEntry) => ({ seq: e.seq, at: e.at, action: e.action });

  for (const [id, r] of snap.runs) {
    const e = latest.get(keyOf("run", id));
    if (!e) {
      if (r.finished) issues.push({ subject: "run", ref: id, kind: "unregistered", why: "还没登记（功能上线前做的，或结束时没登记上）" });
      continue;
    }
    if (GONE.includes(e.action)) { issues.push({ subject: "run", ref: id, kind: "changed", why: "登记的是已删除，现在又出现了", last: lastOf(e) }); continue; }
    const files = runFiles(r.dir);
    if (fingerprint(files) === e.content) { consistent.run += 1; continue; }
    issues.push({ subject: "run", ref: id, kind: "changed", why: "内容和登记时不一样", files: diffFiles(e.files, files), last: lastOf(e) });
  }
  for (const [ref, rec] of snap.ledger) {
    const e = latest.get(keyOf("ledger", ref));
    if (!e) { issues.push({ subject: "ledger", ref, kind: "unregistered", why: "还没登记（功能上线前写的，或保存时没登记上）" }); continue; }
    if (GONE.includes(e.action)) { issues.push({ subject: "ledger", ref, kind: "changed", why: "登记的是已删除，现在又出现了", last: lastOf(e) }); continue; }
    if (fingerprint(rec) === e.content) { consistent.ledger += 1; continue; }
    issues.push({ subject: "ledger", ref, kind: "changed", why: "内容和登记时不一样（不是从软件里改的）", last: lastOf(e) });
  }
  for (const e of latest.values()) {
    if (GONE.includes(e.action)) continue;
    const present = e.subject === "run" ? snap.runs.has(e.ref) : snap.ledger.has(e.ref);
    if (!present) issues.push({ subject: e.subject, ref: e.ref, kind: "missing", why: "登记过，现在不见了（不是从软件里删的）", last: lastOf(e) });
  }
  const tail = entries.at(-1);
  return {
    entries: entries.length,
    head: tail ? { seq: tail.seq, hash: tail.hash, at: tail.at } : null,
    chain_ok: !problems.some((p) => p.serious),
    problems,
    issues,
    consistent,
  };
}

/**
 * 按现状登记:没登记的补登(总是做);和登记时不一样的「按现在的内容重新登记」、
 * 不见了的「确认已经不在」只在调用方明确要求时做 —— 这两类等于用户认下了改动,旧登记仍留在链上。
 */
export function registerAudit(dataRoot: string, snap: AuditSnapshot, opts: { changed?: boolean; missing?: boolean } = {}): AuditEntry[] {
  const report = verifyAudit(dataRoot, snap);
  const items: AuditInput[] = [];
  for (const i of report.issues) {
    const action: AuditAction | null = i.kind === "unregistered" ? "backfill" : i.kind === "changed" && opts.changed ? "reseal" : i.kind === "missing" && opts.missing ? "drop" : null;
    if (!action) continue;
    if (action === "drop") { items.push({ subject: i.subject, ref: i.ref, action, content: null }); continue; }
    if (i.subject === "run") {
      const r = snap.runs.get(i.ref);
      if (r) items.push(runSeal(i.ref, r.dir, action));
    } else {
      const rec = snap.ledger.get(i.ref);
      if (rec) items.push({ subject: "ledger", ref: i.ref, action, content: fingerprint(rec) });
    }
  }
  return appendAudit(dataRoot, items);
}

/* ---------------- 链头 ---------------- */

/** 给用户复制保存的链头:序号 + 时间 + 完整指纹 */
export function formatHead(head: { seq: number; hash: string; at: string }): string {
  return `登记簿第 ${head.seq} 条 · ${head.at.slice(0, 16).replace("T", " ")} · ${head.hash}`;
}

export interface HeadCheck { ok: boolean; seq: number | null; why: string }

/**
 * 拿以前保存的链头来比。对得上 = 从第 1 条到那一条,登记簿在保存链头之后没被改写过
 * (前提是链本身在那之前是通的 —— 每条都压着上一条的指纹)。
 */
export function checkHead(dataRoot: string, saved: string): HeadCheck {
  const hash = /\b[0-9a-f]{64}\b/i.exec(saved)?.[0]?.toLowerCase();
  if (!hash) return { ok: false, seq: null, why: "没在粘贴的内容里找到 64 位的指纹" };
  const m = /第\s*(\d+)\s*条/.exec(saved);
  const { entries, problems } = parseChain(readChainText(dataRoot));
  const target = m ? entries.find((e) => e.seq === Number(m[1])) : entries.find((e) => e.hash === hash);
  const seq = m ? Number(m[1]) : target?.seq ?? null;
  if (!target) {
    if (m) {
      const n = entries.at(-1)?.seq ?? 0;
      const unreadable = problems.find((p) => p.seq === null);
      if (unreadable) return { ok: false, seq, why: `登记簿里找不到第 ${seq} 条：第 ${unreadable.line} 行读不出来，可能就是它被改坏了；保存链头之后登记簿被动过` };
      if (n < Number(m[1])) return { ok: false, seq, why: `登记簿现在只到第 ${n} 条，比保存链头时少：后面的登记被删掉了，或者整份被重写过` };
      return { ok: false, seq, why: `登记簿里没有第 ${seq} 条，却有更后面的登记：这一条被删掉了，或者序号被改过` };
    }
    return { ok: false, seq: null, why: "登记簿里找不到这个指纹：登记簿被整份重写过，或者这不是这份数据的链头" };
  }
  if (target.hash !== hash) return { ok: false, seq, why: `第 ${seq} 条的指纹对不上：这一条以前的登记被改写过，或者这不是这份数据的链头` };
  const broken = problems.find((p) => p.serious && p.line <= target.line);
  if (broken) return { ok: false, seq, why: `链头本身对得上，但第 ${broken.line} 行有问题（${broken.why}），这之前的登记不能算完好` };
  return { ok: true, seq, why: `对得上：第 1 到第 ${seq} 条登记在保存链头之后没被改写过` };
}
