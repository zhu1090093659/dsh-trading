/**
 * 远程访问口令(`scripts/start --remote`):给云端 Agent 部署后把页面发给使用者用。
 *
 * 口令只给页面服务器(Vite preview)用来放行浏览器;本机 API 仍只听回环、仍用自己的 api.token。
 * 🔴 口令等价于整个工作台的使用权(包括这台机器上已登录的订阅 Agent):只发给要给的人。
 *
 * 来源优先级:环境变量 VRA_ACCESS_TOKEN(平台 / 部署者自己管)→ <数据根>/access.token(首次生成后沿用,
 * 机器重启链接不变)。换链接 = 重新生成,旧链接立即失效。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readConfiguredDataRoot, resolveDataRoot } from "./data_root.ts";

/** cookie / URL 都安全的字符集;32 位起步,够长才无法猜 */
export const ACCESS_TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

export function isValidAccessToken(token: unknown): token is string {
  return typeof token === "string" && ACCESS_TOKEN_RE.test(token);
}

export function accessTokenPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataRoot(repoRoot, readConfiguredDataRoot(repoRoot), env), "access.token");
}

export interface AccessToken {
  token: string;
  /** env = 来自 VRA_ACCESS_TOKEN;file = 沿用已有文件;new = 这次新生成(首次或换链接) */
  source: "env" | "file" | "new";
}

export function ensureAccessToken(repoRoot: string, env: NodeJS.ProcessEnv = process.env, rotate = false): AccessToken {
  if (env.VRA_ACCESS_TOKEN !== undefined) {
    if (!isValidAccessToken(env.VRA_ACCESS_TOKEN)) {
      throw new Error("环境变量 VRA_ACCESS_TOKEN 不合格:至少 32 位,只能用字母、数字、- 和 _");
    }
    if (rotate) throw new Error("访问口令来自环境变量 VRA_ACCESS_TOKEN:要换链接,请换这个变量的值");
    return { token: env.VRA_ACCESS_TOKEN, source: "env" };
  }
  const file = accessTokenPath(repoRoot, env);
  if (!rotate) {
    let existing = "";
    try { existing = fs.readFileSync(file, "utf8").trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (isValidAccessToken(existing)) {
      fs.chmodSync(file, 0o600);
      return { token: existing, source: "file" };
    }
    // 文件不存在或内容不合格(被截断 / 手改坏):按首次生成处理
  }
  const token = randomBytes(32).toString("base64url");
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
  try { fs.renameSync(tmp, file); }
  catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
  fs.chmodSync(file, 0o600);
  return { token, source: "new" };
}

/**
 * 发给使用者的根地址:只收 http(s) 根地址。
 * 页面里的请求一律打绝对路径 `/api/...`,挂在子路径下(如 `/proxy/5930/`)跑不起来 ⇒ 当场拒绝,不留到使用者打开才白屏。
 */
export function normalizePublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`--public-url 不是合法地址:${value}`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("--public-url 只能是 http:// 或 https:// 地址");
  if (url.username || url.password || url.search || url.hash) throw new Error("--public-url 不能带用户名密码、查询参数或 # 片段");
  if (url.pathname !== "/") throw new Error("--public-url 只能是根地址:页面不支持挂在子路径下");
  return `${url.protocol}//${url.host}`;
}

/** 明文 http 且不是本机:使用者在页面里填的 API key 会明文过网 */
export function isPlainRemoteHttp(publicUrl: string): boolean {
  const url = new URL(publicUrl);
  return url.protocol === "http:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
}
