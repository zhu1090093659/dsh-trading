/**
 * 持仓视图(`GET /view/holdings`)、旧持有记录迁移(`POST /view/holdings`)与收益率(`GET /view/holdings_perf`)。
 *
 * 读:台账里的交易流水按所选成本法重放(`holdings.ts`),附上还没迁移的旧持有记录各自的状态。行情由界面自己取。
 * 写(act):
 *   - `migrate`:旧持有记录(一只一条:数量 + 均价)逐条转成一笔「期初持仓」流水,`migrated_from` 记原记录 id;
 *   - `adopt`:冲突的那条(同一代码已经有流水)由用户确认后照样转成期初持仓;
 *   - `discard`:用户确认不要的旧记录删掉;
 *   - `import_preview`:从表格导入前预览(不写):逐行说数据对不对、和已记的流水是否一样、写进去以后重放会不会算不了,
 *     以及已记的流水里有哪几笔会因为这批新流水变成算不了(如表格里补了一笔更早的卖出,之后那笔已记的卖出就超了);
 *   - `import`:把勾选的行一次写进台账,**要么全写、要么全不写**,写之前先备份到 `ledger/持仓导入备份-日期/`。
 *
 * 🔴 每次真要写之前,先把 position.json / trade.json 原样复制到 `ledger/持仓迁移备份-日期/`,附恢复说明。
 * 🔴 先写流水、回读确认在了,再删旧记录;删之前旧记录被别处改过(Agent / MCP 同时在写)就撤回刚写的流水、留到下次。
 *    中途断掉留下「流水已写、旧记录还在」的,下次迁移只删旧记录(数量、成本对得上才删,对不上算冲突)。
 * 🔴 同一代码已经有用户自己录的流水:不自动转(可能是同一笔持仓记了两遍,也可能是另一个账户),留给用户选。
 * ⚠️ 旧记录没写建立日期的,按迁移当天记,并在备注里写明 —— 收益率从这天算起,用户可以改日期。
 */
import fs from "node:fs";
import path from "node:path";
import { localClock } from "../notify.ts";
import type { LedgerIssue, LedgerRecord } from "../ledger.ts";
import { ServiceError, ledgerCheck, ledgerInsertMany, ledgerList, ledgerRemove, ledgerSnapshot, ledgerUpsert, runTool, safePath, type ServiceContext } from "../service.ts";
import { SCHEDULE_TZ } from "./schedule.ts";
import { COST_METHODS, replayOrder, replayTrades, tradeOf, tradeProblem, type CostMethod, type ReplayResult, type Trade } from "./holdings.ts";

export const BACKUP_PREFIX = "持仓迁移备份";
export const IMPORT_BACKUP_PREFIX = "持仓导入备份";
/** 一次最多导入多少行:再多请分几份(也防请求体过大) */
export const IMPORT_MAX = 1000;
/** 导入只收这些字段;其余(id、时间戳、migrated_from 等)一律丢掉 */
const IMPORT_FIELDS = ["symbol", "name", "type", "date", "shares", "price", "fee", "amount", "ratio", "note"] as const;
const MIGRATED_NOTE = "从旧持有记录迁移";
const UNDATED_NOTE = "旧记录没写建立日期,按迁移当天记";
const NOTE_MAX = 1000;

