#!/usr/bin/env node
/**
 * 模型 API 兼容矩阵:对 providers/<id>.json 模板指向的 **Chat Completions** 端点真跑 10 个小回合,机器判定 pass / partial / fail / error。
 * 只测产品「模型 API 大脑」真正依赖的能力 —— 六阶段研究、页面 Agent 对话、资料导入走的都是同一条 Chat Completions。
 * 结果写 .local/provider-matrix/<id>/<时间>/results.json + summary.md(不含任何密钥值),并给出模板 `direct` 段的建议值(不自动改模板)。
 * 用法:node orchestrator/src/finance/provider_matrix.ts --provider deepseek [--model M] [--base-url URL] [--tests 1,2,8] [--timeout-min 3]
 * key 只从模板声明的环境变量读(如 DEEPSEEK_API_KEY)。
 * 每项定义(可判定口径):
 *  ① 单次文本:回复含约定 token;
 *  ② 单工具调用:模型发起 echo_text 调用(参数是合法 JSON),拿到结果后最终回复含工具输出;
 *  ③ 连续三轮工具调用:next_code 每次返回下一步要用的码,三次调用依次用上一次的码(码无法猜,少调用拿不到终码);
 *  ④ 并行工具调用:一条回复里同时发起 ≥2 个调用 → pass;都调了但分在多条回复里 → partial(产品本来就逐个执行,partial 不影响使用);
 *  ⑤ 工具失败自修复:先有一次返回错误的调用、再有一次成功调用,且最终回复带出成功结果;
 *  ⑥ 长输出:1–200 编号一个不缺且 finish_reason=stop;
 *  ⑦ 工具后分轮收尾:先用工具取值,再发一轮**不带工具**的请求让它只输出 JSON(研究阶段的固定节奏;历史里带着工具调用),值正确 → pass;
 *  ⑧ 服务端 schema:与产品同样的 response_format(json_schema, strict:false)下回复是合法 JSON 且字段齐 → 建议 structured_output=server_schema,否则 prompt;
 *  ⑨ 多轮上下文延续:第二轮能复述第一轮的约定词(客户端每轮重发历史);
 *  ⑩ 图片输入(资料导入的图片 / 截图用):data URL 小图能说出颜色 → pass;端点拒绝 → fail(只影响导入图片,不影响研究与对话)。
 * 工具都是本地假工具,不联网、不加载产品宪法(只测协议兼容,不测研究纪律)。
 * 落盘前脱敏:key 精确替换为 ***,再叠加通用 token / 签名 URL 脱敏(错误信息可能回显请求头或带签名 URL)。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { chatCompletion, DirectTransportError, type ChatContentPart, type ChatFunctionSpec, type ChatMessage, type ChatMultimodalMessage } from "../engines/direct_transport.ts";
import { writeJson } from "../fsutil.ts";
import { loadProductConfig } from "../productConfig.ts";
import { loadProviderProfile, providerUrlError, type ProviderProfileFile } from "../providers.ts";
import { numberOption, optionValue, parseArgs } from "../run.ts";
import { redact, repoRootFromHere } from "../service.ts";

export interface MatrixCase { no: number; name: string; verdict: "pass" | "partial" | "fail" | "error"; detail: string; duration_ms: number; calls: number; rounds: number }

/** 一次小回合(可能含多轮工具往返)的可判定摘要 */
export interface TurnSummary {
  text: string;
  /** 按发生顺序的工具调用;ok=false 表示本地假工具返回了错误(参数不合法 / 故意失败) */
  calls: { name: string; args: Record<string, unknown> | null; ok: boolean }[];
  /** 单条回复里同时发起的工具调用峰值:≥2 才算观察到并行 */
  max_calls_per_message: number;
  rounds: number;
  finish: string | null;
  error: string | null;
}

/** 脱敏:已知密钥值精确替换 + 通用 token / 签名 URL 模式(service.redact);写入 results / summary / stderr 前必经 */
export function scrubWith(secrets: string[], s: string, max = 600): string {
  let out = String(s ?? "");
  for (const v of secrets) if (v) out = out.split(v).join("***");
  return redact(out, max);
}

