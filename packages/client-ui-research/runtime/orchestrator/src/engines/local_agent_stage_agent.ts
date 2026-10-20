/**
 * 本机订阅 Agent(Claude Code / Codex CLI / WorkBuddy)的六阶段运行器。
 *
 * 每个阶段 attempt 启动一次独立 CLI 会话,只开放产品受控 MCP 工具。会话结束 = 大脑想收工,
 * 产品随即做收工检查(stop_guard.ts):没通过就带着问题清单再起一个续跑会话,上限见 LOCAL_AGENT_STOP_LIMITS。
 * 所有续跑共用这一轮的时间预算,不会因为续跑把单轮时长放大成几倍。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { EventsLog, type AgentRunner, type TurnOutcome } from "../agent_runner.ts";
import type { Stage } from "../config.ts";
import { RUN_TOOLS } from "../run_tools.ts";
import { LOCAL_AGENT_STOP_LIMITS, StopGuard } from "../stop_guard.ts";
import { LocalAgentError, runLocalAgent, type LocalAgentId, type RunLocalAgentOptions } from "../local_agent_runtime.ts";

type Complete = (agent: LocalAgentId, options: RunLocalAgentOptions) => Promise<string>;

const FATAL_LOCAL_AGENT_ERRORS = new Set([
  "agent_not_installed", "agent_not_authenticated", "agent_probe_failed",
  "agent_cli_too_old", "unsupported_cli", "agent_bad_timeout", "agent_quota",
  "agent_shutdown_failed",
]);

/** 剩余时间少于这个数就不再起续跑会话(冷启动 + 重读产物都不够) */
const MIN_CONTINUATION_MS = 60_000;

export interface LocalAgentStageAgentOptions {
  agent: LocalAgentId;
  runId: string;
  runDir: string;
  repoRoot: string;
  python: string;
  eventsPath: string;
  env?: NodeJS.ProcessEnv;
  /** 一个 turn(含全部续跑会话)的总时长 */
  timeoutMs: number;
  observer?: (event: Record<string, unknown>) => void;
  complete?: Complete;
  /** 收工检查的上限(缺省 LOCAL_AGENT_STOP_LIMITS) */
  stopLimits?: { maxIdle: number; maxTotal: number };
}