export type LegacyState = "pending" | "stale" | "conflict" | "skipped";
export interface LegacyPosition {
  id: string; symbol: string; name: string; shares: number | null; cost: number | null; opened_at: string;
  /** pending = 下次自动迁移;stale = 流水已写、旧记录待删;conflict = 要用户选;skipped = 数据不对没法迁 */
  state: LegacyState; why: string;
  /** 已经按它转过的那笔期初持仓(之后旧记录又改了)。确认转换时会**替换**这笔,不是再补一笔 */
  migrated_trade: string | null;
}
export interface HoldingsView extends ReplayResult {
  method_label: string;
  methods: { id: CostMethod; label: string }[];
  /** 全部流水,按重放顺序(界面列表用) */
  trades: Trade[];
  legacy: LegacyPosition[];
  /** 自动迁移能处理的条数(pending + stale);> 0 时界面调一次 migrate */
  migration_pending: number;
  today: string;
}
export interface MigrationResult {
  backup: string | null;
  migrated: { position_id: string; trade_id: string; symbol: string }[];
  removed_stale: string[];
  failed: { position_id: string; symbol: string; why: string }[];
}
/** 导入预览的一行(与传进来的行一一对应) */
export interface ImportPreviewRow {
  /** 这一行自身的数据不对(写不进去);null = 没问题 */
  problem: string | null;
  /** existing = 和台账里已有的一笔完全一样;table = 和表格里前面某一行一样(duplicate_of 是那一行的下标) */
  duplicate: "existing" | "table" | null;
  duplicate_of: number | null;
  /** 按勾选的行写进去以后,重放时这一笔会被跳过的原因(如卖出超过当时持有);null = 能算 */
  skip_reason: string | null;
}
/** 导入预览:逐行结果 + 已记的流水里会因为这批新流水变成算不了的(写进去之前能算、写进去以后不能算) */
export interface ImportPreview { rows: ImportPreviewRow[]; existing_issues: { id: string; symbol: string; date: string; type: string; why: string }[] }
export interface ImportResult { backup: string; imported: number; ids: string[] }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const today = (now: Date) => localClock(now, SCHEDULE_TZ).day;

function methodOf(raw: unknown): CostMethod {
  if (raw === undefined || raw === "") return "average";
  if (raw === "fifo" || raw === "average") return raw;
  throw new ServiceError("bad_request", `成本法只能是 fifo(先进先出)或 average(移动加权平均),收到 ${JSON.stringify(raw)}`);
}

/** 旧持有记录 → 期初持仓流水(不含信封字段) */
export function openingFrom(pos: LedgerRecord, day: string): Record<string, unknown> {
  const opened = str(pos.opened_at);
  const tag = opened ? MIGRATED_NOTE : `${MIGRATED_NOTE};${UNDATED_NOTE}`;
  const base = str(pos.note);
  const note = base ? `${base.slice(0, NOTE_MAX - tag.length - 1)}\n${tag}` : tag;
  const out: Record<string, unknown> = {
    symbol: str(pos.symbol), type: "opening", date: opened || day, shares: num(pos.shares), price: num(pos.cost), note, migrated_from: pos.id,
  };
  if (str(pos.name)) out.name = str(pos.name);
  if (str(pos.account)) out.account = str(pos.account);
  return out;
}

