/** 文件工具:原子写入(临时文件 → fsync → 替换)、sha256、JSON 读写、追加 JSONL。*/
import { createHash } from "node:crypto";
import { spawnSync, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** O_NOFOLLOW 在 Windows 不受支持；Windows 路径由 safePath/lstat 的逐级链接检查保护。 */
export const NOFOLLOW_FLAG = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;

const WINDOWS_CHECK_ACL = String.raw`
$ErrorActionPreference = "Stop"
$file = $env:VRA_PRIVATE_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $file
if (-not $acl.AreAccessRulesProtected) { exit 3 }
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$sidType = [System.Security.Principal.SecurityIdentifier]
$others = @()
$denied = @()
$self = $false
foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
  $ruleSid = $rule.IdentityReference.Value
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
    if ($ruleSid -eq $sid) { if (($rule.FileSystemRights -band $full) -eq $full) { $self = $true } }
    elseif ($others -notcontains $ruleSid) { $others += $ruleSid }
  } elseif ($denied -notcontains $ruleSid) { $denied += $ruleSid }
}
$problems = @($others) + @($denied | ForEach-Object { "deny:$_" })
$owner = $acl.GetOwner($sidType)
if ($null -eq $owner -or $owner.Value -ne $sid) { $problems += "owner" }
if ($problems.Count -gt 0) { Write-Output ($problems -join " "); exit 4 }
if (-not $self) { exit 5 }
exit 0
`;

function windowsAclEnv(file: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, VRA_PRIVATE_FILE: path.resolve(file) };
  // A parent PowerShell 7 process exports its module search path. Windows
  // PowerShell 5.1 cannot load those Security modules; use its own defaults.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  return env;
}

/** others = 其他账户的允许规则,denied = 拒绝规则(含当前用户自己的),ownerWrong = 所有者不是当前用户。 */
type WindowsAclCheck = { secure: boolean; detail: string; others: string[]; denied: string[]; ownerWrong: boolean };

function windowsAclCheck(file: string): WindowsAclCheck {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_CHECK_ACL], {
    env: windowsAclEnv(file), encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  return windowsAclVerdict(result.status, result.stdout, result.error);
}

let windowsSidCache: string | null = null;

/** 从 `whoami /user /fo csv /nh` 的输出里取 SID(形如 "域\用户","S-1-5-21-…")。 */
export function parseWhoamiSid(output: string): string | null {
  const m = /"(S-1-\d+(?:-\d+)+)"$/.exec(String(output ?? "").trim());
  return m ? m[1]! : null;
}

function accountFromEnv(): string {
  const user = process.env.USERNAME ?? "";
  const domain = process.env.USERDOMAIN ?? "";
  if (!user) throw new Error("拿不到当前用户(whoami 失败且 USERNAME 为空)");
  return domain ? `${domain}\\${user}` : user;
}

/** icacls 的授权对象:优先当前进程用户的 SID(`*S-1-…`),跟 WINDOWS_CHECK_ACL 认的是同一个身份,
 *  不受 USERDOMAIN / USERNAME 环境变量影响;whoami 拿不到时才退回用户名(授错人时检查会报出来)。 */
function windowsAccount(): string {
  if (windowsSidCache) return `*${windowsSidCache}`;
  const result = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const sid = !result.error && result.status === 0 ? parseWhoamiSid(result.stdout) : null;
  if (!sid) return accountFromEnv();
  windowsSidCache = sid;
  return `*${sid}`;
}

async function windowsAccountAsync(): Promise<string> {
  if (windowsSidCache) return `*${windowsSidCache}`;
  const sid = await new Promise<string | null>(resolve => {
    execFile("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(error ? null : parseWhoamiSid(stdout)));
  });
  if (!sid) return accountFromEnv();
  windowsSidCache = sid;
  return `*${sid}`;
}

function icacls(file: string, args: string[]): void {
  const result = spawnSync("icacls.exe", [path.resolve(file), ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`无法收紧 Windows 文件权限(${result.error?.message ?? `icacls exit ${result.status}`})`);
  }
}

function icaclsAsync(file: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile("icacls.exe", [path.resolve(file), ...args], { windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" },
      err => err ? reject(new Error(`无法收紧 Windows 文件权限(${err.message})`)) : resolve());
  });
}

