/**
 * **AI 来源(「大脑」)解析** —— 用户在界面上选的那一份按请求带进来;没带就用后台默认。
 *
 * 只有两类大脑:
 *  - **本机订阅 Agent**(`cli-claude` / `cli-codex` / `cli-codebuddy`):用户自己在本机登录好的
 *    Claude Code / Codex CLI / WorkBuddy(CodeBuddy),产品只通过受控工具调用它,免 API key;
 *  - **模型 API**:任意 OpenAI 兼容的 Chat Completions 端点(产品模板或自填地址),要 key。
 *
 * 🔴 与「密钥只从环境变量读」并不冲突:这里收到的 key **一个字节都不落盘**,
 *    只被拼进一个**临时的 env 对象**交给下游;配置文件、日志、账本都碰不到它。
 *
 * 🔴 **认不出的来源直接报错,不回落到任何默认** —— 悄悄换成另一家去打,
 *    用户以为在用自己选的模型,账单和产出却来自别处,而且不会有任何提示。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PROVIDER_ID_RE, apiCapabilityOf, apiVerificationOf, loadProviderProfile, providerUrlError, renamedProviderHint, type StructuredOutputMode } from "./providers.ts";
import { loadProductConfig } from "./productConfig.ts";
import type { LocalAgentId } from "./local_agent_runtime.ts";

/** 界面传下来的那一份。字段名与开源版一致，便于上游页面直接复用。 */
export interface LlmOverride {
  provider: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

/** 页面对话的两种模式:agent = 带产品工具的助手;direct = 不带工具的单次问答 */
export type ExecutionMode = "agent" | "direct";

export function assertExecutionMode(value: unknown): ExecutionMode {
  if (value === undefined) return "agent";
  if (value === "agent" || value === "direct") return value;
  throw new RuntimeProviderError("bad_execution_mode", "executionMode 只能是 agent 或 direct");
}

/** 一个已解析、可直接发请求的模型 API。**只活在内存里**(含 key)。 */
export interface ResolvedApiProvider {
  /** 模板 id;自填端点 = openai-compatible(或界面上那家没有模板的厂商 id) */
  name: string;
  /** 给人看的名字 */
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
  structuredOutput: StructuredOutputMode;
  /** 产品是否实测过这家的 Chat Completions。false = **没测过**,界面与运行记录都要如实说 */
  verified: boolean;
  reason: string;
  /** 交给子进程时放 key 的环境变量名 */
  envKey: string;
}
/** v1 的名字;直连对话现在就是一份普通的 API 来源 */
export type ResolvedDirectProvider = ResolvedApiProvider;

export type ResolvedRuntimeProvider =
  | { runtime: "local-agent"; agent: LocalAgentId; env: NodeJS.ProcessEnv }
  | { runtime: "api"; api: ResolvedApiProvider; env: NodeJS.ProcessEnv };

export class RuntimeProviderError extends Error {
  // ⚠️ 不用构造函数参数属性:`erasableSyntaxOnly` 下那不是可擦除语法(Node 剥类型跑不了)
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** CLI 订阅档：用本机已登录的 CLI，**不需要 key** */
export const isCliProvider = (p: string): boolean => p.startsWith("cli-");

/**
 * 订阅档必须明确映射到有真实适配器的本机 CLI;其余 `cli-*`(旧 localStorage / 手工请求里的
 * Qwen / DeepSeek CLI 等)一律拒绝,不许回落成别的大脑。
 */
const LOCAL_AGENT_BY_PROVIDER = Object.freeze({
  "cli-claude": "claude",
  "cli-codex": "codex",
  "cli-codebuddy": "codebuddy",
} as const satisfies Record<string, LocalAgentId>);

/** 只在本机 / 内网用的名字(RFC 6761 / 6762 / 8375 与 ICANN 保留的 .internal 等):远程模式下页面不能填 */
const PRIVATE_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain"];

/**
 * 远程访问模式下页面填的模型地址:只收 https + 带点的公网域名;IP 字面量(URL 解析器会把十进制 / 十六进制写法都规范成点分)、
 * localhost、内网专用后缀、单段主机名一律拒。⚠️ 解析到内网的**域名**这里管不到(要在连接时解析才知道)。
 * 格式错误不在这里报,交给 providerUrlError。
 */
export function remotePageBaseUrlError(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipLiteral = host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  const privateName = PRIVATE_NAME_SUFFIXES.some((suffix) => `.${host}`.endsWith(suffix));  // 前面补点:localhost 本身也命中
  if (url.protocol === "https:" && !ipLiteral && !privateName && host.includes(".")) return null;
  return "远程访问模式下，页面里填的模型地址只能是 https 公网域名（不能是 IP 地址、localhost 或内网名字）";
}

/** 自填端点用的固定 env 变量名 —— 只存在于内存里的这一份 env */
export const RUNTIME_KEY_VAR = "VRA_RUNTIME_API_KEY";

/** 把界面给的一份配置解析成大脑 + 环境。 */
export function resolveRuntimeProvider(
  repoRoot: string, dataRoot: string, llm: LlmOverride, baseEnv: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeProvider {
  const id = String(llm.provider ?? "").trim();
  if (!id) throw new RuntimeProviderError("bad_provider", "没有指定 AI 来源");
  // 停用的 id(v1 的 openai = 产品内置 Codex 的订阅登录)直接报错指路,不按同名模板解析成按量 API
  const renamed = renamedProviderHint(id);
  if (renamed) throw new RuntimeProviderError("provider_renamed", renamed);

  // ① 本机订阅 Agent:走用户自己的登录态,免 key;模型由登录态决定,界面上的模型名不转发
  if (isCliProvider(id)) {
    if (Object.hasOwn(LOCAL_AGENT_BY_PROVIDER, id)) {
      return { runtime: "local-agent", agent: LOCAL_AGENT_BY_PROVIDER[id as keyof typeof LOCAL_AGENT_BY_PROVIDER], env: baseEnv };
    }
    throw new RuntimeProviderError("unsupported_cli", `订阅档当前只支持 Claude Code、Codex 与 WorkBuddy / CodeBuddy，接不上 ${id}`);
  }

  const key = String(llm.apiKey ?? "").trim();
  const base = String(llm.baseURL ?? "").trim();
  // 🔴 只有**没传**才用模板默认模型。显式传了空串 / 全空格,说明调用方以为自己指定了模型 ——
  //    悄悄换成模板默认,等于替他换了一个模型来调用、计费(Codex 复审 R3-1)。页面自己也不让空模型保存。
  if (llm.model !== undefined && !String(llm.model).trim()) {
    throw new RuntimeProviderError("missing_model", "llm.model 是空的：要用模板的默认模型就不要传这个字段，否则请填写模型名");
  }
  const model = String(llm.model ?? "").trim();
  // 远程访问模式:页面里填的地址由拿到分享链接的人决定 —— 不许借后台去连这台机器自己或任何 IP 上的服务
  // (内网、云元数据)。只管页面传来的 baseURL;后台默认与模板自带的地址不经过这里。
  if (base && baseEnv.VRA_REMOTE === "1") {
    const why = remotePageBaseUrlError(base);
    if (why) throw new RuntimeProviderError("remote_base_url_forbidden", why);
  }

  // ② 任意 OpenAI 兼容端点：产品没有实测记录，如实标出来
  if (id === "openai-compatible" || id === "custom") return customEndpoint("openai-compatible", base, key, model, baseEnv);
  if (!PROVIDER_ID_RE.test(id)) throw new RuntimeProviderError("bad_provider", `AI 来源名不合法:${id}`);

  // ③ 产品(或用户数据根)里的模板
  if (templateIds(repoRoot, dataRoot).includes(id)) {
    if (!key) throw new RuntimeProviderError("missing_key", `${id} 需要 API key`);
    let profile;
    try {
      // baseURL 允许覆盖(私有网关 / 填占位符),交给 loadProviderProfile 在**校验之前**替换
      profile = loadProviderProfile(repoRoot, dataRoot, id, base ? assertHttp(base) : undefined).profile;
    } catch (e) {
      if (e instanceof RuntimeProviderError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      // 占位符这一条要说**在界面上怎么办**:模板层的原话是"复制模板到数据根去改",那是给命令行用户的活
      const ph = /占位符 ([{<][^}>]+[}>])/.exec(raw);
      if (ph && !base) throw new RuntimeProviderError("needs_base_url", `${id} 的端点地址里有占位符 ${ph[1]}，请在 Base URL 里填上你自己的值再保存`);
      throw new RuntimeProviderError("bad_template", raw);
    }
    const cap = apiCapabilityOf(profile);
    if (!cap.usable) throw new RuntimeProviderError(cap.code, cap.reason);
    const chosenModel = model || cap.model;
    if (!chosenModel) throw new RuntimeProviderError("missing_model", `${id} 的模板没有默认模型，请填模型名`);
    return {
      runtime: "api",
      api: Object.freeze({ name: id, label: profile.name, baseURL: cap.baseURL, apiKey: key, model: chosenModel,
        structuredOutput: cap.structuredOutput, verified: cap.verified, reason: cap.reason, envKey: profile.env_key }),
      // 按模板声明的变量名注入,子进程(六阶段研究)按同一个名字取
      env: { ...baseEnv, [profile.env_key]: key },
    };
  }

  // ④ 界面列出的、但产品没有模板的厂商(硅基流动 / OpenRouter 等):用户给了地址就按自填端点走。
  //    请求只会发到用户自己填的那个地址,不存在"悄悄换一家"。
  if (base) return customEndpoint(id, base, key, model, baseEnv);
  throw new RuntimeProviderError("unknown_provider", `没有 ${id} 的模板：请填 Base URL 按自定义端点接入（产品模板见 providers/ 目录）`);
}

function customEndpoint(name: string, base: string, key: string, model: string, baseEnv: NodeJS.ProcessEnv): ResolvedRuntimeProvider {
  if (!base) throw new RuntimeProviderError("missing_base_url", "自定义端点必须填 Base URL");
  if (!key) throw new RuntimeProviderError("missing_key", "自定义端点必须填 API key");
  if (!model) throw new RuntimeProviderError("missing_model", "自定义端点必须填模型名");
  // 与模板共用 URL 校验：远程必须 HTTPS，HTTP 只开放明确的本机地址。
  const checked = assertHttp(base);
  return {
    runtime: "api",
    api: Object.freeze({
      name, label: `${name === "openai-compatible" ? "自定义端点" : name}(${hostOf(checked)})`,
      baseURL: checked, apiKey: key, model, structuredOutput: "prompt" as const, verified: false,
      reason: "用户自填端点，产品没有实测过：结构化要求写进提示词，产物照常由产品自己的校验把关",
      envKey: RUNTIME_KEY_VAR,
    }),
    env: { ...baseEnv, [RUNTIME_KEY_VAR]: key },
  };
}

/**
 * 解析这次请求实际会使用的 AI 来源。未传请求级配置时读后台默认
 * (`<数据根>/config.json` 的 `provider.profile` / 环境变量 `VRA_PROVIDER`)。
 *
 * 🔴 后台默认**没配就报错**:v1 有一个"产品自带引擎 + 产品专用登录"的隐式默认,v2 已经没有了;
 *    这里再编一个默认出来,就是在用户不知情时替他选了大脑。
 */
export function resolveSelectedRuntime(
  repoRoot: string, dataRoot: string, llm?: LlmOverride, baseEnv: NodeJS.ProcessEnv = process.env,
  opts: DefaultSourceOptions = {},
): ResolvedRuntimeProvider {
  return resolveRuntimeProvider(repoRoot, dataRoot, llm ?? defaultLlm(repoRoot, dataRoot, baseEnv, opts), baseEnv);
}

/** 命令行对后台默认的临时覆盖(`--provider` / `--model` / `--config`);页面请求不用它 */
export interface DefaultSourceOptions { providerOverride?: string; model?: string; userConfigPath?: string }

/**
 * 后台默认 AI 来源 → 一份与页面请求同形的 LlmOverride(模型 API 的 key 从模板声明的环境变量取)。
 * 服务层用它把"后台默认"也变成一份显式的请求级来源交给研究子进程,子进程只照着执行、不再自己猜。
 */
export function defaultLlm(repoRoot: string, dataRoot: string, baseEnv: NodeJS.ProcessEnv = process.env, opts: DefaultSourceOptions = {}): LlmOverride {
  let pc: ReturnType<typeof loadProductConfig>;
  try {
    pc = loadProductConfig(repoRoot, { dataRootOverride: dataRoot, env: baseEnv, providerOverride: opts.providerOverride, userConfigPath: opts.userConfigPath });
  } catch (error) {
    throw new RuntimeProviderError("bad_provider", error instanceof Error ? error.message : String(error));
  }
  const id = pc.provider.profile;
  if (!id) {
    const legacy = pc.ignoredLegacy.some((k) => k === "provider.auth" || k === "VRA_PROVIDER_AUTH")
      ? "（v1 的产品专用 Codex 登录已移除；要用 Codex 订阅，请选「Codex 订阅」即 cli-codex，它用你自己在本机登录的 Codex CLI）" : "";
    throw new RuntimeProviderError("ai_source_not_configured",
      `还没有选择 AI 来源：请在页面「接入 AI」里选一个，或在 <数据根>/config.json 写 provider.profile、或设环境变量 VRA_PROVIDER${legacy}`);
  }
  const renamed = renamedProviderHint(id);
  if (renamed) throw new RuntimeProviderError("provider_renamed", renamed);
  const model = opts.model ?? pc.defaults.model ?? undefined;
  if (isCliProvider(id)) {
    if (opts.model) throw new RuntimeProviderError("model_not_supported", "本机订阅 Agent 的模型由已登录的 CLI 自己决定（产品不传模型参数），不能用 --model 覆盖");
    return { provider: id };
  }
  // 后台默认的 API 模板:key 只从模板声明的环境变量读
  let envKey: string;
  try {
    envKey = loadProviderProfile(repoRoot, dataRoot, id).profile.env_key;
  } catch (error) {
    throw new RuntimeProviderError("bad_template", error instanceof Error ? error.message : String(error));
  }
  const apiKey = String(baseEnv[envKey] ?? "").trim();
  if (!apiKey) throw new RuntimeProviderError("missing_key", `后台默认 AI 来源 ${id} 需要环境变量 ${envKey}（密钥只从环境变量读，不进配置文件）`);
  // 🔴 按"有没有给"判断,不按真假值:显式的 "" 要原样交给 resolveRuntimeProvider 报 missing_model,
  //    按真假值省略就成了"没传",被换成模板默认模型去调用、计费(程序化 runBatch({ model: "" }),Codex 复审 R4-1)
  return { provider: id, apiKey, ...(model !== undefined ? { model } : {}) };
}

/**
 * 服务进程 → 研究子进程的来源交接:环境变量里放一份**不含 key** 的来源描述,key 放在 envKey 指向的变量里。
 * 子进程照着它解析,不再自己读后台默认 —— 两边看到的必须是同一个大脑。
 */
export const REQUEST_LLM_META_VAR = "VRA_REQUEST_LLM_META";
export interface RequestLlmMeta { provider: string; baseURL?: string; model?: string; envKey?: string }

export function requestLlmMeta(llm: LlmOverride, runtime: ResolvedRuntimeProvider): RequestLlmMeta {
  if (runtime.runtime === "local-agent") return { provider: llm.provider };
  return {
    provider: llm.provider,
    ...(llm.baseURL ? { baseURL: llm.baseURL } : {}),
    ...(llm.model ? { model: llm.model } : {}),
    envKey: runtime.api.envKey,
  };
}

/** 子进程侧:校验形状并从 envKey 取回 key。形状不对一律报错,不回落到后台默认。 */
export function parseRequestLlmMeta(raw: string, env: NodeJS.ProcessEnv): LlmOverride {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { throw new RuntimeProviderError("bad_request_meta", `${REQUEST_LLM_META_VAR} 格式无效`); }
  const bad = !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => !["provider", "baseURL", "model", "envKey"].includes(key)) ||
    typeof parsed.provider !== "string" ||
    (parsed.envKey !== undefined && (typeof parsed.envKey !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(parsed.envKey))) ||
    (!isCliProvider(parsed.provider) && typeof parsed.envKey !== "string") ||
    ["baseURL", "model"].some((key) => parsed[key] !== undefined && typeof parsed[key] !== "string");
  if (bad) throw new RuntimeProviderError("bad_request_meta", `${REQUEST_LLM_META_VAR} 格式无效`);
  return {
    provider: parsed.provider as string,
    ...(typeof parsed.baseURL === "string" ? { baseURL: parsed.baseURL } : {}),
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    ...(typeof parsed.envKey === "string" ? { apiKey: String(env[parsed.envKey] ?? "") } : {}),
  };
}

/** 两段式任务和多轮辩论用的真实 AI 来源绑定；只暴露摘要，不保留 key。 */
export function runtimeSourceFingerprint(
  repoRoot: string, dataRoot: string, llm?: LlmOverride, baseEnv: NodeJS.ProcessEnv = process.env,
): string {
  const selected = resolveSelectedRuntime(repoRoot, dataRoot, llm, baseEnv);
  const source = selected.runtime === "local-agent"
    ? { runtime: selected.runtime, agent: selected.agent }
    : { runtime: selected.runtime, provider: selected.api.name, baseURL: selected.api.baseURL, model: selected.api.model, apiKey: selected.api.apiKey };
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

/** 只要模型 API(页面直连对话);本机订阅 Agent 不走这条 */
export function resolveDirectProvider(
  repoRoot: string, dataRoot: string, llm: LlmOverride, baseEnv: NodeJS.ProcessEnv = process.env,
): ResolvedApiProvider {
  const resolved = resolveRuntimeProvider(repoRoot, dataRoot, llm, baseEnv);
  if (resolved.runtime !== "api") throw new RuntimeProviderError("direct_provider_unsupported", "本机订阅 Agent 不走 API 直连");
  return resolved.api;
}

/**
 * baseURL 只放 http(s)，且不许带 URL userinfo / query / fragment。
 * API key 只能走单独的 key 字段；否则运行配置的记账链很容易把凭据当成端点地址留下。
 *
 * 🔴 报错**绝不回显原串**：不管凭据藏在 userinfo、query 还是路径里，只要不把 URL 拼进
 *    错误消息，它就不会一路回到前端、也不会被上层记下来。
 *
 * ⚠️ **刻意不做私网/回环封禁**：这是**本机产品**，填 URL 的人就是这台机器的主人；
 *    "私有网关 / 本机推理服务"是文档化的正当用法。
 */
function assertHttp(u: string): string {
  const error = providerUrlError(u);
  if (error) throw new RuntimeProviderError("bad_base_url", error);
  return u;
}

function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return u.slice(0, 40); }
}

/** 产品自带(与用户数据根里)的模板清单(只说"有没有这份模板"，**不代表实测过**) */
export function templateIds(repoRoot: string, dataRoot: string): string[] {
  return Object.keys(templateMatrix(repoRoot, dataRoot)).sort();
}

/**
 * 每份模板的实测状态:`verified` = 产品实测过这家的 Chat Completions;`unsupported` = 实测不可用;
 * `untested` = 只是写好了模板、**没测过**;读不动 / 读坏的 = `unknown`。
 *
 * 🔴 界面靠这个打「已实测」标。**不能用"目录里有这个文件"当判据** —— 那会在界面上造出假的「已实测」。
 * ⚠️ 这里**不做 validateProfile**:带占位符的模板按设计会被它拒掉,
 *    而"它测没测过"与"用户填没填占位符"是两件事。
 */
export function templateMatrix(repoRoot: string, dataRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 用户数据根后读 ⇒ 用户自己放的同名模板覆盖产品那份（与 loadProviderProfile 的优先级一致）
  for (const dir of [path.join(repoRoot, "providers"), path.join(dataRoot, "providers")]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (!PROVIDER_ID_RE.test(id) || isCliProvider(id) || renamedProviderHint(id)) continue;
      try {
        out[id] = apiVerificationOf(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      } catch {
        out[id] = "unknown";
      }
    }
  }
  return out;
}