/** 每条旧持有记录归哪一类(纯函数) */
export function classifyLegacy(positions: readonly LedgerRecord[], positionIssues: readonly LedgerIssue[], trades: readonly LedgerRecord[]): LegacyPosition[] {
  const issueOf = new Map(positionIssues.map((i) => [i.id, i.why]));
  const byOrigin = new Map<string, LedgerRecord>();
  for (const t of trades) if (str(t.migrated_from)) byOrigin.set(str(t.migrated_from), t);
  const usable = (p: LedgerRecord) => !byOrigin.has(p.id) && !issueOf.has(p.id) && !!str(p.symbol) && (num(p.shares) ?? 0) > 0 && num(p.cost) !== null;
  const sameSymbol = new Map<string, number>();
  for (const p of positions) if (usable(p)) sameSymbol.set(str(p.symbol), (sameSymbol.get(str(p.symbol)) ?? 0) + 1);
  return positions.map((p) => {
    const base = { id: p.id, symbol: str(p.symbol), name: str(p.name), shares: num(p.shares), cost: num(p.cost), opened_at: str(p.opened_at), migrated_trade: null };
    const done = byOrigin.get(p.id);
    if (done) {
      const same = str(done.symbol) === base.symbol && num(done.shares) === base.shares && num(done.price) === base.cost;
      return same
        ? { ...base, state: "stale" as const, why: "已经转成期初持仓流水,旧记录待删" }
        : { ...base, migrated_trade: done.id, state: "conflict" as const,
          why: "已经按它转过一笔期初持仓,但旧记录之后的数量或成本和那笔对不上:可以按旧记录现在的数替换那笔,或者删掉这条旧记录、保留那笔" };
    }
    if (issueOf.has(p.id)) return { ...base, state: "skipped" as const, why: `字段不合台账规则(${issueOf.get(p.id)}),请先在台账里改好` };
    if (!base.symbol) return { ...base, state: "skipped" as const, why: "没有代码" };
    if (!(base.shares !== null && base.shares > 0)) return { ...base, state: "skipped" as const, why: "数量是 0,不算持有;不需要可以直接删掉" };
    if (base.cost === null) return { ...base, state: "skipped" as const, why: "没有成本" };
    // 🔴 旧版一只只有一条(加仓是合并进去的);同一代码再冒出来的持有记录多半来自截图导入 / 对话写入,
    //    记的常是**总持仓** —— 自动加进去就成了双倍。已有流水(含别的旧记录迁来的期初)或同代码多条,都留给用户定
    if (trades.some((t) => str(t.symbol) === base.symbol && str(t.migrated_from) !== p.id)) return { ...base, state: "conflict" as const, why: "这个代码已经有交易流水:这条可能是截图里的总持仓,或同一笔记了两遍,请确认要不要按它补一笔期初持仓" };
    if ((sameSymbol.get(base.symbol) ?? 0) > 1) return { ...base, state: "conflict" as const, why: `这个代码有 ${sameSymbol.get(base.symbol)} 条旧持有记录:可能是重复录入,请选一条补期初持仓、删掉其余` };
    return { ...base, state: "pending" as const, why: "" };
  });
}

export async function holdingsView(ctx: ServiceContext, query: Record<string, string>, _signal?: AbortSignal, now = new Date()): Promise<HoldingsView> {
  return buildView(ctx, methodOf(query.method), now);
}

function buildView(ctx: ServiceContext, method: CostMethod, now: Date): HoldingsView {
  const snap = ledgerSnapshot(ctx);
  const tradeRecs = snap.records.trade ?? [];
  const bad = new Map((snap.issues.trade ?? []).map((i) => [i.id, i.why]));
  const all = tradeRecs.map(tradeOf);
  const result = replayTrades(all.filter((t) => !bad.has(t.id)), method);
  // 字段不合台账规则的流水(手改了文件)同样逐条说原因、不参与计算
  for (const t of all) if (bad.has(t.id)) result.issues.push({ id: t.id, symbol: t.symbol, date: t.date, type: t.type, why: `字段不合台账规则:${bad.get(t.id)}` });
  const legacy = classifyLegacy(snap.records.position ?? [], snap.issues.position ?? [], tradeRecs);
  return {
    ...result,
    method_label: COST_METHODS[method],
    methods: (Object.keys(COST_METHODS) as CostMethod[]).map((id) => ({ id, label: COST_METHODS[id] })),
    trades: [...all].sort(replayOrder),
    legacy,
    migration_pending: legacy.filter((l) => l.state === "pending" || l.state === "stale").length,
    today: today(now),
  };
}

/**
 * 收益率(时间加权 / 资金加权):读台账里的交易流水,交给 `backtest.portfolio_perf` 按日估值。
 *
 * 🔴 流水在服务端读,不经界面转发:与持仓明细是同一份数据;流水多了也不会撞上请求体上限。
 * 🔴 字段不合台账规则的流水不送去算(持仓明细里已经逐条列了原因);还没迁移的旧持有记录没有交易日期,也不算。
 */
export async function holdingsPerf(ctx: ServiceContext, _query: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const snap = ledgerSnapshot(ctx);
  const bad = new Set((snap.issues.trade ?? []).map((i) => i.id));
  const trades = (snap.records.trade ?? []).filter((r) => !bad.has(r.id)).map(tradeOf)
    .map(({ id, symbol, name, type, date, shares, price, fee, amount, ratio, created_at }) => ({ id, symbol, name, type, date, shares, price, fee, amount, ratio, created_at }));
  return runTool(ctx, "perf", { trades, charts: true }, signal);
}

