#!/usr/bin/env node
/**
 * 启动端口：页面默认 5930、本机 API 默认 8765。
 *
 * - 默认端口被别的程序占用，或被系统保留（Windows 常见：Hyper-V / WSL 会整段预留端口，绑定时报 EACCES），
 *   就按固定的顺序找一个空闲端口（先紧挨着的 20 个，再试几段远处的），启动器打开的也是实际用的那个地址。
 *   顺序固定是为了让同样的占用情况下每次换到同一个地址：模型 API 设置和对话记录存在浏览器里、按地址分开，
 *   地址每次都变的话，每次启动都要重新设置。都不行才让系统分配（那样每次可能不同，提示里会说）。
 * - 用户自己指定的端口（--port / --api-port，或环境变量 VRA_UI_PORT / VRA_API_PORT）不能用时直接报错，不擅自换。
 * - 远程访问模式的页面端口不自动换：云平台映射的是固定端口，换了外面就连不上。
 * - 默认页面端口（和紧挨着的那段）上已经开着一个本产品：提示直接打开它，不再起第二个。
 * - 换访问链接（--rotate-access）时两个端口都不自动换：旧服务还开着就必须先停掉，否则旧链接仍然有效。
 *
 * 这里属于分发 Core，只管端口，不知道任何垂类业务。scripts/start 经 startup.ts 调用；
 * Windows 的 start.ps1 把它当命令行跑，读最后一行 JSON。
 */
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { productUiReady } from "./startup_health.ts";

export const DEFAULT_UI_PORT = 5930;
export const DEFAULT_API_PORT = 8765;
/** 默认端口不能用时先往后试这么多个；再按 FAR_OFFSETS 试几段远处的（Hyper-V 常整段预留，紧挨着的可能全不能用） */
const SCAN_AFTER_DEFAULT = 20;
const FAR_OFFSETS = [10_000, 20_000, 30_000, 40_000];

/** 默认端口不能用时依次试的端口：紧挨着的 20 个，再是 +1 万、+2 万…各 20 个（不进 49152 以上的系统临时端口段） */
export function fallbackPorts(fallback: number): number[] {
  const near = Array.from({ length: SCAN_AFTER_DEFAULT }, (_, i) => fallback + 1 + i);
  const far = FAR_OFFSETS.flatMap((offset) => Array.from({ length: SCAN_AFTER_DEFAULT }, (_, i) => fallback + offset + i));
  return [...near, ...far].filter((port) => port <= 49151);
}

export type PortState = "free" | "busy" | "reserved";
export type PortProbe = (port: number, host: string) => Promise<PortState>;

export interface PortRequest {
  /** 用户指定的页面 / API 端口；null = 用默认、不能用就自动换 */
  ui: number | null;
  api: number | null;
  /** 页面要监听的地址：本机模式 127.0.0.1；远程访问或局域网模式 0.0.0.0 */
  uiHost: string;
  /** 页面端口不许自动换（远程访问模式、换访问链接） */
  strictUi: boolean;
  /** API 端口不许自动换（换访问链接：旧服务的 API 还占着就说明它没停） */
  strictApi?: boolean;
}

export interface PortChoice {
  ui: number;
  api: number;
  /** 给使用者看的说明（换了端口时说一句） */
  notes: string[];
}

/** 端口值：1–65535 的整数；空 = 没指定 */
export function parsePortValue(raw: string | undefined, label: string): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!/^\d{1,5}$/.test(text) || n < 1 || n > 65535) throw new Error(`${label} 要填 1–65535 之间的整数，现在是「${text}」`);
  return n;
}

/** 试着在这个地址上监听一下：能监听 = 空闲；EADDRINUSE = 被占；EACCES / EPERM = 被系统保留或没有权限 */
export function probePort(port: number, host: string): Promise<PortState> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve("busy");
      else if (error.code === "EACCES" || error.code === "EPERM") resolve("reserved");
      else reject(error);
    });
    server.listen({ port, host, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve("free")));
  });
}

/** 让系统分配一个空闲端口（监听 0 再关掉） */
function systemAssignedPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error("系统没有分配到空闲端口")));
    });
  });
}

const why = (state: PortState) => state === "busy" ? "已被占用" : "被系统保留、不能使用";

