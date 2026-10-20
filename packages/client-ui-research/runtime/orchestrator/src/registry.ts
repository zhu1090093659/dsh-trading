/**
 * 数据源注册表(datasources/registry.json)读取与阶段计划推导(Phase 1 M1)。
 * core = legacy 8 脚本 + 标了 core:true 的端点(没有 legacy 脚本的区域用它们组最小计划;硬测试默认);full = 注册表里所有启用、市场匹配、声明了 stages 的端点(非 legacy 经 fetch_endpoint.py 通用取数器执行)。
 * 不 import config.ts 的运行时值(避免循环依赖);阶段列表由调用方传入。
 */
import fs from "node:fs";
import path from "node:path";
import { currentPlugin } from "./plugin.ts";

export type ScopeKind = "core" | "full";
export type StageLevel = "required" | "optional";

export interface EndpointDef {
  id: string;
  title?: string;
  layer?: string;
  market: string[];
  source?: string;
  compliance?: string;
  module: string;
  function: string;
  symbol_kind?: "cn6" | "us" | "hk" | "global" | "raw" | "none";
  symbol_param?: string;
  stages?: Record<string, StageLevel>;
  enabled?: boolean;
  critical?: boolean;
  /** 算进 core 作用域(与 legacy 脚本同列);没有 legacy 脚本的区域靠它组最小计划 */
  core?: boolean;
  args?: Record<string, unknown>;
  auth_env?: string;
  mapper?: string;
  mapper_module?: string;
  notes?: string;
  libs?: string[];
  sample?: string;
  /** 产业温度计:只在研究主体命中这些标签(datasources/industry_tags.json)时才取 */
  industry_tags?: string[];
  /** 温度计历史序列:这些证据字段(白名单)在归档时写进用户数据区序列,下次运行生成 _prev / _change_* 比较证据(orchestrator/src/finance/thermo_history.ts) */
  history_fields?: string[];
  /**
   * 快照最多能放多久(秒)。缺省 = 不限(界面打开就用上次的,直到用户点刷新)。
   * 🔴 **产出里含"按此刻算出来"的字段的端点必须写这个**,尤其是 `0` = 从不缓存。
   *    这类字段缓存下来就会被永久冻结:上午算出来的状态,晚上再打开还是它,
   *    而且**永远不会自己好**。垂类里往往有整条逻辑建在这种字段上
   *    (Codex 架构评审 arch-r1 §B)。
   */
  cache_max_age_sec?: number | null;
  /**
   * 这个端点给谁看。缺省 `ui`(界面和 agent 都能用)。
   * `agent` = **界面不展示、只让 AI 调用**(如管制与准入、名单核查)——
   * 🔴 光靠"前端不渲染"守不住:以后任何一个通用端点列表组件都会把它列出来。
   */
  exposure?: "ui" | "agent" | "internal";
  [k: string]: unknown;
}

export interface Registry { version: string; endpoints: EndpointDef[] }
export type StagePlan<S extends string = string> = Record<S, { required: string[]; optional: string[] }>;

export const REGISTRY_REL = path.join("datasources", "registry.json");
export const PLAN_REL = path.join("fetch", "_plan.json");

export function registryPath(repoRoot: string): string {
  return path.join(repoRoot, REGISTRY_REL);
}

/** 读注册表;文件不存在 → null(调用方回退 Phase 0 常量);内容非法 → 抛错(配置错误必须冒泡) */
export function loadRegistry(repoRoot: string): Registry | null {
  const p = registryPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  const reg = JSON.parse(fs.readFileSync(p, "utf8")) as Registry;
  if (!reg || typeof reg.version !== "string" || !Array.isArray(reg.endpoints)) throw new Error(`注册表结构非法:${p}`);
  const stageNames = [...currentPlugin().stages];
  const seen = new Set<string>();
  for (const e of reg.endpoints) {
    if (!e?.id || !e.module || !e.function || !Array.isArray(e.market)) throw new Error(`注册表端点缺字段(id/module/function/market):${JSON.stringify(e).slice(0, 120)}`);
    if (seen.has(e.id)) throw new Error(`注册表端点 id 重复:${e.id}`);
    seen.add(e.id);
    for (const [st, lvl] of Object.entries(e.stages ?? {})) {
      if (lvl !== "required" && lvl !== "optional") throw new Error(`端点 ${e.id} 阶段 ${st} 的级别非法:${String(lvl)}`);
      // 🔴 阶段名也要校验:`buildStagePlan` 用 `includes(st)` 静默跳过未知阶段 ——
      //    拼错一个字母(或插件改名后注册表没跟上),这个端点就**永远不会被执行**,
      //    而运行照样 complete、没有 warning、没有 skip 事件(全审 r2-P1-4)。
      if (!stageNames.includes(st)) throw new Error(`端点 ${e.id} 挂在不存在的阶段 ${st} 上(插件声明的阶段:${stageNames.join(" / ")});拼错的阶段名会让这个端点永远不执行`);
    }
    // 产业温度计端点按标签门控,未命中会被整体跳过 → 只能是 optional(required 会被 validator 判"未执行")
    if (Array.isArray(e.industry_tags) && e.industry_tags.length && Object.values(e.stages ?? {}).includes("required")) throw new Error(`端点 ${e.id} 带 industry_tags 却是 required:按产业标签门控的端点只能 optional`);
    if (e.history_fields !== undefined && !(Array.isArray(e.history_fields) && e.history_fields.length > 0 && e.history_fields.every((x) => typeof x === "string" && /^[a-z0-9_]{1,80}$/.test(x)))) throw new Error(`端点 ${e.id} 的 history_fields 非法:须为非空的小写字段名数组`);
  }
  return reg;
}

