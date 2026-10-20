/**
 * 高层任务协议与路由器(Core)。
 *
 * 这里回答的是「这件事应该用哪类执行方式」，不是「用哪家模型」。
 * provider / model / apiKey 属于路由完成后的运行时配置。底层 `engine.ts`
 * 仍只描述六阶段研究内部怎样跑一个 turn，不得代替本文件的产品任务语义。
 */

import { createHash } from "node:crypto";

export const RESEARCH_TASK_KINDS = [
  "browse_data", "refresh_registered_data", "calculate", "summarize_materials",
  "compare_entities", "explain_metric", "extract_fields", "answer_from_materials",
  "translate_material", "locate_passages", "deep_research",
] as const;

export type ResearchTaskKind = typeof RESEARCH_TASK_KINDS[number];
export type RequestedTaskMode = "auto" | "quick" | "deep";
export type MaterialState = "not_needed" | "ready" | "partial" | "missing";
export type EvidenceScope = "existing" | "registered_refresh" | "open_discovery";
export type WorkflowShape = "single_step" | "multi_step";
export type RouteTarget = "deterministic" | "quick" | "deep";
/**
 * 谁来执行:`direct_api` = 模型 API 单次问答(不带工具);`api_agent` = 模型 API + 产品工具循环;
 * `local_agent` = 用户本机已登录的订阅 Agent(Claude Code / Codex CLI / WorkBuddy)。
 */
export type EngineFamily = "none" | "direct_api" | "api_agent" | "local_agent";
export type AgentEngineFamily = "api_agent" | "local_agent";
export type ExecutionMode = "agent" | "direct";
export type TaskInputKind = "page_snapshot" | "evidence" | "report" | "document" | "entity";
export type TaskOutputFormat = "data" | "text" | "table" | "fields" | "document";
export type TaskJson = null | boolean | number | string | readonly TaskJson[] |
  Readonly<{ [key: string]: TaskJson }>;

export interface TaskInputRef {
  /** 服务端材料 ID；协议不直接携带原始路径或正文 */
  readonly kind: TaskInputKind;
  readonly id: string;
}

export type DeterministicOperation =
  | { readonly kind: "browse_data"; readonly queryId: string; readonly args: Readonly<Record<string, TaskJson>> }
  | { readonly kind: "refresh_registered_data"; readonly endpointIds: readonly string[]; readonly args: Readonly<Record<string, TaskJson>> }
  | { readonly kind: "calculate"; readonly functionId: string; readonly args: Readonly<Record<string, TaskJson>> };

export interface ResearchTask {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: ResearchTaskKind;
  /** 兼容旧调用与内部测试的路由提示；新版界面不再把 Auto / Quick / Deep 交给普通用户选择。 */
  readonly requestedMode: RequestedTaskMode;
  readonly objective: string;
  readonly evidenceScope: EvidenceScope;
  readonly workflow: WorkflowShape;
  readonly inputRefs: readonly TaskInputRef[];
  readonly outputFormat: TaskOutputFormat;
  /** 只有确定性任务携带；模型任务必须为 null */
  readonly operation: DeterministicOperation | null;
}

export interface MaterialResolutionEntry extends TaskInputRef {
  /** unauthorized / type mismatch 对任务路由统一表现为 missing，避免暴露材料存在性 */
  readonly status: "ready" | "missing";
  /** ready 时锁定所解析材料的版本；执行器不得悄悄换成更新后的内容 */
  readonly revision?: string;
  /** ready 时由服务端解析器确认；Quick v1 只接收已经提取为文本的材料。 */
  readonly contentMode?: "text" | "non_text";
  /** ready 文本的受控字符数；路由据此在执行前判断 Quick 容量。 */
  readonly contentChars?: number;
}

export const QUICK_LIMITS = Object.freeze({
  maxMaterials: 16,
  maxMaterialChars: 40_000,
  maxPassagesPerMaterial: 512,
  maxPassageChars: 2_000,
  maxSelections: 16,
});

export interface TaskMaterialResolution {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly inputs: readonly MaterialResolutionEntry[];
}

