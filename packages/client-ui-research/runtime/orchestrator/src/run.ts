#!/usr/bin/env node
/**
 * 薄编排器 CLI 入口。
 * 用法:node orchestrator/src/run.ts --symbol 300308 [--run-id X] [--python /path/python]
 *      [--provider <AI 来源>](cli-claude / cli-codex / cli-codebuddy = 本机已登录的订阅 Agent;其余 = providers/<id>.json 模型 API 模板,
 *                             key 从模板声明的环境变量读)。不传就用后台默认(<数据根>/config.json 的 provider.profile 或环境变量 VRA_PROVIDER);
 *                             都没有就报错 —— 产品不替你选大脑
 *      [--model m](只对模型 API 有效;本机订阅 Agent 的模型由已登录的 CLI 自己决定,产品不传模型参数)
 *      [--max-retries 2] [--gate-retries 2] [--turn-timeout-min 30] [--stages profile,financials] [--no-agent] [--overwrite]
 *      [--scenario scenario.json](故障注入:fail_scripts / timeout_scripts / inject_evidence / knowledge / induce_text)
 *      [--config <用户配置.json>](默认读 vibe-research.config.json + <数据根>/config.json + 环境变量 VRA_*)
 *      [--endpoints full|core](full = 注册表全部启用端点(默认);core = 仅 Phase 0 的 8 个 legacy 脚本)
 *      [--knowledge on|off](默认 on:召回 .local/knowledge 里该主体的档案注入提示词)[--no-archive](不生成 viewer / 附录、不归档知识层)
 *      [--progress on|off](默认 on:把阶段进度与各阶段 summary 实时打到 **stderr**;stdout 的 JSON 契约不变)
 *      [--seed-from <夹具目录>] [--allow-stale-fixture](**仅硬测试用**:播种前几个阶段的产物并跳过它们;播种运行按测试运行隔离,不进知识层)
 * 由服务层拉起时,AI 来源由环境变量 VRA_REQUEST_LLM_META 显式给出(见 runtime_provider.ts),不再读后台默认。
 * 退出码:0 complete / 2 incomplete|stale / 3 failed 或编排异常。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeConfig, secretsFor, type RunConfig, type Scenario, type Stage } from "./config.ts";
import { directCapabilities, localAgentCapabilities, type EngineCapabilities, type EngineRuntime } from "./engine.ts";
import { DirectStageAgent } from "./engines/direct_stage_agent.ts";
import { LocalAgentStageAgent } from "./engines/local_agent_stage_agent.ts";
import { NoAgentRunner, type AgentRunner } from "./agent_runner.ts";
import { runFetchScripts } from "./fetchrun.ts";
import { watchResearchCancellation, updateResearchControl, isResearchCancellation } from "./research_control.ts";
import { ProgressReporter } from "./progress.ts";
import { runResearch, type Deps } from "./orchestrate.ts";
import { loadProductConfig } from "./productConfig.ts";
import { REQUEST_LLM_META_VAR, parseRequestLlmMeta, resolveRuntimeProvider, resolveSelectedRuntime, type ResolvedRuntimeProvider } from "./runtime_provider.ts";
import { loadSavedAgentPaths, probeClaude, probeCodeBuddy, probeCodex, type LocalAgentId, type LocalAgentStatus } from "./local_agent_runtime.ts";
import { isStage } from "./schemas.ts";
import { verifyCalcs } from "./validator.ts";


// **composition root**:插件在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
import "./finance/register.ts";
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    // --key=value 与 --key value 等价。不拆开的话 `--engine=codex` 会变成一个叫「engine=codex」的参数,躲过旧参数拒绝
    const eq = a.indexOf("=");
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** 带了就必须有值:`--provider=` 或裸 `--provider` 不能悄悄退回后台默认 —— 用户以为生效的设置其实没生效。 */
export function optionValue(args: Record<string, string | boolean>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new Error(`--${name} 需要一个值`);
  return v;
}

