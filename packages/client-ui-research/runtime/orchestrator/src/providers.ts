/**
 * 模型 API 模板:产品级 providers/<id>.json ← 用户覆盖 <data_root>/providers/<id>.json。
 * 只含环境变量名与契约元数据,永不含密钥。
 *
 * v2 起模板只描述 **OpenAI 兼容的 Chat Completions 端点**(`POST {base_url}/chat/completions`):
 * 页面直连对话与六阶段研究的「API 大脑」共用这一份。
 * v1 为旧引擎(Responses 协议)写的字段(wire_api / auth_modes / responses_support / http_headers …)
 * **读得懂但一律不用** —— 用户数据根里留着的旧覆盖模板不会因此加载失败。
 */
import fs from "node:fs";
import path from "node:path";

import AjvModule from "ajv";
import { NOFOLLOW_FLAG } from "./fsutil.ts";

// 不 import schemas.ts:config.ts → providers.ts → schemas.ts → config.ts 会成环(模块求值期 STAGES 未定义);这里直接用 Ajv
const AjvCtor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (o: object) => { compile: (s: object) => unknown };
const ajv = new AjvCtor({ allErrors: true, strict: false });
let compiled: ((x: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null } | null = null;
function validateWith(schema: unknown, data: unknown): string[] {
  if (!compiled) compiled = ajv.compile(schema as object) as never;
  const ok = compiled!(data);
  return ok ? [] : (compiled!.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
}

export interface ProviderProfileFile {
  id: string;
  name: string;
  /** Chat Completions 的根地址(请求发往 `{base_url}/chat/completions`);null = 模板不给,必须由用户填 */
  base_url: string | null;
  /** API key 所在的环境变量名(值永不进模板) */
  env_key: string;
  default_model: string | null;
  context_limit_tokens?: number | null;
  known_incompatibilities?: string[];
  /** 模板里易变的供应商信息(base_url / default_model)最近一次人工核实日期;null = 未核实 */
  verified_at?: string | null;
  notes?: string[];
  /**
   * **产品对这家 Chat Completions 端点的实测记录**。缺省(不写这一段)= **没测过**:
   * 照样能用,但结构化要求只写进提示词,界面与运行记录都如实标「未实测」,不是静默降级。
   *
   * ⚠️ 段名 `direct` 是 v1 的历史名(当时只有直连对话走 Chat Completions),为了不让用户已有的
   *    覆盖模板失效而保留;现在它就是「这家 API 的实测结论」。
   */
  direct?: {
    /** 实测是否可用。false = 实测不可用,产品拒绝接入(不是"没测过") */
    supported: boolean;
    /** 缺省沿用顶层 base_url */
    base_url?: string | null;
    /** 缺省沿用顶层 default_model */
    default_model?: string | null;
    /** 实测的结构化输出能力:服务端 schema 约束,还是只能写进提示词 */
    structured_output: "server_schema" | "prompt";
    /** 实测日期 YYYY-MM-DD */
    verified_at?: string;
    notes?: string[];
  };
  /** v1 的旧引擎兼容矩阵记录(Responses 协议),v2 不再使用 */
  matrix?: { status: string; note?: string; last_run?: string; results?: Record<string, string> };
}

export const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/**
 * 停用的来源 id → 迁移说明。🔴 这些 id 在 v2 **一律报错**,不能按同名模板继续解析:
 * v1 的 `openai`(v1 init 骨架的默认值)指产品内置 Codex 的 ChatGPT 登录;v2 若把它解析成同名的 OpenAI 官方 API 模板,
 * 只要环境里恰好有 OPENAI_API_KEY,订阅用户就会被**悄悄改成按量计费**。所以 API 模板改名 `openai-api`,旧名只用来报错指路。
 */
const RENAMED_PROVIDER_IDS: Readonly<Record<string, string>> = Object.freeze({
  openai: "来源 id「openai」在 v2 已停用：v1 里它指产品内置 Codex 的 ChatGPT 登录（已移除）。要用 ChatGPT 订阅，改成 cli-codex（本机 Codex CLI，用你自己的 ChatGPT 登录）；要用 OpenAI 官方 API 按量计费，改成 openai-api（key 放环境变量 OPENAI_API_KEY）",
});
/** 停用来源 id 的迁移说明;不是停用 id → null(只认自有键,原型链上的名字不算) */
export function renamedProviderHint(id: string): string | null {
  return Object.hasOwn(RENAMED_PROVIDER_IDS, id) ? RENAMED_PROVIDER_IDS[id]! : null;
}
/** URL 的共同边界:远程 HTTPS;HTTP 仅显式本机回环,不接受 URL 内凭据。 */
export function providerUrlError(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "模型地址不是合法 URL"; }
  if (/[\\\s]/.test(value)) return "模型地址不能包含空白或反斜杠";
  if (url.username || url.password || url.search || url.hash) return "模型地址不能携带用户名密码、查询参数或片段;请把凭据填到 API Key";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) return null;
  return "远程模型地址必须使用 HTTPS;HTTP 仅允许 localhost、127.0.0.1 或 [::1] 的本机服务";
}
const ENV_KEY_RE = "^[A-Z][A-Z0-9_]*$";
/** key 会以这个变量名注入子进程环境:不许借用系统变量名 */
const FORBIDDEN_ENV = ["PATH", "HOME", "USER", "SHELL", "CODEX_HOME", "TMPDIR", "LANG", "TERM"];

