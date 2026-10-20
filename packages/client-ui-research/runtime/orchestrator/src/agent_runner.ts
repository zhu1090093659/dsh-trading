/**
 * 与大脑无关的阶段运行契约与事件账本。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Stage } from "./config.ts";
import type { ResearchFailureCode } from "./research_failure.ts";

export interface CommandRecord { command: string; exit_code: number | null; status: string }

export interface TurnOutcome {
  finalResponse: string;
  usage: Record<string, number> | null;
  commands: CommandRecord[];
  fileChanges: string[];
  itemCount: number;
  durationMs: number;
  failed: string | null;
  /**
   * 执行器自己认出的结构化故障码(目前只有模型 API 的地址跳转)。有它就不再按 `failed` 的文字猜 ——
   * 文字分类只给 CLI 输出兜底;跳转这类配置错误从文字里认不出来,编排会一直补跑(Codex 复审 R3-3)。
   */
  failureCode?: ResearchFailureCode;
  threadId: string | null;
  /**
   * 收工守卫(stop_guard.ts):本轮拦了几次;`terminated` = 终止原因。
   * 终止 ⇒ 该 turn 判失败并补跑。与 `failed` 分开记:它不是执行错误,不参与失败归类。
   */
  stopGuard?: { blocks: number; terminated: string | null };
}

/** 可注入的运行器接口（测试用假运行器实现同一接口）。 */
export interface AgentRunner {
  runTurn(stage: Stage, attempt: number, prompt: string, outputSchema?: unknown, signal?: AbortSignal): Promise<TurnOutcome>;
  readonly threadId: string | null;
  log(stage: Stage | "orchestrator", type: string, payload?: Record<string, unknown>): void;
  /** events.jsonl 全部已写内容的 sha256；null = 不校验。 */
  eventsDigest(): string | null;
}

const GENERIC_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const HOME_USER_RE = /(\/Users\/|\/home\/|C:\\\\Users\\\\)([^/\\\\"'\s:]+)/g;
const PRIVATE_HOST_RE = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3})\b/g;
const USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]*@/gi;
const INTERNAL_HOST_RE = /\b([a-z][a-z0-9+.-]*:\/\/)(localhost|[a-z0-9-]+\.(?:local|internal|lan|corp|intranet))\b/gi;

/**
 * 抹掉一个已知密钥。≥8 位按子串全抹;更短的(自建端点常见 EMPTY、ollama 这类占位值)只抹独立出现的整段 ——
 * 按子串抹会把正文里同样的几个字母抹成一片,而上游回显密钥时它总是独立的一段。
 */
export function maskKnownSecret(text: string, secret: string, mask: string): string {
  if (!secret) return text;
  if (secret.length >= 8) return text.split(secret).join(mask);
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g"), () => mask);
}

/** 编排器自己写的结构字段(时间、运行编号、序号、阶段、事件类型):不是外来文本,不做已知密钥替换,免得短占位密钥把事件类型抹坏 */
const EVENT_STRUCTURE_FIELDS = new Set(["ts", "run_id", "seq", "stage", "type"]);

export function redactEnvironment(text: string): string {
  return text
    .replace(USERINFO_RE, "$1[REDACTED_USERINFO]@")
    .replace(HOME_USER_RE, "$1[USER]")
    .replace(PRIVATE_HOST_RE, "[PRIVATE_IP]")
    .replace(INTERNAL_HOST_RE, "$1[INTERNAL_HOST]");
}

/** 每条 fsync，维护全文 sha256；已知密钥与常见 key 形态在落盘前脱敏。 */
export class EventsLog {
  private readonly hash = crypto.createHash("sha256");
  private readonly path: string;
  private readonly secrets: string[];

  constructor(p: string, secrets: string[] = []) {
    this.path = p;
    // 不设长度门槛:短密钥一样是密钥。去重,长的先抹 —— 短密钥恰是长密钥的一段时,先抹短的会把长的抹残、留下其余部分。
    this.secrets = [...new Set(secrets.filter((x) => typeof x === "string" && x.length > 0))].sort((a, b) => b.length - a.length);
  }

  private maskKnown(text: string): string {
    let out = text;
    for (const sec of this.secrets) out = maskKnownSecret(out, sec, "[REDACTED]");
    return out;
  }

  redact(text: string): string {
    return redactEnvironment(this.maskKnown(text).replace(GENERIC_KEY_RE, "[REDACTED_KEY]"));
  }

  append(obj: unknown): void {
    // 已知密钥在 JSON 转义之前逐个字符串值替换:含引号或反斜杠的密钥在整行 JSON 里已被转义,按行找不到;
    // 只改字符串内容,短密钥也碰不坏 JSON 结构。通用形态与环境信息仍按整行处理(路径规则针对的就是转义后的形态)。
    const maskKnown = (s: string) => this.maskKnown(s);
    const json = JSON.stringify(obj, function (this: unknown, key: string, value: unknown) {
      if (typeof value !== "string" || (this === obj && EVENT_STRUCTURE_FIELDS.has(key))) return value;
      return maskKnown(value);
    });
    const line = redactEnvironment(json.replace(GENERIC_KEY_RE, "[REDACTED_KEY]")) + "\n";
    this.hash.update(line);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const fd = fs.openSync(this.path, "a");
    try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  digest(): string { return this.hash.copy().digest("hex"); }
}

/**
 * 干跑(`--no-agent`)用的 runner:只记事件,不拉起任何大脑。
 * 编排器在 noAgent 时从不调用 runTurn;真被调用说明调用方接错了,当场报错而不是假装跑过。
 */
export class NoAgentRunner implements AgentRunner {
  readonly threadId: string | null = null;
  readonly #events: EventsLog;
  readonly #runId: string;
  #sequence = 0;

  constructor(runId: string, eventsPath: string) {
    this.#runId = runId;
    this.#events = new EventsLog(eventsPath);
  }

  async runTurn(stage: Stage): Promise<TurnOutcome> {
    throw new Error(`干跑模式没有大脑,不能执行阶段 ${stage}`);
  }

  log(stage: Stage | "orchestrator", type: string, payload: Record<string, unknown> = {}): void {
    this.#events.append({ ts: new Date().toISOString(), run_id: this.#runId, seq: ++this.#sequence, stage, type, ...payload });
  }

  eventsDigest(): string | null { return this.#events.digest(); }
}
