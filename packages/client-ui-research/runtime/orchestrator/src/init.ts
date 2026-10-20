#!/usr/bin/env node
/**
 * 幂等初始化(scripts/init):只生成产品自己的用户私有层 `.local/`,不碰任何 Agent 的全局配置与登录态。
 * 做的事:建目录(runs / knowledge / providers / mcp)→ 没有 `.local/config.json` 就写一份骨架
 *        (python 自动探测 .venv;后台默认 AI 来源默认留空,由页面或 `--provider` 指定)
 *        → 确保 `.gitignore` 含 `.local/` → 打印下一步。
 * 已存在的用户配置一律不改(幂等);`--force` 才改,且先备份为 config.json.bak-<时间>。
 * 用法:node orchestrator/src/init.ts [--python P] [--provider <id>] [--force] [--json]
 *   --provider:cli-claude / cli-codex / cli-codebuddy(本机订阅 Agent)或 providers/ 里的模板 id(模型 API)
 */
import fs from "node:fs";
import path from "node:path";

import { resolveDataRoot as resolveDataRootFrom } from "./data_root.ts";
import { nowIso, readJsonIfExists, writeJson } from "./fsutil.ts";
import { DEFAULT_PRODUCT_CONFIG, PRODUCT_CONFIG_FILE, USER_CONFIG_FILE } from "./productConfig.ts";
import { PROVIDER_ID_RE, renamedProviderHint } from "./providers.ts";
import { optionValue, parseArgs } from "./run.ts";
import { repoRootFromHere } from "./service.ts";

export const LOCAL_SUBDIRS = ["runs", "knowledge", "providers", "mcp"] as const;

export interface InitStep { id: string; action: "created" | "exists" | "written" | "kept" | "backed_up" | "appended" | "skipped"; detail: string }
export interface InitResult { repoRoot: string; dataRoot: string; steps: InitStep[]; next: string[] }

/**
 * 数据根:环境变量 VRA_DATA_ROOT > 产品配置 paths.data_root(默认 .local),相对产品根解析;
 * 不走 loadProductConfig(用户配置坏了也要能 init)。
 * 🔴 与启动器同一口径(data_root.ts):原来这里不认 VRA_DATA_ROOT,init 写进 .local、start 却去 user-data 找配置,
 *    照提示再跑 setup 也还是写错地方(第四轮审计 A4)。
 */
export function resolveDataRoot(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const pc = readJsonIfExists<{ paths?: { data_root?: string } }>(path.join(repoRoot, PRODUCT_CONFIG_FILE));
  return resolveDataRootFrom(repoRoot, pc?.paths?.data_root || DEFAULT_PRODUCT_CONFIG.paths.data_root, env);
}

/** lstat:不存在(ENOENT)→ null;存在(含悬空符号链接)→ Stats。existsSync 对悬空符号链接返回 false,不能用来判"是不是符号链接" */
export function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 数据根边界:词法在产品根内 + 最近已存在祖先的 realpath 仍在产品根 realpath 内 + 数据根本身不是符号链接(含悬空;防 .local → 仓库外) */
export function assertDataRootInside(repoRoot: string, dataRoot: string): void {
  const realRepo = fs.realpathSync(repoRoot);
  // ⚠️ init / doctor 面向的是**仓库内布局**(clone 下来自己跑),所以这里仍要求数据根在产品根内。
  //    分离安装(数据根在产品根之外,如桌面安装版)运行时是支持的,但那套的初始化归 launcher ——
  //    别以为这条限制说明运行时也不支持。
  if (dataRoot !== repoRoot && !dataRoot.startsWith(repoRoot + path.sep)) throw new Error(`数据根 ${dataRoot} 不在产品根 ${repoRoot} 之内,拒绝(init 面向仓库内布局;分离安装由 launcher 初始化)`);
  if (lstatOrNull(dataRoot)?.isSymbolicLink()) throw new Error(`数据根 ${dataRoot} 是符号链接,拒绝`);
  let probe = dataRoot;
  while (!lstatOrNull(probe)) { const parent = path.dirname(probe); if (parent === probe) break; probe = parent; }
  const real = fs.realpathSync(probe);
  if (real !== realRepo && !real.startsWith(realRepo + path.sep)) throw new Error(`数据根 ${dataRoot} 解析到产品根之外(${real}),拒绝`);
}

/** .gitignore 里是否已有等价于忽略 <rel>/ 的规则(.local/ · /.local/ · .local · /.local · .local/**) */
export function gitignoreCovers(text: string, rel: string): boolean {
  const base = rel.replace(/\/+$/, "");
  const accepted = new Set([base, `${base}/`, `/${base}`, `/${base}/`, `${base}/**`, `/${base}/**`]);
  return text.split(/\r?\n/).some((l) => accepted.has(l.trim()));
}

