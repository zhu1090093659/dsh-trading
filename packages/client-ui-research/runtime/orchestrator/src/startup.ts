#!/usr/bin/env node
/**
 * macOS / Linux 产品启动器：预检 → 同时启动本机 API 与浏览器界面 → 等待两端真实可用 → 打开浏览器。
 *
 * 这里属于分发 Core，只负责进程、端口与健康检查，不知道任何垂类业务。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureAccessToken, isPlainRemoteHttp, normalizePublicUrl, type AccessToken } from "./access_token.ts";
import { readConfiguredDataRoot, resolveDataRoot } from "./data_root.ts";
import { chooseStartupPorts, DEFAULT_API_PORT, DEFAULT_UI_PORT, portRequestFrom, takePortArgs, type PortChoice } from "./startup_ports.ts";

export interface StartupArgs {
  openBrowser: boolean;
  help: boolean;
  /** 远程访问模式：页面对外开放（先打包再由 vite preview 提供），每个请求都要过访问口令 */
  remote: boolean;
  /** 云平台给页面端口（默认 5930）分配的公网根地址；给了就直接拼出发给使用者的链接 */
  publicUrl: string | null;
  /** 重新生成访问口令，旧链接立即失效 */
  rotateAccess: boolean;
  /** 用已经打包好的页面（desktop/dist，由 vite preview 提供），不起开发服务器、不重新打包。免安装包用它 */
  prebuilt: boolean;
  /** 用户指定的页面 / 本机 API 端口；null = 用默认（被占用或被系统保留时自动换），见 startup_ports.ts */
  port: number | null;
  apiPort: number | null;
}

const USAGE = [
  "用法: scripts/start [--no-open] [--prebuilt] [--port <端口>] [--api-port <端口>] [--remote [--public-url <地址>] [--rotate-access]]",
  "  --no-open          启动后不自动打开浏览器",
  "  --prebuilt         用已经打包好的页面（desktop/dist），不起开发服务器；远程模式下也不再重新打包",
  "  --port <端口>       页面端口。默认 5930，被占用或被系统保留时自动换一个空闲的，打开的就是实际用的地址；",
  "                     指定了就只用它，不能用直接报错。远程访问模式下页面端口不自动换",
  "  --api-port <端口>   本机 API 端口（默认 8765，规则同上）。两个端口也可以用环境变量 VRA_UI_PORT / VRA_API_PORT 指定",
  "  --remote           远程访问模式：页面对外开放，凭访问链接进入（先打包页面，首次约半分钟）。",
  "                     给云端 Agent 部署在自己的云电脑上、再把链接发给使用者用；本机自己用不需要它",
  "  --public-url <地址> 云平台给页面端口（默认 5930）分配的公网根地址（如 https://xxx.example.app），直接拼出发给使用者的链接",
  "  --rotate-access    换一条新的访问链接（先停掉正在运行的服务；新服务起来后旧链接立即失效）",
].join("\n");

export function parseStartupArgs(args: readonly string[]): StartupArgs {
  const ports = takePortArgs(args);
  const out: StartupArgs = {
    openBrowser: true, help: false, remote: false, publicUrl: null, rotateAccess: false, prebuilt: false, port: ports.ui, apiPort: ports.api,
  };
  if (out.port !== null && out.port === out.apiPort) throw new Error(`--port 和 --api-port 不能相同（都是 ${out.port}）`);
  args = ports.rest;
  const unknown: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--no-open") out.openBrowser = false;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--remote") out.remote = true;
    else if (arg === "--rotate-access") out.rotateAccess = true;
    else if (arg === "--prebuilt") out.prebuilt = true;
    else if (arg === "--public-url" || arg.startsWith("--public-url=")) {
      const value = arg === "--public-url" ? args[++i] : arg.slice("--public-url=".length);
      if (!value || value.startsWith("--")) throw new Error("--public-url 后面要跟地址，如 --public-url https://xxx.example.app");
      out.publicUrl = normalizePublicUrl(value);
    } else unknown.push(arg);
  }
  if (unknown.length > 0) throw new Error(`未知参数:${unknown.join(", ")}（可用:--no-open、--prebuilt、--port、--api-port、--remote、--public-url、--rotate-access、--help）`);
  if (!out.remote && (out.publicUrl !== null || out.rotateAccess)) throw new Error("--public-url 和 --rotate-access 只能和 --remote 一起用");
  return out;
}