/** 备份文件夹名:`持仓迁移备份-YYYY-MM-DD`(导入是 `持仓导入备份-…`),同一天已有就加时分秒,再撞加序号 */
function backupDir(ctx: ServiceContext, now: Date, prefix: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  const names = [`${prefix}-${day}`, `${prefix}-${day}-${p.hour}${p.minute}${p.second}`];
  for (let i = 2; i < 100; i++) names.push(`${prefix}-${day}-${p.hour}${p.minute}${p.second}-${i}`);
  for (const n of names) {
    const dir = safePath(ctx, "ledger", n);
    if (!fs.existsSync(dir)) return dir;
  }
  throw new ServiceError("backup_failed", "备份文件夹名用尽,请清理 ledger 里的旧备份后再试");
}

function backup(ctx: ServiceContext, now: Date, why: string, prefix = BACKUP_PREFIX): string {
  const dir = backupDir(ctx, now, prefix);
  fs.mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  for (const f of ["position.json", "trade.json"]) {
    const src = safePath(ctx, "ledger", f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, f), fs.constants.COPYFILE_EXCL); copied.push(f); }
  }
  const at = localClock(now, SCHEDULE_TZ);
  const lines = [
    `# ${prefix}`, "",
    `时间:${at.day} ${at.hm}(${SCHEDULE_TZ})`,
    `原因:${why}`, "",
    "这个文件夹里是改动前的原样文件:",
    ...copied.map((f) => `- ${f}${f === "position.json" ? ":旧持有记录(一只一条:数量 + 均价)" : ":改动前的交易流水"}`),
    ...(copied.includes("trade.json") ? [] : ["- (改动前还没有交易流水,所以没有 trade.json)"]),
    "",
    "恢复:先退出 Vibe Research,把这里的文件复制回上一级 ledger 文件夹、覆盖同名文件;"
      + (copied.includes("trade.json") ? "" : "改动前没有 trade.json 的,把 ledger 里的 trade.json 删掉;") + "再打开就回到改动前。",
    "",
  ];
  fs.writeFileSync(path.join(dir, "README.md"), lines.join("\n"), { flag: "wx" });
  return path.relative(path.resolve(ctx.dataRoot), dir).split(path.sep).join("/");
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 一条旧记录转成期初流水;成功返回流水 id,失败返回原因(已撤回)。
 * `replace` = 以前按它转过的那笔期初:**原地改写**这一笔(一次写盘),不新增再删旧的 ——
 * 新增 + 删旧是两次写,中间出错或进程退出就留下两笔期初,持仓被加成两份(审计第二轮 B3)。
 * 改写之后、删旧记录之前退出也不怕:流水已经和旧记录一致,下次打开归为「已转过」,自动删旧记录。
 */
export function convertOne(ctx: ServiceContext, pos: LedgerRecord, day: string, replace?: LedgerRecord): { trade_id: string } | { why: string } {
  let created: LedgerRecord;
  try {
    created = ledgerUpsert(ctx, { kind: "trade", record: replace ? { ...openingFrom(pos, day), id: replace.id } : openingFrom(pos, day) });
  } catch (e) {
    return { why: `写入流水失败:${e instanceof Error ? e.message : String(e)}` };
  }
  const back = (ledgerList(ctx, "trade").trade ?? []).find((t) => t.id === created.id);
  if (!back || str(back.migrated_from) !== pos.id) return { why: "流水写入后回读不到,旧记录没删" };
  const now = (ledgerList(ctx, "position").position ?? []).find((p) => p.id === pos.id);
  if (!now || !sameJson(now, pos)) {
    // 撤回:新增的删掉;原地改写的写回原样
    if (replace) ledgerUpsert(ctx, { kind: "trade", record: { ...replace } });
    else ledgerRemove(ctx, { kind: "trade", id: created.id });
    return { why: now ? "迁移时这条旧记录被别处改了,已撤回,下次再迁" : "迁移时这条旧记录被别处删了,已撤回" };
  }
  ledgerRemove(ctx, { kind: "position", id: pos.id });
  return { trade_id: created.id };
}

