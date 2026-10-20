/**
 * 新版提示:每天去 GitHub 查一次最新正式发布(没查成隔一小时再试),有更新就在页面顶部提示一行。
 *
 * - 只发一个带当前版本号的 User-Agent,不带本机任何数据;GitHub 能看到的只有请求来源 IP。
 * - 用户可在设置页关掉,或对某个版本「不再提示」;环境变量 VRA_UPDATE_CHECK=0 整个关掉(不联网)。
 * - 状态存在数据目录的 update.json(随 .local 一起走,换新文件夹复制过去就还在)。
 * - 链接一律由我们按发布的版本标签自己拼,不用接口返回的地址,也不用 update.json 里存的地址(那个文件谁都能改)。
 */
import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists, writeJson } from "./fsutil.ts";
import { ServiceError } from "./service.ts";
import { productVersion } from "./version.ts";

export const RELEASES_API = "https://api.github.com/repos/simonlin1212/Vibe-Research/releases/latest";
export const RELEASE_PAGE = "https://github.com/simonlin1212/Vibe-Research/releases";
export const CHECK_INTERVAL_MS = 24 * 3600 * 1000;
/** 查失败(没网 / 被限流)隔一小时再试,别等一整天 */
export const RETRY_INTERVAL_MS = 3600 * 1000;
export const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_CHARS = 2_000_000;
const STATE_FILE = "update.json";

export interface LatestRelease { version: string; tag: string; url: string; published_at: string | null }
export interface UpdateState {
  enabled: boolean;
  skip_version: string | null;
  checked_at: string | null;
  latest: LatestRelease | null;
  error: string | null;
}
export interface UpdateView extends UpdateState {
  current: string;
  /** portable = 免安装包(包根有 package-info.json 且 kind=portable);其余按源码安装 */
  install: "portable" | "source";
  env_disabled: boolean;
  update_available: boolean;
}
export interface UpdateDeps {
  repoRoot: string;
  dataRoot: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  current?: string;
}

const DEFAULT_STATE: UpdateState = { enabled: true, skip_version: null, checked_at: null, latest: null, error: null };

/** "v2.1.0" / "2.1.0" → [2,1,0];带预发布后缀或看不懂的一律 null(不提示) */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const sameVersion = (a: string | null, b: string | null): boolean => {
  const x = parseVersion(a), y = parseVersion(b);
  return Boolean(x && y && x.join(".") === y.join("."));
};

export function envDisabled(env: NodeJS.ProcessEnv): boolean {
  return /^(0|false|off|no)$/i.test((env.VRA_UPDATE_CHECK ?? "").trim());
}

export function installKind(repoRoot: string): "portable" | "source" {
  const info = readJsonIfExists<{ kind?: unknown }>(path.join(repoRoot, "package-info.json"));
  return info?.kind === "portable" ? "portable" : "source";
}

const normalizeVersion = (v: string): string => (parseVersion(v) as number[]).join(".");
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** 发布标签只认 v1.2.3 / 1.2.3 这种,前后不许有别的字符(要拼进链接) */
const TAG_RE = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}$/;
export const releaseUrl = (tag: string): string => `${RELEASE_PAGE}/tag/${tag}`;

function readState(dataRoot: string): UpdateState {
  const raw = readJsonIfExists<Record<string, unknown>>(path.join(dataRoot, STATE_FILE));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_STATE };
  const l = raw.latest as Record<string, unknown> | null | undefined;
  // 存的地址不用:按标签重拼;标签和版本号对不上就当没有
  const tag = l && typeof l === "object" && typeof l.tag === "string" && TAG_RE.test(l.tag) ? l.tag : null;
  const latest = tag && parseVersion(l!.version) && normalizeVersion(l!.version as string) === normalizeVersion(tag)
    ? { version: normalizeVersion(tag), tag, url: releaseUrl(tag), published_at: str(l!.published_at) } : null;
  return {
    enabled: raw.enabled !== false,
    skip_version: parseVersion(raw.skip_version) ? normalizeVersion(raw.skip_version as string) : null,
    checked_at: str(raw.checked_at),
    latest,
    error: str(raw.error),
  };
}

function writeState(dataRoot: string, s: UpdateState): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  writeJson(path.join(dataRoot, STATE_FILE), s);
}