interface LocalTool { spec: ChatFunctionSpec; run: (args: Record<string, unknown>) => { ok: boolean; value: unknown } }
const obj = (props: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties: props, required });

/** next_code 的码链:start → K7 → Q2 → Z9(无法猜,只能按顺序调) */
const CODE_CHAIN: Record<string, string> = { start: "K7", K7: "Q2", Q2: "Z9" };
const LOOKUP: Record<string, string> = { alpha: "a-311", beta: "b-722", gamma: "g-904" };

export const TOOLS: Record<string, LocalTool> = {
  echo_text: { spec: { name: "echo_text", description: "原样返回给定文本", parameters: obj({ text: { type: "string" } }, ["text"]) },
    run: (a) => typeof a.text === "string" ? { ok: true, value: { output: a.text } } : { ok: false, value: { error: "text 必须是字符串" } } },
  next_code: { spec: { name: "next_code", description: "输入当前码,返回下一个码。第一次用 start", parameters: obj({ code: { type: "string" } }, ["code"]) },
    run: (a) => typeof a.code === "string" && CODE_CHAIN[a.code] ? { ok: true, value: { next: CODE_CHAIN[a.code] } } : { ok: false, value: { error: `未知码 ${String(a.code)}` } } },
  lookup: { spec: { name: "lookup", description: "按键名查一个值", parameters: obj({ key: { type: "string" } }, ["key"]) },
    run: (a) => typeof a.key === "string" && LOOKUP[a.key] ? { ok: true, value: { key: a.key, value: LOOKUP[a.key] } } : { ok: false, value: { error: `没有键 ${String(a.key)}` } } },
  read_file: { spec: { name: "read_file", description: "读取一个文本文件", parameters: obj({ path: { type: "string" } }, ["path"]) },
    run: (a) => a.path === "/data/recovered.txt" ? { ok: true, value: { content: "recovered-5519" } } : { ok: false, value: { error: `文件不存在:${String(a.path)}` } } },
};

interface Endpoint { baseURL: string; apiKey: string; model: string; timeoutMs: number }

/** 最小工具循环:执行本地假工具、把结果喂回去,直到模型不再调用工具(最多 maxRounds 次请求) */
async function runTurn(ep: Endpoint, messages: (ChatMessage | ChatMultimodalMessage)[], tools: LocalTool[], secrets: string[],
  opts: { responseFormat?: Record<string, unknown>; maxRounds?: number } = {}): Promise<TurnSummary> {
  const sum: TurnSummary = { text: "", calls: [], max_calls_per_message: 0, rounds: 0, finish: null, error: null };
  const maxRounds = opts.maxRounds ?? 8;
  try {
    while (sum.rounds < maxRounds) {
      sum.rounds += 1;
      const reply = await chatCompletion({ ...ep, messages, ...(tools.length ? { tools: tools.map((t) => t.spec) } : {}), ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}) });
      sum.finish = reply.finishReason;
      // 原样放回历史(有的端点要求把 reasoning_content 等字段带回去,删字段会让下一轮 400)
      messages.push(reply.message);
      const calls = reply.message.tool_calls ?? [];
      if (!calls.length) { sum.text = scrubWith(secrets, reply.message.content ?? "", 20_000); return sum; }
      sum.max_calls_per_message = Math.max(sum.max_calls_per_message, calls.length);
      for (const call of calls) {
        let args: Record<string, unknown> | null = null;
        try { const parsed = JSON.parse(call.function.arguments || "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>; } catch { /* 记为参数不合法 */ }
        const tool = tools.find((t) => t.spec.name === call.function.name);
        const out = !tool ? { ok: false, value: { error: `没有工具 ${call.function.name}` } } : !args ? { ok: false, value: { error: "arguments 不是合法 JSON 对象" } } : tool.run(args);
        sum.calls.push({ name: call.function.name, args, ok: out.ok });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out.value) });
      }
    }
    sum.error = `超过 ${maxRounds} 轮仍在调用工具`;
  } catch (e) {
    sum.error = scrubWith(secrets, e instanceof DirectTransportError ? `${e.code}${e.status !== null ? ` HTTP ${e.status}` : ""}:${e.message}` : e instanceof Error ? e.message : String(e));
  }
  return sum;
}

