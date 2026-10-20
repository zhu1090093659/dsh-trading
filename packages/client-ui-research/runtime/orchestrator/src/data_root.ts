import fs from "node:fs";
import path from "node:path";

/**
 * 只读取产品配置里决定数据位置的一个字段。
 * 完整配置仍由 productConfig.ts 做 schema 校验；浏览器开发服务器只需要先找到 API token。
 */
export function readConfiguredDataRoot(
  repoRoot: string,
  productConfigFile = "vibe-research.config.json",
  fallback = ".local",
): string {
  const file = path.join(repoRoot, productConfigFile);
  if (!fs.existsSync(file)) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`产品配置不是合法 JSON:${file}(${error instanceof Error ? error.message : String(error)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;

  const paths = (parsed as { paths?: unknown }).paths;
  if (paths === undefined) return fallback;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return fallback;

  const configured = (paths as { data_root?: unknown }).data_root;
  if (configured === undefined) return fallback;
  if (typeof configured !== "string" || configured.length === 0) return fallback;
  return configured;
}

/** 数据根唯一解析口径：显式覆盖 > 环境变量 > 产品配置，所有相对路径均相对产品根。 */
export function resolveDataRoot(
  repoRoot: string,
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  if (override) return path.resolve(override);
  if (env.VRA_DATA_ROOT) return path.resolve(repoRoot, env.VRA_DATA_ROOT);
  return path.resolve(repoRoot, configured);
}