/** python 探测顺序:显式参数 → <repo>/.venv/bin/python(或 Scripts/python.exe)→ null(留给用户填) */
export function detectPython(repoRoot: string, explicit?: string): string | null {
  if (explicit) return explicit;
  for (const rel of [path.join(".venv", "bin", "python"), path.join(".venv", "Scripts", "python.exe")]) {
    const p = path.join(repoRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function runInit(opts: { repoRoot?: string; python?: string; provider?: string; force?: boolean; env?: NodeJS.ProcessEnv } = {}): InitResult {
  const repoRoot = path.resolve(opts.repoRoot ?? repoRootFromHere());
  const dataRoot = resolveDataRoot(repoRoot, opts.env);
  assertDataRootInside(repoRoot, dataRoot);
  if (opts.provider !== undefined && !PROVIDER_ID_RE.test(opts.provider)) throw new Error(`非法 provider id ${JSON.stringify(opts.provider)}`);
  const renamed = opts.provider === undefined ? null : renamedProviderHint(opts.provider);
  if (renamed) throw new Error(renamed);
  const steps: InitStep[] = [];
  // 1) 目录
  for (const sub of LOCAL_SUBDIRS) {
    const d = path.join(dataRoot, sub);
    const st = lstatOrNull(d);
    if (st) { if (!st.isDirectory()) throw new Error(`${d} 已存在但不是目录(符号链接也不行)`); steps.push({ id: `dir:${sub}`, action: "exists", detail: d }); }
    else { fs.mkdirSync(d, { recursive: true }); steps.push({ id: `dir:${sub}`, action: "created", detail: d }); }
  }
  // 2) 用户配置骨架(只在不存在或 --force 时写)
  const cfgFile = path.join(dataRoot, USER_CONFIG_FILE);
  // 不替用户挑默认 AI 来源:没给 --provider 就留 null,研究/对话会明确报「还没选 AI 来源」而不是静默走某一家
  const skeleton = {
    python: detectPython(repoRoot, opts.python),
    provider: { profile: opts.provider ?? null },
    defaults: { model: null },
  };
  if (fs.existsSync(cfgFile) && !opts.force) {
    // 给了 --provider 却没生效要明说:不然部署的 Agent 会以为后台默认已经改好了
    const ignored = opts.provider === undefined ? ""
      : `;--provider ${opts.provider} 未生效:改这份文件里的 provider.profile,或设环境变量 VRA_PROVIDER,或加 --force 整份重写`;
    steps.push({ id: "config", action: "kept", detail: `${cfgFile} 已存在,未改动(要重写请加 --force,会先备份)${ignored}` });
  } else {
    if (fs.existsSync(cfgFile)) {
      const stamp = nowIso().replace(/[-:]/g, "").slice(0, 15);
      let bak = `${cfgFile}.bak-${stamp}`;
      for (let n = 1; fs.existsSync(bak); n++) bak = `${cfgFile}.bak-${stamp}-${n}`;  // 同秒重复执行不覆盖旧备份
      fs.copyFileSync(cfgFile, bak);
      steps.push({ id: "config:backup", action: "backed_up", detail: bak });
    }
    writeJson(cfgFile, skeleton);
    steps.push({ id: "config", action: "written", detail: `${cfgFile}(python=${skeleton.python ?? "null,请填"};后台默认 AI 来源=${skeleton.provider.profile ?? "未设,在页面里选"})` });
  }
  // 3) .gitignore 必含 .local/(产品 / 用户数据分离的最后一道)
  const gi = path.join(repoRoot, ".gitignore");
  const giSt = lstatOrNull(gi);
  if (giSt?.isSymbolicLink()) throw new Error(`${gi} 是符号链接(含悬空),拒绝改写`);
  const giText = giSt ? fs.readFileSync(gi, "utf8") : "";
  const relLocal = path.relative(repoRoot, dataRoot).split(path.sep).join("/") + "/";
  if (gitignoreCovers(giText, relLocal)) steps.push({ id: "gitignore", action: "exists", detail: `${relLocal} 已在 .gitignore(或等价规则)` });
  else { fs.appendFileSync(gi, `${giText.endsWith("\n") || !giText ? "" : "\n"}# 用户私有层(init 追加)\n${relLocal}\n`); steps.push({ id: "gitignore", action: "appended", detail: `已追加 ${relLocal} 到 .gitignore` }); }
  const next = [
    "运行 scripts/start（Windows: scripts\\start.cmd）打开产品",
    "在‘接入 AI’里选择订阅或模型 API，测试成功后即可使用",
    "排查环境:运行 scripts/doctor（Windows: scripts\\doctor.ps1）",
  ];
  return { repoRoot, dataRoot, steps, next };
}

/**
 * 命令行参数 → runInit 的选项。带了就必须有值,而且在任何写入之前拒绝:裸 `--provider` 被当成没传的话,
 * 已有配置时命令照样成功、旧来源原样保留,首次初始化则写进一个空来源 —— 部署的 Agent 会以为后台默认已经设好了(Codex 复审 R3-2)。
 */
export function initOptionsFromArgs(a: Record<string, string | boolean>): { python?: string; provider?: string; force: boolean } {
  return { python: optionValue(a, "python"), provider: optionValue(a, "provider"), force: a.force === true };
}

if (process.argv[1] && (process.argv[1].endsWith("/init.ts") || process.argv[1].endsWith("\\init.ts"))) {
  const a = parseArgs(process.argv.slice(2));
  try {
    const r = runInit(initOptionsFromArgs(a));
    if (a.json === true) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`[init] 产品根 ${r.repoRoot}\n[init] 数据根 ${r.dataRoot}`);
      for (const s of r.steps) console.log(`  ${s.action.padEnd(9)} ${s.id}: ${s.detail}`);
      console.log("[init] 下一步:"); for (const n of r.next) console.log(`  - ${n}`);
    }
  } catch (e) { console.error(`[init] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
}