/**
 * 材料解析端口是信任边界：实现必须在服务端完成存在性、类型与授权检查，再密封结果。
 * HTTP 请求体不得直接构造 TaskMaterialResolution。
 */
export interface TaskMaterialResolver {
  resolve(task: ResearchTask, input: TaskInputRef, signal?: AbortSignal): Promise<MaterialResolutionEntry>;
}

/** 确定性操作必须经过服务端查询 / 端点 / 计算注册表的 schema 校验，不能只验字符串形状。 */
export interface TaskOperationRegistry {
  validate(task: ResearchTask, operation: DeterministicOperation, signal?: AbortSignal): Promise<void>;
}

export interface TaskRouterDependencies {
  readonly materials: TaskMaterialResolver;
  readonly operations: TaskOperationRegistry;
}

export interface RouteDecision {
  /** 规范化、冻结后的任务；执行器只消费这里这一份，避免 task / decision 错配 */
  readonly task: ResearchTask;
  readonly materials: TaskMaterialResolution;
  readonly materialState: MaterialState;
  readonly target: RouteTarget;
  readonly engineFamily: EngineFamily;
  readonly requestedMode: RequestedTaskMode;
  /** 全局执行方式；进路由指纹，防止两段式请求中途切换。 */
  readonly executionMode: ExecutionMode;
  /** AI 来源的不可逆摘要；路由与执行必须一致。 */
  readonly runtimeFingerprint: string;
  /** 绑定规范化任务与材料 revision；恢复旧运行时必须一并核对。 */
  readonly routeFingerprint: string;
  readonly reasonCode:
    | "deterministic_task" | "prepared_bounded_task" | "materials_not_ready"
    | "open_evidence_discovery" | "multi_step_investigation" | "deep_research_task"
    | "explicit_deep";
  /** 给 UI / API 原样展示的路由理由，不让 Auto 成为黑箱 */
  readonly reason: string;
}

export type TaskEventType = "started" | "progress" | "artifact" | "completed" | "failed";

export interface TaskEvent {
  /** 执行器创建的不可变运行 ID；同一个 task 可以有多次运行。 */
  readonly runId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly type: TaskEventType;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface ExecutionResumeRef {
  readonly runId: string;
  /** 必须与运行创建时保存的 RouteDecision.routeFingerprint 一致。 */
  readonly routeFingerprint: string;
}

/** 产品层执行器只消费路由器封好的决定，不再另收一份可错配的 task。 */
export interface ExecutionEngine {
  readonly id: string;
  readonly target: "quick" | "deep";
  run(route: RouteDecision, signal?: AbortSignal): AsyncIterable<TaskEvent>;
  resume?(run: ExecutionResumeRef, signal?: AbortSignal): AsyncIterable<TaskEvent>;
  cancel?(runId: string): Promise<void>;
}

export interface DeterministicExecutor {
  readonly id: string;
  readonly target: "deterministic";
  run(route: RouteDecision, signal?: AbortSignal): AsyncIterable<TaskEvent>;
  cancel?(taskId: string): Promise<void>;
}

export class TaskRouteError extends Error {
  readonly code: "invalid_task" | "invalid_material_resolution" | "material_resolution_failed" |
    "operation_not_available" | "quick_not_eligible";

