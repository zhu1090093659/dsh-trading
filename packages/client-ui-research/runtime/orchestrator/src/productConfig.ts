/**
 * 产品配置:skills / calc / 数据根 / Python / 后台默认 AI 来源 / 运行默认值,全部从产品自己的配置读。
 * 优先级(低 → 高):内置默认 ← <repo>/vibe-research.config.json(产品,入库)← <data_root>/config.json(用户私有,gitignore)← 环境变量 ← CLI。
 * 不含任何密钥:后台默认 AI 来源只记模板 id,key 从模板声明的环境变量取(见 runtime_provider.ts)。
 *
 * v1 的旧引擎字段(engine.* / provider 的 name·wire_api·base_url·env_key·auth / paths.constitution / defaults.reasoning)
 * **读得懂但不再使用**:旧的用户配置照样能加载,被忽略的键记在 `ignoredLegacy` 里由体检如实报出来。
 */
import fs from "node:fs";
import path from "node:path";

import { resolveDataRoot } from "./data_root.ts";
import { validateWith } from "./schemas.ts";

export interface ProductConfig {
  python: string | null;
  /**
   * 后台默认 AI 来源:`cli-claude` / `cli-codex` / `cli-codebuddy`(本机订阅 Agent),
   * 或 providers/<id>.json 的模板 id(模型 API)。null = 没有默认,页面必须自己选。
   */
  provider: { profile: string | null };
  paths: { skills: string; calc_cli: string; data_root: string };
  defaults: { model: string | null; max_retries: number; gate_retries: number; turn_timeout_min: number; fetch_timeout_sec: number };
}

export const PRODUCT_CONFIG_FILE = "vibe-research.config.json";
export const USER_CONFIG_FILE = "config.json"; // 位于 data_root 下

export const DEFAULT_PRODUCT_CONFIG: ProductConfig = {
  python: null,
  provider: { profile: null },
  paths: { skills: ".agents/skills", calc_cli: "calc/cli.py", data_root: ".local" },
  defaults: { model: null, max_retries: 2, gate_retries: 2, turn_timeout_min: 30, fetch_timeout_sec: 180 },
};

/** v1 字段:允许出现,内容不校验 */
const LEGACY_PROVIDER_KEYS = ["name", "wire_api", "base_url", "env_key", "auth"] as const;

export const productConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    python: { type: ["string", "null"] },
    provider: { type: "object", additionalProperties: false, properties: {
      profile: { type: ["string", "null"], pattern: "^[a-z][a-z0-9_-]{0,31}$" },
      ...Object.fromEntries(LEGACY_PROVIDER_KEYS.map((k) => [k, {}])) } },
    paths: { type: "object", additionalProperties: false, properties: {
      skills: { type: "string", minLength: 1 }, calc_cli: { type: "string", minLength: 1 }, data_root: { type: "string", minLength: 1 },
      constitution: {} } },
    defaults: { type: "object", additionalProperties: false, properties: {
      // null = 不指定(用模板默认)。空串 / 全空格不算"不指定":放行就会被当成没写、悄悄换成模板默认模型(Codex 复审 R4-1)
      model: { type: ["string", "null"], pattern: "\\S" }, max_retries: { type: "integer", minimum: 0, maximum: 5 }, gate_retries: { type: "integer", minimum: 0, maximum: 5 },
      turn_timeout_min: { type: "number", exclusiveMinimum: 0 }, fetch_timeout_sec: { type: "number", exclusiveMinimum: 0 },
      reasoning: {} } },
    engine: { type: "object" },
  },
} as const;

type Partialish = { [K in keyof ProductConfig]?: Partial<ProductConfig[K]> };

/** 读一层配置:校验 schema,剥掉 v1 旧字段(记进 ignored),返回只含 v2 字段的部分配置 */
function readLayer(file: string, label: string, ignored: string[]): Partialish {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`${label} 不是合法 JSON:${file}(${e instanceof Error ? e.message : String(e)})`); }
  const errs = validateWith("product-config", productConfigSchema, parsed);
  if (errs.length) throw new Error(`${label} 不符合 schema:${file}\n  ${errs.slice(0, 5).join("\n  ")}`);
  const raw = parsed as Record<string, Record<string, unknown> | string | null | undefined>;
  const out: Partialish = {};
  if (raw.python !== undefined) out.python = raw.python as string | null;
  if (raw.engine !== undefined) ignored.push("engine");
  const provider = raw.provider as Record<string, unknown> | undefined;
  if (provider) {
    for (const k of LEGACY_PROVIDER_KEYS) if (k in provider) ignored.push(`provider.${k}`);
    if ("profile" in provider) out.provider = { profile: provider.profile as string | null };
  }
  const paths = raw.paths as Record<string, unknown> | undefined;
  if (paths) {
    if ("constitution" in paths) ignored.push("paths.constitution");
    const { constitution: _c, ...rest } = paths;
    out.paths = rest as Partial<ProductConfig["paths"]>;
  }
  const defaults = raw.defaults as Record<string, unknown> | undefined;
  if (defaults) {
    if ("reasoning" in defaults) ignored.push("defaults.reasoning");
    const { reasoning: _r, ...rest } = defaults;
    out.defaults = rest as Partial<ProductConfig["defaults"]>;
  }
  return out;
}