/** v1 旧引擎字段:允许出现(旧覆盖模板照样能加载),内容不校验、也不使用 */
export const LEGACY_PROFILE_KEYS = ["wire_api", "auth_modes", "requires_openai_auth", "responses_support", "stream_format", "tool_calls", "reasoning",
  "retryable_errors", "query_params", "http_headers", "env_http_headers", "request_max_retries", "stream_max_retries",
  "stream_idle_timeout_ms", "structured_output"] as const;

export const providerProfileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "base_url", "env_key", "default_model"],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" }, name: { type: "string", minLength: 1 },
    base_url: { type: ["string", "null"], pattern: "^https?://[^\\s]+$" }, env_key: { type: "string", pattern: ENV_KEY_RE, not: { enum: FORBIDDEN_ENV } },
    default_model: { type: ["string", "null"] }, context_limit_tokens: { type: ["integer", "null"], minimum: 1 },
    known_incompatibilities: { type: "array", items: { type: "string" } },
    verified_at: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    notes: { type: "array", items: { type: "string" } },
    // ⚠️ TS 类型改了不会报错,运行时的门是这份 schema —— 两份真理源,加字段时必须一起改。
    direct: {
      type: "object", additionalProperties: false, required: ["supported", "structured_output"],
      properties: {
        supported: { type: "boolean" },
        base_url: { type: ["string", "null"], pattern: "^https?://[^\\s]+$" },
        default_model: { type: ["string", "null"] },
        structured_output: { type: "string", enum: ["server_schema", "prompt"] },
        verified_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        notes: { type: "array", items: { type: "string" } },
      },
    },
    matrix: { type: "object" },
    ...Object.fromEntries(LEGACY_PROFILE_KEYS.map((k) => [k, {}])),
  },
} as const;

/** 结构化输出走哪条路:服务端 JSON Schema 约束,还是写进提示词 */
export type StructuredOutputMode = "server_schema" | "prompt";

/**
 * 一份模板在 Chat Completions 下能不能用、用到什么程度。
 * `verified=false` 是**没测过**,不是"已验证的保守选择" —— 两者都会走 prompt 模式,
 * 外观一模一样,调用方必须把前者说出来,否则用户会以为那是产品的结论。
 */
export type ApiCapability =
  | { usable: true; baseURL: string; model: string | null; structuredOutput: StructuredOutputMode; verified: boolean; reason: string }
  | { usable: false; code: "api_unsupported" | "needs_base_url"; reason: string };