  constructor(code: TaskRouteError["code"], message: string) {
    super(message);
    this.name = "TaskRouteError";
    this.code = code;
  }
}

const KINDS = new Set<string>(RESEARCH_TASK_KINDS);
const MODES = new Set<string>(["auto", "quick", "deep"]);
const EVIDENCE_SCOPES = new Set<string>(["existing", "registered_refresh", "open_discovery"]);
const WORKFLOWS = new Set<string>(["single_step", "multi_step"]);
const INPUT_KINDS = new Set<string>(["page_snapshot", "evidence", "report", "document", "entity"]);
const OUTPUT_FORMATS = new Set<string>(["data", "text", "table", "fields", "document"]);
const DETERMINISTIC_KINDS = new Set<ResearchTaskKind>(["browse_data", "refresh_registered_data", "calculate"]);
const QUICK_KINDS = new Set<ResearchTaskKind>([
  // 单次模型请求无法确定性证明摘要 / 问答没有选择性遗漏。Quick v1 因此只做
  // “定位相关原文段落”；其余通用 kind 在对应执行能力上线前 Auto 走 Deep。
  "locate_passages",
]);
const TASK_KEYS = [
  "id", "kind", "requestedMode", "objective", "evidenceScope", "workflow",
  "inputRefs", "outputFormat", "operation",
] as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRUSTED_ROUTE_DECISIONS = new WeakSet<object>();

function record(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskRouteError("invalid_task", `${name} 必须是对象`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TaskRouteError("invalid_task", `${name} 必须是普通 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(name: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new TaskRouteError("invalid_task", `${name} 含契约外字段:${extra.join(",")}`);
}

function enumValue<T extends string>(name: string, value: unknown, allowed: ReadonlySet<string>): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TaskRouteError("invalid_task", `${name} 取值无效:${String(value)}`);
  }
  return value as T;
}

function safeId(name: string, value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TaskRouteError("invalid_task", `${name} 只许安全标识符（1-128 位）`);
  }
  return value;
}

function freezeJson(value: unknown, path: string, budget: { nodes: number }, depth = 0): TaskJson {
  budget.nodes += 1;
  if (budget.nodes > 4_096 || depth > 8) {
    throw new TaskRouteError("invalid_task", `${path} 超过 JSON 大小或嵌套限制`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 8_000) throw new TaskRouteError("invalid_task", `${path} 字符串过长`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TaskRouteError("invalid_task", `${path} 只许有限数字`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new TaskRouteError("invalid_task", `${path} 数组过长`);
    return Object.freeze(value.map((item, index) => freezeJson(item, `${path}[${index}]`, budget, depth + 1)));
  }
  const source = record(path, value);
  const keys = Object.keys(source);
  if (keys.length > 256) throw new TaskRouteError("invalid_task", `${path} 字段过多`);
  const out: Record<string, TaskJson> = Object.create(null);
  for (const key of keys) {
    if (!key || key.length > 128 || ["__proto__", "prototype", "constructor"].includes(key)) {
      throw new TaskRouteError("invalid_task", `${path} 含不安全字段名:${key}`);
    }
    out[key] = freezeJson(source[key], `${path}.${key}`, budget, depth + 1);
  }
  return Object.freeze(out);
}

function args(name: string, value: unknown): Readonly<Record<string, TaskJson>> {
  return freezeJson(record(name, value), name, { nodes: 0 }) as Readonly<Record<string, TaskJson>>;
}

function stringList(name: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new TaskRouteError("invalid_task", `${name} 必须是 1-64 条安全标识符`);
  }
  const values = value.map((item, index) => safeId(`${name}[${index}]`, item));
  if (new Set(values).size !== values.length) throw new TaskRouteError("invalid_task", `${name} 不得重复`);
  return Object.freeze(values);
}

function parseOperation(taskKind: ResearchTaskKind, raw: unknown): DeterministicOperation | null {
  if (!DETERMINISTIC_KINDS.has(taskKind)) {
    if (raw !== null && raw !== undefined) throw new TaskRouteError("invalid_task", "模型任务不得携带 operation");
    return null;
  }
  const op = record("operation", raw);
  const kind = enumValue<ResearchTaskKind>("operation.kind", op.kind, KINDS);
  if (kind !== taskKind) throw new TaskRouteError("invalid_task", "operation.kind 必须与任务 kind 一致");
  if (kind === "browse_data") {
    exactKeys("operation", op, ["kind", "queryId", "args"]);
    return Object.freeze({ kind, queryId: safeId("operation.queryId", op.queryId), args: args("operation.args", op.args) });
  }
  if (kind === "refresh_registered_data") {
    exactKeys("operation", op, ["kind", "endpointIds", "args"]);
    return Object.freeze({ kind, endpointIds: stringList("operation.endpointIds", op.endpointIds), args: args("operation.args", op.args) });
  }
  exactKeys("operation", op, ["kind", "functionId", "args"]);
  return Object.freeze({ kind: "calculate", functionId: safeId("operation.functionId", op.functionId), args: args("operation.args", op.args) });
}

function buildResearchTask(input: unknown, expectSchemaVersion: boolean): ResearchTask {
  const source = record("ResearchTask", input);
  const allowed = expectSchemaVersion ? ["schemaVersion", ...TASK_KEYS] : [...TASK_KEYS];
  exactKeys("ResearchTask", source, allowed);
  if (expectSchemaVersion && source.schemaVersion !== 1) {
    throw new TaskRouteError("invalid_task", "ResearchTask.schemaVersion 必须为 1");
  }
  const id = safeId("ResearchTask.id", source.id);
  if (typeof source.objective !== "string") throw new TaskRouteError("invalid_task", "ResearchTask.objective 必须是字符串");
  const objective = source.objective.trim();
  if (!objective || objective.length > 8_000) throw new TaskRouteError("invalid_task", "ResearchTask.objective 必须为 1-8000 字符");
  const kind = enumValue<ResearchTaskKind>("kind", source.kind, KINDS);
  const requestedMode = enumValue<RequestedTaskMode>("requestedMode", source.requestedMode, MODES);
  const evidenceScope = enumValue<EvidenceScope>("evidenceScope", source.evidenceScope, EVIDENCE_SCOPES);
  const workflow = enumValue<WorkflowShape>("workflow", source.workflow, WORKFLOWS);
  const outputFormat = enumValue<TaskOutputFormat>("outputFormat", source.outputFormat, OUTPUT_FORMATS);
  if (!Array.isArray(source.inputRefs) || source.inputRefs.length > 64) {
    throw new TaskRouteError("invalid_task", "ResearchTask.inputRefs 必须是最多 64 条的数组");
  }
  const seen = new Set<string>();
  const inputRefs = source.inputRefs.map((candidate, index): TaskInputRef => {
    const ref = record(`inputRefs[${index}]`, candidate);
    exactKeys(`inputRefs[${index}]`, ref, ["kind", "id"]);
    const refKind = enumValue<TaskInputKind>(`inputRefs[${index}].kind`, ref.kind, INPUT_KINDS);
    const refId = safeId(`inputRefs[${index}].id`, ref.id);
    const key = `${refKind}:${refId}`;
    if (seen.has(key)) throw new TaskRouteError("invalid_task", `inputRefs 含重复引用:${key}`);
    seen.add(key);
    return Object.freeze({ kind: refKind, id: refId });
  });
  if (kind === "refresh_registered_data" && evidenceScope !== "registered_refresh") {
    throw new TaskRouteError("invalid_task", "refresh_registered_data 必须使用 registered_refresh 证据范围");
  }
  if (DETERMINISTIC_KINDS.has(kind) && evidenceScope === "open_discovery") {
    throw new TaskRouteError("invalid_task", "确定性任务不得声称需要开放式取证");
  }
  return Object.freeze({
    schemaVersion: 1, id, kind, requestedMode, objective, evidenceScope, workflow,
    inputRefs: Object.freeze(inputRefs), outputFormat,
    operation: parseOperation(kind, source.operation),
  });
}

/** 构造可信任务；API 收到已有 schemaVersion 的对象时用 parseResearchTask。 */
export function makeResearchTask(input: Omit<ResearchTask, "schemaVersion">): ResearchTask {
  return buildResearchTask(input, false);
}

/** 严格运行时入口：拒绝额外字段、错误版本和所有未规范化值。 */
export function parseResearchTask(input: unknown): ResearchTask {
  return buildResearchTask(input, true);
}

function checkedMaterial(ref: TaskInputRef, value: unknown, index: number): MaterialResolutionEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskRouteError("invalid_material_resolution", `材料解析器第 ${index + 1} 条结果不是对象`);
  }
  const entry = value as Record<string, unknown>;
  const extra = Object.keys(entry).filter((key) => !["kind", "id", "status", "revision", "contentMode", "contentChars"].includes(key));
  if (extra.length) throw new TaskRouteError("invalid_material_resolution", `材料解析结果含契约外字段:${extra.join(",")}`);
  if (entry.kind !== ref.kind || entry.id !== ref.id || (entry.status !== "ready" && entry.status !== "missing")) {
    throw new TaskRouteError("invalid_material_resolution", `材料解析器第 ${index + 1} 条结果与请求引用不一致`);
  }
  if (entry.status === "ready") {
    if (typeof entry.revision !== "string" || !SAFE_ID.test(entry.revision)) {
      throw new TaskRouteError("invalid_material_resolution", `材料解析器第 ${index + 1} 条 ready 结果缺安全 revision`);
    }
    if (entry.contentMode !== "text" && entry.contentMode !== "non_text") {
      throw new TaskRouteError("invalid_material_resolution", `材料解析器第 ${index + 1} 条 ready 结果缺内容形态`);
    }
    if (!Number.isSafeInteger(entry.contentChars) || (entry.contentChars as number) < 0) {
      throw new TaskRouteError("invalid_material_resolution", `材料解析器第 ${index + 1} 条 ready 结果缺合法字符数`);
    }
    if (entry.contentMode === "text" && entry.contentChars === 0) {
      throw new TaskRouteError("invalid_material_resolution", `材料解析器第 ${index + 1} 条文本材料不得为空`);
    }
    const revision = entry.revision;
    return Object.freeze({ kind: ref.kind, id: ref.id, status: "ready", revision,
      contentMode: entry.contentMode, contentChars: entry.contentChars as number });
  }
  if (entry.revision !== undefined || entry.contentMode !== undefined || entry.contentChars !== undefined) {
    throw new TaskRouteError("invalid_material_resolution", `缺失材料不得携带 revision、内容形态或字符数`);
  }
  return Object.freeze({ kind: ref.kind, id: ref.id, status: "missing" });
}

function materialState(task: ResearchTask, materials: TaskMaterialResolution): MaterialState {
  if (DETERMINISTIC_KINDS.has(task.kind)) return "not_needed";
  if (materials.inputs.length === 0) return "missing";
  const ready = materials.inputs.filter((entry) => entry.status === "ready").length;
  if (ready === materials.inputs.length) return "ready";
  return ready === 0 ? "missing" : "partial";
}

function fingerprintRoute(task: ResearchTask, materials: TaskMaterialResolution, executionMode: ExecutionMode,
  runtimeFingerprint: string, engineFamily: EngineFamily): string {
  return createHash("sha256").update(JSON.stringify({ task, materials, executionMode, runtimeFingerprint, engineFamily })).digest("hex");
}

function decision(task: ResearchTask, materials: TaskMaterialResolution, state: MaterialState,
  target: RouteTarget, engineFamily: EngineFamily, reasonCode: RouteDecision["reasonCode"],
  reason: string, executionMode: ExecutionMode, runtimeFingerprint: string): RouteDecision {
  const routeFingerprint = fingerprintRoute(task, materials, executionMode, runtimeFingerprint, engineFamily);
  const result = Object.freeze({ task, materials, materialState: state, target, engineFamily,
    requestedMode: task.requestedMode, executionMode, runtimeFingerprint, routeFingerprint, reasonCode, reason });
  TRUSTED_ROUTE_DECISIONS.add(result);
  return result;
}

/** 同进程执行器的真实性检查：序列化后必须重新走 TaskRouter，不能复用这个身份。 */
export function isTrustedRouteDecision(value: unknown): value is RouteDecision {
  if (!value || typeof value !== "object" || !TRUSTED_ROUTE_DECISIONS.has(value)) return false;
  const route = value as RouteDecision;
  return (route.executionMode === "agent" || route.executionMode === "direct") &&
    /^[a-f0-9]{64}$/.test(route.runtimeFingerprint) &&
    route.routeFingerprint === fingerprintRoute(route.task, route.materials, route.executionMode, route.runtimeFingerprint, route.engineFamily);
}

function quickIneligibleReason(task: ResearchTask, materials: TaskMaterialResolution, state: MaterialState): string | null {
  if (!QUICK_KINDS.has(task.kind)) return `任务类型 ${task.kind} 不是 Quick 的有界分析任务`;
  if (task.outputFormat !== "text") return "Quick v1 只交付原文段落文本";
  if (task.inputRefs.length > QUICK_LIMITS.maxMaterials) return `Quick v1 一次最多处理 ${QUICK_LIMITS.maxMaterials} 份材料`;
  if (state !== "ready") return "Quick 只能使用服务端已解析并授权的完备材料";
  if (materials.inputs.some((entry) => entry.contentMode !== "text")) {
    return "Quick v1 只处理已经提取为文本的材料";
  }
  const totalChars = materials.inputs.reduce((sum, entry) => sum + (entry.contentChars ?? 0), 0);
  if (totalChars > QUICK_LIMITS.maxMaterialChars) {
    return `材料共 ${totalChars} 字符，超过 Quick v1 的 ${QUICK_LIMITS.maxMaterialChars} 字符上限`;
  }
  if (task.evidenceScope !== "existing") return "Quick 不负责刷新来源或开放式寻找新证据";
  if (task.workflow !== "single_step") return "Quick 不负责跨来源、多子问题的迭代调查";
  return null;
}

/**
 * 普通用户不选 Quick / Deep；只有目标**开头明确要求**重做深研才升级。
 * 不在全句扫单个子串，否则“找出报告中对完整六阶段研究的描述”也会误启动长流程。
 */
function explicitDeepObjective(objective: string): boolean {
  const text = objective.trim().replace(/^(?:请帮我?|帮我|烦劳|基于(?:这些|所选)?(?:材料|报告))[、，,\s]*/, "");
  return /^(?:(?:做|执行|开始|重做)(?:一|1)?次)?(?:重新|深入|深度|完整|全面|系统|六阶段).{0,12}(?:研究|尽调|分析|核验|调查|流程)/.test(text);
}

/** 材料解析完成后的纯函数部分；不导出，外部不能塞自报的 ready 结果。 */
function decideResearchTask(task: ResearchTask, materials: TaskMaterialResolution, executionMode: ExecutionMode,
  runtimeFingerprint: string, agentEngineFamily: AgentEngineFamily): RouteDecision {
  const state = materialState(task, materials);
  if (DETERMINISTIC_KINDS.has(task.kind)) {
    return decision(task, materials, state, "deterministic", "none", "deterministic_task",
      "这是浏览、登记源刷新或确定性计算，直接运行类型化操作，不消耗模型额度。", executionMode, runtimeFingerprint);
  }
  if (task.requestedMode === "deep") {
    return decision(task, materials, state, "deep", agentEngineFamily, "explicit_deep",
      "该任务需要完整取证与研究流程，转为完整研究执行。", executionMode, runtimeFingerprint);
  }
  if (task.requestedMode === "auto" && task.kind === "locate_passages" && explicitDeepObjective(task.objective)) {
    return decision(task, materials, state, "deep", agentEngineFamily, "explicit_deep",
      "用户明确要求重做深度研究，系统已升级为完整 Agent 流程。", executionMode, runtimeFingerprint);
  }
  if (task.requestedMode === "quick") {
    const why = quickIneligibleReason(task, materials, state);
    if (why) throw new TaskRouteError("quick_not_eligible", `${why}。不会静默改用 Deep，请明确切换模式。`);
    return decision(task, materials, state, "quick", executionMode === "agent" ? agentEngineFamily : "direct_api", "prepared_bounded_task",
      executionMode === "agent"
        ? "材料已由服务端核实且任务边界清楚，由 AI 调用工具完成一次有界材料定位。"
        : "材料已由服务端核实且任务边界清楚，用模型直连定位相关材料段落。", executionMode, runtimeFingerprint);
  }
  if (task.kind === "deep_research") {
    return decision(task, materials, state, "deep", agentEngineFamily, "deep_research_task",
      "任务本身是开放式深度研究，需要可恢复的长流程执行。", executionMode, runtimeFingerprint);
  }
  if (state !== "ready") {
    return decision(task, materials, state, "deep", agentEngineFamily, "materials_not_ready",
      "服务端确认现有材料未备齐，需要 Agent 补证据并处理数据缺口。", executionMode, runtimeFingerprint);
  }
  if (task.evidenceScope === "open_discovery") {
    return decision(task, materials, state, "deep", agentEngineFamily, "open_evidence_discovery",
      "任务要开放式寻找新来源和处理冲突，超出单次直连的已有材料边界。", executionMode, runtimeFingerprint);
  }
  if (task.workflow === "multi_step") {
    return decision(task, materials, state, "deep", agentEngineFamily, "multi_step_investigation",
      "任务需要跨来源或多子问题迭代，使用 Agent 的长流程能力。", executionMode, runtimeFingerprint);
  }
  const why = quickIneligibleReason(task, materials, state);
  if (why) {
    return decision(task, materials, state, "deep", agentEngineFamily, "deep_research_task",
      `${why}，系统为避免不完整结果选择 Agent 长流程。`, executionMode, runtimeFingerprint);
  }
  return decision(task, materials, state, "quick", executionMode === "agent" ? agentEngineFamily : "direct_api", "prepared_bounded_task",
    executionMode === "agent"
      ? "材料已由服务端核实且任务边界清楚，由 AI 调用工具完成一次有界材料定位。"
      : "材料已由服务端核实且任务边界清楚，用模型直连定位相关材料段落。", executionMode, runtimeFingerprint);
}

/**
 * 产品任务路由器。可信依赖只在服务端 composition root 构造实例时注入；
 * 每次 HTTP 请求只能提交 task，不能提交 resolver、operation registry 或 ready 结果。
 */
export class TaskRouter {
  readonly #resolveMaterial: TaskMaterialResolver["resolve"];
  readonly #validateOperation: TaskOperationRegistry["validate"];

  constructor(dependencies: TaskRouterDependencies) {
    if (!dependencies || typeof dependencies.materials?.resolve !== "function" ||
        typeof dependencies.operations?.validate !== "function") {
      throw new TypeError("TaskRouter 需要材料解析器与确定性操作注册表");
    }
    this.#resolveMaterial = dependencies.materials.resolve.bind(dependencies.materials);
    this.#validateOperation = dependencies.operations.validate.bind(dependencies.operations);
  }

  async route(taskInput: unknown, signal?: AbortSignal, executionMode: ExecutionMode = "agent",
    runtimeFingerprint = "0".repeat(64), agentEngineFamily: AgentEngineFamily = "api_agent"): Promise<RouteDecision> {
    if (!/^[a-f0-9]{64}$/.test(runtimeFingerprint)) throw new TaskRouteError("invalid_task", "AI 来源指纹无效");
    if (agentEngineFamily !== "api_agent" && agentEngineFamily !== "local_agent") {
      throw new TaskRouteError("invalid_task", "Agent 引擎家族无效");
    }
    const task = parseResearchTask(taskInput);
    let inputs: MaterialResolutionEntry[];
    try {
      inputs = await Promise.all(task.inputRefs.map(async (ref, index) =>
        checkedMaterial(ref, await this.#resolveMaterial(task, ref, signal), index)));
    } catch (error) {
      if (error instanceof TaskRouteError) throw error;
      throw new TaskRouteError("material_resolution_failed", "材料解析失败，未执行任务");
    }
    const materials: TaskMaterialResolution = Object.freeze({
      schemaVersion: 1,
      taskId: task.id,
      inputs: Object.freeze(inputs),
    });
    if (task.operation) {
      try {
        await this.#validateOperation(task, task.operation, signal);
      } catch (error) {
        if (error instanceof TaskRouteError) throw error;
        throw new TaskRouteError("operation_not_available", "确定性操作未在注册表中通过校验");
      }
    }
    return decideResearchTask(task, materials, executionMode, runtimeFingerprint, agentEngineFamily);
  }
}