/**
 * 自动迁移:pending 转成期初流水,stale 删旧记录。没有要做的就什么都不写(也不备份)。
 *
 * ⚠️ 整个迁移同步执行(中间没有 await):同一个进程里两个请求(两个标签页同时打开、开发模式下页面加载两次)
 *    会一个接一个跑,后一个看到的已经迁完。只有两个进程同时迁移同一份数据才可能各写一笔期初 ——
 *    台账新增时不能指定 id,没法靠固定 id 去重;真碰上了在流水列表里删掉多的那笔。
 */
export function migrateLegacy(ctx: ServiceContext, now = new Date()): MigrationResult {
  const snap = ledgerSnapshot(ctx);
  const positions = snap.records.position ?? [];
  const legacy = classifyLegacy(positions, snap.issues.position ?? [], snap.records.trade ?? []);
  const todo = legacy.filter((l) => l.state === "pending" || l.state === "stale");
  const out: MigrationResult = { backup: null, migrated: [], removed_stale: [], failed: [] };
  if (!todo.length) return out;
  out.backup = backup(ctx, now, "持仓改成按交易流水计算,旧持有记录转成「期初持仓」流水");
  const day = today(now);
  for (const l of todo) {
    const pos = positions.find((p) => p.id === l.id)!;
    if (l.state === "stale") {
      const cur = (ledgerList(ctx, "position").position ?? []).find((p) => p.id === pos.id);
      if (cur && sameJson(cur, pos)) { ledgerRemove(ctx, { kind: "position", id: pos.id }); out.removed_stale.push(pos.id); }
      continue;
    }
    const r = convertOne(ctx, pos, day);
    if ("trade_id" in r) out.migrated.push({ position_id: pos.id, trade_id: r.trade_id, symbol: l.symbol });
    else out.failed.push({ position_id: pos.id, symbol: l.symbol, why: r.why });
  }
  return out;
}

function findLegacy(ctx: ServiceContext, id: unknown): { pos: LedgerRecord; info: LegacyPosition; issue: string | null } {
  if (typeof id !== "string" || !id) throw new ServiceError("bad_request", "要给出旧持有记录的 id");
  const snap = ledgerSnapshot(ctx);
  const pos = (snap.records.position ?? []).find((p) => p.id === id);
  if (!pos) throw new ServiceError("not_found", "没有这条旧持有记录(可能已经迁移或删除)");
  const info = classifyLegacy([pos], snap.issues.position ?? [], snap.records.trade ?? [])[0]!;
  return { pos, info, issue: (snap.issues.position ?? []).find((i) => i.id === pos.id)?.why ?? null };
}

/** 用户确认:冲突的这条照样转成期初持仓 */
export function adoptLegacy(ctx: ServiceContext, id: unknown, now = new Date()): MigrationResult {
  const { pos, info, issue } = findLegacy(ctx, id);
  if (info.state === "skipped") throw new ServiceError("bad_request", `这条旧记录没法转:${info.why}`);
  if (info.state === "stale") throw new ServiceError("bad_request", "这条已经转过了,旧记录会在下次打开持仓页时删掉");
  // 🔴 「已转过一笔、旧记录后来被改了」这种冲突在分类时**先于**数量 / 成本检查返回,
  //    这里必须补查一遍:旧记录被改成 0 股时照样往下走,会先删掉原来那笔期初、新的又写不进去(审计 B3)
  if (issue) throw new ServiceError("bad_request", `这条旧记录没法转:字段不合台账规则(${issue}),请先在台账里改好`);
  if (!info.symbol) throw new ServiceError("bad_request", "这条旧记录没法转:没有代码");
  if (!(info.shares !== null && info.shares > 0)) throw new ServiceError("bad_request", "这条旧记录没法转:数量是 0,不算持有;不需要可以直接删掉");
  if (info.cost === null) throw new ServiceError("bad_request", "这条旧记录没法转:没有成本");
  const out: MigrationResult = { backup: backup(ctx, now, `用户确认把旧持有记录 ${info.symbol} 转成期初持仓流水`), migrated: [], removed_stale: [], failed: [] };
  // 已按它转过、之后旧记录又被改了(conflict 的另一种):原地改写原来那笔期初(见 convertOne)。
  // 写不进去时原来那笔原样还在;不止一笔(以前两个进程同时迁移留下的)时改写第一笔、删掉多的
  const previous = (ledgerList(ctx, "trade").trade ?? []).filter((t) => str(t.migrated_from) === pos.id);
  const r = convertOne(ctx, pos, today(now), previous[0]);
  if ("trade_id" in r) {
    for (const t of previous.slice(1)) ledgerRemove(ctx, { kind: "trade", id: t.id });
    out.migrated.push({ position_id: pos.id, trade_id: r.trade_id, symbol: info.symbol });
  } else out.failed.push({ position_id: pos.id, symbol: info.symbol, why: r.why });
  return out;
}