export function apiCapabilityOf(prof: ProviderProfileFile): ApiCapability {
  const d = prof.direct;
  const baseURL = d?.base_url ?? prof.base_url;
  const model = d?.default_model ?? prof.default_model ?? null;
  if (d && !d.supported) {
    return { usable: false, code: "api_unsupported",
      reason: `${prof.id} 的模板声明其 Chat Completions 端点实测不可用${d.verified_at ? `(${d.verified_at})` : ""}` };
  }
  if (!baseURL) return { usable: false, code: "needs_base_url", reason: `${prof.id} 的模板没有给端点地址,请填 Base URL` };
  if (!d) {
    return { usable: true, baseURL, model, structuredOutput: "prompt", verified: false,
      reason: `${prof.id} 的 Chat Completions 端点产品还没实测过:结构化要求写进提示词,产物照常由产品自己的校验把关` };
  }
  return { usable: true, baseURL, model, structuredOutput: d.structured_output, verified: true,
    reason: `${prof.id} 实测可用${d.verified_at ? `(${d.verified_at})` : ""};结构化输出=${d.structured_output}` };
}

/** 模板的实测状态(给界面打标用):verified = 实测可用 / unsupported = 实测不可用 / untested = 没测过 */
export function apiVerificationOf(raw: unknown): "verified" | "unsupported" | "untested" {
  const d = raw && typeof raw === "object" ? (raw as { direct?: { supported?: unknown } }).direct : undefined;
  if (d && typeof d === "object") {
    if (d.supported === true) return "verified";
    if (d.supported === false) return "unsupported";
  }
  return "untested";
}

/**
 * 按 provider 的能力决定 schema 走哪条路。
 *
 * 🔴 为什么可以降级到提示词而不算放松要求:**`outputSchema` 从来就不是校验边界**。
 *    它是给模型的约束,产物合不合规是我们自己校验的(阶段产物过 validator、导入草稿过 parseOutput)。
 *    ⇒ 降级损失的是**命中率**不是**正确性**:写歪了照样过不了我们这关。
 *
 * ⚠️ 所以这条降级**不能**顺手把校验也一起省掉 —— 那才是真放松。
 */
export function withOutputSchema(
  prompt: string,
  schema: unknown,
  mode: StructuredOutputMode,
): { prompt: string; outputSchema?: unknown } {
  if (schema === undefined || schema === null) return { prompt };
  if (mode === "server_schema") return { prompt, outputSchema: schema };
  return {
    prompt:
      `${prompt}\n\n---\n\n` +
      "**最终回复必须是一个 JSON 对象,且只有这个 JSON —— 不要代码围栏、不要任何解释文字。**\n" +
      "它必须符合下面这份 JSON Schema(你所在的通道不支持由服务端强制 schema,所以这里靠你自己遵守):\n" +
      "```json\n" +
      `${JSON.stringify(schema, null, 2)}\n` +
      "```",
  };
}

export function validateProfile(p: unknown, label: string): ProviderProfileFile {
  const errs = validateWith(providerProfileSchema, p);
  if (errs.length) throw new Error(`${label} 不符合 provider 模板 schema:${errs.slice(0, 5).join("; ")}`);
  const prof = p as ProviderProfileFile;
  for (const u of [prof.base_url, prof.direct?.base_url]) {
    if (!u) continue;
    const error = providerUrlError(u);
    if (error) throw new Error(`${label}:${error}`);
    // 模板里有需要用户替换的占位(如 {WorkspaceId})。没换就直接发请求,会得到一个看不懂的 404/401
    const ph = /[{<]([A-Za-z_][A-Za-z0-9_]*)[}>]/.exec(u);
    if (ph) {
      throw new Error(
        `${label}:base_url 里还有没替换的占位符 ${ph[0]},模板不能直接用。` +
          `请把这份模板复制到 <数据根>/providers/${prof.id}.json,把 ${ph[0]} 换成你自己的值,再选用 ${prof.id}。`,
      );
    }
  }
  return prof;
}

export function providersDirs(repoRoot: string, dataRoot: string): { product: string; user: string } {
  return { product: path.join(repoRoot, "providers"), user: path.join(dataRoot, "providers") };
}

const MISSING = Symbol("missing");

