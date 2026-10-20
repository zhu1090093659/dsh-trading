/**
 * 运行进度的人类可读渲染(只写 **stderr**,stdout 的 JSON 契约一行不动)。
 *
 * 为什么需要:六阶段研究要跑 15–19 分钟,而 `run.ts` 全程只打印一行配置 + 六行 `stage=X attempt=1/3`,
 * 最后甩一个 JSON —— 用户在十几分钟里**看不到任何内容**,无从判断它在干什么、有没有卡住。
 * 但数据其实**早就在流**了(ht27 实测:agent 第一条文字出现在 +0.2 分,profile 阶段 +1.3 分就完成,
 * 且 `stages/profile.json` 的 `summary` 已经是一段可读的中文公司画像)。
 * ⇒ 这不是架构问题,是**显示**问题:订阅既有事件流即可。实测(ht28 回放)时间线 ——
 *   **+5 秒**出现第一行实质内容(本阶段取了哪几个源、哪个失败了),**+1 分 49 秒**出现完整的公司画像段落,
 *   此后每 2 分钟左右一段。对比改前:**17 分钟里一个字都没有**,最后甩一个 JSON。
 *   **只动展示层,不碰三级约束的任何一环。**
 *
 * 🔴 边界:
 * - 渲染器**只读不写**,任何异常都吞掉(见 onEvent 的 try/catch)—— 显示层永远不能把一次真实研究搞失败。
 * - 不打印本机绝对路径(事件里带路径的字段一律不取),与事件流本身的脱敏口径一致。
 * - 不碰 stdout:批处理 / MCP / HTTP API 都靠 stdout 的 JSON,**加一个字节都可能破坏调用方**。
 */
import { currentPlugin } from "./plugin.ts";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./service_redact.ts";
import { NOFOLLOW_FLAG } from "./fsutil.ts";

/** 阶段显示名**由插件提供**。同时是**白名单** —— 只有这些 stage 允许被拼进文件路径(见 stageSummary) */
const stageLabels = (): Record<string, string> => currentPlugin().stageLabels as Record<string, string>;

/** stages/<stage>.json 读取上限:超过就当没有 summary。显示层不为一个坏文件把事件循环卡住(Codex progress-r1 P2) */
const MAX_STAGE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 终端安全净化(Codex progress-r1 P1)。要打到终端的**全部**文本都得先过这里 ——
 * summary / validator 报错 / 失败源名 / 异常消息都来自 **agent 或外部**,是不可信文本:
 * - ESC / OSC / CSI 序列可以清屏、改窗口标题、写剪贴板,甚至**伪造出几行假的进度**骗过用户;
 * - C0/C1 控制字符与 DEL 会打乱输出;退格可以把已打印的内容"擦掉"重写;
 * - 双向控制字符(U+202A–U+202E / U+2066–U+2069)能让一行文字的**视觉顺序与实际内容相反**。
 */
export function sanitizeTerm(text: string): string {
  return String(text ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")   // OSC(含未闭合的)
    .replace(/\u001b[@-_][0-?]*[ -\/]*[@-~]?/g, "")                    // CSI / 其它 ESC 序列
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")        // C0(留 \t\n,后续统一折叠)/ DEL / C1
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");        // 双向控制
}

/** 抹掉可能内嵌在自由文本里的本机绝对路径(Codex progress-r1 P1):事件字段不取路径 ≠ 正文里没有路径 */
export function stripPaths(text: string): string {
  // 在中文散文里认路径,正则一路打补丁会在两个方向反复翻车(要么泄露后半段,要么把后面的中文一起吞掉),
  // 所以这里改成扫描器,把判据写成一条能讲清楚的规则:
  //   **遇到全角标点时,只有它后面还会出现路径分隔符,才认为路径还在继续。**
  //   `conf.json)损坏` -> `)` 之后没有 / -> 路径到此为止(不吞中文);
  //   `客户(机密)/报表.json` -> `(` 之后还有 / -> 继续(不泄露)。
  // 跨空白同理:只有下一个词里带分隔符才接着吃,所以 "<路径> 不存在" 不会被过度吞。
  const src = String(text ?? "");
  // 盘符两种写法都要认:C:\ 与 C:/(Codex progress-r10)
  const START = /(?<![A-Za-z0-9\u4e00-\u9fff_.\-/\\])(?:\/[A-Za-z_.]|[A-Za-z]:[\\/])/g;
  const FW = /[\uff08\uff09\u3010\u3011\u300c\u300d\u300e\u300f\uff0c\uff1b\u3002\u3001\uff01\uff1f\uff1a]/;
  const SEP = /[/\\]/;
  const isBreak = (ch: string) => /\s/.test(ch) || ch === '"' || ch === "'" || ch === "`";

  /** 从 i 起吃掉一个"词"(到空白 / 引号为止),返回词内路径真正结束的位置 */
  const scanChunk = (i: number): number => {
    let j = i, end = i;
    while (j < src.length && !isBreak(src[j])) {
      if (FW.test(src[j])) {
        // 全角标点:后面这个词里还有分隔符才算路径还在继续
        let k = j; while (k < src.length && !isBreak(src[k])) k++;
        if (!SEP.test(src.slice(j, k))) break;
      }
      end = ++j;
    }
    return end;
  };

  let out = "", last = 0, m: RegExpExecArray | null;
  while ((m = START.exec(src)) !== null) {
    if (m.index < last) { START.lastIndex = last; continue; }
    let end = scanChunk(m.index);
    // 跨空白续接:下一个词里带分隔符才继续(否则 "<路径> 不存在" 会把"不存在"也吃掉)
    for (;;) {
      const ws = /^\s+/.exec(src.slice(end));
      if (!ws) break;
      const next = end + ws[0].length;
      let k = next; while (k < src.length && !isBreak(src[k])) k++;
      if (k === next || !SEP.test(src.slice(next, k))) break;
      end = scanChunk(next);
    }
    const seg = src.slice(m.index, end);
    const tail = /[,;.、。)\]]+$/.exec(seg)?.[0] ?? "";     // 结尾句读不属于路径,原样留下
    out += src.slice(last, m.index) + "<路径>" + tail;
    last = end;
    START.lastIndex = end;
  }
  return out + src.slice(last);
}