const LONG_LINES = 200;

function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { const o = JSON.parse(t); return o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : null; } catch { return null; }
}

export function judge(no: number, t: TurnSummary, ctx: { token?: string } = {}): { verdict: MatrixCase["verdict"]; detail: string } {
  if (t.error) return { verdict: "error", detail: t.error };
  const txt = t.text.toLowerCase();
  const okCalls = t.calls.filter((c) => c.ok);
  switch (no) {
    case 1: return txt.includes("vra-ok-7731") ? { verdict: "pass", detail: "回复含约定 token" } : { verdict: "fail", detail: `回复未含约定 token:${t.text.slice(0, 80)}` };
    case 2: {
      const called = okCalls.some((c) => c.name === "echo_text" && c.args?.text === "hello-tool-4412");
      if (called && txt.includes("hello-tool-4412")) return { verdict: "pass", detail: `${t.calls.length} 次调用,最终回复带出工具输出` };
      return { verdict: called ? "partial" : "fail", detail: called ? "调用了工具但最终回复没带出输出" : `没有按要求调用 echo_text(调用 ${t.calls.length} 次)` };
    }
    case 3: {
      const codes = t.calls.filter((c) => c.name === "next_code").map((c) => String(c.args?.code ?? ""));
      const ordered = codes.length >= 3 && codes.slice(0, 3).join(",") === "start,K7,Q2";
      if (ordered && txt.includes("z9")) return { verdict: "pass", detail: "三次调用依次用上一次的码,拿到终码 Z9" };
      return { verdict: codes.length ? "partial" : "fail", detail: `next_code 参数序列 ${codes.join(" → ") || "(无)"};终码${txt.includes("z9") ? "已" : "未"}出现` };
    }
    case 4: {
      const keys = new Set(okCalls.filter((c) => c.name === "lookup").map((c) => String(c.args?.key)));
      const both = keys.has("alpha") && keys.has("beta");
      if (!both) return { verdict: "fail", detail: `alpha / beta 未都查到(查到 ${[...keys].join(",") || "无"})` };
      return t.max_calls_per_message >= 2 ? { verdict: "pass", detail: `一条回复里同时发起 ${t.max_calls_per_message} 个调用` } : { verdict: "partial", detail: "两个都查了,但分在多条回复里(未观察到并行;产品逐个执行,不影响使用)" };
    }
    case 5: {
      const firstFail = t.calls.findIndex((c) => c.name === "read_file" && !c.ok);
      const recovered = t.calls.some((c, i) => i > firstFail && c.name === "read_file" && c.ok);
      const told = txt.includes("recovered-5519");
      if (firstFail >= 0 && recovered && told) return { verdict: "pass", detail: "先失败后改读成功,最终回复带出结果" };
      return { verdict: recovered || told ? "partial" : "fail", detail: `失败调用${firstFail >= 0 ? "有" : "无"},改读成功${recovered ? "有" : "无"},最终回复${told ? "带出" : "未带出"}结果` };
    }
    case 6: {
      const nums = t.text.split("\n").map((l) => /^\s*(\d+)[.、)]/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
      const have = new Set(nums); const missing = Array.from({ length: LONG_LINES }, (_, i) => i + 1).filter((n) => !have.has(n));
      if (!missing.length && t.finish === "stop") return { verdict: "pass", detail: `${LONG_LINES} 行编号齐全,finish_reason=stop` };
      return { verdict: "partial", detail: `编号行 ${nums.length},缺 ${missing.length} 个${missing.length ? `(如 ${missing.slice(0, 5).join(",")})` : ""};finish_reason=${t.finish ?? "无"}` };
    }
    case 7: {
      const o = parseJsonObject(t.text);
      if (o && o.key === "gamma" && o.value === "g-904") return { verdict: "pass", detail: "工具取值后,不带工具的收尾轮输出了正确 JSON" };
      return { verdict: o ? "partial" : "fail", detail: o ? `JSON 合法但值不对:${t.text.slice(0, 80)}` : `收尾轮不是 JSON:${t.text.slice(0, 80)}` };
    }
    case 8: {
      const o = parseJsonObject(t.text);
      if (o && o.answer === "vra" && o.n === 42 && Object.keys(o).length === 2) return { verdict: "pass", detail: "JSON 合法且字段齐" };
      return { verdict: o ? "partial" : "fail", detail: o ? `JSON 合法但字段不符:${t.text.slice(0, 80)}` : `回复不是 JSON:${t.text.slice(0, 80)}` };
    }
    case 9: return ctx.token && txt.includes(ctx.token) ? { verdict: "pass", detail: "第二轮复述了第一轮的约定词" } : { verdict: "fail", detail: `未复述:${t.text.slice(0, 80)}` };
    case 10: return /红|\bred\b/.test(txt) ? { verdict: "pass", detail: "能识别图片(说出了颜色)" } : { verdict: "fail", detail: `没认出图片颜色:${t.text.slice(0, 80)}` };
    default: return { verdict: "error", detail: "unknown" };
  }
}