/** 页面监听所有网卡（局域网 / 远程模式）时也要看回环地址：macOS 上别的程序只占着 127.0.0.1 时，0.0.0.0 仍可能绑得上，本机访问却会落到那个程序 */
async function probeHosts(probe: PortProbe, port: number, host: string): Promise<PortState> {
  const first = await probe(port, host);
  if (first !== "free" || host !== "0.0.0.0") return first;
  return await probe(port, "127.0.0.1");
}

interface PickOptions {
  label: string;
  requested: number | null;
  fallback: number;
  host: string;
  strict: boolean;
  avoid: ReadonlySet<number>;
  probe: PortProbe;
  assign: (host: string) => Promise<number>;
  /** 默认端口（和紧挨着的那段）被占时先看看是不是本产品已经在跑；是就抛出这条提示 */
  alreadyRunning?: (port: number) => Promise<string | null>;
  strictHint?: string;
  /** 换了端口时附在说明后面的话（页面端口：浏览器里存的设置按地址分开） */
  switchHint?: string;
  /** 与另一个端口撞上时怎么称呼它（「本机 API 」/「页面」） */
  otherLabel: string;
}

async function pickPort(o: PickOptions): Promise<{ port: number; note: string | null }> {
  if (o.requested !== null) {
    if (o.avoid.has(o.requested)) throw new Error(`页面端口和本机 API 端口不能相同（都是 ${o.requested}）`);
    const state = await probeHosts(o.probe, o.requested, o.host);
    if (state === "free") return { port: o.requested, note: null };
    throw new Error(`你指定的${o.label}端口 ${o.requested} ${why(state)}。请换一个端口，或先关掉占用它的程序。`);
  }
  const takenByOther = o.avoid.has(o.fallback);
  const state = takenByOther ? "busy" : await probeHosts(o.probe, o.fallback, o.host);
  if (state === "free") return { port: o.fallback, note: null };
  const reason = takenByOther ? `已经给${o.otherLabel}用了` : why(state);
  // 本产品可能就开在默认端口或紧挨着的那段上（上次也换过端口）：先认出来，别再起第二个
  const nearby = new Set(fallbackPorts(o.fallback).slice(0, SCAN_AFTER_DEFAULT));
  if (state === "busy" && !takenByOther && o.alreadyRunning) {
    const running = await o.alreadyRunning(o.fallback);
    if (running) throw new Error(running);
  }
  if (o.strict) throw new Error(`${o.label}端口 ${o.fallback} ${reason}。${o.strictHint ?? ""}`.trim());
  const hint = o.switchHint ?? "";
  for (const port of fallbackPorts(o.fallback)) {
    if (o.avoid.has(port)) continue;
    const s = await probeHosts(o.probe, port, o.host);
    if (s === "free") return { port, note: `${o.label}默认端口 ${o.fallback} ${reason}，这次改用 ${port}。${hint}` };
    if (s === "busy" && nearby.has(port) && o.alreadyRunning) {
      const running = await o.alreadyRunning(port);
      if (running) throw new Error(running);
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await o.assign(o.host);
    if (!o.avoid.has(port) && (o.host !== "0.0.0.0" || await o.probe(port, "127.0.0.1") === "free")) {
      return { port, note: `${o.label}默认端口 ${o.fallback} ${reason}，常用的备选端口也都不能用，这次改用 ${port}（每次启动可能不同）。${hint}` };
    }
  }
  throw new Error(`${o.label}端口 ${o.fallback} ${reason}，也没找到别的空闲端口。`);
}

/** 默认页面端口上是不是已经开着本产品：页面和它的 /api/health 都对得上才算 */
export async function productAlreadyRunning(port: number): Promise<string | null> {
  const url = `http://127.0.0.1:${port}`;
  return await productUiReady(url, 1_500)
    ? `${url} 上已经有一个 Vibe Research 在运行：直接在浏览器打开这个地址就行。要重新启动，先关掉旧的窗口（或在它的终端按 Ctrl+C）。`
    : null;
}

/** 先定 API 端口（只听回环），再定页面端口；两者不会相同 */
export async function chooseStartupPorts(
  request: PortRequest,
  deps: { probe?: PortProbe; assign?: (host: string) => Promise<number>; alreadyRunning?: (port: number) => Promise<string | null> } = {},
): Promise<PortChoice> {
  const probe = deps.probe ?? probePort;
  const assign = deps.assign ?? systemAssignedPort;
  const alreadyRunning = deps.alreadyRunning ?? productAlreadyRunning;
  const api = await pickPort({
    label: "本机 API ", otherLabel: "页面", requested: request.api, fallback: DEFAULT_API_PORT, host: "127.0.0.1",
    // 只有换访问链接时才不许换(startup.ts 会接上「先停掉正在运行的服务」的说明)
    strict: request.strictApi === true, avoid: new Set(request.ui === null ? [] : [request.ui]), probe, assign,
  });
  const ui = await pickPort({
    label: "页面", otherLabel: "本机 API ", requested: request.ui, fallback: DEFAULT_UI_PORT, host: request.uiHost,
    strict: request.strictUi, avoid: new Set([api.port]), probe, assign,
    // 远程模式的页面要访问口令，这里探不到；本机 / 局域网模式才看是不是已经开着
    alreadyRunning: request.strictUi ? undefined : alreadyRunning,
    strictHint: "远程访问模式不自动换端口（云平台映射的是固定端口）：先停掉占用它的程序，或用 --port 指定平台开放的另一个端口。",
    switchHint: `注意：接入 AI 里的模型 API 设置和对话记录存在浏览器里、按地址分开，在新地址要重新设置；${DEFAULT_UI_PORT} 空出来后重启，就回到原来的地址和设置。`,
  });
  return { ui: ui.port, api: api.port, notes: [api.note, ui.note].filter((x): x is string => x !== null) };
}

/** 命令行参数里的 --port / --api-port（也接受 --port=6930 写法），当场校验；其它参数原样留给调用方 */
export function takePortArgs(args: readonly string[]): { ui: number | null; api: number | null; rest: string[] } {
  let ui: number | null = null;
  let api: number | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = (["--port", "--api-port"] as const).find((f) => arg === f || arg.startsWith(`${f}=`));
    if (!flag) {
      rest.push(arg);
      continue;
    }
    const value = arg === flag ? args[++i] : arg.slice(flag.length + 1);
    if (!value || value.startsWith("--")) throw new Error(`${flag} 后面要跟端口号，如 ${flag} ${flag === "--port" ? 6930 : 9765}`);
    if (flag === "--port") ui = parsePortValue(value, flag); else api = parsePortValue(value, flag);
  }
  return { ui, api, rest };
}