/**
 * 读 providers 目录里的一份模板:目录不得是符号链接、realpath 必须落在根(仓库根 / 数据根)之内,最终文件 O_NOFOLLOW 打开。
 * 只有「文件不存在」返回 MISSING(去下一层找);存在但不是普通文件(符号链接、目录)直接报错 —— 以前当成不存在,
 * 用户的覆盖模板被悄悄跳过、改用产品模板,使用者还以为自己的覆盖生效了。内容(含 JSON null)一律交给 schema 校验。
 */
function readProfileJson(dir: string, id: string, root: string, label: string): unknown {
  const f = path.join(dir, `${id}.json`);
  let st: fs.Stats;
  try { st = fs.lstatSync(f); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return MISSING;
    throw e;
  }
  if (!st.isFile()) throw new Error(`${label} ${f} 不是普通文件(符号链接或目录),拒绝读取`);
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${label} 目录 ${dir} 是符号链接,拒绝读取`);
  const realDir = fs.realpathSync(dir), realRoot = fs.realpathSync(root);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw new Error(`${label} 目录 ${dir} 解析到根目录之外(${realDir}),拒绝读取`);
  const fd = fs.openSync(f, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
  try { return JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
}

/**
 * 读一份模板:用户覆盖优先(整份替换),否则产品模板;都没有 → 抛错列出可用 id。
 *
 * `baseUrlOverride`:**在校验之前**替换 base_url(连同 direct.base_url)。
 * 🔴 顺序是承重的 —— 带占位符的模板会被 `validateProfile` 拒掉,
 *    先校验再替换的话,用户明明在界面上填了自己的地址,仍然会被告知"模板不能直接用"。
 */
export function loadProviderProfile(
  repoRoot: string, dataRoot: string, id: string, baseUrlOverride?: string,
): { profile: ProviderProfileFile; source: string } {
  if (!PROVIDER_ID_RE.test(id)) throw new Error(`非法 provider id ${JSON.stringify(id)}`);
  const renamed = renamedProviderHint(id);
  if (renamed) throw new Error(renamed);  // 数据根里留着 v1 复制的同名覆盖模板也不读
  const { product, user } = providersDirs(repoRoot, dataRoot);
  for (const [dir, root, label] of [[user, dataRoot, "用户 provider"], [product, repoRoot, "产品 provider"]] as const) {
    const raw0 = readProfileJson(dir, id, root, label);
    if (raw0 === MISSING) continue;
    let raw = raw0;
    if (baseUrlOverride && raw0 && typeof raw0 === "object" && !Array.isArray(raw0)) {
      const obj = raw0 as Record<string, unknown>;
      const direct = obj.direct && typeof obj.direct === "object" && !Array.isArray(obj.direct)
        ? { ...(obj.direct as Record<string, unknown>), base_url: baseUrlOverride } : obj.direct;
      raw = { ...obj, base_url: baseUrlOverride, ...(direct !== undefined ? { direct } : {}) };
    }
    const f = path.join(dir, `${id}.json`);
    const prof = validateProfile(raw, `${label} ${f}`);
    if (prof.id !== id) throw new Error(`${label} ${f} 的 id=${prof.id} 与文件名不符`);
    return { profile: prof, source: f };
  }
  throw new Error(`未知 provider ${id};可用:${listProviderIds(repoRoot, dataRoot).join(", ") || "(没有模板)"}`);
}

/** 目录是否可安全枚举:存在、非符号链接、realpath 落在根之内(与 readProfileJson 同口径) */
function safeDir(dir: string, root: string): boolean {
  if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return false;
  const realDir = fs.realpathSync(dir), realRoot = fs.realpathSync(root);
  return realDir === realRoot || realDir.startsWith(realRoot + path.sep);
}

export function listProviderIds(repoRoot: string, dataRoot: string): string[] {
  const { product, user } = providersDirs(repoRoot, dataRoot);
  const ids = new Set<string>();
  for (const [dir, root] of [[product, repoRoot], [user, dataRoot]] as const)
    if (safeDir(dir, root)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".json") && PROVIDER_ID_RE.test(f.slice(0, -5)) && !renamedProviderHint(f.slice(0, -5))) ids.add(f.slice(0, -5));
  return [...ids].sort();
}
