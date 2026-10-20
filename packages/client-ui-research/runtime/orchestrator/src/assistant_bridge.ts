/**
 * 普通 Agent 对话的工具执行规则(两类大脑共用一份):
 *  - 本机订阅 Agent:CLI 进程经 MCP 适配器(assistant_tools_mcp.ts)→ 本文件的一次性 HTTP 桥 → 执行器;
 *  - 模型 API:chat.ts 的工具循环在本进程里直接调执行器。
 * 校验、逐个执行、每轮次数上限、结果大小上限、失败判定与报错收口都在执行器里,两条路不各写一份。
 * 凭据与服务上下文只留在 API 进程里。
 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restrictPrivateFileAsync } from "./fsutil.ts";
import { complianceGate } from "./gate.ts";
import { z } from "zod";

export interface AssistantTool {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never, signal: AbortSignal) => unknown | Promise<unknown>;
  /** 这次调用用到了什么来源(界面「本轮来源」用);失败时 result 是 undefined。不提供 = 这个工具不算来源 */
  cite?: (args: never, result: unknown) => ToolCite | null | undefined;
}

/** 一次调用用到的来源。只放展示字段:不放本机路径、令牌、原始结果 */
export interface ToolCite {
  /** 来源名:数据端点标题 / 联网搜索 / 研究报告 … */
  label: string;
  /** 查的对象:代码 / 关键词 / 运行编号 */
  target?: string;
  /** 实际给出数据的来源 */
  sources?: string[];
  /** 数据的取得时间 */
  as_of?: string;
  /** 拿到几条 */
  count?: number;
  /** 只拿到一部分(网页正文截断也算) */
  partial?: boolean;
  /** 用的是上次的快照,没有重新取 */
  cached?: boolean;
  /** 公开网页(只收 http / https,不带账号密码) */
  links?: { title: string; url: string }[];
}

export interface ToolReceipt { name: string; ok: boolean; duration_ms: number; cite?: ToolCite }

const clip = (v: unknown, n: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n) : "");
const publicUrl = (v: unknown): string => {
  if (typeof v !== "string" || v.length > 2048) return "";
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? u.href : "";
  } catch { return ""; }
};

/** 搜索关键词是模型写的、网页标题是外来文字:来源面板绕开了回答的合规检查,这里自己过一遍 */
export const CITE_TARGET_HIDDEN = "〔关键词含产出红线用语,已隐去〕";
const passes = (s: string) => complianceGate(s).ok;

/** 工具给的来源说明逐项收紧;形状不对的字段直接丢,整条不合格就不记 */
export function cleanCite(raw: unknown): ToolCite | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const rawLabel = clip(c.label, 80);
  if (!rawLabel) return undefined;
  // 标签一般是端点标题;注册表里查不到时退回模型给的端点名,也要过检查
  const label = passes(rawLabel) ? rawLabel : "数据工具";
  const out: ToolCite = { label };
  const target = clip(c.target, 120);
  if (target) out.target = passes(target) ? target : CITE_TARGET_HIDDEN;
  const asOf = clip(c.as_of, 40);
  if (asOf) out.as_of = asOf;
  if (Array.isArray(c.sources)) {
    const s = [...new Set(c.sources.map((x) => clip(x, 40)).filter(Boolean))].slice(0, 6);
    if (s.length) out.sources = s;
  }
  if (typeof c.count === "number" && Number.isInteger(c.count) && c.count >= 0) out.count = c.count;
  if (c.partial === true) out.partial = true;
  if (c.cached === true) out.cached = true;
  if (Array.isArray(c.links)) {
    const links = c.links.flatMap((l) => {
      const url = publicUrl((l as { url?: unknown } | null)?.url);
      if (!url) return [];
      const title = clip((l as { title?: unknown }).title, 120);
      // 标题不过检查就不显示,只留地址(界面会用域名代替)
      return [{ title: title && !passes(title) ? "" : title, url }];
    }).slice(0, 5);
    if (links.length) out.links = links;
  }
  return out;
}