const SERVER_NAME = "vra";
const allowedTools = RUN_TOOLS.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`);

function digest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 只记账 agent 合法可写的三类产物；受保护文件另有编排器 hash 校验。 */
function writableSnapshot(runDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (file: string) => {
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && !st.isSymbolicLink()) out.set(path.resolve(file), digest(file));
    } catch { /* 不存在就没有快照项 */ }
  };
  for (const dir of ["calcs", "stages"]) {
    const base = path.join(runDir, dir);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) if (/^[A-Za-z0-9._-]+\.json$/.test(name)) add(path.join(base, name));
  }
  add(path.join(runDir, "report.md"));
  return out;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.entries()].filter(([file, hash]) => before.get(file) !== hash).map(([file]) => file).sort();
}

const SYSTEM_PROMPT = `
你正在 Vibe Research 的受控六阶段执行器中工作。
宿主 Shell、任意文件读写、浏览器、网络和子 Agent 都不可用。
只使用显式提供的 VRA MCP 工具：list_run_files、read_run_file、calculate、write_stage、write_report。
用户消息里若有 shell 命令示例，它们只表达要完成的操作；必须翻译成上述受控工具，不得尝试执行命令。
严格完成当前阶段产物，最后按给定 JSON Schema 汇报。`.trim();

/** 续跑会话的提示词:原阶段任务 + 收工检查的问题清单 */
function continuationPrompt(prompt: string, message: string): string {
  return `${prompt}\n\n---\n\n` +
    "**这是同一阶段的续跑会话。** 上一次会话结束时，产品的收工检查没有通过：\n\n" +
    `${message}\n\n` +
    "上一次会话已经写好的产物仍在运行目录里：先用 list_run_files / read_run_file 看清现状，只补缺的、改错的，不要从头重来。";
}

export class LocalAgentStageAgent implements AgentRunner {
  readonly threadId: string | null = null;
  readonly #options: LocalAgentStageAgentOptions;
  readonly #events: EventsLog;
  readonly #complete: Complete;
  #sequence = 0;

  constructor(options: LocalAgentStageAgentOptions) {
    this.#options = options;
    this.#events = new EventsLog(options.eventsPath);
    this.#complete = options.complete ?? runLocalAgent;
  }

  eventsDigest(): string | null { return this.#events.digest(); }

  log(stage: Stage | "orchestrator", type: string, payload: Record<string, unknown> = {}): void {
    const event = { ts: new Date().toISOString(), run_id: this.#options.runId, seq: ++this.#sequence, stage, type, ...payload };
    this.#events.append(event);
    if (this.#options.observer) { try { this.#options.observer(event); } catch { /* 观察者不影响研究 */ } }
  }

  async runTurn(stage: Stage, attempt: number, prompt: string, _outputSchema?: unknown, signal?: AbortSignal): Promise<TurnOutcome> {
    signal?.throwIfAborted();
    const started = Date.now();
    const deadline = started + this.#options.timeoutMs;
    const before = writableSnapshot(this.#options.runDir);
    const guard = new StopGuard(this.#options.runDir, stage, this.#options.stopLimits ?? LOCAL_AGENT_STOP_LIMITS);
    let finalResponse = "";
    let failed: string | null = null;
    let fatal: LocalAgentError | null = null;
    let stopTerminated: string | null = null;
    let sessions = 0;
    let userPrompt = prompt;
    this.log(stage, "local_agent.turn_start", { attempt, agent: this.#options.agent });
    for (;;) {
      signal?.throwIfAborted();
      sessions += 1;
      try {
        finalResponse = await this.#complete(this.#options.agent, {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
          // 不把 --json-schema 与工具放在同一轮：真实 WorkBuddy 会因此直接回汇报、零工具调用。
          // turn 汇报不是真理源；stages/report 产物由受控工具 schema + 编排器 validator 双重强制。
          outputSchema: undefined,
          env: this.#options.env,
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal,
          controlledMcp: {
            serverName: SERVER_NAME,
            command: process.execPath,
            args: [path.join(this.#options.repoRoot, "orchestrator", "src", "finance", "run_tools_mcp.ts")],
            env: {
              VRA_RUN_DIR: this.#options.runDir,
              VRA_REPO_ROOT: this.#options.repoRoot,
              VRA_PYTHON: this.#options.python,
            },
            allowedTools,
            maxTurns: 32,
          },
        });
      } catch (error) {
        failed = error instanceof LocalAgentError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
        if (error instanceof LocalAgentError && FATAL_LOCAL_AGENT_ERRORS.has(error.code)) fatal = error;
        this.log(stage, "local_agent.turn_failed", { attempt, session: sessions, agent: this.#options.agent,
          code: error instanceof LocalAgentError ? error.code : "unknown", message: failed });
        break;
      }
      // 会话正常结束 = 大脑想收工:过收工检查
      const verdict = guard.check();
      if (verdict.decision === "allow") break;
      if (verdict.decision === "error") { this.log(stage, "stop_guard.error", { attempt, session: sessions, error: verdict.error }); break; }
      if (verdict.decision === "terminate") {
        stopTerminated = verdict.reason;
        this.log(stage, "stop_guard.terminate", { attempt, session: sessions, idle_streak: verdict.idleStreak, blocks: verdict.blocks, problems: verdict.problems });
        break;
      }
      this.log(stage, "stop_guard.block", { attempt, session: sessions, idle_streak: verdict.idleStreak, blocks: verdict.blocks, problems: verdict.problems });
      if (deadline - Date.now() < MIN_CONTINUATION_MS) {
        stopTerminated = `收工检查未通过且本轮时间已用完(已续跑 ${sessions - 1} 次):${verdict.problems.slice(0, 3).join("; ")}`.slice(0, 1000);
        this.log(stage, "stop_guard.terminate", { attempt, session: sessions, reason: "time_budget_exhausted", blocks: verdict.blocks, problems: verdict.problems });
        break;
      }
      userPrompt = continuationPrompt(prompt, verdict.message);
      this.log(stage, "local_agent.continue", { attempt, session: sessions + 1, agent: this.#options.agent });
    }
    const fileChanges = changedFiles(before, writableSnapshot(this.#options.runDir));
    const durationMs = Date.now() - started;
    this.log(stage, "local_agent.turn_end", { attempt, agent: this.#options.agent, sessions,
      file_changes: fileChanges.length, duration_ms: durationMs, failed, stop_blocks: guard.blocks, stop_terminated: !!stopTerminated });
    // 登录失效、未安装与额度耗尽都不是“让模型再写一遍”能修复的问题。
    // 直接交给编排器的异常收口，避免同一错误在六个阶段里连续调用十八次。
    if (fatal) throw fatal;
    return { finalResponse, usage: null, commands: [], fileChanges,
      itemCount: failed ? 0 : sessions, durationMs, failed, threadId: null,
      stopGuard: { blocks: guard.blocks, terminated: stopTerminated } };
  }
}