/** 用户确认:不要这条旧记录(先备份再删) */
export function discardLegacy(ctx: ServiceContext, id: unknown, now = new Date()): MigrationResult {
  const { pos, info } = findLegacy(ctx, id);
  const out: MigrationResult = { backup: backup(ctx, now, `用户确认删除旧持有记录 ${info.symbol}`), migrated: [], removed_stale: [], failed: [] };
  ledgerRemove(ctx, { kind: "position", id: pos.id });
  out.removed_stale.push(pos.id);
  return out;
}

/* ---------------- 从表格导入 ---------------- */

/** 传进来的行 → 只留导入字段的记录。不是对象、行数不对直接拒 */
function importRows(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ServiceError("bad_request", "没有要导入的流水");
  if (raw.length > IMPORT_MAX) throw new ServiceError("bad_request", `一次最多导入 ${IMPORT_MAX} 行,这次有 ${raw.length} 行:请分成几份`);
  return raw.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new ServiceError("bad_request", `第 ${i + 1} 条不是一笔流水`);
    const out: Record<string, unknown> = {};
    for (const k of IMPORT_FIELDS) if ((r as Record<string, unknown>)[k] !== undefined) out[k] = (r as Record<string, unknown>)[k];
    return out;
  });
}

/** 这一行能不能存:台账字段规则 + 重放要的字段(和手动记一笔同一套检查) */
function rowProblem(ctx: ServiceContext, rec: Record<string, unknown>, t: Trade): string | null {
  return tradeProblem(t) ?? (ledgerCheck(ctx, "trade", rec) === null ? null : `字段不合台账规则:${ledgerCheck(ctx, "trade", rec)}`);
}

/** 判断「同一笔」:代码、类型、日期,加这一类要的数(没写费用和费用 0 算一样) */
function sameTradeKey(t: Trade): string {
  const n = (v: number | null) => (v === null ? "" : String(v));
  const nums = t.type === "buy" || t.type === "sell" ? [n(t.shares), n(t.price), n(t.fee ?? 0)]
    : t.type === "opening" ? [n(t.shares), n(t.price)]
    : t.type === "dividend" ? [n(t.amount)]
    : t.type === "split" ? [n(t.ratio)] : [];
  return [t.symbol.toUpperCase(), t.type, t.date, ...nums].join("|");
}

/** 导入行 → 重放用的流水。id、录入时间是占位:排在已有流水之后、按表格顺序(与真正写入时的先后一致) */
const importTrade = (rec: Record<string, unknown>, i: number): Trade =>
  tradeOf({ ...rec, id: `import:${i}`, kind: "trade", created_at: `~${String(i).padStart(5, "0")}`, updated_at: "" } as LedgerRecord);