export function repoRootFromStartup(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 启动前只查会让两棵进程必然失败的条件；业务配置完整性由 doctor 负责。 */
export function startupMissingFiles(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  prebuilt = false,
): string[] {
  const configured = readConfiguredDataRoot(repoRoot);
  const dataRoot = resolveDataRoot(repoRoot, configured, env);
  const required: [string, string][] = [
    [path.join(repoRoot, "orchestrator", "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "orchestrator 依赖"],
    [path.join(repoRoot, "desktop", "node_modules", "vite", "package.json"), "界面依赖"],
    [path.join(dataRoot, "config.json"), "产品初始化配置"],
  ];
  if (prebuilt) required.push([path.join(repoRoot, "desktop", "dist", "index.html"), "打包好的页面（desktop/dist）"]);
  return required.filter(([file]) => !fs.existsSync(file)).map(([, label]) => label);
}

/**
 * 两个子进程各拿什么环境。远程模式:访问口令只给页面服务器(平台放在环境变量里的也从 API 那份剥掉);
 * API 只知道自己在远程模式 —— 页面不能改这台机器要运行的程序位置,页面填的模型地址只收 https 公网域名。
 * 本机模式:外面环境里残留的 VRA_REMOTE / VRA_PUBLIC_URL 一律去掉,不能因此对外开放或误开远程限制。
 * 推送里的链接要用对外地址:API 只拿到 VRA_PUSH_LINK_BASE(不是口令,只用来拼链接),不拿 VRA_PUBLIC_URL。
 */
export function startupChildEnvs(env: NodeJS.ProcessEnv, access: Pick<AccessToken, "token"> | null, publicUrl: string | null,
  ports: Pick<PortChoice, "ui" | "api"> = { ui: DEFAULT_UI_PORT, api: DEFAULT_API_PORT }):
  { apiEnv: NodeJS.ProcessEnv; uiEnv: NodeJS.ProcessEnv } {
  // 两个进程都知道实际端口：页面服务器按它监听、把 /api 转给对的 API；API 拼推送里的本机链接要用页面端口
  env = { ...env, VRA_UI_PORT: String(ports.ui), VRA_API_PORT: String(ports.api) };
  if (!access) {
    const local: NodeJS.ProcessEnv = { ...env };
    delete local.VRA_REMOTE;
    delete local.VRA_PUBLIC_URL;
    delete local.VRA_PUSH_LINK_BASE;
    return { apiEnv: local, uiEnv: local };
  }
  const uiEnv: NodeJS.ProcessEnv = { ...env, VRA_REMOTE: "1", VRA_ACCESS_TOKEN: access.token };
  if (publicUrl) uiEnv.VRA_PUBLIC_URL = publicUrl; else delete uiEnv.VRA_PUBLIC_URL;
  const apiEnv: NodeJS.ProcessEnv = { ...env, VRA_REMOTE: "1" };
  delete apiEnv.VRA_ACCESS_TOKEN;
  delete apiEnv.VRA_PUBLIC_URL;
  if (publicUrl) apiEnv.VRA_PUSH_LINK_BASE = publicUrl; else delete apiEnv.VRA_PUSH_LINK_BASE;
  return { apiEnv, uiEnv };
}

/**
 * 选端口（规则见 startup_ports.ts）。换链接时页面端口被占 = 旧服务还拿着旧口令在跑：不停掉它，换了也不生效。
 */
export async function resolveStartupPorts(
  args: Pick<StartupArgs, "remote" | "rotateAccess" | "port" | "apiPort">,
  env: NodeJS.ProcessEnv,
  deps: Parameters<typeof chooseStartupPorts>[1] = {},
): Promise<PortChoice> {
  try {
    return await chooseStartupPorts(portRequestFrom({ ui: args.port, api: args.apiPort }, env, args), deps);
  } catch (error) {
    if (args.rotateAccess) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n换新访问链接要先停掉正在运行的服务（在它的终端按 Ctrl+C），再运行 scripts/start --remote --rotate-access；新服务起来后旧链接和旧 cookie 才失效。`);
    }
    throw error;
  }
}

export interface WaitReadyOptions {
  probe: () => Promise<boolean>;
  failure?: () => string | null;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 可测试的就绪循环：重试网络瞬断，同时在子进程提前退出时立即停止等待。 */
export async function waitUntilReady(options: WaitReadyOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  while (now() - started < timeoutMs) {
    const failed = options.failure?.();
    if (failed) throw new Error(failed);
    if (await options.probe()) return;
    await sleep(intervalMs);
  }
  throw new Error(`启动等待超过 ${Math.ceil(timeoutMs / 1000)} 秒，请查看上方日志。`);
}

function tokenFile(repoRoot: string, env: NodeJS.ProcessEnv): string {
  const configured = readConfiguredDataRoot(repoRoot);
  return path.join(resolveDataRoot(repoRoot, configured, env), "api.token");
}

function apiToken(repoRoot: string, env: NodeJS.ProcessEnv): string {
  if (env.VRA_API_TOKEN && env.VRA_API_TOKEN.length >= 16) return env.VRA_API_TOKEN;
  try {
    const token = fs.readFileSync(tokenFile(repoRoot, env), "utf8").trim();
    return token.length >= 16 ? token : "";
  } catch {
    return "";
  }
}

/** 跑一个必须成功的前置步骤（远程模式的页面打包），失败就停在这里，不带着旧页面或空目录对外 */
function runToCompletion(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", (error) => reject(new Error(`无法运行 ${path.basename(args[0] ?? command)}:${error.message}`)));
    child.once("exit", (code, signal) => code === 0 ? resolve()
      : reject(new Error(`页面打包失败（${code === null ? `信号 ${signal ?? "未知"}` : `退出码 ${code}`}），请查看上方日志。`)));
  });
}

async function reachable(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function childFailure(label: string, child: ChildProcess, launchError: Error | null): string | null {
  if (launchError) return `${label}无法启动:${launchError.message}`;
  if (child.exitCode !== null) return `${label}启动失败（退出码 ${child.exitCode}）。`;
  if (child.signalCode !== null) return `${label}启动失败（信号 ${child.signalCode}）。`;
  return null;
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return;
  const opener = spawn(command, [url], { detached: true, stdio: "ignore" });
  opener.once("error", () => { /* 没有 opener 时终端里仍有可点击地址 */ });
  opener.unref();
}

type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface ShutdownOutcome {
  kind: "signal" | "child_exit";
  message?: string;
  signal?: StopSignal;
}

export interface ShutdownMonitor {
  wait: Promise<ShutdownOutcome>;
  dispose: () => void;
}

/**
 * 信号监听必须在首个异步健康检查前装好；否则启动窗口内 Ctrl+C/关闭终端会绕过 finally，
 * 留下 detached 的 API 与界面进程组。
 */
export function createShutdownMonitor(
  api: ChildProcess,
  ui: ChildProcess,
  signalSource: NodeJS.Process = process,
): ShutdownMonitor {
  let settled = false;
  let resolveOutcome: (outcome: ShutdownOutcome) => void = () => {};
  const wait = new Promise<ShutdownOutcome>((resolve) => { resolveOutcome = resolve; });
  const finish = (outcome: ShutdownOutcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome(outcome);
  };
  const signalHandlers = new Map<StopSignal, () => void>([
    ["SIGINT", () => finish({ kind: "signal", signal: "SIGINT" })],
    ["SIGTERM", () => finish({ kind: "signal", signal: "SIGTERM" })],
    ["SIGHUP", () => finish({ kind: "signal", signal: "SIGHUP" })],
  ]);
  const exited = (label: string, code: number | null, signal: NodeJS.Signals | null) => {
    finish({
      kind: "child_exit",
      message: `${label}已停止（${code === null ? `信号 ${signal ?? "未知"}` : `退出码 ${code}`}），另一进程将同步关闭。`,
    });
  };
  const apiExit = (code: number | null, signal: NodeJS.Signals | null) => exited("本机 API", code, signal);
  const uiExit = (code: number | null, signal: NodeJS.Signals | null) => exited("浏览器界面", code, signal);
  for (const [signal, handler] of signalHandlers) signalSource.once(signal, handler);
  api.once("exit", apiExit);
  ui.once("exit", uiExit);

  return {
    wait,
    dispose: () => {
      for (const [signal, handler] of signalHandlers) signalSource.removeListener(signal, handler);
      api.removeListener("exit", apiExit);
      ui.removeListener("exit", uiExit);
    },
  };
}

export async function runStartup(
  args: StartupArgs,
  repoRoot = repoRootFromStartup(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (process.platform === "win32") {
    throw new Error(args.remote ? "远程访问模式目前只支持 macOS / Linux。" : "Windows 请运行 scripts\\start.cmd。");
  }

  const missing = startupMissingFiles(repoRoot, env, args.prebuilt);
  if (missing.length > 0) {
    throw new Error(`还没有完成安装（缺少:${missing.join("、")}）。请先运行 scripts/setup${args.prebuilt ? "；用 --prebuilt 还要先在 desktop 目录运行 npm run build" : ""}。`);
  }
  const ports = await resolveStartupPorts(args, env);
  for (const note of ports.notes) console.log(`[start] ${note}`);

  // 远程模式：口令只交给页面服务器（环境变量），本机 API 进程拿不到也用不着
  const access = args.remote ? ensureAccessToken(repoRoot, env, args.rotateAccess) : null;
  const desktopDir = path.join(repoRoot, "desktop");
  const viteBin = path.join(desktopDir, "node_modules", "vite", "bin", "vite.js");
  const { apiEnv, uiEnv } = startupChildEnvs(env, access, args.publicUrl, ports);
  if (access && !args.prebuilt) {
    console.log("[start] 远程访问模式：先打包页面（首次约半分钟）…");
    await runToCompletion(process.execPath, [viteBin, "build"], desktopDir, uiEnv);
  }

  const detached = true;
  const api = spawn(process.execPath, ["orchestrator/src/api.ts", "--port", String(ports.api), "--host", "127.0.0.1"], {
    cwd: repoRoot, env: apiEnv, detached, stdio: "inherit",
  });
  // 绑定策略交给 Vite 配置：默认回环；VRA_LAN=1 开放开发界面；远程模式由 vite preview 对外。API 始终只绑回环。
  // 打包好的页面（--prebuilt）本机模式也由 vite preview 提供，同样只听回环。
  const uiBase = `http://127.0.0.1:${ports.ui}`;
  const ui = access || args.prebuilt
    ? spawn(process.execPath, [viteBin, "preview"], { cwd: desktopDir, env: uiEnv, detached, stdio: "inherit" })
    : spawn("npm", ["run", "dev", "--prefix", "desktop"], { cwd: repoRoot, env: uiEnv, detached, stdio: "inherit" });
  let apiLaunchError: Error | null = null;
  let uiLaunchError: Error | null = null;
  api.once("error", (error) => { apiLaunchError = error; });
  ui.once("error", (error) => { uiLaunchError = error; });
  const shutdown = createShutdownMonitor(api, ui);

  try {
    const startupOutcome = await Promise.race([
      waitUntilReady({
        failure: () => childFailure("本机 API", api, apiLaunchError) ?? childFailure("浏览器界面", ui, uiLaunchError),
        probe: async () => {
          const token = apiToken(repoRoot, env);
          if (!token) return false;
          const [apiOk, uiOk] = await Promise.all([
            reachable(`http://127.0.0.1:${ports.api}/health`, { Authorization: `Bearer ${token}` }),
            reachable(uiBase, access ? { Cookie: `vra_access=${access.token}` } : undefined),
          ]);
          return apiOk && uiOk;
        },
      }).then(() => ({ kind: "ready" as const })),
      shutdown.wait,
    ]);
    if (startupOutcome.kind === "signal") return;
    if (startupOutcome.kind === "child_exit") throw new Error(startupOutcome.message);

    const url = access ? `${uiBase}/?access=${access.token}` : uiBase;
    if (access) console.log(remoteLinkLines(access, args.publicUrl, args.rotateAccess, ports.ui).join("\n"));
    else console.log(`\nVibe Research 已启动:${url}\n按 Ctrl+C 关闭。`);
    if (args.openBrowser) openBrowser(url);
    const stopOutcome = await shutdown.wait;
    if (stopOutcome.kind === "child_exit") throw new Error(stopOutcome.message);
  } finally {
    shutdown.dispose();
    stopChild(ui);
    stopChild(api);
  }
}

/** 链接本身就是凭据：只打在终端里给部署者看，不写日志文件 */
/** 远程模式启动成功后打印给部署者(云端 Agent)看的几行:本机链接、发给使用者的链接、口令从哪来、风险提示 */
export function remoteLinkLines({ token, source }: AccessToken, publicUrl: string | null, rotated: boolean,
  uiPort = DEFAULT_UI_PORT): string[] {
  const link = (base: string) => `${base}/?access=${token}`;
  const lines = [
    "",
    `Vibe Research 已启动（远程访问模式）。按 Ctrl+C 关闭。`,
    `本机打开：${link(`http://127.0.0.1:${uiPort}`)}`,
    publicUrl
      ? `发给使用者的链接：${link(publicUrl)}`
      : `发给使用者的链接：把云平台给 ${uiPort} 端口分配的公网地址（只用 https 的那个）接上 /?access=${token}`,
    source === "env" ? "（访问口令来自环境变量 VRA_ACCESS_TOKEN。）"
      : source === "file" ? "（沿用上次的访问链接，机器重启也不变。）"
      : rotated ? "（已换成新的访问链接；之前发出去的旧链接已经失效。）" : "（新生成的访问链接，之后重启沿用同一条。）",
    "⚠️ 拿到链接的人能用这台机器上的全部功能（包括这里已登录的订阅 Agent），只发给你要给的人；",
    "   换新链接、让旧链接失效：先在这里按 Ctrl+C 停掉服务，再运行 scripts/start --remote --rotate-access（新服务起来后旧链接才失效）",
  ];
  if (!publicUrl) {
    lines.push("提示：启动时加 --public-url <平台给的 https 地址>，访问 cookie 才能确定带上 Secure 标记（有的代理不告诉后台用户走的是 https）。");
  }
  if (publicUrl && isPlainRemoteHttp(publicUrl)) {
    lines.push("⚠️ 这个公网地址是明文 http：使用者在页面里填的 API key 会明文经过网络。请改用平台给的 https 地址。");
  }
  return lines;
}

function isEntryPath(argv1: string | undefined): boolean {
  return /[\\/]startup\.(ts|js|mjs|cjs)$/.test(argv1 ?? "");
}

if (isEntryPath(process.argv[1])) {
  let args: StartupArgs;
  try {
    args = parseStartupArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[start] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  runStartup(args).catch((error) => {
    console.error(`[start] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
