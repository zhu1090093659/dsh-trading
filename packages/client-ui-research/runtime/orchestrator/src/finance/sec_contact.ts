/**
 * SEC EDGAR 的联系方式(设置页选填)。
 *
 * SEC 要求每个访问者在 User-Agent 里写自己的「英文姓名 邮箱」,不写一律 403;产品不能替用户编一个,也不冒充浏览器。
 * 所以由用户自己填:只存在数据根的 sec-contact.json(权限 0600),只交给声明了 VRA_SEC_CONTACT 的端点 / 工具的
 * 取数子进程,由取数层放进发往 SEC 的请求头 —— 不进日志、错误信息,也不发给别处。
 *
 * 环境变量 VRA_SEC_CONTACT 设了就以它为准(部署者的配置),页面不能改。
 * 每次取数现读这个小文件:设置页保存后,已经开着的后台、MCP 进程不用重启就能用上。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { restrictPrivateFile } from "../fsutil.ts";
import type { SavedCredential } from "../plugin.ts";
import { CredentialError } from "../saved_credentials.ts";

export const SEC_CONTACT_VAR = "VRA_SEC_CONTACT";
export const SEC_CONTACT_FILE = "sec-contact.json";
const MAX_CONTACT = 200;
/** 姓名 + 空格 + 邮箱,邮箱在最后(SEC 示例的顺序);邮箱域名至少两段 */
const CONTACT_RE = /^([^@]+?) ([^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+)$/;
const EXAMPLE = "例如 Zhang San zhangsan@example.com";

/** 校验不通过:Core 认 CredentialError,把 code 与提示原样交给页面 */
export class SecContactError extends CredentialError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "SecContactError";
  }
}

export interface SecContactStatus {
  /** env = 环境变量指定(页面不能改);saved = 设置页保存的;none = 没填 */
  source: "env" | "saved" | "none";
  /** 打码后的样子(录屏、截图不露全名和邮箱);没填为 null */
  masked: string | null;
  /** 格式对不对。设置页存的一定对;环境变量是部署者自己写的,可能不对 */
  valid: boolean;
}

/**
 * 整理并校验:去掉首尾空白、中间连续空白并成一个空格(换行、制表符也并掉,请求头里不会出现换行);
 * 只收可打印 ASCII —— 请求头只能放这些。不合格抛 SecContactError。
 */
export function normalizeSecContact(input: string): string {
  const v = String(input).trim().replace(/\s+/g, " ");
  if (!v) throw new SecContactError("bad_sec_contact", "联系方式是空的");
  if (v.length > MAX_CONTACT) throw new SecContactError("bad_sec_contact", `联系方式太长（最多 ${MAX_CONTACT} 个字符）`);
  if (!/^[\x20-\x7E]+$/.test(v)) throw new SecContactError("bad_sec_contact", `姓名请用英文或拼音，邮箱也只能是英文字符（SEC 只认这些），${EXAMPLE}`);
  const m = CONTACT_RE.exec(v);
  if (!m || !/[A-Za-z]/.test(m[1])) throw new SecContactError("bad_sec_contact", `格式是「英文姓名 邮箱」：姓名在前、邮箱在后，中间空一格，${EXAMPLE}`);
  return v;
}

const validContact = (v: string): string | null => { try { return normalizeSecContact(v); } catch { return null; } };
const envContact = (env: NodeJS.ProcessEnv) => String(env[SEC_CONTACT_VAR] ?? "").trim();

/** 设置页保存的联系方式。文件没有、读不懂或内容不合格一律当没填:坏文件不能拖垮取数。 */
export function readSavedSecContact(dataRoot: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dataRoot, SEC_CONTACT_FILE), "utf8"));
    const v = parsed && typeof parsed === "object" ? (parsed as { contact?: unknown }).contact : undefined;
    return typeof v === "string" ? validContact(v) : null;
  } catch {
    return null;
  }
}

/**
 * 实际交给取数进程的值:环境变量优先,其次设置页保存的。
 * 🔴 环境变量也按同一口径整理、校验:夹着换行的值会被请求库拒绝,而它的报错里带着整串原值。
 *    环境变量设了但格式不对 = 当没填(不退回设置页存的那份:设了环境变量页面就锁住,用户看到的是「格式不对」)。
 */
export function secContactValue(dataRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const e = envContact(env);
  return e ? validContact(e) : readSavedSecContact(dataRoot);
}

/** 「Zhang San zhangsan@example.com」→「Z*** S*** z***@example.com」;格式不对的只露第一个字符 */
export function maskSecContact(v: string): string {
  const m = CONTACT_RE.exec(v);
  if (!m) return `${v.slice(0, 1)}***`;
  const name = m[1].split(" ").map((w) => `${w.slice(0, 1)}***`).join(" ");
  const at = m[2].indexOf("@");
  return `${name} ${m[2].slice(0, 1)}***${m[2].slice(at)}`;
}

export function secContactStatus(dataRoot: string, env: NodeJS.ProcessEnv = process.env): SecContactStatus {
  const e = envContact(env);
  if (e) {
    const v = validContact(e);
    return { source: "env", masked: maskSecContact(v ?? e.replace(/\s+/g, " ")), valid: v !== null };
  }
  const saved = readSavedSecContact(dataRoot);
  return saved ? { source: "saved", masked: maskSecContact(saved), valid: true } : { source: "none", masked: null, valid: false };
}

/**
 * 设置页保存 / 清除(input 为 null 或空白 = 清除,回到东财)。
 * 先写同目录临时文件(创建时就是 0600)再改名:不会留下写了一半的文件,也没有一段时间是别人可读的。
 */
export function saveSecContact(dataRoot: string, input: string | null, env: NodeJS.ProcessEnv = process.env): SecContactStatus {
  if (envContact(env)) {
    throw new SecContactError("sec_contact_env_locked", "SEC 联系方式已由环境变量 VRA_SEC_CONTACT 指定；要改请改这个变量");
  }
  const file = path.join(dataRoot, SEC_CONTACT_FILE);
  if (input === null || !String(input).trim()) {
    fs.rmSync(file, { force: true });
    return secContactStatus(dataRoot, env);
  }
  const contact = normalizeSecContact(input);
  fs.mkdirSync(dataRoot, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ contact, saved_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  // Windows 上 mode 不起作用:用和 api.token 同一套办法收紧成只有自己可读
  try { restrictPrivateFile(tmp); fs.renameSync(tmp, file); }
  catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
  return secContactStatus(dataRoot, env);
}

/**
 * 交给 Core 的设置项(Plugin.savedCredentials):接口 /settings/sec-contact,请求体 {"contact": "..."}。
 * 远程访问模式:拿到分享链接的人不能替部署者决定以谁的名义访问 SEC。
 */
export const SEC_CONTACT_CREDENTIAL: SavedCredential = {
  id: "sec-contact",
  envVar: SEC_CONTACT_VAR,
  bodyField: "contact",
  remoteLockedMessage: "远程访问模式下不能在页面里修改 SEC 联系方式：请部署者用环境变量 VRA_SEC_CONTACT 设置后重启",
  status: (dataRoot, env) => secContactStatus(dataRoot, env),
  value: (dataRoot, env) => secContactValue(dataRoot, env),
  save: (dataRoot, input, env) => {
    if (input !== null && typeof input !== "string") throw new SecContactError("bad_sec_contact", "联系方式必须是文字");
    return saveSecContact(dataRoot, input, env);
  },
};