function citeOf(tool: AssistantTool | undefined, args: unknown, result: unknown): ToolCite | undefined {
  if (!tool?.cite || args === undefined) return undefined;
  // 来源说明只是附带信息:它自己出错不能连累这次调用
  try { return cleanCite(tool.cite(args as never, result)); } catch { return undefined; }
}

/** 每轮最多执行几次工具 */
export const MAX_TOOL_CALLS_PER_TURN = 30;
/** 单次结果的缺省上限(字符)。超了不截断(坏 JSON 只会更糊涂),而是告诉模型缩小范围 */
export const MAX_TOOL_RESULT_CHARS = 120_000;

export type ToolCallOutcome =
  | { kind: "result"; isError: boolean; text: string }
  /** 上一个调用还没结束 —— 只会出现在 HTTP 桥上(进程内循环天然逐个执行) */
  | { kind: "busy" }
  /** 本轮工具次数已用完 */
  | { kind: "budget" }
  /** 本轮已经结束(取消 / 超时 / 已回答) */
  | { kind: "finished" };

export interface ToolExecutor {
  readonly receipts: ToolReceipt[];
  /** 本轮交给模型的工具结果原文。只在进程内给数字闸门核对用,不回传给页面 */
  readonly texts: string[];
  /** 给模型看的工具目录(MCP inputSchema / function calling parameters 同一份 JSON Schema) */
  catalog(): { name: string; description: string; inputSchema: Record<string, unknown> }[];
  /**
   * 执行一次调用。不抛错:参数不合法、工具失败都变成 isError 结果并记一条失败回执。
   * `maxResultChars` 只能收紧不能放宽(模型 API 按剩余上下文预算逐次收紧)。
   */
  call(name: unknown, args: unknown, limits?: { maxResultChars?: number }): Promise<ToolCallOutcome>;
  /** 请求本身就坏了(参数不是合法 JSON / 请求体形状不对):记一条失败回执 */
  malformed(name?: string): ToolCallOutcome;
}

const FAILURE_TEXT = "工具执行失败或参数不合法，请核对输入后重试；不得将失败当作没有数据。";

export function createToolExecutor(tools: AssistantTool[], signal: AbortSignal,
  opts: { maxResultChars?: number } = {}): ToolExecutor {
  const receipts: ToolReceipt[] = [];
  const texts: string[] = [];
  const maxResultChars = opts.maxResultChars ?? MAX_TOOL_RESULT_CHARS;
  let calls = 0;
  let active = false;
  const failed = (name: string, start: number, error?: unknown, cite?: ToolCite): ToolCallOutcome => {
    receipts.push({ name, ok: false, duration_ms: Date.now() - start, ...(cite ? { cite } : {}) });
    // 不回传原始异常:里面可能有 provider key 或本机路径。zod 报错只给字段路径与错误类型。
    const detail = error instanceof z.ZodError
      ? " 参数字段：" + error.issues.map(i => i.path.filter(p => typeof p === "number" || /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(String(p))).join(".") + " (" + i.code + ")").join("; ").slice(0, 400)
      : "";
    return { kind: "result", isError: true, text: FAILURE_TEXT + detail };
  };
  return {
    receipts,
    texts,
    catalog: () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema) as Record<string, unknown> })),
    malformed: (name = "unknown") => failed(tools.some((t) => t.name === name) ? name : "unknown", Date.now()),
    async call(nameInput, rawArgs, limits = {}) {
      if (signal.aborted) return { kind: "finished" };
      const cap = Math.min(maxResultChars, limits.maxResultChars ?? maxResultChars);
      const start = Date.now();
      let name = "unknown";
      let acquired = false;
      let tool: AssistantTool | undefined;
      let parsed: unknown;
      try {
        tool = tools.find((t) => t.name === nameInput);
        if (!tool) throw new Error("unknown_tool");
        name = tool.name;
        const args = tool.schema.parse(rawArgs);
        if (signal.aborted) throw new Error("turn_finished");
        if (active) return { kind: "busy" };
        if (++calls > MAX_TOOL_CALLS_PER_TURN) return { kind: "budget" };
        active = acquired = true;
        parsed = args;
        const result = await tool.run(args as never, signal);
        if (signal.aborted) throw new Error("turn_finished");
        const text = JSON.stringify(result);
        if (text.length > cap) {
          const cite = citeOf(tool, args, undefined);
          receipts.push({ name, ok: false, duration_ms: Date.now() - start, ...(cite ? { cite } : {}) });
          return { kind: "result", isError: true, text: "结果过大，请缩小查询范围或减少条数后重试；本次未向模型提供完整结果。" };
        }
        const value = result as { ok?: unknown; status?: unknown; result?: { status?: unknown }; envelope?: { status?: unknown } } | null;
        const isError = value?.ok === false || [value?.status, value?.result?.status, value?.envelope?.status]
          .some((status) => status === "error" || status === "failed");
        const cite = citeOf(tool, args, result);
        receipts.push({ name, ok: !isError, duration_ms: Date.now() - start, ...(cite ? { cite } : {}) });
        texts.push(text);
        return { kind: "result", isError, text };
      } catch (error) {
        // 参数过了校验、执行时才失败的,照样记下查的是什么(结果当作没有)
        return failed(name, start, error, citeOf(tool, parsed, undefined));
      } finally { if (acquired) active = false; }
    },
  };
}