/** 复查列出的问题 → 依次要跑的 icacls 修复:删其他账户的授权、删拒绝规则、把所有者改回当前用户。
 *  顺序不能换:拒绝规则可能挡住改所有者。 */
function repairArgs(check: WindowsAclCheck, account: string): string[][] {
  const steps: string[][] = [];
  if (check.others.length) steps.push(["/remove:g", ...check.others.map(sid => `*${sid}`)]);
  if (check.denied.length) steps.push(["/remove:d", ...check.denied.map(sid => `*${sid}`)]);
  if (check.ownerWrong) steps.push(["/setowner", account]);
  return steps;
}

/** Windows 的 mode 0600 不会改变 NTFS DACL；敏感文件必须显式断开继承并只授权当前用户。
 *
 * 🔴 不用 Get-Acl/Set-Acl:Get-Acl 默认捕获全部安全节(含 SACL),Set-Acl 会原样写回,
 *    而写 SACL 需要 SeSecurityPrivilege —— 普通未提权进程没有这个特权,
 *    整个 API 会因此起不来(2026-10-14 实测:PrivilegeNotHeldException)。
 *    icacls 只动 DACL、继承标志和所有者,不需要任何特权。
 *
 * 🔴 `/inheritance:r /grant:r` 只断继承、替换当前用户那一条,不删别的账户单独挂的授权 ——
 *    GitHub 的 Windows 测试机上新建的文件就带着(2026-10-18 CI 实测);也不删单独挂的拒绝规则、不改所有者
 *    (所有者不管 DACL 怎么写都能改权限,别人是所有者就能把读权限加回去)。所以收紧后复查,
 *    复查列出的其他账户授权用 `/remove:g` 删、拒绝规则用 `/remove:d` 删、所有者用 `/setowner` 改回当前用户,
 *    再查一次;还不干净、或当前用户自己没有完全控制(whoami 失败时退回的用户名不对)就报错,不当成功。
 */
export function restrictPrivateFile(file: string): void {
  if (process.platform !== "win32") { fs.chmodSync(file, 0o600); return; }
  // 🔴 必须一条命令完成:先 /inheritance:r 单独执行会把 DACL 清空(继承 ACE 全没了、又没加新 ACE),
  //    连 icacls 自己都打不开文件(实测拒绝访问),第二步永远失败。先授权当前用户、再删别人,也是这个原因。
  const account = windowsAccount();
  icacls(file, ["/inheritance:r", "/grant:r", `${account}:F`]);
  let check = windowsAclCheck(file);
  const steps = check.secure ? [] : repairArgs(check, account);
  if (steps.length) {
    for (const args of steps) icacls(file, args);
    check = windowsAclCheck(file);
  }
  if (!check.secure) throw new Error(`无法收紧 Windows 文件权限(${check.detail})`);
}

/** Request-path ACL setup must not block unrelated API requests on Windows. */
export async function restrictPrivateFileAsync(file: string): Promise<void> {
  if (process.platform !== "win32") { await fs.promises.chmod(file, 0o600); return; }
  const account = await windowsAccountAsync();
  await icaclsAsync(file, ["/inheritance:r", "/grant:r", `${account}:F`]);
  let check = await windowsAclCheckAsync(file);
  const steps = check.secure ? [] : repairArgs(check, account);
  if (steps.length) {
    for (const args of steps) await icaclsAsync(file, args);
    check = await windowsAclCheckAsync(file);
  }
  if (!check.secure) throw new Error(`无法收紧 Windows 文件权限(${check.detail})`);
}