/** 运行市场 → 注册表端点作用域标签。映射本身是垂类知识,由契约给(Plugin.marketRegion);未知取值抛错,绝不猜 */
export function regionOf(market: string): string {
  return currentPlugin().marketRegion(market);
}

/** 端点是否落在本次作用域内:启用、区域匹配;core 作用域另要求是 legacy 脚本或标了 core:true */
function inScope(ep: EndpointDef, region: string, scope: ScopeKind): boolean {
  if (ep.enabled === false) return false;
  if (scope === "core" && ep.module !== "legacy" && ep.core !== true) return false;
  return ep.market.includes(region);
}

/** 阶段计划:按注册表顺序;core 只含 legacy 与 core:true;full 含所有启用且市场匹配的端点 */
export function buildStagePlan<S extends string>(reg: Registry, stages: readonly S[], opts: { market: string; scope: ScopeKind }): StagePlan<S> {
  const region = regionOf(opts.market);
  const plan = {} as StagePlan<S>;
  for (const s of stages) plan[s] = { required: [], optional: [] };
  for (const ep of reg.endpoints) {
    if (!inScope(ep, region, opts.scope)) continue;
    for (const [st, lvl] of Object.entries(ep.stages ?? {})) {
      if ((stages as readonly string[]).includes(st)) plan[st as S][lvl].push(ep.id);
    }
  }
  return plan;
}

/**
 * 关键端点(全部失败 → 运行 failed):注册表 critical:true。
 * 🔴 给了运行的市场 / 作用域就**按同一把尺过滤**:别的区域的关键端点本次不会执行、没有账本,
 *    而"全失败"判据见到没执行的关键端点就判不成立 —— 不过滤,加一个别区域的关键端点
 *    就会让本区域的"关键数据全挂 → 运行 failed"静默失效。
 */
export function criticalScripts(reg: Registry, opts?: { market: string; scope: ScopeKind }): string[] {
  const region = opts ? regionOf(opts.market) : null;
  return reg.endpoints
    .filter((e) => e.critical === true && (opts ? inScope(e, region as string, opts.scope) : e.enabled !== false))
    .map((e) => e.id);
}

export function endpointsById(reg: Registry): Record<string, EndpointDef> {
  const out: Record<string, EndpointDef> = {};
  for (const e of reg.endpoints) out[e.id] = e;
  return out;
}

/** 取数命令:legacy → 脚本自身;其余 → fetch_endpoint.py --endpoint <id>(symbol_kind=none 不传 --symbol) */
export function fetchArgv(def: EndpointDef | undefined, script: string, opts: { scriptsDir: string; symbol: string; runDir: string }): string[] {
  if (!def || def.module === "legacy") {
    const file = def?.function ?? `${script}.py`;
    return [path.join(opts.scriptsDir, file), "--symbol", opts.symbol, "--out-dir", opts.runDir];
  }
  const argv = [path.join(opts.scriptsDir, "fetch_endpoint.py"), "--endpoint", def.id, "--out-dir", opts.runDir];
  if (def.symbol_kind !== "none") argv.push("--symbol", opts.symbol);
  return argv;
}

/** 写入运行目录的计划文件(审计 + --no-agent 复核时 validator 读取) */
export interface PlanFile {
  scope: ScopeKind;
  /** 本次运行的区域(插件 marketRegion 的结果);复核时据此选区域契约。旧计划文件没有这个键 */
  region?: string;
  registry_version: string | null;
  stage_plan: StagePlan;
  critical: string[];
  endpoints: Record<string, Pick<EndpointDef, "module" | "symbol_kind" | "title" | "source" | "compliance">>;
}

export function planFileOf(scope: ScopeKind, registryVersion: string | null, plan: StagePlan, critical: string[], endpoints: Record<string, EndpointDef>, region?: string): PlanFile {
  const ids = new Set<string>();
  for (const v of Object.values(plan)) for (const id of [...v.required, ...v.optional]) ids.add(id);
  const epMap: PlanFile["endpoints"] = {};
  for (const id of ids) {
    const d = endpoints[id];
    if (d) epMap[id] = { module: d.module, symbol_kind: d.symbol_kind, title: d.title, source: d.source, compliance: d.compliance };
  }
  return { scope, ...(region === undefined ? {} : { region }), registry_version: registryVersion, stage_plan: plan, critical, endpoints: epMap };
}