/**
 * 数值参数:abc、空值、负数直接报错,不让 NaN 流进超时 / 重试逻辑。
 * 次数(`count`)只收整数:0.5 次重试会让循环多跑一轮,"最后一次"的判断还永远对不上(Codex 复审 R3-4);超时分钟可以带小数。
 */
export function numberOption(args: Record<string, string | boolean>, name: string, kind: "count" | "positive"): number | undefined {
  const v = optionValue(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  const ok = Number.isFinite(n) && (kind === "count" ? Number.isInteger(n) && n >= 0 : n > 0);
  if (!ok) throw new Error(`--${name} 需要${kind === "count" ? "不小于 0 的整数" : "大于 0 的数字"},收到 ${v}`);
  return n;
}

/**
 * v1 的参数在 v2 里已经没有意义。**一律报错并说清楚改成什么**:悄悄忽略会让用户以为
 * 自己指定的引擎 / 认证方式生效了,实际跑的却是另一个大脑。
 */
const REMOVED_FLAGS: Record<string, string> = {
  "codex-path": "v2 不再内置 Codex 引擎;要用 Codex 订阅请装好 Codex CLI 并 codex login,然后 --provider cli-codex",
  "codex-home": "v2 不再有产品专用的 CODEX_HOME;cli-codex 直接用你自己的 Codex 登录(CODEX_HOME 环境变量照常生效)",
  "no-hooks": "v2 没有引擎钩子;收工检查由产品自己执行,对所有大脑都生效,不能关闭",
  "execution-mode": "v2 所有大脑都只走产品受控工具,不再区分 shell_hooks / controlled_mcp",
  "engine": "v2 用 --provider 选大脑:cli-claude / cli-codex / cli-codebuddy 或 providers/ 里的模型 API 模板 id",
  "experimental-direct-deep": "模型 API 现在是正式的六阶段大脑,用 --provider <模板 id> 即可,不需要实验开关",
  "auth": "v2 的认证方式由 AI 来源决定:本机订阅 Agent 用你自己的 CLI 登录,模型 API 用模板声明的环境变量里的 key",
  "reasoning": "v2 不再转发推理档位;模型 API 用模板默认,本机订阅 Agent 由各 CLI 按自身默认决定(产品以隔离参数启动,Codex 不读你的 config.toml)",
};

/** 研究与批量两个入口共用:带了 v1 参数就报错并说清楚改成什么 */
export function assertNoRemovedFlags(args: Record<string, string | boolean>): void {
  for (const [flag, hint] of Object.entries(REMOVED_FLAGS)) {
    if (args[flag] !== undefined) throw new Error(`--${flag} 已在 v2.0 移除:${hint}`);
  }
}

/** 配置优先级:内置默认 ← 产品配置文件 ← 用户配置文件 ← 环境变量 ← CLI 参数 */
function parseScope(v: string | undefined): "core" | "full" {
  if (v === undefined || v === "full") return "full";
  if (v === "core") return "core";
  throw new Error(`--endpoints 只能是 full 或 core,收到 ${v}`);
}

/** 解析出的大脑 → RunConfig 里对应的几个字段(不含 key) */
function engineFields(runtime: ResolvedRuntimeProvider | null, explicitModel: string | undefined): Partial<RunConfig> {
  if (!runtime) return { engine: "none" };
  if (runtime.runtime === "local-agent") return { engine: "local_agent", localAgent: runtime.agent };
  const { api } = runtime;
  return {
    engine: "direct",
    api: { provider: api.name, label: api.label, baseURL: api.baseURL, model: api.model,
      structuredOutput: api.structuredOutput, verified: api.verified, envKey: api.envKey },
    ...(explicitModel ? { model: explicitModel } : {}),
  };
}

export function configFromArgs(args: Record<string, string | boolean>, env: NodeJS.ProcessEnv = process.env): { cfg: RunConfig; stages?: Stage[]; sources: string[]; progress: boolean } {
  if (!str(args.symbol)) throw new Error("缺少 --symbol");
  assertNoRemovedFlags(args);
  let scenario: Scenario | null = null;
  if (str(args.scenario)) scenario = JSON.parse(fs.readFileSync(str(args.scenario)!, "utf8")) as Scenario;
  const repoRoot = str(args["repo-root"]) ?? repoRootFromHere();
  const providerOverride = optionValue(args, "provider");
  const pc = loadProductConfig(repoRoot, { userConfigPath: str(args.config), env, providerOverride });
  const dataRoot = pc.resolved.dataRoot;
  const noAgent = args["no-agent"] === true;
  const requestMeta = String(env[REQUEST_LLM_META_VAR] ?? "").trim();
  const cliModel = optionValue(args, "model");
  // 干跑不解析大脑:没配 AI 来源、缺 key 都不影响只跑编排与校验
  let runtime: ResolvedRuntimeProvider | null = null;
  let explicitModel: string | undefined;
  if (!noAgent && requestMeta) {
    if (providerOverride !== undefined) throw new Error("请求级 AI 来源(由服务层给出)不能再用 --provider 覆盖");
    const llm = parseRequestLlmMeta(requestMeta, env);
    if (cliModel !== undefined) llm.model = cliModel;
    runtime = resolveRuntimeProvider(repoRoot, dataRoot, llm, env);
    explicitModel = llm.model;
  } else if (!noAgent) {
    runtime = resolveSelectedRuntime(repoRoot, dataRoot, undefined, env, { providerOverride, model: cliModel, userConfigPath: str(args.config) });
    explicitModel = cliModel ?? pc.defaults.model ?? undefined;
  }
  if (runtime?.runtime === "local-agent" && cliModel !== undefined) {
    throw new Error("本机订阅 Agent 的模型由已登录的 CLI 自己决定（产品不传模型参数），不能用 --model 覆盖");
  }
  const d = pc.defaults;
  const taskObjective = String(env.VRA_TASK_OBJECTIVE ?? "").trim();
  if (taskObjective.length > 8_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(taskObjective)) {
    throw new Error("VRA_TASK_OBJECTIVE 格式无效");
  }
  const reportIds = String(env.VRA_TASK_REPORT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (reportIds.length > 16 || new Set(reportIds).size !== reportIds.length ||
      reportIds.some((id) => !/^[0-9a-f]{32}$/.test(id))) throw new Error("VRA_TASK_REPORT_IDS 格式无效");
  let reportRevisions: Record<string, string> = {};
  try {
    const parsed = JSON.parse(String(env.VRA_TASK_REPORT_REVISIONS ?? "{}")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("not object");
    reportRevisions = { ...(parsed as Record<string, string>) };
  } catch { throw new Error("VRA_TASK_REPORT_REVISIONS 格式无效"); }
  if (Object.keys(reportRevisions).length !== reportIds.length ||
      reportIds.some((id) => !Object.hasOwn(reportRevisions, id) || !/^[a-f0-9]{64}$/.test(String(reportRevisions[id] ?? ""))) ||
      Object.keys(reportRevisions).some((id) => !reportIds.includes(id))) {
    throw new Error("VRA_TASK_REPORT_REVISIONS 格式无效");
  }
  const cfg = makeConfig({
    symbol: str(args.symbol)!,
    companyName: str(args["company-name"]),
    ...(taskObjective ? { taskObjective } : {}),
    ...(reportIds.length ? { reportIds } : {}),
    ...(reportIds.length ? { reportRevisions } : {}),
    market: str(args.market) ?? "",
    repoRoot,
    dataRoot,
    runId: str(args["run-id"]),
    python: str(args.python) ?? pc.python ?? undefined,
    scriptsRel: pc.resolved.scriptsRel,
    calcCliRel: pc.paths.calc_cli,
    ...engineFields(runtime, explicitModel),
    maxRetries: numberOption(args, "max-retries", "count") ?? d.max_retries,
    gateRetries: numberOption(args, "gate-retries", "count") ?? d.gate_retries,
    turnTimeoutMs: (numberOption(args, "turn-timeout-min", "positive") ?? d.turn_timeout_min) * 60_000,
    fetchTimeoutMs: d.fetch_timeout_sec * 1000,
    noAgent,
    overwrite: args.overwrite === true,
    scenario,
    endpointScope: parseScope(str(args.endpoints)),
    knowledgeRecall: str(args.knowledge) === undefined ? true : str(args.knowledge) === "on",
    knowledgeArchive: args["no-archive"] !== true,
    seedFrom: str(args["seed-from"]),
    allowStaleFixture: args["allow-stale-fixture"] === true,
  });
  let stages: Stage[] | undefined;
  if (str(args.stages)) {
    stages = str(args.stages)!.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { if (!isStage(s)) throw new Error(`未知阶段 ${s}`); return s; });
  }
  return { cfg, stages, sources: requestMeta && !noAgent ? [...pc.sources, "request-runtime"] : pc.sources, progress: str(args.progress) !== "off" };
}

const PROBES: Record<LocalAgentId, (env: NodeJS.ProcessEnv) => Promise<LocalAgentStatus>> = {
  claude: probeClaude, codex: probeCodex, codebuddy: probeCodeBuddy,
};

/**
 * **组装根**:按 cfg.engine 配好大脑的 runner 与能力声明,编排器只认契约、不认具体实现。
 * 🔴 前置条件不满足一律**当场抛错、绝不回落到别的大脑** —— 用户以为在用自己选的那个,
 *    账单和产出却来自另一个,而界面上一个字都看不出来。
 */
export async function makeEngine(cfg: RunConfig, eventsPath: string, observer?: (ev: Record<string, unknown>) => void,
  env: NodeJS.ProcessEnv = process.env): Promise<{
  runner: AgentRunner;
  capabilities: EngineCapabilities | null;
  runtime: ReturnType<Deps["sdkVersion"]>;
}> {
  if (cfg.engine === "local_agent") {
    const agent = cfg.localAgent;
    if (!agent) throw new Error("local_agent 引擎缺少本机 Agent 种类");
    // 设置页手动指定的 CLI 位置存在数据根里(#50):研究子进程与页面认同一个 WorkBuddy
    loadSavedAgentPaths(cfg.dataRoot);
    let version: string | null = null;
    try { version = (await PROBES[agent](env)).version; } catch { /* 探测失败不阻断,见下 */ }
    // 探测结果只用于运行记录，不能在这里提前终止：服务层已经把 Deep 任务交给
    // 独立子进程，若在 runResearch 建立 manifest 前抛错，界面只能在宽限期后猜成
    // deep_start_lost。让 runner 的真实调用返回结构化 LocalAgentError，编排器才能把本次
    // 运行立即、明确地收口为 failed。探测与真实请求之间也天然存在登录刚好失效的竞态。
    const runner = new LocalAgentStageAgent({ agent, runId: cfg.runId, runDir: cfg.runDir,
      repoRoot: cfg.repoRoot, python: cfg.python, eventsPath, env, timeoutMs: cfg.turnTimeoutMs, observer });
    const runtime: EngineRuntime = { kind: "local_agent", version: `${agent}/${version ?? "unknown"}`, binary: null, model: null };
    return { runner, capabilities: localAgentCapabilities(), runtime };
  }
  if (cfg.engine === "direct") {
    const api = cfg.api;
    if (!api) throw new Error("模型 API 大脑缺少已解析的端点信息");
    const apiKey = env[api.envKey];
    if (!apiKey) throw new Error(`模型 API 需要密钥:环境变量 ${api.envKey} 是空的(密钥只从环境变量读,不进配置文件)`);
    const runner = new DirectStageAgent({
      runId: cfg.runId,
      toolCtx: { runDir: cfg.runDir, repoRoot: cfg.repoRoot, python: cfg.python },
      api, apiKey, eventsPath,
      secrets: secretsFor(cfg, env),
      requestTimeoutMs: cfg.turnTimeoutMs,
      observer,
    });
    const runtime: EngineRuntime = { kind: "direct", version: `direct-api/${api.provider}/${api.model}`, binary: null, model: api.model };
    return { runner, capabilities: directCapabilities(api.structuredOutput), runtime };
  }
  if (!cfg.noAgent) throw new Error("没有选择 AI 来源:用 --provider 指定,或配置后台默认(见 run.ts 用法)");
  return { runner: new NoAgentRunner(cfg.runId, eventsPath), capabilities: null, runtime: { version: "none", binary: null, model: null } };
}

function engineLabel(cfg: RunConfig): string {
  if (cfg.engine === "local_agent") return `local-agent:${cfg.localAgent}`;
  if (cfg.engine === "direct" && cfg.api) return `api:${cfg.api.provider}/${cfg.api.model}${cfg.api.verified ? "" : "(未实测)"}`;
  return "none(干跑)";
}

async function main(): Promise<number> {
  let cfg: RunConfig, stages: Stage[] | undefined, sources: string[], progress: boolean;
  try { ({ cfg, stages, sources, progress } = configFromArgs(parseArgs(process.argv.slice(2)))); }
  catch (e) { console.error(`参数 / 配置错误:${e instanceof Error ? e.message : String(e)}`); return 3; }
  console.error(`[orchestrator] run ${cfg.runId} → ${cfg.runDir}\n[orchestrator] config sources: ${sources.join(" ← ")}; engine=${engineLabel(cfg)}`);
  // 进度只写 stderr:六阶段要跑十几分钟,没有它用户全程看不到任何内容(见 progress.ts 顶部)。
  // **连构造也要保护**:显示层任何环节出问题都只是"没有进度显示",绝不能让一次真实研究起不来。
  let reporter: ProgressReporter | null = null;
  if (progress) {
    try { reporter = new ProgressReporter({ runDir: cfg.runDir }); }
    catch (e) { console.error(`[orchestrator] 进度显示未启用(不影响研究):${e instanceof Error ? e.message : String(e)}`); }
  }
  const token = process.env.VRA_RESEARCH_CONTROL_TOKEN;
  const control = token ? watchResearchCancellation(cfg.dataRoot, cfg.runId, token) : null;
  try {
  control?.signal.throwIfAborted();
  const { runner, capabilities, runtime } = await makeEngine(cfg, path.join(cfg.runDir, "events.jsonl"), reporter ? (ev) => reporter.onEvent(ev) : undefined);
  control?.check();
  control?.signal.throwIfAborted();
  const res = await runResearch(cfg, { runner, ...(capabilities ? { capabilities } : {}), signal: control?.signal, checkpoint: control?.checkpoint,
    beginFinalization: control?.finalize, fetchRunner: runFetchScripts, verify: verifyCalcs, sdkVersion: () => runtime }, stages);
  if (token) updateResearchControl(cfg.dataRoot, cfg.runId, token, res.status);
  console.log(JSON.stringify({ run_id: cfg.runId, run_dir: cfg.runDir, status: res.status, exit_code: res.exitCode,
    stages: res.manifest.stages.map((s) => ({ stage: s.stage, status: s.status, attempts: s.attempts, validator_ok: s.validator_ok })) }, null, 2));
  return res.exitCode;
  } catch (e) {
    if (token) updateResearchControl(cfg.dataRoot, cfg.runId, token, isResearchCancellation(e, control?.signal) ? "cancelled" : "failed");
    throw e;
  } finally { control?.close(); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(3); });
}
