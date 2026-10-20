/** 统一任务 API 的 composition：真实路由适配器 + deterministic / Quick / Deep 执行器。 */
import { DirectTransportError, type ChatReply, type ChatRequest } from "./engines/direct_transport.ts";
import { ChatError, chatSend as chatSendCore } from "./chat.ts";
import { DeepResearchEngine, DeepExecutionError, type DeepResearchBackend, type DeepTargetResolver } from "./engines/deep_engine.ts";
import { DeterministicEngine } from "./engines/deterministic_engine.ts";
import { QuickEngine, type QuickProvider } from "./engines/quick_engine.ts";
import { assertExecutionMode, resolveDirectProvider, resolveRuntimeProvider, resolveSelectedRuntime, runtimeSourceFingerprint, RuntimeProviderError, type ExecutionMode, type LlmOverride } from "./runtime_provider.ts";
import { ServiceError, type ServiceContext } from "./service.ts";
import { ProductTaskOperations, ReportTaskMaterials } from "./task_adapters.ts";
import { TaskRouteError, TaskRouter, type AgentEngineFamily, type RouteDecision, type TaskEvent } from "./task_router.ts";

export interface UnifiedTaskRequest {
  readonly task: unknown;
  readonly execute?: boolean;
  readonly llm?: LlmOverride;
  readonly executionMode: ExecutionMode;
  /** 两段式 UI 把 route-only 的决定绑定到执行请求；材料变化时拒绝，不得悄悄换路线。 */
  readonly expectedRouteFingerprint?: string;
}
export interface UnifiedTaskResult {
  readonly status: "routed" | "running" | "completed" | "failed";
  readonly executionAvailable: boolean;
  readonly route: RouteDecision;
  readonly events: readonly TaskEvent[];
}

export interface TaskServiceDependencies {
  /** 仅用于测试或受控传输替换；HTTP 请求不能注入。 */
  readonly quickProvider?: QuickProvider;
  readonly complete?: (request: ChatRequest) => Promise<ChatReply>;
  readonly deepBackend?: DeepResearchBackend;
  /** 由具体产品的 composition root 注入；Core 不猜对象代码或范围。 */
  readonly deepTargetResolver?: DeepTargetResolver;
}

export interface UnifiedTaskResumeResult {
  readonly status: "running" | "completed" | "failed";
  readonly events: readonly TaskEvent[];
}

function requestOf(value: unknown): UnifiedTaskRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("invalid_task_request", "任务请求必须是对象");
  }
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter((key) => !["task", "execute", "llm", "executionMode", "expectedRouteFingerprint"].includes(key));
  if (extra.length) throw new ServiceError("invalid_task_request", `任务请求含契约外字段:${extra.join(",")}`);
  if (!("task" in raw)) throw new ServiceError("invalid_task_request", "任务请求缺少 task");
  if (raw.execute !== undefined && typeof raw.execute !== "boolean") {
    throw new ServiceError("invalid_task_request", "execute 必须是布尔值");
  }
  if (raw.expectedRouteFingerprint !== undefined &&
      (typeof raw.expectedRouteFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.expectedRouteFingerprint))) {
    throw new ServiceError("invalid_task_request", "expectedRouteFingerprint 必须是 64 位路由指纹");
  }
  if (raw.llm !== undefined) {
    if (!raw.llm || typeof raw.llm !== "object" || Array.isArray(raw.llm)) {
      throw new ServiceError("invalid_task_request", "llm 必须是对象");
    }
    const llm = raw.llm as Record<string, unknown>;
    const bad = Object.keys(llm).filter((key) => !["provider", "baseURL", "apiKey", "model"].includes(key));
    if (bad.length || typeof llm.provider !== "string" ||
        ["baseURL", "apiKey", "model"].some((key) => llm[key] !== undefined && typeof llm[key] !== "string")) {
      throw new ServiceError("invalid_task_request", "llm 配置字段无效");
    }
  }
  let executionMode: ExecutionMode;
  try { executionMode = assertExecutionMode(raw.executionMode); }
  catch (error) { throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_execution_mode", error instanceof Error ? error.message : String(error)); }
  return { task: raw.task, executionMode, ...(raw.execute === undefined ? {} : { execute: raw.execute }),
    ...(raw.llm === undefined ? {} : { llm: raw.llm as LlmOverride }),
    ...(raw.expectedRouteFingerprint === undefined ? {} : { expectedRouteFingerprint: raw.expectedRouteFingerprint as string }) };
}