/** 本机订阅 Agent 用的一次性 HTTP 桥:随机令牌、只监听 127.0.0.1、拒绝带 Origin 的浏览器请求。 */
export async function openAssistantBridge(tools: AssistantTool[], signal: AbortSignal) {
  const token = crypto.randomBytes(32).toString("hex");
  const executor = createToolExecutor(tools, signal);
  const server = http.createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      req.resume(); send(403, { error: "forbidden" }); return;
    }
    if (signal.aborted) { req.resume(); send(410, { error: "turn_finished" }); return; }
    if (req.method === "GET" && req.url === "/tools") {
      send(200, executor.catalog());
      return;
    }
    if (req.method !== "POST" || req.url !== "/call" || req.headers["content-type"] !== "application/json") {
      req.resume(); send(400, { error: "invalid_request" }); return;
    }
    let body: { name: string; arguments?: unknown };
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64_000) { send(413, { error: "input_too_large" }); return; }
        chunks.push(chunk);
      }
      body = z.object({ name: z.string(), arguments: z.unknown() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      const outcome = executor.malformed();
      send(200, outcome.kind === "result" ? { isError: true, content: [{ type: "text", text: outcome.text }] } : { isError: true });
      return;
    }
    const outcome = await executor.call(body.name, body.arguments);
    if (outcome.kind === "busy") { send(409, { error: "tool_busy_retry_sequentially" }); return; }
    if (outcome.kind === "budget") { send(429, { error: "turn_tool_budget_reached" }); return; }
    if (outcome.kind === "finished") { send(410, { error: "turn_finished" }); return; }
    send(200, { ...(outcome.isError ? { isError: true } : {}), content: [{ type: "text", text: outcome.text }] });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bridge_unavailable");
  // CLI 把 MCP env 配置序列化到 argv；这里只传私有文件路径，不传 bearer 值。
  let tokenDir: string | undefined;
  let tokenFile: string;
  try {
    tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-bridge-"));
    tokenFile = path.join(tokenDir, "token");
    // 先收紧空文件权限，再写令牌（Windows 也不能先写后收紧）。
    fs.writeFileSync(tokenFile, "", { flag: "wx", mode: 0o600 });
    await restrictPrivateFileAsync(tokenFile);
    fs.writeFileSync(tokenFile, token, { flag: "r+" });
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (tokenDir) fs.rmSync(tokenDir, { recursive: true, force: true });
    throw error;
  }
  return {
    url: `http://127.0.0.1:${address.port}`, token, tokenFile, receipts: executor.receipts, texts: executor.texts,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tokenDir!, { recursive: true, force: true });
    },
  };
}