export function previewImport(ctx: ServiceContext, rawRows: unknown, rawSelected?: unknown): ImportPreview {
  const rows = importRows(rawRows);
  const snap = ledgerSnapshot(ctx);
  const bad = new Set((snap.issues.trade ?? []).map((i) => i.id));
  const existing = (snap.records.trade ?? []).map(tradeOf);
  const existingKeys = new Set(existing.map(sameTradeKey));
  const trades = rows.map(importTrade);
  const seen = new Map<string, number>();
  const out: ImportPreviewRow[] = rows.map((rec, i) => {
    const t = trades[i]!;
    const key = sameTradeKey(t);
    const first = seen.get(key);
    if (first === undefined) seen.set(key, i);
    return {
      problem: rowProblem(ctx, rec, t),
      duplicate: existingKeys.has(key) ? "existing" : first !== undefined ? "table" : null,
      duplicate_of: existingKeys.has(key) || first === undefined ? null : first,
      skip_reason: null,
    };
  });
  // 勾选哪些由界面决定;没给就按默认:数据对、且不和已记的重复
  const sel = Array.isArray(rawSelected) && rawSelected.length === rows.length
    ? rawSelected.map((v) => v === true)
    : out.map((r) => r.problem === null && r.duplicate !== "existing");
  const chosen = trades.filter((_, i) => sel[i] && out[i]!.problem === null);
  const usable = existing.filter((t) => !bad.has(t.id));
  const replay = replayTrades([...usable, ...chosen], "average");
  const why = new Map(replay.issues.map((x) => [x.id, x.why]));
  trades.forEach((t, i) => { if (sel[i] && out[i]!.problem === null) out[i]!.skip_reason = why.get(t.id) ?? null; });
  // 已记的流水:写进去之前能算、写进去以后不能算的,单独列出来(本来就算不了的不重复说)
  const already = new Set(replayTrades(usable, "average").issues.map((x) => x.id));
  const existingIds = new Set(usable.map((t) => t.id));
  const existing_issues = replay.issues.filter((x) => existingIds.has(x.id) && !already.has(x.id));
  return { rows: out, existing_issues };
}

/** 把这些行一次写进台账(先备份)。有一行不对就整批不写,报出第几条 */
export function importTrades(ctx: ServiceContext, rawRows: unknown, now = new Date()): ImportResult {
  const rows = importRows(rawRows);
  const problems = rows.map((rec, i) => rowProblem(ctx, rec, importTrade(rec, i))).map((p, i) => (p ? `第 ${i + 1} 条:${p}` : "")).filter(Boolean);
  if (problems.length) {
    throw new ServiceError("bad_request", `有 ${problems.length} 条数据不对,这次一条都没写:${problems.slice(0, 5).join(";")}${problems.length > 5 ? " …" : ""}`);
  }
  const dir = backup(ctx, now, `从表格导入 ${rows.length} 笔交易流水`, IMPORT_BACKUP_PREFIX);
  const added = ledgerInsertMany(ctx, { kind: "trade", records: rows });
  return { backup: dir, imported: added.length, ids: added.map((r) => r.id) };
}

/** 旧持有记录的三个动作:migrate / adopt / discard */
export async function legacyAct(ctx: ServiceContext, body: Record<string, unknown>, _signal?: AbortSignal, now = new Date()): Promise<{ result: MigrationResult; view: HoldingsView }> {
  const method = methodOf(body.method);
  const action = body.action;
  const result = action === "migrate" ? migrateLegacy(ctx, now)
    : action === "adopt" ? adoptLegacy(ctx, body.id, now)
    : action === "discard" ? discardLegacy(ctx, body.id, now)
    : (() => { throw new ServiceError("bad_request", `不认识的动作 ${JSON.stringify(action)}(只有 migrate / adopt / discard / import_preview / import)`); })();
  return { result, view: buildView(ctx, method, now) };
}

/** `POST /view/holdings` 的入口:导入两个动作在这里,其余交给 legacyAct */
export async function holdingsAct(ctx: ServiceContext, body: Record<string, unknown>, signal?: AbortSignal, now = new Date()): Promise<unknown> {
  if (body.action === "import_preview") {
    const p = previewImport(ctx, body.rows, body.selected);
    return { preview: p.rows, existing_issues: p.existing_issues };
  }
  if (body.action === "import") {
    const method = methodOf(body.method);
    const imported = importTrades(ctx, body.rows, now);
    return { imported, view: buildView(ctx, method, now) };
  }
  return legacyAct(ctx, body, signal, now);
}