function quickProviderOf(ctx: ServiceContext, llm?: LlmOverride): QuickProvider {
  try {
    if (!llm) throw new ServiceError("quick_provider_unsupported", "直连模式缺少 AI 来源配置");
    return resolveDirectProvider(ctx.repoRoot, ctx.dataRoot, llm);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (error instanceof RuntimeProviderError) throw new ServiceError(error.code, error.message);
    throw new ServiceError("quick_provider_unsupported", error instanceof Error ? error.message : "Quick 模型配置不可用");
  }
}

function agentQuickProvider(llm?: LlmOverride): QuickProvider {
  const label = String(llm?.provider ?? "vibe-research-agent").trim() || "vibe-research-agent";
  return Object.freeze({
    name: label,
    // 下面的 complete 被 Agent 适配器完整接管，这些字段只用于 QuickEngine 的结构与事件投影。
    baseURL: "https://agent.invalid",
    apiKey: "agent-adapter-not-sent",
    model: String(llm?.model ?? label).trim() || label,
    structuredOutput: "server_schema",
  });
}

function agentQuickComplete(ctx: ServiceContext, llm?: LlmOverride): (request: ChatRequest) => Promise<ChatReply> {
  return async (request) => {
    const system = request.messages.find((x) => x.role === "system")?.content ?? "";
    const message = [...request.messages].reverse().find((x) => x.role === "user")?.content ?? "";
    const schema = (request.responseFormat as { json_schema?: { schema?: unknown } } | undefined)?.json_schema?.schema;
    let turn: Awaited<ReturnType<typeof chatSendCore>>;
    try {
      turn = await chatSendCore({
        repoRoot: ctx.repoRoot,
        dataRoot: ctx.dataRoot,
        python: ctx.python,
        developerInstructions: String(system),
        ...(schema !== undefined ? { outputSchema: schema } : {}),
        persistent: false,
        preambleText: "",
        skipGate: true,
        signal: request.signal,
      }, { session: "bounded-task", message: String(message), ...(llm ? { llm } : {}) });
    } catch (error) {
      // QuickEngine 只认自己的错误和传输层错误;对话层的 ChatError 原样抛进去会变成笼统的「Quick 执行失败」,
      // 用户看不到"去改 Base URL"。跳转换回传输层的 redirect,与直连 Quick 同一句提示(Codex 复审 R4-2)。
      if (error instanceof ChatError && error.code === "api_redirect") throw new DirectTransportError("redirect", error.message, null, false);
      throw error;
    }
    return { message: { role: "assistant", content: turn.reply }, finishReason: "stop", usage: null, durationMs: turn.duration_ms };
  };
}

/** 没有可用 AI 来源时的占位指纹(真实来源的指纹是 sha256,不会撞上全零) */
const NO_SOURCE_FINGERPRINT = "0".repeat(64);

/**
 * 路由要绑定 AI 来源指纹。v2 没有默认大脑:请求没带来源、后台默认也没配(或配坏了)时,
 * 确定性任务(浏览、登记源刷新、计算)照样能路由执行 —— 它们根本不调用模型;
 * 用占位指纹路由,其余路线在路由后照实报来源错误。请求里**显式**带的来源解析失败则照常报错。
 */
function taskSource(ctx: ServiceContext, llm?: LlmOverride): { fingerprint: string; family: AgentEngineFamily; unavailable?: RuntimeProviderError } {
  try {
    const selected = resolveSelectedRuntime(ctx.repoRoot, ctx.dataRoot, llm);
    return { fingerprint: runtimeSourceFingerprint(ctx.repoRoot, ctx.dataRoot, llm),
      family: selected.runtime === "local-agent" ? "local_agent" : "api_agent" };
  } catch (error) {
    if (llm || !(error instanceof RuntimeProviderError)) throw error;
    return { fingerprint: NO_SOURCE_FINGERPRINT, family: "api_agent", unavailable: error };
  }
}