export function privateFilePermissions(file: string): { secure: boolean; detail: string } {
  if (process.platform !== "win32") {
    const mode = fs.statSync(file).mode & 0o777;
    return { secure: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` };
  }
  const { secure, detail } = windowsAclCheck(file);
  return { secure, detail };
}

/** WINDOWS_CHECK_ACL 的退出码 → 结论;exit 4 时 stdout 用空格隔开列出问题:
 *  裸 SID = 其他账户的允许规则,`deny:<SID>` = 拒绝规则,`owner` = 所有者不是当前用户;
 *  exit 5 = 没有上面这些问题,但当前用户自己也没有完全控制(产品写的私密文件一律给当前用户完全控制)。 */
export function windowsAclVerdict(status: number | null, stdout?: string | null, error?: Error): WindowsAclCheck {
  const clean = { others: [], denied: [], ownerWrong: false };
  if (error) return { secure: false, detail: `Windows ACL 检查失败:${error.message}`, ...clean };
  if (status === 0) return { secure: true, detail: "Windows ACL 已断开继承，仅当前用户 SID 可读写", ...clean };
  if (status === 3) return { secure: false, detail: "Windows ACL 仍在继承父目录权限", ...clean };
  if (status === 4) {
    const sid = /^S-1-\d+(?:-\d+)+$/;
    const items = String(stdout ?? "").split(/\s+/);
    const others = items.filter(s => sid.test(s));
    const denied = items.filter(s => s.startsWith("deny:")).map(s => s.slice(5)).filter(s => sid.test(s));
    const ownerWrong = items.includes("owner");
    const parts = [
      ...(others.length || (!denied.length && !ownerWrong) ? [`还授权了其他账户${others.length ? `(${others.join("、")})` : ""}`] : []),
      ...(denied.length ? [`还有拒绝规则(${denied.join("、")})`] : []),
      ...(ownerWrong ? ["所有者不是当前用户"] : []),
    ];
    return { secure: false, detail: `Windows ACL ${parts.join("，")}`, others, denied, ownerWrong };
  }
  if (status === 5) return { secure: false, detail: "Windows ACL 没有给当前用户完全控制", ...clean };
  return { secure: false, detail: `Windows ACL 检查异常(exit ${status})`, ...clean };
}

/** 同 privateFilePermissions 的 Windows 分支,但不阻塞事件循环(请求路径上用)。 */
function windowsAclCheckAsync(file: string): Promise<WindowsAclCheck> {
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_CHECK_ACL],
      { env: windowsAclEnv(file), encoding: "utf8", windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (!error) return resolve(windowsAclVerdict(0, stdout));
        const failure = error as { code?: unknown; killed?: boolean };
        resolve(typeof failure.code === "number" && !failure.killed ? windowsAclVerdict(failure.code, stdout) : windowsAclVerdict(null, null, error));
      });
  });
}

export function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function sha256Text(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function atomicWrite(p: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.part`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

export function writeJson(p: string, obj: unknown): void {
  atomicWrite(p, JSON.stringify(obj, null, 2) + "\n");
}

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

export function readJsonIfExists<T = unknown>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    return readJson<T>(p);
  } catch {
    return null;
  }
}

export function appendJsonl(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "a");
  try {
    fs.writeSync(fd, JSON.stringify(obj) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function listFiles(dir: string, ext?: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith(".") && (!ext || f.endsWith(ext)))
    .sort()
    .map((f) => path.join(dir, f));
}

export function nowIso(d = new Date()): string {
  // Asia/Shanghai ISO 字符串(台账的录入时间都用这一种写法:按字符串比先后,混进 `Z` 结尾的写法顺序就乱了)
  const sh = new Date(d.getTime() + 8 * 3600 * 1000);
  return sh.toISOString().replace("Z", "+08:00");
}

export function ensureDirs(root: string, subs: string[]): void {
  for (const s of subs) fs.mkdirSync(path.join(root, s), { recursive: true });
}