/** 命令行参数优先，其次环境变量 VRA_UI_PORT / VRA_API_PORT */
export function portRequestFrom(
  cli: { ui: number | null; api: number | null },
  env: NodeJS.ProcessEnv,
  mode: { remote: boolean; rotateAccess: boolean },
): PortRequest {
  return {
    ui: cli.ui ?? parsePortValue(env.VRA_UI_PORT, "VRA_UI_PORT"),
    api: cli.api ?? parsePortValue(env.VRA_API_PORT, "VRA_API_PORT"),
    uiHost: mode.remote || env.VRA_LAN === "1" ? "0.0.0.0" : "127.0.0.1",
    strictUi: mode.remote || mode.rotateAccess,
    strictApi: mode.rotateAccess,
  };
}

/** 是不是被直接当命令行运行：比真实路径（仓库在符号链接 / 目录联接 / subst 盘符下时，两边写法会不同） */
export function isDirectRun(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

/**
 * Windows 启动脚本用：`node orchestrator/src/startup_ports.ts [--port N] [--api-port N]`。
 * 全部写到 stdout（Windows PowerShell 5.1 会把子程序的 stderr 当错误处理）：说明是 `[start] …` 行；
 * 成功时最后一行是 {"ui":5930,"api":8765}；失败时只有说明行，退出码 2。
 */
if (isDirectRun(process.argv[1], import.meta.url)) {
  try {
    const parsed = takePortArgs(process.argv.slice(2));
    if (parsed.rest.length) throw new Error(`未知参数:${parsed.rest.join(", ")}（可用:--port、--api-port）`);
    const choice = await chooseStartupPorts(portRequestFrom(parsed, process.env, { remote: false, rotateAccess: false }));
    for (const note of choice.notes) console.log(`[start] ${note}`);
    console.log(JSON.stringify({ ui: choice.ui, api: choice.api }));
  } catch (error) {
    console.log(`[start] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