function mergeLayer(base: ProductConfig, layer: Partialish): ProductConfig {
  return {
    python: layer.python !== undefined ? layer.python : base.python,
    provider: { ...base.provider, ...(layer.provider ?? {}) },
    paths: { ...base.paths, ...(layer.paths ?? {}) },
    defaults: { ...base.defaults, ...(layer.defaults ?? {}) },
  };
}

export interface LoadedProductConfig extends ProductConfig {
  /** 已解析为绝对路径 */
  resolved: { dataRoot: string; skills: string; calcCli: string; scriptsRel: string };
  sources: string[];
  /** 读到了但 v2 不再使用的旧字段 / 旧环境变量(体检如实报给用户) */
  ignoredLegacy: string[];
}

/** 读取并合并各层;相对路径一律相对产品根(repoRoot)解析 */
export function loadProductConfig(repoRoot: string, opts: {
    userConfigPath?: string;
    /**
     * 覆盖数据根。**一次决定三样东西**:用户配置在哪、provider 用户覆盖模板在哪、产物落在哪。
     * 🔴 只单独塞 `userConfigPath` 会让"用户配置"与"用户覆盖模板"从两个根读,且不报错。
     */
    dataRootOverride?: string;
    env?: NodeJS.ProcessEnv;
    /** CLI --provider */
    providerOverride?: string;
  } = {}): LoadedProductConfig {
  const env = opts.env ?? process.env;
  const sources: string[] = ["builtin"];
  const ignoredLegacy: string[] = [];
  let cfg = DEFAULT_PRODUCT_CONFIG;
  const productFile = path.join(repoRoot, PRODUCT_CONFIG_FILE);
  if (fs.existsSync(productFile)) { cfg = mergeLayer(cfg, readLayer(productFile, "产品配置", ignoredLegacy)); sources.push(productFile); }
  /**
   * 数据根。**只在这里算一次,后面所有地方都用它。**
   * 优先级:调用方显式 override > `VRA_DATA_ROOT` > 产品配置里的 `paths.data_root`(相对产品根)。
   */
  const dataRoot = resolveDataRoot(repoRoot, cfg.paths.data_root, env, opts.dataRootOverride);
  const userFile = opts.userConfigPath ?? path.join(dataRoot, USER_CONFIG_FILE);
  if (fs.existsSync(userFile)) {
    const layer = readLayer(userFile, "用户配置", ignoredLegacy);
    if (layer.paths && "data_root" in layer.paths) throw new Error(`用户配置不得修改 paths.data_root(它决定了用户配置自身的位置):${userFile}`);
    cfg = mergeLayer(cfg, layer); sources.push(userFile);
  }
  const envLayer: Partialish = {};
  if (env.VRA_PYTHON) envLayer.python = env.VRA_PYTHON;
  if (env.VRA_PROVIDER) envLayer.provider = { profile: assertProfileId(env.VRA_PROVIDER, "VRA_PROVIDER") };
  for (const k of ["VRA_CODEX_PATH", "VRA_CODEX_HOME", "VRA_PROVIDER_AUTH"]) if (env[k]) ignoredLegacy.push(k);
  if (Object.keys(envLayer).length) { cfg = mergeLayer(cfg, envLayer); sources.push("env"); }
  if (opts.providerOverride !== undefined) {
    cfg = mergeLayer(cfg, { provider: { profile: assertProfileId(opts.providerOverride, "--provider") } }); sources.push("cli");
  }
  const abs = (p: string) => path.resolve(repoRoot, p);
  return {
    ...cfg,
    resolved: {
      dataRoot,
      skills: abs(cfg.paths.skills),
      calcCli: abs(cfg.paths.calc_cli),
      scriptsRel: path.join(cfg.paths.skills, "data-access", "scripts"),
    },
    sources,
    ignoredLegacy,
  };
}

function assertProfileId(v: string, label: string): string {
  if (/^[a-z][a-z0-9_-]{0,31}$/.test(v)) return v;
  throw new Error(`${label} 不是合法的 AI 来源 id:${JSON.stringify(v)}(本机订阅用 cli-claude / cli-codex / cli-codebuddy,模型 API 用 providers/ 里的模板 id)`);
}
