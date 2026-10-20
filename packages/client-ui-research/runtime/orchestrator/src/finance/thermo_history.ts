/**
 * 温度计历史序列(第 13 层产业温度计的时间维度):让报告能写"B200 现货中位 6.88,上次观测(08-16)7.50,变动 −8.27%"。
 *
 * 存储:用户数据区 `<dataRoot>/knowledge/thermometers/<endpoint>.json`(产品仓库永不含用户序列)。
 *   归档时(运行结束、非 scenario、未 failed)从**已通过校验的取数信封**按端点 `history_fields` 白名单追加观测;同一 run_id 只追加一次(幂等)。
 * 召回:risk 阶段取数之后、agent 开工之前,编排器确定性地生成一份合成信封 `fetch/thermo_history.json`
 *   (账本条目 `thermo_history`,原始依据落 `raw/thermo_history.json` 并登记 sha256),证据字段:
 *   `<field>_prev`(上次观测值)· `<field>_change_abs`(本次 − 上次,同单位)· `<field>_change_pct`(相对变动 %,上次 ≠ 0)
 *   或 `<field>_change_pp`(单位本身是 % 的字段:百分点差)。这样"上次值 / 变动"在报告里同样绑定到证据 id,数字绑定规则不变。
 * 读法(写进每条 note,硬测试要求与数字同段):**两点不成线** —— 两次观测之差只是变动不是趋势;上次值来自更早运行,资料期可能不同。
 * 纪律:
 *   - "上次" = 严格更早日历日(Asia/Shanghai)的最近一次观测;同一天多次运行不互比(避免"同日重取变动 0"的噪音)。
 *   - 序列文件当**不可信数据**读:逐条 schema 校验,只取数字 / 日期 / 标识符,任何自由文本(note / 标题)都不进提示词;
 *     损坏的文件在归档时移到 `.corrupt-<时间>` 旁路并出声,召回时只出声不改文件。
 *   - 只比同一 (endpoint, record_key, field);record_key 自带合约月(KXB200MS:2026-12)的远期字段天然不跨月比。
 *   - scenario.inject_thermo_history 存在时**只用注入的观测、完全不读真实序列**(硬测试确定性),且该运行不归档。
 *   - Codex thermo-r1 之后的收紧:period 只认严格日期 / 日期区间(真实日历);上次观测的 unit 必须与本次一致才比;run_id 只留在 raw/(不进 note / 信封 extra);
 *     序列文件有字节数 / 条目数上限;归档前复核信封 sha256 = 账本(TOCTOU);端点级文件锁;资料期倒退不比、同期非零差写"修订 / 来源变化";
 *     归档(在线与 backfill 同一口径)复核 信封 sha256 = 账本 + 本端点 raw sha + 证据 raw_ref 精确属于本端点 + 退出码不变量 + 信封 schema,过不了的端点跳过出声
 *     (磁盘账本只是审计副本,这是 backfill 能做到的最强复核;在线路径账本在内存)。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RunConfig, Scenario } from "../config.ts";
import type { Ledger, LedgerEntry } from "../fetchrun.ts";
import { listFiles, nowIso, readJsonIfExists, sha256File, writeJson } from "../fsutil.ts";
import { shDate } from "../knowledge.ts";
import { loadProductConfig } from "../productConfig.ts";
import { endpointsById, loadRegistry, registryPath, type EndpointDef } from "../registry.ts";
import { validateFetchEnvelope } from "../schemas.ts";


// **composition root**:插件在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
export const THERMO_DIR_REL = path.join("knowledge", "thermometers");
export const THERMO_SCRIPT = "thermo_history";
export const THERMO_FILE_REL = path.join("fetch", `${THERMO_SCRIPT}.json`);
export const THERMO_RAW_NAME = `${THERMO_SCRIPT}.json`;
export const THERMO_MAX_OBS = 3000;
export const THERMO_GUARD = "读法:两点不成线,两次观测之差只是变动不是趋势;上次值来自更早运行的同一端点,资料期可能不同,比较前看 period";
export const THERMO_SCHEMA_VERSION = 1;

export interface ThermoObservation {
  run_id: string;
  /** 运行日期(Asia/Shanghai,按 fetched_at) */
  run_date: string;
  /** 观测日期 = 证据 as_of */
  as_of: string;
  fetched_at: string;
  record_key: string;
  field: string;
  value: number;
  unit: string;
  period: string;
  /** 那次运行里的原始响应路径(相对那次 run 目录;只作溯源,不在本次 raw/) */
  raw_ref: string | null;
  source: string;
}
export interface ThermoLedgerFile { schema_version: number; endpoint: string; observations: ThermoObservation[] }
export interface ThermoReadResult { obs: ThermoObservation[]; dropped: number; unreadable: boolean; exists: boolean }

interface EvidenceLike { id: string; symbol: string; market: string; field: string; value: unknown; unit: string; currency: string; period: string; as_of: string; source: string; endpoint: string; fetched_at: string; adjustment: string; raw_ref: string | null; note?: string; record_key?: string }
interface EnvelopeLike { script: string; symbol: string; market: string; status: string; fetched_at: string; primary_source?: string | null; used_sources: string[]; evidence: EvidenceLike[]; extra: Record<string, unknown>; errors: unknown[]; missing?: unknown[] }