function view(d: UpdateDeps, s: UpdateState): UpdateView {
  const current = d.current ?? productVersion();
  const off = envDisabled(d.env ?? process.env);
  const update_available = s.enabled && !off && s.latest !== null && isNewer(s.latest.version, current) && !sameVersion(s.latest.version, s.skip_version);
  return { ...s, current, install: installKind(d.repoRoot), env_disabled: off, update_available };
}

function due(s: UpdateState, now: number): boolean {
  const t = s.checked_at ? Date.parse(s.checked_at) : NaN;
  if (!Number.isFinite(t) || t > now) return true;   // 没查过 / 时间写坏 / 时钟往回拨
  return now - t >= (s.error ? RETRY_INTERVAL_MS : CHECK_INTERVAL_MS);
}

/** 接口返回的东西只取版本号和发布时间;看不懂就当没有,原因如实写进 error */
async function fetchLatest(d: UpdateDeps, current: string): Promise<{ latest: LatestRelease | null; error: string | null }> {
  const f = d.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(RELEASES_API, {
      headers: { "User-Agent": `VibeResearch/${current}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { latest: null, error: timeout ? `连不上 GitHub(${FETCH_TIMEOUT_MS / 1000} 秒没有响应)` : `连不上 GitHub:${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
  if (res.status === 404) return { latest: null, error: "GitHub 上还没有正式发布的版本" };
  if (res.status === 403 || res.status === 429) return { latest: null, error: "GitHub 暂时限制了查询次数,稍后再试" };
  if (!res.ok) return { latest: null, error: `GitHub 返回 ${res.status}` };
  let body: Record<string, unknown>;
  try {
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) return { latest: null, error: "GitHub 返回的内容太大,没有采用" };
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { latest: null, error: "GitHub 返回的内容看不懂" };
  }
  if (!body || typeof body !== "object" || body.draft === true || body.prerelease === true) return { latest: null, error: "GitHub 上还没有正式发布的版本" };
  const tag = typeof body.tag_name === "string" ? body.tag_name.trim() : body.tag_name;
  if (typeof tag !== "string" || !TAG_RE.test(tag)) {
    const shown = typeof tag === "string" ? tag.replace(/[^\w.\-]/g, "").slice(0, 40) : String(tag);
    return { latest: null, error: `最新发布的版本号看不懂:${shown}` };
  }
  return {
    latest: { version: normalizeVersion(tag), tag, url: releaseUrl(tag), published_at: str(body.published_at) },
    error: null,
  };
}

const inFlight = new Map<string, Promise<UpdateState>>();

async function check(d: UpdateDeps): Promise<UpdateState> {
  const key = path.resolve(d.dataRoot);
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    const now = (d.now ?? Date.now)();
    const r = await fetchLatest(d, d.current ?? productVersion());
    // 查的这几秒里用户可能刚改过开关:以磁盘上最新的为准,只更新查询结果
    const fresh = readState(d.dataRoot);
    const next: UpdateState = { ...fresh, checked_at: new Date(now).toISOString(), latest: r.latest ?? (r.error ? fresh.latest : null), error: r.error };
    writeState(d.dataRoot, next);
    return next;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** GET /update:到点了(且没关)就先查一次,最多等 FETCH_TIMEOUT_MS;写盘失败也照样返回,原因放 error */
export async function updateStatus(d: UpdateDeps, opts: { force?: boolean } = {}): Promise<UpdateView> {
  let s = readState(d.dataRoot);
  if (s.enabled && !envDisabled(d.env ?? process.env) && (opts.force || due(s, (d.now ?? Date.now)()))) {
    try {
      s = await check(d);
    } catch (e) {
      s = { ...s, error: `新版检查结果没能保存:${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
    }
  }
  return view(d, s);
}

/** POST /update {action:"disable"|"enable"|"skip"|"check", version?};enable 同时清掉「这个版本不再提示」 */
export async function updateAction(d: UpdateDeps, body: Record<string, unknown>): Promise<UpdateView> {
  const action = body.action;
  if (action === "check") return updateStatus(d, { force: true });
  const s = readState(d.dataRoot);
  if (action === "disable") s.enabled = false;
  else if (action === "enable") { s.enabled = true; s.skip_version = null; }   // 重新打开 = 跳过的版本也恢复提示
  else if (action === "skip") {
    if (!parseVersion(body.version)) throw new ServiceError("bad_update_action", "要跳过的版本号看不懂,例如 2.1.0");
    s.skip_version = normalizeVersion(body.version as string);
  } else throw new ServiceError("bad_update_action", "action 只能是 disable / enable / skip / check");
  writeState(d.dataRoot, s);
  return view(d, s);
}