export interface ProgressEvent { stage?: unknown; type?: unknown; [k: string]: unknown }
export interface ProgressOptions {
  runDir: string;
  /** 每行输出到哪(默认 stderr;测试注入数组收集器) */
  write?: (line: string) => void;
  /** 相对时间基准,便于测试注入 */
  now?: () => number;
  /** 阶段 summary 最多打多少字(默认 400,长文不刷屏) */
  maxSummary?: number;
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 把毫秒写成 "1分20秒" / "45秒" */
export function humanElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, "0")}秒`;
}

/** 截断到 max 个字符,截断时补省略号(按**字符**不按字节 —— 中文按字节截会切坏字) */
export function clip(text: string, max: number): string {
  // 净化 → 抹路径 / 密钥 → 折叠空白 → 按**字符**截断。顺序不能换:先截断会把转义序列切成半截。
  const t = stripPaths(redact(sanitizeTerm(String(text ?? "")), 100_000)).replace(/\s+/g, " ").trim();
  return [...t].length <= max ? t : `${[...t].slice(0, max).join("")}…`;
}

export class ProgressReporter {
  private readonly runDir: string;
  private readonly out: (line: string) => void;
  private readonly now: () => number;
  private readonly maxSummary: number;
  private readonly t0: number;
  /**
   * 取数批次**按阶段各存一份**(Codex progress-r1 P1)。单一 lastStage 计数器有两个真实缺陷:
   * ① 没有取数的阶段(如 report)不会触发重置 → 会把上一阶段的计数当成自己的播报出去(ht28 实测就是这样);
   * ② 同一阶段补跑再取数时,旧计数没清 → 两轮合并、数字翻倍。
   */
  private readonly batches = new Map<string, { ok: number; badCount: number; bad: string[]; announced: boolean }>();

  constructor(opts: ProgressOptions) {
    this.runDir = opts.runDir;
    this.out = opts.write ?? ((l) => process.stderr.write(`${l}\n`));
    this.now = opts.now ?? (() => Date.now());
    this.maxSummary = opts.maxSummary ?? 400;
    this.t0 = this.now();
  }

  private line(text: string): void {
    this.out(`[${humanElapsed(this.now() - this.t0)}] ${text}`);
  }

  /** 读该阶段落盘的 summary。读不到就返回 null —— 显示层不猜、不编。 */
  private stageSummary(stage: string): string | null {
    // 🔴 stage 来自事件 payload,而 runner 构造事件时 `...payload` 在固定字段之后 —— **payload 能覆盖 stage**。
    //    所以这里只认白名单阶段名,并再做一次目录包含校验(Codex progress-r1 P1:否则 "../../x" 可读到别处的 JSON)。
    if (!Object.prototype.hasOwnProperty.call(stageLabels(), stage)) return null;
    try {
      const dir = path.resolve(this.runDir, "stages");
      // 目录本身是链接时,下面对 f 与 dir 各做一次 realpath 会**双双解析到同一个外部目录**而放行
      // (Codex progress-r3 P1)—— 所以先拒绝链接目录。
      if (fs.lstatSync(dir).isSymbolicLink()) return null;
      const f = path.resolve(dir, `${stage}.json`);
      if (f !== path.join(dir, `${stage}.json`)) return null;
      // 🔴 用 O_NOFOLLOW 打开再对**文件描述符**做 fstat,一次挡住三件事:
      //  ① 符号链接(O_NOFOLLOW 直接 ELOOP,字符串层面的包含校验挡不住 —— Codex progress-r2);
      //  ② 检查与读取之间被换掉(TOCTOU:先 stat 再按路径读,中间可以被替换);
      //  ③ **命名管道**:readFileSync 对 FIFO 会**永久阻塞**,而阻塞是 try/catch 救不了的
      //     —— 显示层会把整次真实研究拖死(Codex progress-r6)。所以必须 isFile() 才读。
      // 🔴 O_NONBLOCK 不可省:对 FIFO 来说**连 openSync 本身都会阻塞**(等写端),
      //    检查放在 open 之后根本来不及 —— 我第一版就是这么写的,测试当场挂死。
      const fd = fs.openSync(f, fs.constants.O_RDONLY | NOFOLLOW_FLAG | fs.constants.O_NONBLOCK);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > MAX_STAGE_FILE_BYTES) return null;
        const v = (JSON.parse(fs.readFileSync(fd, "utf8")) as { summary?: unknown }).summary;
        return typeof v === "string" && v.trim() ? v : null;
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  }

  /** 订阅事件流。**任何异常都不得冒泡** —— 显示层出错不能把真实研究搞挂。 */
  onEvent(ev: ProgressEvent): void {
    try { this.render(ev); } catch { /* 显示层永不影响运行 */ }
  }

  private render(ev: ProgressEvent): void {
    const type = s(ev.type);
    const stage = s(ev.stage);
    // 非白名单 stage 同样会进多条输出 —— 必须过 clip,否则 payload 覆盖 stage 就能注入控制字符 / 换行(Codex progress-r2 P1)
    const label = stageLabels()[stage] ?? clip(stage, 40);
    switch (type) {
      case "research.started":
        this.line(`开始研究 ${clip(s(ev.symbol), 20)}.${clip(s(ev.market), 8)} · 共 ${Array.isArray(ev.stages) ? ev.stages.length : "?"} 个阶段`);
        return;
      case "knowledge.recalled":
        this.line(`召回上次研究结论(${clip(s(ev.as_of), 20)} · ${clip(s(ev.status), 20)}),由 agent 逐条裁决新旧冲突`);
        return;
      case "fetch.executed": {
        // 取数在每个阶段开头几秒内成批完成 —— 逐条打会刷屏,攒到 turn.prompt 时汇总成一行。
        // 这一行是**用户在第一分钟里唯一能看到的实质内容**(实测 +5 秒),所以失败的源要点名。
        // 只给白名单阶段建批次:否则 payload 里塞任意 stage 就能让这个 Map 无界增长(Codex progress-r2 P2)
        if (!Object.prototype.hasOwnProperty.call(stageLabels(), stage)) return;
        const b = this.batches.get(stage) ?? { ok: 0, badCount: 0, bad: [], announced: false };
        if (b.announced) { b.ok = 0; b.badCount = 0; b.bad = []; b.announced = false; }   // 已播报过 → 补跑的新一批,从零开始
        if (s(ev.status) === "ok") b.ok += 1;
        else {
          b.badCount += 1;                                     // 计数与明细分开:只留 20 条名字,但总数要准
          if (b.bad.length < 20) b.bad.push(clip(s(ev.script) || s(ev.endpoint) || "?", 60));
        }
        this.batches.set(stage, b);
        return;
      }
      case "turn.prompt": {
        const b = this.batches.get(stage);
        if (!b || b.announced) return;            // 无取数(如 report 阶段)或补跑未再取数 → 不播报
        b.announced = true;
        const bad = b.badCount ? ` · 失败 ${b.badCount}(${b.bad.slice(0, 3).join(", ")}${b.badCount > 3 ? " 等" : ""})` : "";
        this.line(`${label}:取数 ${b.ok + b.badCount} 个源,成功 ${b.ok}${bad} → 交给 agent 解读`);
        return;
      }
      case "turn.done": {
        const ms = n(ev.duration_ms);
        if (ms !== null) this.line(`${label}:agent 用了 ${humanElapsed(ms)}`);
        return;
      }
      case "validator": {
        if (ev.ok === true) return;
        const errs = Array.isArray(ev.errors) ? ev.errors : [];
        this.line(`${label}:校验未过(${errs.length} 项),自动补跑 —— ${clip(errs.slice(0, 2).map(String).join("; "), 160)}`);
        return;
      }
      case "stage.completed": {
        const sum = this.stageSummary(stage);
        const st = s(ev.status);
        const mark = st === "complete" ? "✓" : "△";
        this.line(`${mark} ${label} ${clip(st, 20)}${sum ? "" : "(无 summary)"}`);
        if (sum) this.out(`    ${clip(sum, this.maxSummary)}`);
        return;
      }
      case "industry.gate": {
        const tags = Array.isArray(ev.tags) ? ev.tags : [];
        this.line(tags.length ? `命中产业标签 ${clip(tags.slice(0, 8).map(String).join(", "), 120)} → 挂载对应的产业温度计` : "未命中任何产业标签(不取产业温度计,这不是数据缺口)");
        return;
      }
      case "run.done": {
        const e = n(ev.evidence), c = n(ev.calculations), cf = n(ev.conflicts);
        this.line(`${clip(s(ev.status), 20)} · 证据 ${e ?? "?"} 条 · 计算 ${c ?? "?"} 项 · 跨源冲突 ${cf ?? "?"} 处`);
        return;
      }
      case "research.failed":
        this.line(`研究失败:${clip(s(ev.error), 200)}`);
        return;
      default:
        return;
    }
  }
}