const RUN_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_RE = /^[a-z0-9_]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** 序列文件里会进提示词 / 证据 note 的短字段,按各自形状收紧(不信任序列文件;自由文本一律不收):
 *  record_key:B200 / 2383 / KXB200MS:2026-12 / 2383x2368;period:2026-08-16 / 2026-07-01..2026-07-31;unit:美元/卡时 / 亿新台币 / % / 小数 / 档;source:vast+kalshi / finmind */
const RECORD_KEY_RE = /^[A-Za-z0-9:._x-]{1,32}$/;
/** 资料期只认 YYYY-MM-DD 或 YYYY-MM-DD..YYYY-MM-DD,且每个日期都是真实日历日(Codex thermo-r1:字符白名单不能承担文本安全) */
const PERIOD_RE = /^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/;
const UNIT_RE = /^[\p{L}\p{N}%/·._ -]{1,16}$/u;
const SOURCE_RE = /^[A-Za-z0-9+:._ -]{1,32}$/;
/** 序列文件上限:字节数 / 条目数超过即按 unreadable 处理(同步损坏 / 恶意膨胀的文件不能拖死召回、归档与 doctor) */
export const THERMO_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const THERMO_MAX_PARSE_OBS = THERMO_MAX_OBS * 4;

export function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function isValidPeriod(p: string): boolean {
  if (!PERIOD_RE.test(p)) return false;
  const [a, b] = p.split("..");
  return isRealDate(a) && (b === undefined || (isRealDate(b) && b >= a));
}
/** 资料期起点(区间取起点),用于判定推进 / 同期 / 倒退 */
export function periodStart(p: string): string { return p.split("..")[0]; }

export function thermoDir(cfg: Pick<RunConfig, "dataRoot">): string {
  return path.join(cfg.dataRoot, THERMO_DIR_REL);
}
export function thermoLedgerPath(cfg: Pick<RunConfig, "dataRoot">, endpoint: string): string {
  if (!/^[a-z0-9_]{1,80}$/.test(endpoint)) throw new Error(`端点 id 非法:${endpoint}`);
  return path.join(thermoDir(cfg), `${endpoint}.json`);
}

/** 端点声明了 history_fields(非空字符串数组)才做历史序列;注册表加载时已校验格式 */
export function historyFieldsOf(def: Pick<EndpointDef, "history_fields"> | undefined): string[] {
  const hf = def?.history_fields;
  return Array.isArray(hf) ? hf.filter((x): x is string => typeof x === "string" && FIELD_RE.test(x)) : [];
}

/** 逐条校验序列观测(不可信输入):任一字段不合格整条丢弃 */
export function validateObservation(o: unknown): ThermoObservation | null {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const str = (k: string, re: RegExp) => typeof r[k] === "string" && re.test(r[k] as string) ? (r[k] as string) : null;
  const run_id = str("run_id", RUN_ID_RE), run_date = str("run_date", DATE_RE), as_of = str("as_of", DATE_RE), fetched_at = str("fetched_at", ISO_RE);
  const record_key = str("record_key", RECORD_KEY_RE), field = str("field", FIELD_RE), unit = str("unit", UNIT_RE), period = str("period", PERIOD_RE), source = str("source", SOURCE_RE);
  const value = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null;
  // raw_ref 只认平铺的 raw/<文件名>(不含任何斜杠 → 没有 raw/../x 这种别名;Codex thermo-r2)
  const raw_ref = r.raw_ref === null || r.raw_ref === undefined ? null : typeof r.raw_ref === "string" && /^raw\/[^\/\\\x00-\x1f\x7f]{1,200}$/.test(r.raw_ref) ? r.raw_ref : undefined;
  if (!run_id || !run_date || !as_of || !fetched_at || !record_key || !field || !unit || !period || !source || value === null || raw_ref === undefined) return null;
  if (!isRealDate(run_date) || !isRealDate(as_of) || !isValidPeriod(period)) return null;
  return { run_id, run_date, as_of, fetched_at, record_key, field, value, unit, period, raw_ref, source };
}

export function readThermoLedger(file: string): ThermoReadResult {
  if (!fs.existsSync(file)) return { obs: [], dropped: 0, unreadable: false, exists: false };
  let parsed: unknown;
  try {
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > THERMO_MAX_FILE_BYTES) return { obs: [], dropped: 0, unreadable: true, exists: true };
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return { obs: [], dropped: 0, unreadable: true, exists: true }; }
  const p = parsed as Partial<ThermoLedgerFile> | null;
  if (!p || typeof p !== "object" || Array.isArray(p) || p.schema_version !== THERMO_SCHEMA_VERSION || !Array.isArray(p.observations) || p.observations.length > THERMO_MAX_PARSE_OBS) return { obs: [], dropped: 0, unreadable: true, exists: true };
  const obs: ThermoObservation[] = [];
  let dropped = 0;
  for (const o of p.observations) { const v = validateObservation(o); if (v) obs.push(v); else dropped++; }
  return { obs, dropped, unreadable: false, exists: true };
}