export async function runUnifiedTask(ctx: ServiceContext, input: unknown, signal?: AbortSignal,
  dependencies: TaskServiceDependencies = {}): Promise<UnifiedTaskResult> {
  const req = requestOf(input);
  // 协议错误先于一切:不先去解析材料、读 AI 配置,免得"没选来源"之类的报错盖住调用方的 bug
  if (req.execute !== false && req.expectedRouteFingerprint === undefined) {
    throw new ServiceError("invalid_task_request", "执行任务前必须先路由并带回 expectedRouteFingerprint");
  }
  const materials = new ReportTaskMaterials(ctx.dataRoot);
  const operations = new ProductTaskOperations(ctx);
  const router = new TaskRouter({ materials, operations });
  let route: RouteDecision;
  try {
    const source = taskSource(ctx, req.llm);
    route = await router.route(req.task, signal, req.executionMode, source.fingerprint, source.family);
    if (source.unavailable && route.target !== "deterministic") throw source.unavailable;
  }
  catch (error) {
    if (signal?.aborted) throw new ServiceError("cancelled", "任务已取消");
    if (error instanceof TaskRouteError) throw new ServiceError(error.code, error.message);
    if (error instanceof RuntimeProviderError) throw new ServiceError(error.code, error.message);
    throw error;
  }
  if (req.expectedRouteFingerprint !== undefined && route.routeFingerprint !== req.expectedRouteFingerprint) {
    throw new ServiceError("route_changed", "所选材料在路由后发生变化，请重新开始任务");
  }
  if (route.target === "deep" && req.llm) {
    try {
      resolveRuntimeProvider(ctx.repoRoot, ctx.dataRoot, req.llm);
    }
    catch (error) {
      throw new ServiceError(error instanceof RuntimeProviderError ? error.code : "bad_llm",
        error instanceof Error ? error.message : String(error));
    }
  }
  const executionAvailable = route.target !== "deep" ||
    (req.executionMode === "agent" && dependencies.deepTargetResolver !== undefined);
  if (req.execute === false) {
    return Object.freeze({ status: "routed", executionAvailable, route, events: Object.freeze([]) });
  }
  if (route.target === "deep" && req.executionMode === "direct") {
    throw new ServiceError("agent_required", "这个任务要长流程取证和调用工具：请先接入 AI；接口调用时 executionMode 要用 agent");
  }
  if (route.target === "deep" && !dependencies.deepTargetResolver) {
    throw new ServiceError("deep_executor_unavailable", "当前产品没有注册 Deep 研究对象解析器");
  }
  const engine = route.target === "deterministic"
    ? new DeterministicEngine(operations)
    : route.target === "quick"
      ? req.executionMode === "direct"
        ? new QuickEngine({ provider: dependencies.quickProvider ?? quickProviderOf(ctx, req.llm),
            materials, requestTimeoutMs: 120_000, engineFamily: "direct_api",
            ...(dependencies.complete ? { complete: dependencies.complete } : {}) })
        : new QuickEngine({ provider: dependencies.quickProvider ?? agentQuickProvider(req.llm),
            materials, requestTimeoutMs: 120_000, engineFamily: route.engineFamily as AgentEngineFamily,
            complete: dependencies.complete ?? agentQuickComplete(ctx, req.llm) })
      : new DeepResearchEngine({ ctx, materials: dependencies.deepTargetResolver!,
          engineFamily: route.engineFamily as AgentEngineFamily,
          ...(req.llm ? { runtimeLlm: req.llm } : {}),
          ...(dependencies.deepBackend ? { backend: dependencies.deepBackend } : {}) });
  const events: TaskEvent[] = [];
  for await (const event of engine.run(route, signal)) events.push(event);
  const last = events.at(-1)?.type;
  const status = last === "completed" ? "completed" : last === "failed" ? "failed" : "running";
  return Object.freeze({ status, executionAvailable: true, route, events: Object.freeze(events) });
}

function resumeRequest(value: unknown): { runId: string; routeFingerprint: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("invalid_task_resume", "恢复请求必须是对象");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "runId" && key !== "routeFingerprint") ||
      typeof raw.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.runId) ||
      typeof raw.routeFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.routeFingerprint)) {
    throw new ServiceError("invalid_task_resume", "恢复请求缺少合法运行编号或路由指纹");
  }
  return { runId: raw.runId, routeFingerprint: raw.routeFingerprint };
}

/** 从已有六阶段运行账本生成当前统一事件快照；不重启、不复制状态机。 */
export async function resumeUnifiedTask(ctx: ServiceContext, input: unknown, signal?: AbortSignal,
  dependencies: Pick<TaskServiceDependencies, "deepBackend" | "deepTargetResolver"> = {}): Promise<UnifiedTaskResumeResult> {
  if (signal?.aborted) throw new ServiceError("cancelled", "任务状态读取已取消");
  const request = resumeRequest(input);
  if (!dependencies.deepTargetResolver) throw new ServiceError("deep_executor_unavailable", "当前产品没有注册 Deep 研究对象解析器");
  const engine = new DeepResearchEngine({ ctx, materials: dependencies.deepTargetResolver,
    ...(dependencies.deepBackend ? { backend: dependencies.deepBackend } : {}) });
  const events: TaskEvent[] = [];
  try {
    for await (const event of engine.resume!(request, signal)) events.push(event);
  } catch (error) {
    if (error instanceof DeepExecutionError) throw new ServiceError(error.code, error.message);
    throw error;
  }
  const last = events.at(-1)?.type;
  const status = last === "completed" ? "completed" : last === "failed" ? "failed" : "running";
  return Object.freeze({ status, events: Object.freeze(events) });
}