/**
 * 按矩阵结果给出模板 `direct` 段的建议值。核心能力(①②③⑤⑦⑨)有一项不过就建议 supported=false;
 * ⑧ 通过才建议 server_schema。④⑥⑩ 只影响体验或资料导入,写进 notes 而不左右 supported。
 */
export function suggestDirect(cases: MatrixCase[], today: string): { supported: boolean; structured_output: "server_schema" | "prompt"; verified_at: string; notes: string[] } {
  const v = (no: number) => cases.find((c) => c.no === no)?.verdict;
  const core = [1, 2, 3, 5, 7, 9];
  const supported = core.every((no) => v(no) === "pass");
  const notes: string[] = [];
  const missing = core.filter((no) => v(no) === undefined);
  if (missing.length) notes.push(`核心项 ${missing.join("/")} 本次未跑,supported 不能据此判定`);
  if (v(4) && v(4) !== "pass") notes.push("不支持(或没观察到)并行工具调用;产品逐个执行,不影响使用");
  if (v(6) && v(6) !== "pass") notes.push("长输出不完整,长报告可能被截断");
  if (v(10) && v(10) !== "pass") notes.push("不支持图片输入:资料导入里的图片 / 截图用不了,文字资料不受影响");
  return { supported: supported && !missing.length, structured_output: v(8) === "pass" ? "server_schema" : "prompt", verified_at: today, notes };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf: Buffer): number { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
/** 纯色 RGB PNG(⑩ 用;现场生成,不依赖图片库,也不放一串看不懂的 base64) */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; // 8 位 RGB,无隔行
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export async function runMatrix(opts: { provider: string; model?: string; baseURL?: string; tests?: number[]; timeoutMs?: number; repoRoot?: string; env?: NodeJS.ProcessEnv }): Promise<{ dir: string; cases: MatrixCase[]; profile: ProviderProfileFile; suggestion: ReturnType<typeof suggestDirect> }> {
  if (opts.model !== undefined && !opts.model.trim()) throw new Error("--model 需要一个值");
  const repoRoot = opts.repoRoot ?? repoRootFromHere();
  const env = opts.env ?? process.env;
  const pc = loadProductConfig(repoRoot, { env });
  if (opts.baseURL) { const err = providerUrlError(opts.baseURL); if (err) throw new Error(`--base-url:${err}`); }
  const { profile } = loadProviderProfile(repoRoot, pc.resolved.dataRoot, opts.provider, opts.baseURL);
  const apiKey = String(env[profile.env_key] ?? "").trim();
  if (!apiKey) throw new Error(`缺少环境变量 ${profile.env_key}(key 只从环境变量读)`);
  // 矩阵要能复测"模板声明实测不可用"的端点,所以不走 apiCapabilityOf 的 usable 闸门;地址与模型的取法与它一致
  const baseURL = profile.direct?.base_url ?? profile.base_url;
  if (!baseURL) throw new Error(`${profile.id} 的模板没有端点地址,请用 --base-url 指定`);
  const model = opts.model ?? profile.direct?.default_model ?? profile.default_model;
  if (!model) throw new Error(`${profile.id} 的模板没有默认模型,请用 --model 指定`);
  const secrets = [apiKey];
  const ep: Endpoint = { baseURL, apiKey, model, timeoutMs: opts.timeoutMs ?? 3 * 60_000 };
  const want = new Set(opts.tests ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dir = path.join(pc.resolved.dataRoot, "provider-matrix", profile.id, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const cases: MatrixCase[] = [];
  const header = () => ({ provider: profile.id, model, base_url: baseURL, protocol: "chat_completions" });
  const rec = (no: number, name: string, t: TurnSummary, v: { verdict: MatrixCase["verdict"]; detail: string }, ms: number) => {
    cases.push({ no, name, verdict: v.verdict, detail: scrubWith(secrets, v.detail, 300), duration_ms: ms, calls: t.calls.length, rounds: t.rounds });
    console.error(`[matrix] ${no}. ${name}: ${v.verdict} — ${scrubWith(secrets, v.detail, 300)} (${Math.round(ms / 1000)}s)`);
    writeJson(path.join(dir, "results.json"), { ...header(), cases });
  };
  const user = (content: string): ChatMessage => ({ role: "user", content });
  const run1 = async (no: number, name: string, messages: (ChatMessage | ChatMultimodalMessage)[], tools: LocalTool[] = [], extra: Parameters<typeof runTurn>[4] = {}) => {
    if (!want.has(no)) return;
    const t0 = Date.now();
    const t = await runTurn(ep, messages, tools, secrets, extra);
    rec(no, name, t, judge(no, t), Date.now() - t0);
  };
  await run1(1, "单次文本", [user("请只回复这个字符串,不要其它内容:vra-ok-7731")]);
  await run1(2, "单工具调用", [user("请调用 echo_text 工具,参数 text 为 hello-tool-4412,然后把工具返回的 output 原样回复给我。")], [TOOLS.echo_text]);
  await run1(3, "连续三轮工具调用", [user("请用 next_code 工具:第一次用 start,之后每次都用上一次返回的 next 作为参数,共调用三次。最后只回复第三次返回的码。")], [TOOLS.next_code]);
  await run1(4, "并行工具调用", [user("请在同一条回复里同时发起两个 lookup 调用,分别查 alpha 与 beta(两者互不依赖,不要一个一个等),然后回复两个值。")], [TOOLS.lookup]);
  await run1(5, "工具失败自修复", [user("请用 read_file 读取 /missing/vra-7731.txt;如果失败,改读 /data/recovered.txt,并在最终回复里告诉我读到的内容。")], [TOOLS.read_file]);
  await run1(6, "长输出", [user(`请输出 ${LONG_LINES} 行,每行格式为 \`<序号>. line\`,序号从 1 到 ${LONG_LINES},不要省略、不要解释。`)]);
  if (want.has(7)) {
    const t0 = Date.now();
    const messages: ChatMessage[] = [user("请用 lookup 工具查 gamma 的值。查到后简单回复一句即可。")];
    const first = await runTurn(ep, messages, [TOOLS.lookup], secrets);
    if (first.error || !first.calls.some((c) => c.name === "lookup" && c.ok)) {
      rec(7, "工具后分轮收尾", first, first.error ? { verdict: "error", detail: `取值轮失败:${first.error}` } : { verdict: "fail", detail: "取值轮没有成功调用 lookup" }, Date.now() - t0);
    } else {
      messages.push(user("现在只输出一个 JSON 对象,形如 {\"key\": \"gamma\", \"value\": \"<查到的值>\"},不要代码围栏、不要任何解释。"));
      const second = await runTurn(ep, messages, [], secrets);
      rec(7, "工具后分轮收尾", second, judge(7, second), Date.now() - t0);
    }
  }
  await run1(8, "服务端 schema", [user("请回答:answer 填写 vra,n 填写 42。")], [], {
    responseFormat: { type: "json_schema", json_schema: { name: "vra_probe", strict: false, schema: obj({ answer: { type: "string" }, n: { type: "integer" } }, ["answer", "n"]) } },
  });
  if (want.has(9)) {
    const token = "cobalt-lantern-5519";
    const t0 = Date.now();
    const messages: ChatMessage[] = [user(`请记住这个约定词并只回复"已记住":${token}`)];
    const first = await runTurn(ep, messages, [], secrets);
    if (first.error) rec(9, "多轮上下文延续", first, { verdict: "error", detail: `第一轮失败:${first.error}` }, Date.now() - t0);
    else {
      messages.push(user("我刚才让你记住的约定词是什么?只回复那个词。"));
      const second = await runTurn(ep, messages, [], secrets);
      rec(9, "多轮上下文延续", second, judge(9, second, { token }), Date.now() - t0);
    }
  }
  const image: ChatContentPart[] = [
    { type: "text", text: "这张图片是什么颜色?只回复颜色名。" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${solidPng(64, 64, [220, 20, 20]).toString("base64")}` } },
  ];
  await run1(10, "图片输入", [{ role: "user", content: image }]);

  const tally: Record<string, number> = {};
  for (const c of cases) tally[c.verdict] = (tally[c.verdict] ?? 0) + 1;
  const suggestion = suggestDirect(cases, new Date().toISOString().slice(0, 10));
  const md = [`# 模型 API 兼容矩阵 · ${profile.id} · 模型 ${model} · ${stamp}`, "",
    `> Chat Completions(${new URL(baseURL).host});机器判定口径见 provider_matrix.ts 头注释;结果只反映该时刻该模型;不含任何密钥。`, "",
    `- 合计:${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    `- 模板 \`direct\` 段建议:\`${JSON.stringify(suggestion)}\`(人工确认后回填 providers/${profile.id}.json)`, "",
    "| # | 项目 | 判定 | 说明 | 工具调用 | 请求轮数 | 耗时 s |", "|---|---|---|---|---|---|---|",
    ...cases.map((c) => `| ${c.no} | ${c.name} | ${c.verdict} | ${c.detail.replace(/\|/g, "/")} | ${c.calls} | ${c.rounds} | ${Math.round(c.duration_ms / 1000)} |`)].join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "summary.md"), md);
  writeJson(path.join(dir, "results.json"), { ...header(), tally, suggestion, cases });
  return { dir, cases, profile, suggestion };
}

/**
 * 命令行参数 → runMatrix 的选项;null = 没给 --provider(打用法)。
 * 带了就必须有值,而且在建结果目录、发请求之前拒绝:裸 `--model` 被当成没传的话,矩阵会悄悄改测模板默认模型(Codex 复审 R3-1)。
 * --tests 里的无效编号以前被静默丢掉,全丢光就退回整套 10 项 —— 照样计费。
 */
export function matrixOptionsFromArgs(a: Record<string, string | boolean>): { provider: string; model?: string; baseURL?: string; tests?: number[]; timeoutMs?: number } | null {
  if (a.provider === undefined) return null;
  const testsRaw = optionValue(a, "tests");
  const tests = testsRaw?.split(",").map((s) => Number(s.trim()));
  if (tests?.some((n) => !Number.isInteger(n) || n < 1 || n > 10)) throw new Error(`--tests 只收 1-10 的编号(逗号分隔),收到 ${testsRaw}`);
  const timeoutMin = numberOption(a, "timeout-min", "positive");
  return { provider: optionValue(a, "provider")!, model: optionValue(a, "model"), baseURL: optionValue(a, "base-url"), tests,
    timeoutMs: timeoutMin === undefined ? undefined : timeoutMin * 60_000 };
}

async function main(): Promise<void> {
  const opts = matrixOptionsFromArgs(parseArgs(process.argv.slice(2)));
  if (!opts) { console.error("用法:node orchestrator/src/finance/provider_matrix.ts --provider <模板 id> [--model M] [--base-url URL] [--tests 1,2,8] [--timeout-min 3]"); process.exit(2); }
  const r = await runMatrix(opts);
  console.error(`[matrix] done → ${r.dir}/summary.md`);
  process.exit(r.cases.some((c) => c.verdict === "fail" || c.verdict === "error") ? 2 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("provider_matrix.ts")) main().catch((e) => { console.error(`[matrix] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
