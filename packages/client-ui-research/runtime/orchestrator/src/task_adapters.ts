/** 统一任务层的真实服务端适配器：本地文档正文、页面/端点/计算注册表。 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import { QUICK_LIMITS, TaskRouteError, type DeterministicOperation, type MaterialResolutionEntry,
  type ResearchTask, type RouteDecision, type TaskInputRef, type TaskMaterialResolver,
  type TaskOperationRegistry } from "./task_router.ts";
import { type QuickMaterial, type QuickMaterialLoader } from "./engines/quick_engine.ts";
import { reportText } from "./report_library.ts";
import { currentPlugin } from "./plugin.ts";
import { endpointsById, loadRegistry } from "./registry.ts";
import { ServiceError, assertArgs, assertSymbol, fetchEndpoint, pageQuery, type ServiceContext } from "./service.ts";

export interface TaskAdapterContext { readonly repoRoot: string; readonly dataRoot: string; readonly python: string }

function revisionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 只把用户明确引用的本地文档解析成 ready；其它材料种类尚无真实适配器时统一 missing。 */
export class ReportTaskMaterials implements TaskMaterialResolver, QuickMaterialLoader {
  readonly #dataRoot: string;
  constructor(dataRoot: string) { this.#dataRoot = dataRoot; }

  async resolve(_task: ResearchTask, ref: TaskInputRef): Promise<MaterialResolutionEntry> {
    if (ref.kind === "entity") return Object.freeze({ ...ref, status: "ready" as const,
      revision: `entity-v1-${revisionOf(ref.id)}`, contentMode: "non_text" as const, contentChars: 0 });
    if (ref.kind !== "report" && ref.kind !== "document") return { ...ref, status: "missing" };
    const found = reportText(this.#dataRoot, ref.id);
    if (!found) return { ...ref, status: "missing" };
    return Object.freeze({ ...ref, status: "ready" as const, revision: revisionOf(found.text),
      contentMode: "text" as const, contentChars: found.text.length });
  }

  async load(_route: RouteDecision, expected: MaterialResolutionEntry): Promise<QuickMaterial> {
    if ((expected.kind !== "report" && expected.kind !== "document") || expected.status !== "ready") {
      throw new Error("Quick 只读取路由器确认过的本地文档正文");
    }
    const found = reportText(this.#dataRoot, expected.id);
    if (!found || revisionOf(found.text) !== expected.revision || found.text.length !== expected.contentChars) {
      throw new Error("资料在路由后发生变化，请重新发起任务");
    }
    return Object.freeze({ kind: expected.kind, id: expected.id, revision: expected.revision!,
      title: found.record.name, excerpts: splitQuickPassages(found.text) });
  }

}

/** 按原文边界确定性分段；只裁外侧空白，不让模型自己截句。 */
export function splitQuickPassages(text: string): readonly string[] {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const out: string[] = [];
  let pending = "";
  const flush = () => { if (pending) { out.push(pending); pending = ""; } };
  for (const paragraph of paragraphs) {
    if (paragraph.length <= QUICK_LIMITS.maxPassageChars) {
      const joined = pending ? `${pending}\n\n${paragraph}` : paragraph;
      if (joined.length <= QUICK_LIMITS.maxPassageChars) pending = joined;
      else { flush(); pending = paragraph; }
      continue;
    }
    flush();
    let rest = paragraph;
    while (rest.length > QUICK_LIMITS.maxPassageChars) {
      const window = rest.slice(0, QUICK_LIMITS.maxPassageChars + 1);
      const floor = Math.floor(QUICK_LIMITS.maxPassageChars * 0.55);
      const candidates = [window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"),
        window.lastIndexOf("\n"), window.lastIndexOf(" ")];
      const cut = Math.max(...candidates.filter((value) => value >= floor));
      const end = cut >= floor ? cut + 1 : QUICK_LIMITS.maxPassageChars;
      out.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trim();
    }
    if (rest) pending = rest;
  }
  flush();
  if (!out.length || out.length > QUICK_LIMITS.maxPassagesPerMaterial) {
    throw new Error("资料无法在 Quick 段落限制内安全分段");
  }
  return Object.freeze(out);
}

interface CalcResult {
  readonly calculation_id?: unknown;
  readonly function?: unknown;
  readonly output?: { readonly status?: unknown; readonly reason?: unknown; readonly details?: { readonly kind?: unknown } };
  readonly [key: string]: unknown;
}

function operationError(message: string): never {
  throw new TaskRouteError("operation_not_available", message);
}

function objectArg(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) operationError(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function endpointNeedsSymbol(endpoint: { symbol_kind?: string; module?: string }): boolean {
  return endpoint.symbol_kind !== "none" || endpoint.module === "legacy";
}

function validateBrowse(ctx: TaskAdapterContext, operation: Extract<DeterministicOperation, { kind: "browse_data" }>): void {
  const queries = currentPlugin().pageQueries ?? {};
  if (!Object.prototype.hasOwnProperty.call(queries, operation.queryId)) {
    operationError(`没有这个界面查询:${operation.queryId}`);
  }
  const args = operation.args as Record<string, unknown>;
  const extra = Object.keys(args).filter((key) => !["symbol", "refresh", "blockArgs"].includes(key));
  if (extra.length) operationError(`界面查询参数含契约外字段:${extra.join(",")}`);
  if (args.refresh !== undefined && typeof args.refresh !== "boolean") operationError("界面查询 refresh 必须是布尔值");
  const symbol = args.symbol;
  if (symbol !== undefined && typeof symbol !== "string") operationError("界面查询 symbol 必须是字符串");
  const rawBlockArgs = args.blockArgs === undefined ? {} : objectArg("界面查询 blockArgs", args.blockArgs);
  const def = queries[operation.queryId]!;
  const registry = loadRegistry(ctx.repoRoot);
  if (!registry) operationError("数据源注册表不可用");
  const byId = endpointsById(registry);
  const blocks = new Map(def.blocks.map((block) => [block.id, block]));
  for (const blockId of Object.keys(rawBlockArgs)) {
    if (!blocks.has(blockId)) operationError(`界面查询 ${operation.queryId} 没有块:${blockId}`);
  }
  let consumesSymbol = false;
  for (const block of def.blocks) {
    const endpoint = byId[block.endpoint];
    if (!endpoint || endpoint.enabled === false) operationError(`界面查询引用不可用端点:${block.endpoint}`);
    if (!block.symbol && endpointNeedsSymbol(endpoint)) {
      consumesSymbol = true;
      if (symbol === undefined) operationError(`界面查询 ${operation.queryId} 需要 symbol`);
      assertSymbol(symbol, endpoint.symbol_kind === "none" ? "cn6" : endpoint.symbol_kind);
    }
    const given = rawBlockArgs[block.id] === undefined ? {} : objectArg(`blockArgs.${block.id}`, rawBlockArgs[block.id]);
    const allowed = new Set(block.userArgs ?? []);
    const unknown = Object.keys(given).filter((key) => !allowed.has(key));
    if (unknown.length) operationError(`界面查询块 ${block.id} 不允许参数:${unknown.join(",")}`);
    assertArgs(endpoint, { ...(block.args ?? {}), ...given });
  }
  if (symbol !== undefined && !consumesSymbol) operationError(`界面查询 ${operation.queryId} 不使用 symbol`);
}

function calcEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };
  for (const key of ["PATH", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

function runCalcProcess(ctx: TaskAdapterContext, argv: readonly string[], signal?: AbortSignal): Promise<{ status: number | null; stdout: string }> {
  if (signal?.aborted) return Promise.reject(new ServiceError("cancelled", "确定性计算已取消"));
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.python, argv, { cwd: ctx.repoRoot, env: calcEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped: "timeout" | "overflow" | "cancelled" | null = null;
    const stop = (why: NonNullable<typeof stopped>) => { if (!stopped) { stopped = why; child.kill("SIGKILL"); } };
    const timer = setTimeout(() => stop("timeout"), 30_000);
    timer.unref();
    const abort = () => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) return stop("overflow");
      chunks.push(chunk);
    });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.on("error", () => { cleanup(); reject(new ServiceError("calc_unavailable", "确定性计算进程不可用")); });
    child.on("close", (status) => {
      cleanup();
      if (stopped === "cancelled") return reject(new ServiceError("cancelled", "确定性计算已取消"));
      if (stopped) return reject(new ServiceError("calc_unavailable", `确定性计算进程${stopped === "timeout" ? "超时" : "输出过大"}`));
      resolve({ status, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

async function validateCalculation(ctx: TaskAdapterContext,
  operation: Extract<DeterministicOperation, { kind: "calculate" }>, signal?: AbortSignal): Promise<void> {
  const payload = JSON.stringify({ function: operation.functionId, args: operation.args });
  const result = await runCalcProcess(ctx, [path.join(ctx.repoRoot, "calc", "cli.py"), "validate", "--args", payload], signal);
  let parsed: { valid?: unknown; error?: unknown };
  try { parsed = JSON.parse(result.stdout) as { valid?: unknown; error?: unknown }; }
  catch { operationError("计算注册表返回了无效结果"); }
  if (result.status !== 0 || parsed.valid !== true) {
    operationError(`确定性计算未通过参数校验:${typeof parsed.error === "string" ? parsed.error : "参数契约无效"}`);
  }
}

async function runCalculation(ctx: TaskAdapterContext,
  operation: Extract<DeterministicOperation, { kind: "calculate" }>, signal?: AbortSignal): Promise<CalcResult> {
  const result = await runCalcProcess(ctx, [path.join(ctx.repoRoot, "calc", "cli.py"), operation.functionId,
    "--args", JSON.stringify(operation.args)], signal);
  let parsed: CalcResult;
  try { parsed = JSON.parse(result.stdout) as CalcResult; }
  catch { throw new ServiceError("calc_bad_result", "确定性计算返回了无效结果"); }
  if (result.status !== 0 && result.status !== 2) {
    throw new ServiceError("calc_failed", typeof parsed.output?.reason === "string" ? parsed.output.reason : "确定性计算失败");
  }
  return Object.freeze(parsed);
}

/** 只认可产品当前真实注册表中的操作，并通过同一适配器执行。 */
export class ProductTaskOperations implements TaskOperationRegistry {
  readonly #ctx: TaskAdapterContext;
  constructor(ctx: TaskAdapterContext) { this.#ctx = ctx; }

  async validate(_task: ResearchTask, operation: DeterministicOperation, signal?: AbortSignal): Promise<void> {
    if (operation.kind === "browse_data") {
      validateBrowse(this.#ctx, operation);
      return;
    }
    if (operation.kind === "calculate") {
      await validateCalculation(this.#ctx, operation, signal);
      return;
    }
    const registry = loadRegistry(this.#ctx.repoRoot);
    if (!registry) throw new TaskRouteError("operation_not_available", "数据源注册表不可用");
    const byId = endpointsById(registry);
    const symbol = operation.args.symbol;
    const endpointArgs = Object.fromEntries(Object.entries(operation.args).filter(([key]) => key !== "symbol"));
    for (const id of operation.endpointIds) {
      const endpoint = byId[id];
      if (!endpoint || endpoint.enabled === false) {
        throw new TaskRouteError("operation_not_available", `没有这个可用数据端点:${id}`);
      }
      if (endpointNeedsSymbol(endpoint) && symbol === undefined) {
        throw new TaskRouteError("operation_not_available", `端点 ${id} 需要 symbol`);
      }
      if (symbol !== undefined) assertSymbol(symbol, endpoint.symbol_kind === "none" ? "cn6" : endpoint.symbol_kind);
      assertArgs(endpoint, endpointArgs);
    }
  }

  async execute(operation: DeterministicOperation, signal?: AbortSignal): Promise<unknown> {
    if (operation.kind === "browse_data") {
      validateBrowse(this.#ctx, operation);
      const args = operation.args as Record<string, unknown>;
      return pageQuery(this.#ctx as ServiceContext, {
        query: operation.queryId,
        ...(typeof args.symbol === "string" ? { symbol: args.symbol } : {}),
        ...(typeof args.refresh === "boolean" ? { refresh: args.refresh } : {}),
        ...(args.blockArgs ? { blockArgs: args.blockArgs as Record<string, Record<string, unknown>> } : {}), signal,
      });
    }
    if (operation.kind === "calculate") {
      return runCalculation(this.#ctx, operation, signal);
    }
    await this.validate({} as ResearchTask, operation);
    const symbol = typeof operation.args.symbol === "string" ? operation.args.symbol : undefined;
    const endpointArgs = Object.fromEntries(Object.entries(operation.args).filter(([key]) => key !== "symbol"));
    const results = await Promise.all(operation.endpointIds.map(async (endpoint) => ({
      endpoint,
      result: await fetchEndpoint(this.#ctx as ServiceContext, {
        endpoint, ...(symbol ? { symbol } : {}), args: endpointArgs, consistency: { mode: "fresh" }, signal,
      }),
    })));
    return Object.freeze({ endpoints: Object.freeze(results) });
  }
}