/** 从一份真实信封抽观测:只取 history_fields 白名单内、值为有限数的证据 */
export function extractObservations(env: EnvelopeLike, runId: string, fields: string[]): ThermoObservation[] {
  const out: ThermoObservation[] = [];
  const allow = new Set(fields);
  for (const e of env.evidence ?? []) {
    if (!allow.has(e.field) || typeof e.value !== "number" || !Number.isFinite(e.value)) continue;
    if (typeof e.raw_ref !== "string") continue;  // 没有原始响应依据的数值不进序列
    const o = validateObservation({
      run_id: runId, run_date: shDate(new Date(env.fetched_at)), as_of: e.as_of, fetched_at: e.fetched_at, record_key: e.record_key ?? e.symbol, field: e.field,
      value: e.value, unit: e.unit, period: e.period, raw_ref: e.raw_ref, source: e.source,
    });
    if (o) out.push(o);
  }
  return out;
}

function sortKey(o: ThermoObservation): string { return `${o.as_of}|${o.fetched_at}`; }

/** 追加观测到序列文件:同 run_id 已在则不重复;按观测日期排序并裁到上限(丢最旧) */
export function mergeObservations(existing: ThermoObservation[], incoming: ThermoObservation[]): { merged: ThermoObservation[]; appended: number } {
  const seen = new Set(existing.map((o) => `${o.run_id}|${o.record_key}|${o.field}`));
  const add = incoming.filter((o) => { const k = `${o.run_id}|${o.record_key}|${o.field}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const merged = [...existing, ...add].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { merged: merged.length > THERMO_MAX_OBS ? merged.slice(merged.length - THERMO_MAX_OBS) : merged, appended: add.length };
}

export interface AppendResult { endpoints: string[]; appended: number; skipped: { endpoint: string; reason: string }[]; corrupt_moved: string[] }

/** 端点级跨进程文件锁。
 *  拿锁 = `mkdir <file>.lock` 原子;锁目录内写 owner 令牌(pid-随机)。占用则短等重试,超过 waitMs 抛错(调用方记事件,不静默)。
 *  陈旧判定(Codex thermo-r3:不能仅凭 mtime 抢活锁):① owner 缺失且目录超 120 s(写 owner 前崩溃)② owner pid 已不存在 ③ 目录超 1 小时硬上限(兜底 pid 复用——归档本身毫秒级,活锁不可能持有 1 小时;Codex thermo-r4)。
 *  回收动作(Codex thermo-r4 ABA:两个进程同判陈旧、后者会把前者刚建的新锁 rename 掉)→ 用第二把 `.reclaim` 锁串行化:拿到 reclaim 锁后**重读**主锁 owner 再判一次,
 *  仍陈旧才 rename 到唯一名字并删除;主锁的增删只在 reclaim 锁内或正常释放时发生,所以"读到的 owner"与"被 rename 的目录"是同一个。reclaim 锁本身只持有毫秒级,超 60 s 视为遗留直接删。
 *  释放前核对 owner 令牌,不是自己的锁绝不删。残余风险(已知、接受):两个进程在 60 s 内先后崩在 reclaim 锁里的极端情况;更强的保证要靠内核 advisory lock,Node 核心没有。 */
export const THERMO_LOCK_STALE_MS = 120_000;
export const THERMO_LOCK_HARD_MAX_MS = 3_600_000;
export const THERMO_RECLAIM_STALE_MS = 60_000;
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }  // EPERM = 存在但不是我们的进程,也算活着
}
function readOwner(ownerFile: string): string | null { try { return fs.readFileSync(ownerFile, "utf8"); } catch { return null; } }
function lockStale(lock: string, ownerFile: string, now: number): boolean {
  let age: number;
  try { age = now - fs.statSync(lock).mtimeMs; } catch { return false; }
  if (age > THERMO_LOCK_HARD_MAX_MS) return true;
  const owner = readOwner(ownerFile);
  if (owner === null) return age > THERMO_LOCK_STALE_MS;
  const pid = Number(owner.split("-")[0]);
  return Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
}
/** 在 reclaim 锁内重判并回收主锁;返回是否做了回收。拿不到 reclaim 锁 = 别人正在回收,直接返回 false 让调用方重试 */
function reclaimStaleLock(lock: string, ownerFile: string, token: string, now: () => number): boolean {
  const reclaim = `${lock}.reclaim`;
  try { fs.mkdirSync(reclaim); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let age = 0; try { age = now() - fs.statSync(reclaim).mtimeMs; } catch { return false; }
    if (age > THERMO_RECLAIM_STALE_MS) { try { fs.rmSync(reclaim, { recursive: true, force: true }); } catch { /* 别人先删 */ } }
    return false;
  }
  try {
    if (!lockStale(lock, ownerFile, now())) return false;  // 重读:拿到 reclaim 锁时主锁可能已换成别人的活锁
    const aside = `${lock}.stale-${token}`;
    try { fs.renameSync(lock, aside); } catch { return false; }
    try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* 留残骸无害 */ }
    return true;
  } finally { try { fs.rmSync(reclaim, { recursive: true, force: true }); } catch { /* 忽略 */ } }
}
export function withThermoLock<T>(file: string, fn: () => T, opts: { waitMs?: number; now?: () => number } = {}): T {
  const lock = `${file}.lock`;
  const ownerFile = path.join(lock, "owner");
  const token = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.waitMs ?? 5000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try { fs.mkdirSync(lock); fs.writeFileSync(ownerFile, token); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (lockStale(lock, ownerFile, now()) && reclaimStaleLock(lock, ownerFile, token, now)) continue;  // 回收成功立刻重试 mkdir;别人在回收就按普通等待走(有 deadline,不忙等)
      if (now() > deadline) throw new Error(`温度计序列被占用超过 ${opts.waitMs ?? 5000} ms:${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); }
  finally {
    // 只释放自己的锁:owner 令牌不符(锁已被陈旧回收、别人持有)就不动
    if (readOwner(ownerFile) === token) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  }
}

/** 归档入口:运行结束后把本次已校验信封里的温度计观测写进用户数据区序列(调用方保证:非 scenario、未 failed)。
 *  信封在落盘后、归档前仍可能被外部进程改写(TOCTOU),所以重新读取前先核对 sha256 = 内存账本记录的值;不一致 → 跳过并出声。 */
export function appendThermoLedger(cfg: Pick<RunConfig, "dataRoot" | "runDir" | "runId" | "endpoints">, ledger: Ledger, log: (type: string, payload: Record<string, unknown>) => void): AppendResult {
  const res: AppendResult = { endpoints: [], appended: 0, skipped: [], corrupt_moved: [] };
  for (const [script, entry] of Object.entries(ledger)) {
    const fields = historyFieldsOf(cfg.endpoints?.[script]);
    if (!fields.length) continue;
    if (!["ok", "partial"].includes(entry.status)) { res.skipped.push({ endpoint: script, reason: `账本状态 ${entry.status}` }); continue; }
    if (entry.injected || entry.synthetic_overlay) { res.skipped.push({ endpoint: script, reason: "含合成数据" }); continue; }
    const envPath = path.join(cfg.runDir, "fetch", `${script}.json`);
    const derived = entry.exit_code === 0 ? "ok" : entry.exit_code === 2 ? "partial" : "failed";
    if (derived !== entry.status) { res.skipped.push({ endpoint: script, reason: `账本退出码 ${entry.exit_code} 与状态 ${entry.status} 不自洽` }); continue; }
    if (!fs.existsSync(envPath) || !fs.lstatSync(envPath).isFile()) { res.skipped.push({ endpoint: script, reason: "信封不存在或不是普通文件" }); continue; }
    if (!entry.sha256 || sha256File(envPath) !== entry.sha256) { res.skipped.push({ endpoint: script, reason: "信封 sha256 与账本不一致(落盘后被改写?)" }); log("thermo_history.envelope_tampered", { endpoint: script, file: envPath }); continue; }
    const env = readJsonIfExists<EnvelopeLike>(envPath);
    if (!env || validateFetchEnvelope(env).length || env.status !== entry.status) { res.skipped.push({ endpoint: script, reason: "信封不符契约或状态与账本不一致" }); continue; }
    // raw 归属(在线与 backfill 同一口径,Codex thermo-r2):本端点账本记录的 raw 文件都在且 sha 一致;每条证据的 raw_ref 必须**精确等于** "raw/<本端点 raw 文件名>"
    // (全局 validator 只证明 raw 文件属于"某个"账本条目,证不了属于本端点;basename 比对会被 raw/../x 绕过)
    const bad = Object.entries(entry.raw_files ?? {}).find(([name, sha]) => { const p = path.join(cfg.runDir, "raw", name); return !fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink() || sha256File(p) !== sha; });
    if (bad) { res.skipped.push({ endpoint: script, reason: `raw/${bad[0]} 缺失或 sha256 不一致` }); continue; }
    const rawRefs = new Set(Object.keys(entry.raw_files ?? {}).map((n) => `raw/${n}`));
    // 每条证据(不只白名单字段)都必须有 raw_ref 且精确属于本端点;null 也不行(Codex thermo-r3:null 会绕过归属校验)
    if ((env.evidence ?? []).some((e) => typeof e.raw_ref !== "string" || !rawRefs.has(e.raw_ref))) { res.skipped.push({ endpoint: script, reason: "证据 raw_ref 缺失或不是本端点账本记录的 raw/<文件名>" }); continue; }
    const incoming = extractObservations(env, cfg.runId, fields);
    if (!incoming.length) { res.skipped.push({ endpoint: script, reason: "白名单字段无数值证据" }); continue; }
    const file = thermoLedgerPath(cfg, script);
    try {
      withThermoLock(file, () => {
        const cur = readThermoLedger(file);
        if (cur.unreadable) {
          // 归档绝不覆盖读不懂的文件:移到旁路、出声、从空序列重建(丢数据比静默写坏更可接受,但要留原件)
          const aside = `${file}.corrupt-${nowIso().replace(/[:.]/g, "-")}`;
          fs.renameSync(file, aside);
          res.corrupt_moved.push(aside);
          log("thermo_history.ledger_corrupt_moved", { endpoint: script, moved_to: aside });
        }
        if (cur.dropped) log("thermo_history.ledger_invalid_dropped", { endpoint: script, dropped: cur.dropped });
        const { merged, appended } = mergeObservations(cur.unreadable ? [] : cur.obs, incoming);
        const payload: ThermoLedgerFile = { schema_version: THERMO_SCHEMA_VERSION, endpoint: script, observations: merged };
        writeJson(file, payload);
        res.endpoints.push(script);
        res.appended += appended;
        log("thermo_history.archived", { endpoint: script, file, appended, total: merged.length, skipped_duplicate: incoming.length - appended });
      });
    } catch (e) {
      res.skipped.push({ endpoint: script, reason: `写序列失败:${e instanceof Error ? e.message : String(e)}` });
      log("thermo_history.archive_failed", { endpoint: script, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return res;
}

/** 选"上次":同 (record_key, field, unit)、观测日严格早于本次、不同 run_id;取最近一条(同日多条取 fetched_at 最晚)。
 *  单位不同的候选一律不比(Codex thermo-r1:750 美分 − 7.5 美元);资料期比本次还晚的候选(序列混入未来资料期)不比并回报 regressed。 */
export function selectPrev(obs: ThermoObservation[], cur: { record_key: string; field: string; as_of: string; run_id: string; unit?: string; period?: string }): { prev: ThermoObservation | null; unit_mismatch: number; regressed: number } {
  let best: ThermoObservation | null = null;
  let unit_mismatch = 0, regressed = 0;
  for (const o of obs) {
    if (o.record_key !== cur.record_key || o.field !== cur.field || o.run_id === cur.run_id) continue;
    if (!(o.as_of < cur.as_of)) continue;
    if (cur.unit !== undefined && o.unit !== cur.unit) { unit_mismatch++; continue; }
    if (cur.period !== undefined && periodStart(o.period) > periodStart(cur.period)) { regressed++; continue; }
    if (!best || sortKey(o) > sortKey(best)) best = o;
  }
  return { prev: best, unit_mismatch, regressed };
}

function round2(x: number): number { return Number(x.toFixed(2)); }
function idOf(parts: string[]): string { return `ev-${crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12)}`; }

export type PeriodRelation = "advanced" | "same" | "regressed";
export interface DeltaBuild { evidence: EvidenceLike[]; summary: { endpoint: string; record_key: string; field: string; cur_id: string; cur: number; cur_period: string; cur_as_of: string; prev: number; prev_as_of: string; prev_period: string; ids: Record<string, string>; period_relation: PeriodRelation; period_advanced: boolean } }

export function periodRelation(prevPeriod: string, curPeriod: string): PeriodRelation {
  const a = periodStart(prevPeriod), b = periodStart(curPeriod);
  return a < b ? "advanced" : a === b ? "same" : "regressed";
}

/** 一条本次证据 + 一条上次观测 → 历史比较证据(_prev / _change_*),全部指向本次 raw/thermo_history.json。
 *  note 里只放数字 / 日期 / 资料期关系,不放序列里的任何标识文本(run_id 只在 raw 里)。 */
export function buildDeltaEvidence(endpoint: string, cur: EvidenceLike, prev: ThermoObservation, fetchedAt: string, rawRef: string): DeltaBuild {
  const curV = Number(cur.value);
  const relation = periodRelation(prev.period, cur.period);
  const diff = round2(curV - prev.value);
  const periodNote = relation === "advanced" ? `资料期推进 ${prev.period} → ${cur.period}` : relation === "same" ? (diff === 0 ? `同一资料期 ${cur.period}(上游未更新,变动为 0 属正常)` : `同一资料期 ${cur.period} 但数值不同(上游修订或来源变化,不是新数据点)`) : `资料期倒退 ${prev.period} → ${cur.period}(异常,比较不可用)`;
  const base = { symbol: cur.symbol, market: cur.market, currency: cur.currency, as_of: cur.as_of, source: "history", endpoint: `orchestrator.${THERMO_SCRIPT}`, fetched_at: fetchedAt, adjustment: cur.adjustment, raw_ref: rawRef, record_key: cur.record_key ?? cur.symbol };
  const rk = base.record_key;
  const ids: Record<string, string> = {};
  const evs: EvidenceLike[] = [];
  const push = (suffix: string, value: number, unit: string, note: string) => {
    if (!Number.isFinite(value)) return;  // 两个有限数之差 / 商仍可能溢出(1e308 − (−1e308));溢出就不出这条,绝不落 null / Infinity
    const id = idOf([THERMO_SCRIPT, endpoint, rk, cur.field, suffix, cur.id]);
    ids[suffix] = id;
    evs.push({ ...base, id, field: `${cur.field}_${suffix}`, value, unit, period: suffix === "prev" ? prev.period : cur.period, note });
  };
  push("prev", prev.value, cur.unit, `上次观测 ${prev.as_of}(${periodNote});本次 ${curV} ${cur.unit}(${cur.id});${THERMO_GUARD}`);
  if (relation !== "regressed") {
    if (cur.unit === "%") {
      push("change_pp", diff, "百分点", `本次 ${curV}% − 上次 ${prev.value}%(${prev.as_of});${periodNote};${THERMO_GUARD}`);
    } else {
      push("change_abs", diff, cur.unit, `本次 ${curV} − 上次 ${prev.value}(${prev.as_of}),单位 ${cur.unit};${periodNote};${THERMO_GUARD}`);
      if (cur.unit !== "小数" && prev.value !== 0) push("change_pct", round2(((curV - prev.value) / Math.abs(prev.value)) * 100), "%", `(本次 ${curV} − 上次 ${prev.value}) ÷ |上次| × 100(${prev.as_of});${periodNote};${THERMO_GUARD}`);
    }
  }
  return { evidence: evs, summary: { endpoint, record_key: rk, field: cur.field, cur_id: cur.id, cur: curV, cur_period: cur.period, cur_as_of: cur.as_of, prev: prev.value, prev_as_of: prev.as_of, prev_period: prev.period, ids, period_relation: relation, period_advanced: relation === "advanced" } };
}

export interface ThermoHistoryFile { generated_at: string; synthetic: string | null; comparisons: DeltaBuild["summary"][]; first_observation: { endpoint: string; record_key: string; field: string; reason: string }[]; ledgers: Record<string, { path: string | null; observations: number; dropped: number; unreadable: boolean }>; skipped_candidates: { unit_mismatch: number; regressed: number } }

/** 把 scenario 注入的观测转成序列观测(只认合法字段;run_id 默认 synthetic-prev) */
export function injectedObservations(items: NonNullable<Scenario["inject_thermo_history"]>, endpoint: string): ThermoObservation[] {
  const out: ThermoObservation[] = [];
  for (const it of items) {
    if (it.endpoint !== endpoint) continue;
    const o = validateObservation({ run_id: it.run_id ?? "synthetic-prev", run_date: it.as_of, as_of: it.as_of, fetched_at: `${it.as_of}T09:00:00+08:00`, record_key: it.record_key, field: it.field, value: it.value, unit: it.unit ?? "", period: it.period, raw_ref: null, source: "injected" });
    if (o) out.push(o);
  }
  return out;
}

/**
 * 取数后入口:为本阶段账本里带 history_fields 的 ok / partial 信封生成历史比较信封。无任何可比观测 → 不生成信封(只出声)。
 * 返回 null = 本阶段没有温度计端点或没有历史。
 */
export function applyThermometerHistory(cfg: Pick<RunConfig, "dataRoot" | "runDir" | "runId" | "symbol" | "market" | "endpoints"> & { scenario?: Scenario | null }, stage: string, ledger: Ledger, log: (type: string, payload: Record<string, unknown>) => void): LedgerEntry | null {
  if (ledger[THERMO_SCRIPT]) return ledger[THERMO_SCRIPT];
  const scenario: Scenario = cfg.scenario ?? {};
  const injected = scenario.inject_thermo_history;
  const started = nowIso();
  const comparisons: DeltaBuild["summary"][] = [];
  const firsts: ThermoHistoryFile["first_observation"] = [];
  const ledgers: ThermoHistoryFile["ledgers"] = {};
  const evidence: EvidenceLike[] = [];
  const rawRel = `raw/${THERMO_RAW_NAME}`;
  const usedPrev: ThermoObservation[] = [];
  const skippedCandidates = { unit_mismatch: 0, regressed: 0 };
  let candidates = 0;
  for (const [script, entry] of Object.entries(ledger)) {
    if (entry.stage !== stage) continue;
    const fields = historyFieldsOf(cfg.endpoints?.[script]);
    if (!fields.length || !["ok", "partial"].includes(entry.status)) continue;
    const env = readJsonIfExists<EnvelopeLike>(path.join(cfg.runDir, "fetch", `${script}.json`));
    if (!env) continue;
    candidates++;
    let obs: ThermoObservation[];
    if (injected?.length) {
      obs = injectedObservations(injected, script);
      ledgers[script] = { path: null, observations: obs.length, dropped: 0, unreadable: false };
    } else {
      const file = thermoLedgerPath(cfg, script);
      const r = readThermoLedger(file);
      obs = r.obs;
      ledgers[script] = { path: file, observations: r.obs.length, dropped: r.dropped, unreadable: r.unreadable };
      if (r.unreadable) log("thermo_history.ledger_unreadable", { endpoint: script, file, hint: "序列文件损坏,本次按无历史处理;归档时会移到 .corrupt 旁路重建" });
      if (r.dropped) log("thermo_history.ledger_invalid_dropped", { endpoint: script, dropped: r.dropped });
    }
    const allow = new Set(fields);
    for (const e of env.evidence ?? []) {
      if (!allow.has(e.field) || typeof e.value !== "number" || !Number.isFinite(e.value) || !DATE_RE.test(e.as_of)) continue;
      const rk = e.record_key ?? e.symbol;
      if (!isValidPeriod(e.period)) continue;  // 本次资料期形状不对就不做历史(不让坏形状进序列语义)
      const sel = selectPrev(obs, { record_key: rk, field: e.field, as_of: e.as_of, run_id: cfg.runId, unit: e.unit, period: e.period });
      skippedCandidates.unit_mismatch += sel.unit_mismatch; skippedCandidates.regressed += sel.regressed;
      const prev = sel.prev;
      if (!prev) { firsts.push({ endpoint: script, record_key: rk, field: e.field, reason: obs.length ? (sel.unit_mismatch ? "有更早观测但单位不同,不比" : sel.regressed ? "更早观测的资料期比本次还晚(序列异常),不比" : "序列里没有更早日历日的同键观测") : "序列为空(首次观测)" }); continue; }
      const d = buildDeltaEvidence(script, e, prev, started, rawRel);
      evidence.push(...d.evidence);
      comparisons.push(d.summary);
      usedPrev.push(prev);
    }
  }
  if (!candidates) return null;
  if (skippedCandidates.unit_mismatch || skippedCandidates.regressed) log("thermo_history.candidates_skipped", { stage, ...skippedCandidates });
  if (!evidence.length) { log("thermo_history.none", { stage, first_observation: firsts.length, ledgers, ...skippedCandidates }); return null; }
  // raw/:本次比较用到的上次观测(原样数值 + 溯源 run_id / raw_ref),是证据的 raw_ref 依据
  const rawPath = path.join(cfg.runDir, "raw", THERMO_RAW_NAME);
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  writeJson(rawPath, { generated_at: started, synthetic: injected?.length ? "inject_thermo_history" : null, prev_observations: usedPrev, comparisons });
  const file = path.join(cfg.runDir, THERMO_FILE_REL);
  const hist: ThermoHistoryFile = { generated_at: started, synthetic: injected?.length ? "inject_thermo_history" : null, comparisons, first_observation: firsts, ledgers, skipped_candidates: skippedCandidates };
  const env: EnvelopeLike = {
    script: THERMO_SCRIPT, symbol: cfg.symbol, market: cfg.market || "", status: "ok", fetched_at: started, primary_source: "history", used_sources: ["history"], evidence,
    extra: { endpoint: { layer: "13 产业温度计", source: "history", title: "温度计历史比较(编排器从用户数据区序列确定性生成)" }, guard: THERMO_GUARD, ...hist }, errors: [], missing: [],
  };
  writeJson(file, env);
  const finished = nowIso();
  const entry: LedgerEntry = { script: THERMO_SCRIPT, argv: [], exit_code: 0, duration_ms: Math.max(0, Date.parse(finished) - Date.parse(started)), status: "ok", file: THERMO_FILE_REL, sha256: sha256File(file), raw_files: { [THERMO_RAW_NAME]: sha256File(rawPath) }, started_at: started, finished_at: finished, stage, ...(injected?.length ? { synthetic_overlay: "inject_thermo_history" } : {}) };
  ledger[THERMO_SCRIPT] = entry;
  log("thermo_history.built", { stage, comparisons: comparisons.length, evidence: evidence.length, first_observation: firsts.length, synthetic: entry.synthetic_overlay ?? null, ledgers });
  return entry;
}

export function readThermoHistoryFile(runDir: string): (EnvelopeLike & { extra: Record<string, unknown> & ThermoHistoryFile }) | null {
  return readJsonIfExists(path.join(runDir, THERMO_FILE_REL));
}

/** 提示词块(risk / report):逐条列"本次 ← 上次 / 变动"与各自的 ev id;没有信封 → 空串 */
export function thermoHistoryPromptBlock(runDir: string): string {
  const f = readThermoHistoryFile(runDir);
  if (!f) return "";
  const x = f.extra;
  const lines = (x.comparisons ?? []).slice(0, 24).map((c) => {
    const ch = c.ids.change_pp ? `变动(百分点)[${c.ids.change_pp}]` : [c.ids.change_abs ? `变动 [${c.ids.change_abs}]` : "", c.ids.change_pct ? `相对变动% [${c.ids.change_pct}]` : ""].filter(Boolean).join(" / ");
    return `   - ${c.endpoint} · ${c.record_key} · ${c.field}:本次 [${c.cur_id}](资料期 ${c.cur_period})← 上次观测 ${c.prev_as_of} [${c.ids.prev}](资料期 ${c.prev_period}${c.period_advanced ? ",已推进" : ",同期"});${ch}`;
  });
  const firsts = (x.first_observation ?? []).slice(0, 8).map((r) => `${r.endpoint}·${r.record_key}·${r.field}`);
  return `\n【温度计历史比较】账本信封 ${THERMO_SCRIPT}(fetch/${THERMO_SCRIPT}.json;上次值 / 变动都是证据,各有自己的 ev id;数值照抄 value):\n${lines.join("\n")}${firsts.length ? `\n   首次观测、无历史:${firsts.join("、")}` : ""}\n   写法:每个温度计的段落里,本次值、上次值(带观测日期)、变动各自带 [ev-id];**"两点不成线"这句护栏必须与历史数字同段**;不得把上次值写成本次值,不得把变动写成趋势或预测;同期重取(变动 0)要写明"上游未更新"。`;
}

/** 回填:扫 runs 目录里已完成、非测试场景的运行,把温度计观测补进序列(幂等;给首次启用 / 迁移用) */
export function backfillThermoLedger(cfg: Pick<RunConfig, "dataRoot" | "endpoints">, runsDir: string, log: (type: string, payload: Record<string, unknown>) => void): { runs: number; appended: number; skipped: number } {
  let runs = 0, appended = 0, skipped = 0;
  const dirs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).map((d) => path.join(runsDir, d)).filter((d) => fs.statSync(d).isDirectory()) : [];
  for (const runDir of dirs.sort()) {
    const manifest = readJsonIfExists<{ run_id?: string; status?: string; test_scenario?: boolean; exit_code?: number }>(path.join(runDir, "manifest.json"));
    const ledger = readJsonIfExists<Ledger>(path.join(runDir, "fetch", "_ledger.json"));
    if (!manifest || !ledger || !manifest.run_id || !RUN_ID_RE.test(manifest.run_id) || manifest.run_id !== path.basename(runDir)) { skipped++; continue; }
    if (manifest.test_scenario || !["complete", "incomplete"].includes(manifest.status ?? "") || ![0, 2].includes(manifest.exit_code ?? -1)) { skipped++; continue; }
    // 磁盘账本只是审计副本:能做的最强复核 = 信封 sha256 / raw sha256 / 退出码不变量 / 信封 schema(appendThermoLedger verifyRaw 路径);过不了的端点被跳过并出声
    const r = appendThermoLedger({ dataRoot: cfg.dataRoot, runDir, runId: manifest.run_id, endpoints: cfg.endpoints }, ledger, log);
    if (r.skipped.length) log("thermo_history.backfill_skipped", { run: path.basename(runDir), skipped: r.skipped });
    if (r.endpoints.length) runs++;
    appended += r.appended;
  }
  return { runs, appended, skipped };
}

/** 序列概览(CLI show 用) */
export function thermoLedgerOverview(cfg: Pick<RunConfig, "dataRoot">): { endpoint: string; file: string; observations: number; dropped: number; unreadable: boolean; first: string | null; last: string | null; keys: number }[] {
  const dir = thermoDir(cfg);
  return listFiles(dir, ".json").filter((f) => !/\.corrupt-/.test(f)).map((f) => {
    const r = readThermoLedger(f);
    const keys = new Set(r.obs.map((o) => `${o.record_key}|${o.field}`));
    return { endpoint: path.basename(f, ".json"), file: f, observations: r.obs.length, dropped: r.dropped, unreadable: r.unreadable, first: r.obs[0]?.as_of ?? null, last: r.obs[r.obs.length - 1]?.as_of ?? null, keys: keys.size };
  });
}

/**
 * 用法:node orchestrator/src/finance/thermo_history.ts show|backfill [--repo-root <产品根>] [--data-root <用户数据区,默认产品配置的 dataRoot>] [--runs-dir <默认 <dataRoot>/runs>] [--json]
 *   show     = 列出各端点序列的观测数 / 首末日期 / 无效条数
 *   backfill = 扫运行目录里已完成、非测试场景的运行,把温度计观测补进序列(幂等;首次启用或迁移后用)
 */
/** 本文件在 orchestrator/src/finance/ 下：上三层是仓库根 */
export const thermoRepoRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
// 命令行直接跑时先注册金融插件(回填要按插件契约校验信封;之前漏了,backfill 一跑就抛「未注入插件」)。
// 不能写成文件顶部的静态 import:finance/plugin.ts 那条引用链会绕回来,FINANCE_PLUGIN 初始化前就被读到
if (isMain) import("./register.ts").then(cli).catch((e) => { console.error(e); process.exit(3); });

function cli(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const repoRoot = path.resolve(arg("--repo-root") ?? thermoRepoRoot());
  const dataRoot = path.resolve(arg("--data-root") ?? loadProductConfig(repoRoot).resolved.dataRoot);
  const json = argv.includes("--json");
  if (cmd === "show") {
    const rows = thermoLedgerOverview({ dataRoot });
    if (json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log(`[thermo-history] ${thermoDir({ dataRoot })} 下没有序列(跑过一次完整研究并归档后才会有;或先 backfill)`);
    else for (const r of rows) console.log(`[thermo-history] ${r.endpoint}:${r.observations} 条观测 / ${r.keys} 个键 / ${r.first ?? "-"} → ${r.last ?? "-"}${r.dropped ? ` / ⚠️ 无效 ${r.dropped} 条` : ""}${r.unreadable ? " / 🔴 文件不可读" : ""}`);
  } else if (cmd === "backfill") {
    const reg = loadRegistry(repoRoot);
    if (!reg) { console.error(`[thermo-history] 注册表不可读:${registryPath(repoRoot)}`); process.exit(2); }
    const runsDir = path.resolve(arg("--runs-dir") ?? path.join(dataRoot, "runs"));
    const events: Record<string, unknown>[] = [];
    const r = backfillThermoLedger({ dataRoot, endpoints: endpointsById(reg) }, runsDir, (type, payload) => events.push({ type, ...payload }));
    if (json) console.log(JSON.stringify({ ...r, events }, null, 2));
    else console.log(`[thermo-history] 回填完成:有温度计观测的运行 ${r.runs} 个,新增观测 ${r.appended} 条,跳过运行 ${r.skipped} 个(测试场景 / 未完成 / 无账本)${events.filter((e) => String(e.type).includes("corrupt")).length ? ";⚠️ 有损坏序列文件被移到旁路" : ""}`);
  } else {
    console.error("用法:node orchestrator/src/finance/thermo_history.ts show|backfill [--repo-root <dir>] [--data-root <dir>] [--runs-dir <dir>] [--json]");
    process.exit(2);
  }
}
